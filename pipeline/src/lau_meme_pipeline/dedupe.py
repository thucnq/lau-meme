"""Dedupe step (AC-PIPE-05): exact matches by folded key without the LLM; only near matches are asked."""

import difflib
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from lau_meme_pipeline.crawl import RawConcept
from lau_meme_pipeline.text import fold

NEAR_RATIO = 0.6


def dedupe_key(name: str) -> str:
    """ "CÒN CÁI NỊT!!" → "con cai nit": fold, keep letters/digits/spaces, collapse spaces."""
    return " ".join(re.sub(r"[^\w\s]|_", " ", fold(name)).split())


@dataclass
class DedupeResult:
    kept: list[RawConcept] = field(default_factory=list)
    dropped: dict[str, str] = field(default_factory=dict)


def _closest(key: str, existing: Sequence[tuple[str, str]]) -> tuple[float, str]:
    best = (0.0, "")
    for ek, name in existing:
        ratio = difflib.SequenceMatcher(None, key, ek).ratio()
        if ratio > best[0]:
            best = (ratio, name)
    return best


def dedupe(
    concepts: Sequence[RawConcept],
    existing_names: Sequence[str],
    ask_same: Callable[[list[dict]], list[bool]],
) -> DedupeResult:
    result = DedupeResult()
    existing = [(dedupe_key(n), n) for n in existing_names]
    seen = {k for k, _ in existing}
    candidates: list[RawConcept] = []
    for c in concepts:
        key = dedupe_key(c.name)
        if key in seen:
            result.dropped[c.name] = "exact"
            continue
        seen.add(key)
        candidates.append(c)

    near: list[tuple[RawConcept, str]] = []
    for c in candidates:
        ratio, closest = _closest(dedupe_key(c.name), existing)
        if ratio >= NEAR_RATIO:
            near.append((c, closest))
    same: list[bool] = []
    if near:
        same = ask_same([{"name": c.name, "existing": closest} for c, closest in near])
    answers = {c.name: s for (c, _), s in zip(near, same, strict=False) if isinstance(s, bool)}
    near_names = {c.name for c, _ in near}
    for c in candidates:
        if answers.get(c.name) is True:
            result.dropped[c.name] = "llm_same"
        elif c.name in near_names and c.name not in answers:
            # No clear answer (quota, failed call): never published as new; crawled again next batch.
            result.dropped[c.name] = "no_answer"
        else:
            result.kept.append(c)
    return result
