"""Choose and announce the Món đặc biệt of a batch (AC-DAILY-01..03).

Pure functions: the "random" order is a hash seeded by the batch version, so a re-run picks the same dish.
"""

import hashlib
import re
from collections.abc import Mapping, Sequence
from typing import NamedTuple

from lau_meme_pipeline.ids import element_id
from lau_meme_pipeline.text import fold

MIN_DEPTH = 4
MAX_DEPTH = 8
MAX_HINT_LENGTH = 200
RECENT_BATCHES = 30  # a dish is not repeated within this many batches (AC-DAILY-01/18)
TREND = "trend"


class NoDailyCandidate(Exception):
    """No element satisfies the conditions: the batch fails (AC-PIPE-11) and keeps the old version."""

    def __init__(self) -> None:
        super().__init__("Mẻ thất bại: không chọn được Món đặc biệt (không phần tử nào thỏa depth 4–8 và điều kiện)")


def _eligible(c: Mapping) -> bool:
    return (
        MIN_DEPTH <= c["depth"] <= MAX_DEPTH
        and c["active"]
        and c["reachable"]
        and not c["held"]
        and bool(c["hint"])
        and c["hint_ok"]
    )


def core_hints(core: Mapping) -> dict[str, str]:
    """Hand-written hints of the core by element name: every element's `daily_hint` (open question 41), plus the
    older `daily_examples` whose target has none, so a core written before `daily_hint` keeps its dishes."""
    hints = {e["name"]: e["daily_hint"] for e in core.get("elements", []) if e.get("daily_hint")}
    for ex in core.get("daily_examples", []):
        if ex.get("hint"):
            hints.setdefault(ex["target"], ex["hint"])
    return hints


def _seeded(version: int, element: str) -> str:
    """Deterministic shuffle key: same (version, element) → same order, whatever the input order."""
    return hashlib.sha256(f"lm1|daily|{version}|{element}".encode()).hexdigest()


def select_daily(candidates: Sequence[Mapping], history: Sequence[Mapping], version: int) -> Mapping:
    """Saltiest (`trend_peak`), then never or longest not a dish, then newest (`added_version` = first batch in the
    store), then seeded order, skipping the dishes of the last `RECENT_BATCHES` batches; when all of them are
    recent, the dish whose last use is the oldest (AC-DAILY-01, 2026-10-23/24).

    `history` lists earlier picks as {element_id, version}; held/inactive/unreachable dishes never qualify.
    """
    return pick_daily(candidates, history, version).chosen


class DailyPick(NamedTuple):
    chosen: Mapping
    exhausted: bool  # every candidate was a dish of the last RECENT_BATCHES batches: "Pool thử thách cạn"


def pick_daily(candidates: Sequence[Mapping], history: Sequence[Mapping], version: int) -> DailyPick:
    pool = [c for c in candidates if _eligible(c)]
    if not pool:
        raise NoDailyCandidate()
    last_used: dict[str, int] = {}
    for h in history:
        last_used[h["element_id"]] = max(h["version"], last_used.get(h["element_id"], h["version"]))
    # counted in batches, not days (open question 43): one history entry per published batch
    recent = {h["element_id"] for h in sorted(history, key=lambda h: h["version"], reverse=True)[:RECENT_BATCHES]}

    def seeded(c: Mapping) -> str:
        return _seeded(version, c["element_id"])

    fresh = [c for c in pool if c["element_id"] not in recent]
    if fresh:
        # never a dish before (-1), else the one whose last use is the oldest, ahead of newness (chốt 2026-10-24)
        def rank(c: Mapping) -> tuple:
            return (-c.get("trend_peak", 0), last_used.get(c["element_id"], -1), -c["added_version"], seeded(c))

        return DailyPick(min(fresh, key=rank), False)
    return DailyPick(min(pool, key=lambda c: (last_used[c["element_id"]], seeded(c))), True)


def build_daily_block(element: Mapping, hint: str) -> dict:
    """`manifest.daily`: hashed id, emoji, hint, depth - never the readable name (AC-DAILY-03)."""
    name = element["name"]
    if not hint or len(hint) > MAX_HINT_LENGTH:
        raise ValueError(f"Gợi ý phải dài 1–{MAX_HINT_LENGTH} ký tự")
    if re.search(r"(?<!\w)" + re.escape(fold(name)) + r"(?!\w)", fold(hint)):
        raise ValueError("Gợi ý không được chứa tên Món đặc biệt")
    return {"element_id": element_id(name), "emoji": element["emoji"], "hint": hint, "depth": element["depth"]}


def pinned_daily(pin: Mapping | None, element: Mapping | None, blocked: frozenset[str]) -> dict | None:
    """The admin's Món đặc biệt for this batch (AC-DAILY-19, ADR 0019): any element still active and not blocked, with
    the admin's hint, whatever its depth or how recently it was a dish. None when the pin cannot be used (dropped).

    `element` is the stored element of `pin["element_id"]` as {name, emoji, depth, active} or None when absent.
    """
    if pin is None or element is None or not element["active"] or pin["element_id"] in blocked:
        return None
    try:
        return build_daily_block(element, pin["hint"])
    except ValueError:  # the Worker checks the hint, but a renamed element could now be named in it
        return None
