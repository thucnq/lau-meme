"""Content and game invariants checked before every batch is published (docs/acceptance/inv.md, AC-PIPE-11).

Pure functions: no network, no clock; the random-play simulation (AC-INV-12) uses its own fixed-seed generator.
`check_all` runs AC-INV-01..04, 07, 10 and raises with every violation; AC-INV-12 only warns.
"""

import re
from collections.abc import Mapping, Sequence

from lau_meme_pipeline.daily import MAX_DEPTH, MIN_DEPTH
from lau_meme_pipeline.graph import decrypt_entry, graph_to_bytes, open_entry
from lau_meme_pipeline.ids import recipe_id
from lau_meme_pipeline.moderation import Concept, ModLists, layer1
from lau_meme_pipeline.seed import ACTIVE, ContentStore

MAX_FIRST20_MISS = 0.45
MAX_OVERALL_MISS = 0.70
FIRST_TURNS = 20
# A name made only of base64url characters and shorter than this may appear in ciphertext by chance (AC-INV-04).
MIN_OPAQUE_SCAN = 6
B64URL = re.compile(r"^[A-Za-z0-9_-]+$")
MASK64 = (1 << 64) - 1


class InvariantError(Exception):
    """At least one invariant is broken: the batch fails at step "invariants" (AC-PIPE-11)."""

    def __init__(self, violations: list[str]) -> None:
        super().__init__("\n".join(violations))
        self.violations = violations


def _active_recipes(store: ContentStore) -> list:
    """Recipes the players can use: the recipe and its two inputs and result are active."""
    active = {i for i, e in store.elements.items() if e.status == ACTIVE}
    recipes = (store.recipes[k] for k in sorted(store.recipes))
    return [r for r in recipes if r.status == ACTIVE and {r.a, r.b, r.result} <= active]


def _bfs(store: ContentStore) -> dict[str, int]:
    """Depth of every element reachable from the active starters through active recipes and elements only."""
    active = {i for i, e in store.elements.items() if e.status == ACTIVE}
    depth = {s: 0 for s in store.starters if s in active}
    recipes = _active_recipes(store)
    level = 0
    while True:
        level += 1
        new = {r.result: level for r in recipes if r.a in depth and r.b in depth and r.result not in depth}
        if not new:
            return depth
        depth.update(new)


def _name(store: ContentStore, element_id: str) -> str:
    element = store.elements.get(element_id)
    return element.name if element else element_id


def check_symmetric(graph: Mapping, names: Sequence[str]) -> list[str]:
    """AC-INV-01: A + B and B + A give the same answer. Only pairs with an entry can differ (the lookup key and the
    cipher key are both built from the sorted pair), so the others are skipped."""
    entries = graph.get("entries", {})
    unique = sorted(set(names))
    violations = []
    for i, a in enumerate(unique):
        for b in unique[i:]:
            if recipe_id(a, b) not in entries:
                continue
            if decrypt_entry(graph, a, b) != decrypt_entry(graph, b, a):
                violations.append(f"INV-01: {a} + {b} khác {b} + {a}")
    return violations


def check_unique_pairs(store: ContentStore) -> list[str]:
    """AC-INV-02: at most one active recipe per unordered pair of folded names."""
    by_pair: dict[tuple[str, ...], list[str]] = {}
    for rid in sorted(store.recipes):
        r = store.recipes[rid]
        if r.status != ACTIVE:
            continue
        folds = [store.elements[x].fold if x in store.elements else x for x in (r.a, r.b)]
        by_pair.setdefault(tuple(sorted(folds)), []).append(rid)
    return [
        f"INV-02: cặp {pair[0]} + {pair[-1]} có {len(ids)} công thức đang hoạt động"
        for pair, ids in by_pair.items()
        if len(ids) > 1
    ]


def check_reachability(store: ContentStore) -> list[str]:
    """AC-INV-03: every active element is reachable and its stored depth is the BFS depth."""
    depth = _bfs(store)
    violations = []
    for eid in sorted(store.elements):
        e = store.elements[eid]
        if e.status != ACTIVE:
            continue
        if eid not in depth:
            violations.append(f"INV-03: {e.name} đang hoạt động nhưng không tới được từ phần tử khởi đầu")
        elif e.depth != depth[eid]:
            violations.append(f"INV-03: {e.name} lưu depth {e.depth}, BFS {depth[eid]}")
    return violations


def _readable(text: str, term: str) -> bool:
    return bool(term) and (len(term) >= MIN_OPAQUE_SCAN or not B64URL.match(term)) and term in text


def check_opaque(graph: Mapping, store: ContentStore) -> list[str]:
    """AC-INV-04: no readable name/emoji of a depth ≥ 1 element in the graph file, and no entry (A, B) opens with the
    key of (A, X) or (B, X) for any element X other than the partner."""
    text = graph_to_bytes(graph).decode("utf-8")
    violations = []
    for eid in sorted(store.elements):
        e = store.elements[eid]
        if eid in store.starters or e.depth < 1:
            continue
        if _readable(text, e.name) or _readable(text, e.fold):
            violations.append(f"INV-04: file graph lộ tên {e.name}")
        if e.emoji and e.emoji in text:
            violations.append(f"INV-04: file graph lộ emoji của {e.name}")
    folds = sorted({e.fold for e in store.elements.values()})
    by_key = {r.id: r for r in store.recipes.values()}
    for key in sorted(graph.get("entries", {})):
        r = by_key.get(key)
        if r is None or r.a not in store.elements or r.b not in store.elements:
            violations.append(f"INV-04: mục {key} không thuộc công thức nào")
            continue
        a, b = store.elements[r.a].fold, store.elements[r.b].fold
        for keep, partner in ((a, b), (b, a)):
            for x in folds:
                if x != partner and open_entry(graph, key, keep, x) is not None:
                    pair = f"{_name(store, r.a)} + {_name(store, r.b)}"
                    violations.append(f"INV-04: mục {pair} mở được khi thiếu đầu vào ({keep} + {x})")
                    break
    return violations


def check_moderation(store: ContentStore, lists: ModLists) -> list[str]:
    """AC-INV-07: layer 1 again (banned words, blocked aliases, admin-blocked names) on every active element - its
    name, emoji and image hint; a recipe is published only with an active result, so its result covers it."""
    violations = []
    for eid in sorted(store.elements):
        e = store.elements[eid]
        if e.status != ACTIVE:
            continue
        reason = layer1(Concept(key=eid, name=e.name, emoji=e.emoji, image_hint=e.image_hint), lists)
        if reason:
            violations.append(f"INV-07: {e.name} khớp danh mục cấm ({reason})")
    return violations


def check_daily(manifest: Mapping, store: ContentStore) -> list[str]:
    """AC-INV-10: the Món đặc biệt exists, is active, reachable, and its depth is within [4, 8]."""
    daily = manifest.get("daily") or {}
    eid = daily.get("element_id")
    e = store.elements.get(eid) if isinstance(eid, str) else None
    if e is None:
        return [f"INV-10: Món đặc biệt {eid} không có trong kho"]
    violations = []
    if e.status != ACTIVE:
        violations.append(f"INV-10: Món đặc biệt {e.name} không hoạt động")
    if eid not in _bfs(store):
        violations.append(f"INV-10: Món đặc biệt {e.name} không tới được")
    if not MIN_DEPTH <= e.depth <= MAX_DEPTH:
        violations.append(f"INV-10: Món đặc biệt {e.name} có depth {e.depth}, ngoài [{MIN_DEPTH}, {MAX_DEPTH}]")
    return violations


def check_all(graph: Mapping, manifest: Mapping, store: ContentStore, lists: ModLists) -> None:
    """Every blocking invariant (AC-INV-01..04, 07, 10); raises InvariantError listing all violations."""
    names = [store.elements[k].name for k in sorted(store.elements)]
    violations = [
        *check_symmetric(graph, names),
        *check_unique_pairs(store),
        *check_reachability(store),
        *check_opaque(graph, store),
        *check_moderation(store, lists),
        *check_daily(manifest, store),
    ]
    if violations:
        raise InvariantError(violations)


class Rng:
    """SplitMix64: fixed-seed and identical on every Python version (no `random`, AC-INV-05)."""

    def __init__(self, seed: int) -> None:
        self.state = seed & MASK64

    def below(self, n: int) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return (z ^ (z >> 31)) % n


def simulate_miss_rate(
    graph: Mapping, starters: Sequence[Mapping], *, games: int = 1000, turns: int = 100, seed: int = 0
) -> tuple[float, float]:
    """AC-INV-12: random play - each turn picks 2 elements of the plate (the same one may come twice) and drops
    them in the pot; a miss is a pair with no recipe. Returns (miss rate of the first 20 turns, of the whole game)."""
    rng = Rng(seed)
    looked_up: dict[tuple[str, str], str | None] = {}

    def result(a: str, b: str) -> str | None:
        pair = (a, b) if a <= b else (b, a)
        if pair not in looked_up:
            entry = decrypt_entry(graph, a, b)
            looked_up[pair] = entry["name"] if entry else None
        return looked_up[pair]

    first_misses = misses = 0
    first = min(FIRST_TURNS, turns)
    for _ in range(games):
        plate = [s["name"] for s in starters]
        known = set(plate)
        for turn in range(turns):
            got = result(plate[rng.below(len(plate))], plate[rng.below(len(plate))])
            if got is None:
                misses += 1
                first_misses += turn < first
            elif got not in known:
                known.add(got)
                plate.append(got)
    if games == 0 or turns == 0:
        return 0.0, 0.0
    return first_misses / (games * first), misses / (games * turns)


def miss_rate_warning(first20: float, overall: float) -> str | None:
    """Vietnamese warning for the batch report when random play misses too often (AC-INV-12); None when fine."""
    if first20 <= MAX_FIRST20_MISS and overall <= MAX_OVERALL_MISS:
        return None
    return (
        f"⚠️ Tỉ lệ ghép trượt khi chơi ngẫu nhiên cao: 20 lượt đầu {first20:.0%} (ngưỡng {MAX_FIRST20_MISS:.0%}), "
        f"cả ván {overall:.0%} (ngưỡng {MAX_OVERALL_MISS:.0%}) - nên bổ sung công thức"
    )
