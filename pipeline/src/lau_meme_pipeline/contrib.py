"""Approved meme contributions (CONTRIB, ADR 0013) joined into the content of the next batch.

Pure: the rows come from `/pipeline/state.contributions` (game content only - no description, image link, account or
nickname, AC-CONTRIB-09). Depth comes from BFS like every other element; a contribution whose parent is not active
stays out of the graph until the parent is active again (AC-CONTRIB-08).
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace

from lau_meme_pipeline.ids import element_id, recipe_id
from lau_meme_pipeline.linking import Graph, bfs_depths
from lau_meme_pipeline.seed import ACTIVE, INACTIVE, ContentStore, StoredElement, StoredRecipe
from lau_meme_pipeline.text import fold

CONTRIB = "contrib"
DEFAULT_EMOJI = "🍲"


@dataclass(frozen=True)
class Joined:
    store: ContentStore
    waiting: int  # approved contributions not in this graph (AC-CONTRIB-08, batch report)


def _graph(store: ContentStore, blocked: frozenset[str]) -> Graph:
    return Graph(
        starters=tuple(store.starters),
        elements={e.id: e.name for e in store.elements.values()},
        recipes={tuple(sorted((r.a, r.b))): r.result for r in store.recipes.values() if r.status == ACTIVE},
        inactive=blocked | frozenset(e.id for e in store.elements.values() if e.status != ACTIVE),
    )


def add_contributions(
    store: ContentStore,
    rows: Iterable[Mapping],
    *,
    version: int,
    first_versions: Mapping[str, int],
    blocked: frozenset[str] = frozenset(),
) -> Joined:
    """Each approved row becomes an element and the recipe of its pair; a row already joined by an earlier batch is
    joined again (it may be back from waiting). A row whose pair or name is taken by something else is skipped, and
    one whose parent is not active stays in the store inactive; both count as waiting."""
    elements = dict(store.elements)
    recipes = dict(store.recipes)
    added: list[tuple[str, str]] = []
    waiting = 0
    for row in rows:
        eid = element_id(row["name"])
        a, b = elements.get(row["a"]), elements.get(row["b"])
        if a is None or b is None:
            waiting += 1
            continue
        rid = recipe_id(a.name, b.name)
        own = rid in recipes and recipes[rid].result == eid
        if (rid in recipes or eid in elements) and not own:
            waiting += 1
            continue
        emoji = row.get("emoji") or DEFAULT_EMOJI
        hint = row.get("image_hint") or ""
        previous = elements.get(eid)
        elements[eid] = (
            replace(previous, name=row["name"], fold=fold(row["name"]), emoji=emoji, image_hint=hint, status=ACTIVE)
            if previous
            else StoredElement(
                id=eid,
                name=row["name"],
                fold=fold(row["name"]),
                emoji=emoji,
                origin="vn",
                depth=0,
                image_hint=hint,
                batch=str(first_versions.get(eid, version)),
                status=ACTIVE,
            )
        )
        x, y = sorted((a.id, b.id))
        recipes[rid] = StoredRecipe(id=rid, a=x, b=y, result=eid, batch=CONTRIB, status=ACTIVE)
        added.append((eid, rid))
    joined = replace(store, elements=elements, recipes=recipes)
    if not added:
        return Joined(joined, waiting)
    depths = bfs_depths(_graph(joined, blocked))
    for eid, rid in added:
        if eid in depths:
            elements[eid] = replace(elements[eid], depth=depths[eid])
        else:
            elements[eid] = replace(elements[eid], status=INACTIVE)
            recipes[rid] = replace(recipes[rid], status=INACTIVE)
            waiting += 1
    return Joined(replace(joined, elements=elements, recipes=recipes), waiting)
