"""Ngon / Nhạt (AC-FEEDBACK-04): hide recipes the players found bland, never an element's last way in.

Pure: reads the anonymous per-recipe counts of PipelineState.feedback (no UUID) and returns a new store.
"""

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, replace

from lau_meme_pipeline.seed import ACTIVE, INACTIVE, ContentStore

MIN_VOTES = 10  # open question 15 (default)
MIN_NHAT_PERCENT = 60


@dataclass(frozen=True)
class FeedbackResult:
    store: ContentStore
    hidden: tuple[str, ...]  # recipe ids taken out of this batch
    kept: tuple[str, ...]  # over the threshold, but the only recipe keeping an element reachable


def hidden_recipes(feedback: Sequence[Mapping]) -> Collection[str]:
    """Recipe ids with >= 10 votes and >= 60 % "Nhạt" (both bounds inclusive)."""
    return frozenset(
        f["recipe_id"]
        for f in feedback
        if f["votes"] >= MIN_VOTES and f["nhat"] * 100 >= f["votes"] * MIN_NHAT_PERCENT  # integers: no float edge
    )


def _depths(store: ContentStore) -> dict[str, int]:
    """BFS from the active starters through active recipes and elements (same rule as AC-SEED-06)."""
    active = {i for i, e in store.elements.items() if e.status == ACTIVE}
    recipes = [r for r in store.recipes.values() if r.status == ACTIVE and {r.a, r.b, r.result} <= active]
    depth = {s: 0 for s in store.starters if s in active}
    level = 0
    while True:
        level += 1
        new = {r.result: level for r in recipes if r.a in depth and r.b in depth and r.result not in depth}
        if not new:
            return depth
        depth.update(new)


def apply_feedback(store: ContentStore, feedback: Sequence[Mapping]) -> FeedbackResult:
    """Marks each bland recipe inactive (in id order) unless that leaves an element unreachable, then sets the
    depths again so the stored depth stays the BFS depth (AC-INV-03). Unknown ids are ignored."""
    reachable = set(_depths(store))
    hidden: list[str] = []
    kept: list[str] = []
    for rid in sorted(hidden_recipes(feedback)):
        recipe = store.recipes.get(rid)
        if recipe is None or recipe.status != ACTIVE:
            continue
        trial = replace(store, recipes={**store.recipes, rid: replace(recipe, status=INACTIVE)})
        if reachable <= set(_depths(trial)):
            store = trial
            hidden.append(rid)
        else:
            kept.append(rid)
    if hidden:
        depths = _depths(store)
        elements = {i: replace(e, depth=depths[i]) if i in depths else e for i, e in store.elements.items()}
        store = replace(store, elements=elements)
    return FeedbackResult(store=store, hidden=tuple(hidden), kept=tuple(kept))


def feedback_report(result: FeedbackResult, before: ContentStore, feedback: Sequence[Mapping]) -> list[str]:
    """Report lines of the batch: what was hidden for "Nhạt" and what stayed as the only way in."""
    counts = {f["recipe_id"]: f for f in feedback}
    names = {i: e.name for i, e in before.elements.items()}

    def describe(rid: str) -> str:
        r, f = before.recipes[rid], counts[rid]
        return f"{names[r.a]} + {names[r.b]} = {names[r.result]} ({f['nhat']}/{f['votes']} phiếu Nhạt)"

    lines = [f'Ẩn do "Nhạt": {describe(rid)}' for rid in result.hidden]
    lines += [f'⚠️ Giữ dù nhiều "Nhạt" (công thức duy nhất tới món): {describe(rid)}' for rid in result.kept]
    return lines
