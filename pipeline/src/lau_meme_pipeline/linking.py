"""Back-linking and supplementary recipes (AC-PIPE-06/08): only valid pairs enter the graph; depth = BFS again."""

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field

from lau_meme_pipeline.invariants import FIRST_TURNS, Rng
from lau_meme_pipeline.text import fold

# Pairs asked for supplementary recipes per batch (AC-PIPE-08; default - open question 30).
SUPPLEMENT_LIMIT = 150


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


@dataclass(frozen=True)
class Simulation:
    presence: dict[str, int]  # element id -> turns (over all games) it sat on the plate
    first20: float
    overall: float


def simulate_plate(graph: Graph, *, games: int = 1000, turns: int = 100, seed: int = 0) -> Simulation:
    """The AC-INV-12 random play on the id graph, also counting how often each element is on the plate (AC-PIPE-08).
    A pair with no recipe, or with an inactive input or result, is a miss."""
    starters = [s for s in graph.starters if s not in graph.inactive]
    if not starters or games <= 0 or turns <= 0:
        return Simulation({}, 0.0, 0.0)
    rng = Rng(seed)
    presence: dict[str, int] = {}
    first_misses = misses = 0
    first = min(FIRST_TURNS, turns)
    for _ in range(games):
        plate = list(starters)
        known = set(plate)
        for turn in range(turns):
            for e in plate:
                presence[e] = presence.get(e, 0) + 1
            a, b = plate[rng.below(len(plate))], plate[rng.below(len(plate))]
            got = graph.recipes.get((a, b) if a <= b else (b, a))
            if got is None or got in graph.inactive:
                misses += 1
                first_misses += turn < first
            elif got not in known:
                known.add(got)
                plate.append(got)
    return Simulation(presence, first_misses / (games * first), misses / (games * turns))


def supplement_pairs(
    graph: Graph,
    presence: Mapping[str, int],
    *,
    limit: int = SUPPLEMENT_LIMIT,
    asked: Collection[tuple[str, str]] = (),
) -> list[tuple[str, str]]:
    """Pairs without a recipe that most often sit on the plate together, best first (AC-PIPE-08): ordered by the
    product of the two presence counts, ties by folded names; pairs already asked and rejected are skipped."""
    present = sorted(e for e, n in presence.items() if n > 0 and e in graph.elements and e not in graph.inactive)
    skip = {tuple(sorted(p)) for p in asked}
    scored = []
    for i, a in enumerate(present):
        for b in present[i:]:
            if (a, b) in graph.recipes or (a, b) in skip:
                continue
            names = tuple(sorted((fold(graph.elements[a]), fold(graph.elements[b]))))
            scored.append((-presence[a] * presence[b], names, (a, b)))
    scored.sort()
    return [pair for _, _, pair in scored[: max(limit, 0)]]
