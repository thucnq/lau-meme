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
    """Each approved row becomes an element (tier 1 unless `tiers` says otherwise) and the recipe of its pair.
    A row whose pair is already taken or whose name is already an element is skipped and counted as waiting."""
    elements = dict(store.elements)
    recipes = dict(store.recipes)
    added: list[str] = []
    waiting = 0
    for row in rows:
        eid = element_id(row["name"])
        a, b = elements.get(row["a"]), elements.get(row["b"])
        if eid in elements or a is None or b is None:
            waiting += 1
            continue
        rid = recipe_id(a.name, b.name)
        if rid in recipes:
            waiting += 1
            continue
        elements[eid] = StoredElement(
            id=eid,
            name=row["name"],
            fold=fold(row["name"]),
            emoji=row.get("emoji") or DEFAULT_EMOJI,
            origin="vn",
            depth=0,
            image_hint=row.get("image_hint") or "",
            batch=str(first_versions.get(eid, version)),
            status=ACTIVE,
        )
        x, y = sorted((a.id, b.id))
        recipes[rid] = StoredRecipe(id=rid, a=x, b=y, result=eid, batch=CONTRIB, status=ACTIVE)
        added.append(eid)
    joined = replace(store, elements=elements, recipes=recipes)
    if not added:
        return Joined(joined, waiting)
    depths = bfs_depths(_graph(joined, blocked))
    for eid in added:
        if eid in depths:
            elements[eid] = replace(elements[eid], depth=depths[eid])
        else:
            elements[eid] = replace(elements[eid], status=INACTIVE)
            waiting += 1
    return Joined(replace(joined, elements=elements), waiting)
