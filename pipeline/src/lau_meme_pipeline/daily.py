"""Choose and announce the Món đặc biệt of a batch (AC-DAILY-01..03).

Pure functions: the "random" order is a hash seeded by the batch version, so a re-run picks the same dish.
"""

import hashlib
import re
from collections.abc import Mapping, Sequence

from lau_meme_pipeline.ids import element_id
from lau_meme_pipeline.text import fold

MIN_DEPTH = 4
MAX_DEPTH = 8
MAX_HINT_LENGTH = 200
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


def _seeded(version: int, element: str) -> str:
    """Deterministic shuffle key: same (version, element) → same order, whatever the input order."""
    return hashlib.sha256(f"lm1|daily|{version}|{element}".encode()).hexdigest()


def select_daily(candidates: Sequence[Mapping], history: Sequence[Mapping], version: int) -> Mapping:
    """Newest unused trend, else an unused classic, else the dish whose last use is the oldest.

    `history` lists earlier picks as {element_id, version}; held/inactive/unreachable dishes never qualify.
    """
    pool = [c for c in candidates if _eligible(c)]
    if not pool:
        raise NoDailyCandidate()
    last_used: dict[str, int] = {}
    for h in history:
        last_used[h["element_id"]] = max(h["version"], last_used.get(h["element_id"], h["version"]))

    def seeded(c: Mapping) -> str:
        return _seeded(version, c["element_id"])

    unused = [c for c in pool if c["element_id"] not in last_used]
    trends = [c for c in unused if c["source"] == TREND]
    if trends:
        return min(trends, key=lambda c: (-c["added_version"], seeded(c)))
    if unused:
        return min(unused, key=seeded)
    return min(pool, key=lambda c: (last_used[c["element_id"]], seeded(c)))


def build_daily_block(element: Mapping, hint: str) -> dict:
    """`manifest.daily`: hashed id, emoji, hint, depth — never the readable name (AC-DAILY-03)."""
    name = element["name"]
    if not hint or len(hint) > MAX_HINT_LENGTH:
        raise ValueError(f"Gợi ý phải dài 1–{MAX_HINT_LENGTH} ký tự")
    if re.search(r"(?<!\w)" + re.escape(fold(name)) + r"(?!\w)", fold(hint)):
        raise ValueError("Gợi ý không được chứa tên Món đặc biệt")
    return {"element_id": element_id(name), "emoji": element["emoji"], "hint": hint, "depth": element["depth"]}
