"""Automatic moderation of new content (AC-MOD-01..13, `ghi-chu-hop.md` sections 7 and 7.1).

Pure logic: the LLM is a `classify` callable passed in (a network adapter in production, a fake in tests), the
batch date is passed in, never read from the clock. Layer 1 (word lists) runs first and its rejects never reach
the LLM; layer 2 asks the LLM per concept and anything not clearly safe is rejected ("không chắc thì loại").
"""

import re
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta

from lau_meme_pipeline.llm import QuotaExhausted
from lau_meme_pipeline.text import fold

CATEGORIES = (
    "real_person",
    "politics",
    "religion",
    "sexual",
    "discrimination",
    "body_shaming",
    "violence",
    "drugs",
    "self_harm",
    "harassment",
    "not_meme",  # a bare name, title or event rather than a meme (AC-MOD-13)
)
HOLD_DAYS = 30  # "tin nguội" after a hot story about one person (7.1, AC-MOD-08)
MIN_CONFIDENCE = 0.8  # open question #23
SHORT_TERM = 4  # shorter terms match whole tokens only, so "ma" does not block "Mama" (open question #24)
MIN_ALIAS = 3  # shorter names are never auto-blocked: one or two letters would block most text (open question #24)
MAX_ALIASES = 10  # per concept, so one answer cannot flood the persistent alias list
TEXT_FIELDS = ("name", "emoji", "description", "daily_hint", "image_hint")
BLOCKING_FIELDS = frozenset({"name", "emoji", "description"})
REQUEST_FIELDS = ("key", "kind", "name", "emoji", "description", "daily_hint", "image_hint", "context", "source_name")

# Report labels of the batch Issue (AC-MOD-01/02/10).
LABELS = {
    "banned_word": "từ cấm",
    "blocked_alias": "bí danh bị chặn",
    "admin_blocked": "đã bị chặn",
    "real_person": "người thật",
    "accusation": "người thật",
    "politics": "chính trị",
    "religion": "tôn giáo",
    "sexual": "tình dục",
    "discrimination": "phân biệt",
    "body_shaming": "body shaming",
    "violence": "bạo lực",
    "drugs": "ma túy",
    "self_harm": "tự hại",
    "harassment": "quấy rối",
    "not_meme": "không phải meme",
    "unsure": "không chắc",
    "invalid_response": "không chắc",
    "llm_error": "không chắc",
    "flagged_field": "không chắc",
}
QUOTA_LABEL = "hết quota"


# Title signals of things that are not memes: livestreams, schedules, tournaments (AC-MOD-12, open question 102).
# Matched on the folded name, so case and diacritics do not matter.
NOT_MEME_PATTERNS = tuple(
    re.compile(p)
    for p in (
        r"\btruc tiep\b",
        r"\blive ?stream\b",
        r"\b\d{1,2}([./-])\d{1,2}\1\d{4}\b",  # full day-month-year date
        r"\bvong (bang|loai|swiss|\d+)\b",
        r"\bgiai doan\b",
        r"\bplayoffs?\b",
        r"\bmua giai\b",
        r"\bmua (xuan|ha|he|thu|dong) \d{4}\b",
    )
)
NOT_MEME_MAX_WORDS = 10


@dataclass(frozen=True)
class Concept:
    key: str
    name: str
    kind: str = "element"  # "element" | "recipe" (a recipe is checked through its result name)
    emoji: str = ""
    description: str = ""
    daily_hint: str = ""
    image_hint: str = ""
    context: str = ""  # source passage: the real-person rule needs it, not only the title (AC-MOD-05)
    source_name: str = ""


@dataclass(frozen=True)
class ModLists:
    banned_words: frozenset[str] = frozenset()
    aliases: frozenset[str] = frozenset()
    admin_blocked: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Passed:
    concept: Concept
    hint_ok: bool = True
    image_hint_ok: bool = True
    held_until: date | None = None


@dataclass
class ModerationResult:
    passed: list[Passed] = field(default_factory=list)
    rejected: dict[str, str] = field(default_factory=dict)
    queued: list[Concept] = field(default_factory=list)
    reasons: dict[str, list[str]] = field(default_factory=dict)  # every reason per rejected key (AC-MOD-11)
    steps: dict[str, str] = field(default_factory=dict)  # "layer1" | "layer2" per rejected key
    new_aliases: frozenset[str] = frozenset()
    counts: dict[str, int] = field(default_factory=dict)


def _key(text: str) -> str:
    """Letters and digits of the folded text: "T.ừ  C-ấm" → "tucam" (same rule as the Worker's nickname filter)."""
    return re.sub(r"[\W_]", "", fold(text))


def _tokens(text: str) -> set[str]:
    """Folded words, plus each run of single letters joined: "N.V.A fan" → {n, v, a, fan, nva} (dotted acronyms)."""
    words = [t for t in re.split(r"[\W_]+", fold(text)) if t]
    out = set(words)
    run: list[str] = []
    for w in [*words, ""]:
        if len(w) == 1:
            run.append(w)
            continue
        if len(run) > 1:
            out.add("".join(run))
        run = []
    return out


def not_meme_title(name: str) -> bool:
    """A livestream, schedule or tournament title, judged on the name alone (AC-MOD-12)."""
    folded = fold(name)
    return (
        "🔴" in name
        or name.count("|") >= 2
        or len(name.split()) > NOT_MEME_MAX_WORDS
        or any(p.search(folded) for p in NOT_MEME_PATTERNS)
    )


def layer1(concept: Concept, lists: ModLists) -> str | None:
    """Word lists and title signals, no LLM (AC-MOD-01/06/10/12)."""
    reasons = layer1_reasons(concept, lists)
    return reasons[0] if reasons else None


def listed(concept: Concept, lists: ModLists) -> str | None:
    """Word lists only: what published content must never match (AC-INV-07), whatever its title looks like."""
    reasons = list_reasons(concept, lists)
    return reasons[0] if reasons else None


def layer1_reasons(concept: Concept, lists: ModLists) -> list[str]:
    """Every layer-1 reason, most serious first: the admin sees them all, not only the first (AC-MOD-11)."""
    reasons = list_reasons(concept, lists)
    if not_meme_title(concept.name):
        reasons.append("not_meme")
    return reasons


def list_reasons(concept: Concept, lists: ModLists) -> list[str]:
    reasons = []
    if any(fold(concept.name) == fold(t) for t in lists.admin_blocked):
        reasons.append("admin_blocked")
    # Daily/image hints are checked too and reject the whole concept: stricter than layer 2 (which only drops the
    # hint), on purpose - a listed word anywhere means the concept was about it.
    texts = [_key(getattr(concept, f)) for f in TEXT_FIELDS]
    tokens = set().union(*(_tokens(getattr(concept, f)) for f in TEXT_FIELDS))

    def hit(terms: frozenset[str]) -> bool:
        for term in terms:
            key = _key(term)
            if not key:
                continue
            if len(key) < SHORT_TERM:
                if key in tokens:
                    return True
            elif any(key in text for text in texts):
                return True
        return False

    if hit(lists.aliases):
        reasons.append("blocked_alias")
    if hit(lists.banned_words):
        reasons.append("banned_word")
    return reasons


def _request(c: Concept) -> dict:
    return {f: getattr(c, f) for f in REQUEST_FIELDS}


def _valid(item: object) -> bool:
    if not isinstance(item, Mapping):
        return False
    person = item.get("person")
    confidence = item.get("confidence")
    return (
        item.get("category") in ("safe", "unsure", *CATEGORIES)
        and isinstance(confidence, int | float)
        and not isinstance(confidence, bool)
        and 0 <= confidence <= 1
        and isinstance(person, Mapping)
        and isinstance(person.get("targets"), bool)
        and (person.get("name") is None or isinstance(person.get("name"), str))
        and isinstance(person.get("aliases", []), list)
        and all(isinstance(a, str) for a in person.get("aliases", []))
        and isinstance(item.get("accusation"), bool)
        and isinstance(item.get("hot_person"), bool)
        and isinstance(item.get("flagged_fields", []), list)
        and all(isinstance(f, str) for f in item.get("flagged_fields", []))
    )


def _person_names(item: Mapping) -> set[str]:
    """Name then aliases, folded; too-short ones dropped and at most MAX_ALIASES kept (the answer is untrusted)."""
    person = item["person"]
    names = [person.get("name") or "", *person.get("aliases", [])]
    kept = [fold(n) for n in names if len(_key(n)) >= MIN_ALIAS]
    return set(list(dict.fromkeys(kept))[:MAX_ALIASES])


def is_held(held_until: date | None, batch_date: date) -> bool:
    """Compared with the batch date, never the system clock (AC-MOD-08)."""
    return held_until is not None and batch_date < held_until


def daily_candidate_flags(passed: Passed, batch_date: date) -> dict:
    """Flags for `daily.select_daily` candidates: held dishes and dishes without an approved hint never qualify."""
    return {"held": is_held(passed.held_until, batch_date), "hint_ok": passed.hint_ok}


def show_new_label(passed: Passed, batch_date: date) -> bool:
    return not is_held(passed.held_until, batch_date)


def moderate(
    concepts: Sequence[Concept],
    lists: ModLists,
    classify: Callable[[list[dict]], list[dict]],
    batch_date: date,
    *,
    batch_size: int = 10,
    min_confidence: float = MIN_CONFIDENCE,
) -> ModerationResult:
    """`batch_date` is the GMT+7 date of the batch's `batch_at`, never today's date (AC-MOD-08)."""
    result = ModerationResult()
    reasons: Counter[str] = Counter()
    aliases: set[str] = set()
    pending: list[Concept] = []
    for c in concepts:
        found = layer1_reasons(c, lists)
        if found:
            result.rejected[c.key] = found[0]
            result.reasons[c.key] = found
            result.steps[c.key] = "layer1"
            reasons[found[0]] += 1
        else:
            pending.append(c)

    def reject(c: Concept, reason: str) -> None:
        result.rejected[c.key] = reason
        result.reasons[c.key] = [reason]
        result.steps[c.key] = "layer2"
        reasons[reason] += 1

    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        try:
            answers = classify([_request(c) for c in batch])
        except QuotaExhausted:
            result.queued = pending[start:]  # stop calling; the rest waits for the next batch (AC-PIPE-12)
            break
        except Exception:  # LlmError, or anything the adapter did not wrap: never "safe" (AC-MOD-03)
            for c in batch:
                reject(c, "llm_error")
            continue
        by_key: dict[str, Mapping] = {}
        seen: set[str] = set()
        for a in answers if isinstance(answers, list) else []:
            key = a.get("key") if isinstance(a, Mapping) else None
            if not isinstance(key, str):
                continue
            if key in seen:
                by_key.pop(key, None)  # two answers for one concept: trust neither
            else:
                seen.add(key)
                by_key[key] = a
        for c in batch:
            item = by_key.get(c.key)
            if not _valid(item):
                reject(c, "invalid_response")
                continue
            if item["accusation"] or item["person"]["targets"]:
                aliases |= _person_names(item)
                reject(c, "accusation" if item["accusation"] else "real_person")
                continue
            if item["category"] == "unsure" or item["confidence"] < min_confidence:
                reject(c, "unsure")
                continue
            if item["category"] in CATEGORIES:
                reject(c, item["category"])
                continue
            flagged = set(item.get("flagged_fields", []))
            if flagged & BLOCKING_FIELDS:
                reject(c, "flagged_field")
                continue
            held = batch_date + timedelta(days=HOLD_DAYS) if item["hot_person"] else None
            result.passed.append(Passed(c, "daily_hint" not in flagged, "image_hint" not in flagged, held))

    counts: Counter[str] = Counter()
    for reason, n in reasons.items():
        counts[LABELS[reason]] += n
    if result.queued:
        counts[QUOTA_LABEL] = len(result.queued)
    result.counts = dict(counts)
    result.new_aliases = frozenset(aliases)
    return result
