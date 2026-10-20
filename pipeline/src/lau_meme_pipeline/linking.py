"""Back-linking and supplementary recipes (AC-PIPE-06/08): only valid pairs enter the graph; depth = BFS again."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Graph:
    starters: tuple[str, ...]
    elements: Mapping[str, str]  # id → name
    recipes: Mapping[tuple[str, str], str]  # sorted pair of ids → result id
    inactive: frozenset[str] = frozenset()  # hidden/blocked element ids


@dataclass
class LinkResult:
    accepted: list[tuple[str, str]] = field(default_factory=list)
    rejected: dict[tuple[str, str], str] = field(default_factory=dict)


def _pair(a: str, b: str) -> tuple[str, str]:
    x, y = sorted((a, b))
    return (x, y)


def validate_links(new_id: str, proposals: Sequence[tuple[str, str]], graph: Graph) -> LinkResult:
    """A pair is kept only when both inputs exist and are active, it is new, and it does not use the meme itself."""
    result = LinkResult()
    taken: set[tuple[str, str]] = set()
    for a, b in proposals:
        pair = _pair(a, b)
        if pair in taken:
            reason = "duplicate"
        elif new_id in pair:
            reason = "self"
        elif any(x not in graph.elements for x in pair):
            reason = "unknown"
        elif any(x in graph.inactive for x in pair):
            reason = "inactive"
        elif pair in graph.recipes:
            reason = "exists"
        else:
            reason = ""
        taken.add(pair)
        if reason:
            result.rejected[pair] = reason
        else:
            result.accepted.append(pair)
    return result


def bfs_depths(graph: Graph) -> dict[str, int]:
    """Same rule as the core (AC-SEED-06): starters 0; a result gets round k once both inputs are known."""
    active = {e for e in graph.elements if e not in graph.inactive}
    depth = {s: 0 for s in graph.starters if s in active}
    level = 0
    while True:
        level += 1
        new: dict[str, int] = {}
        for (a, b), result in sorted(graph.recipes.items()):
            if result in active and a in depth and b in depth and result not in depth:
                new.setdefault(result, level)
        if not new:
            return depth
        depth.update(new)


def needs_supplement(graph: Graph, min_out: int = 3) -> list[str]:
    """Active elements used as an input by fewer than `min_out` recipes (AC-PIPE-08)."""
    out: dict[str, int] = {e: 0 for e in graph.elements if e not in graph.inactive}
    for a, b in graph.recipes:
        for x in {a, b}:
            if x in out:
                out[x] += 1
    return sorted(e for e, n in out.items() if n < min_out)
