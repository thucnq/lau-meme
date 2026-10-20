"""Automatic moderation of new content (AC-MOD-01..10, `ghi-chu-hop.md` sections 7 and 7.1).

Pure logic: the LLM is a `classify` callable passed in (a network adapter in production, a fake in tests), the
batch date is passed in, never read from the clock. Layer 1 (word lists) runs first and its rejects never reach
the LLM; layer 2 asks the LLM per concept and anything not clearly safe is rejected ("không chắc thì loại").
"""

import re
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta

from lau_meme_pipeline.llm import LlmError, QuotaExhausted
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
)
HOLD_DAYS = 30  # "tin nguội" after a hot story about one person (7.1, AC-MOD-08)
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
    "unsure": "không chắc",
    "invalid_response": "không chắc",
    "llm_error": "không chắc",
    "flagged_field": "không chắc",
}
QUOTA_LABEL = "hết quota"


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
    new_aliases: frozenset[str] = frozenset()
    counts: dict[str, int] = field(default_factory=dict)


def _key(text: str) -> str:
    """Letters and digits of the folded text: "T.ừ  C-ấm" → "tucam" (same rule as the Worker's nickname filter)."""
    return re.sub(r"[^\w]|_", "", fold(text))


def layer1(concept: Concept, lists: ModLists) -> str | None:
    """Word lists only, no LLM (AC-MOD-01/06/10)."""
    if any(fold(concept.name) == fold(t) for t in lists.admin_blocked):
        return "admin_blocked"
    texts = [_key(getattr(concept, f)) for f in TEXT_FIELDS]

    def hit(terms: frozenset[str]) -> bool:
        keys = [k for k in (_key(t) for t in terms) if k]
        return any(k in text for k in keys for text in texts)

    if hit(lists.aliases):
        return "blocked_alias"
    if hit(lists.banned_words):
        return "banned_word"
    return None


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
    )


def _person_names(item: Mapping) -> set[str]:
    person = item["person"]
    names = [person.get("name") or "", *person.get("aliases", [])]
    return {fold(n) for n in names if fold(n)}


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
    min_confidence: float = 0.8,  # open question #23
) -> ModerationResult:
    result = ModerationResult()
    reasons: Counter[str] = Counter()
    aliases: set[str] = set()
    pending: list[Concept] = []
    for c in concepts:
        reason = layer1(c, lists)
        if reason:
            result.rejected[c.key] = reason
            reasons[reason] += 1
        else:
            pending.append(c)

    def reject(c: Concept, reason: str) -> None:
        result.rejected[c.key] = reason
        reasons[reason] += 1

    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        try:
            answers = classify([_request(c) for c in batch])
        except QuotaExhausted:
            result.queued = pending[start:]  # stop calling; the rest waits for the next batch (AC-PIPE-12)
            break
        except LlmError:
            for c in batch:
                reject(c, "llm_error")
            continue
        by_key = {a.get("key"): a for a in answers if isinstance(a, Mapping)} if isinstance(answers, list) else {}
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
