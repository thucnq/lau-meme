"""What the admin decided about moderated content (ADR 0022), as pure functions over the batch's data.

- `rejected_rows`: concepts blocked this batch, sent back in `rejected` so the admin sees them (AC-MOD-11).
- `unblocked_items`: concepts the admin unblocked, queued first and never moderated again (AC-PIPE-21).
- `apply_edits`: the admin's edits of live elements on every batch, a rename keeping the id (AC-ADMIN-16).
"""

from collections.abc import Mapping, Sequence
from dataclasses import replace

from lau_meme_pipeline.dedupe import dedupe_key
from lau_meme_pipeline.ids import recipe_id
from lau_meme_pipeline.moderation import LABELS
from lau_meme_pipeline.seed import ContentStore
from lau_meme_pipeline.text import fold

MAX_CONTEXT = 500
MAX_SOURCE = 50
MAX_URL = 500
# Worker limits of the published text fields (UTF-16 units, as it counts with `.length`)
TEXT_LIMITS = {"description": 200, "daily_hint": 200, "image_hint": 300}
DESCRIBED = ("emoji", "description", "daily_hint", "image_hint")


def cut(text: str, units: int) -> str:
    """At most `units` UTF-16 code units, never splitting a character."""
    out, used = [], 0
    for ch in text:
        size = 2 if ord(ch) > 0xFFFF else 1
        if used + size > units:
            break
        out.append(ch)
        used += size
    return "".join(out)


def rejected_rows(
    items: Mapping[str, Mapping], reasons: Mapping[str, Sequence[str]], steps: Mapping[str, str]
) -> list[dict]:
    """One row per fold for each blocked key: name, source, context (≤ 500), every reason with its label, the step.
    Public meme content only, never player data (AC-PIPE-13)."""
    by_fold: dict[str, dict] = {}
    for key, codes in reasons.items():
        item = items[key]
        concept = item["concept"]
        described = item.get("described", {})
        row = by_fold.get(fold(concept["name"]))
        if row is None:
            row = {
                "name": concept["name"],
                "fold": fold(concept["name"]),
                "source_name": cut(str(concept.get("source_name") or "?"), MAX_SOURCE),
                "reasons": [],
                "step": steps[key],
            }
            url = str(concept.get("source_url") or "")
            if url.startswith("https://") and len(url) <= MAX_URL:
                row["source_url"] = url
            if concept.get("context"):
                row["context"] = cut(str(concept["context"]), MAX_CONTEXT)
            if described.get("emoji"):
                row["emoji"] = described["emoji"]
            if described.get("description"):
                row["description"] = cut(described["description"], TEXT_LIMITS["description"])
            by_fold[row["fold"]] = row
        for code in codes:
            if all(r["code"] != code for r in row["reasons"]):
                row["reasons"].append({"code": code, "label": LABELS.get(code, code)})
    return [by_fold[f] for f in sorted(by_fold)]


def unblocked_items(rows: Sequence[Mapping], queue: Sequence[Mapping]) -> list[dict]:
    """Queue items for the unblocked rows, oldest first; a row already queued keeps its attempts. The admin's fields
    win over the LLM's; when the admin filled them all, the concept is not described again."""
    queued = {q["key"]: q for q in queue}
    out = []
    for row in rows:
        key = dedupe_key(row["name"])
        admin = {k: row[k] for k in DESCRIBED if row.get(k)}
        item = {
            **{k: v for k, v in queued.get(key, {}).items() if k != "described"},
            "key": key,
            "concept": {
                "name": row["name"],
                "quote": "",
                "context": row.get("context") or "",
                "source_name": row.get("source_name") or "",
                "source_url": row.get("source_url") or "",
            },
            "unblocked": row["id"],
            "admin": admin,
        }
        if len(admin) == len(DESCRIBED):
            item["described"] = dict(admin)
        out.append(item)
    return out


def apply_edits(store: ContentStore, edits: Sequence[Mapping]) -> ContentStore:
    """The admin's edits of elements in `store`; a renamed element keeps its id and the recipes it is an input of
    get the lookup key of the new name, so the graph opens with what the player sees (ADR 0022)."""
    by_id = {e["element_id"]: e for e in edits if e["element_id"] in store.elements}
    if not by_id:
        return store
    elements = dict(store.elements)
    for eid, edit in by_id.items():
        e = elements[eid]
        name = edit.get("name") or e.name
        elements[eid] = replace(
            e,
            name=name,
            fold=fold(name),
            emoji=edit.get("emoji") or e.emoji,
            origin=edit.get("origin") or e.origin,
            image_hint=edit.get("image_hint") or e.image_hint,
        )
    renamed = {eid for eid in by_id if elements[eid].fold != store.elements[eid].fold}
    recipes = dict(store.recipes)
    if renamed:
        recipes = {}
        for r in store.recipes.values():
            if r.a in renamed or r.b in renamed:
                r = replace(r, id=recipe_id(elements[r.a].name, elements[r.b].name))
            recipes[r.id] = r
    return replace(store, elements=elements, recipes=recipes)


def edited_texts(texts: Mapping[str, Mapping], edits: Sequence[Mapping]) -> dict[str, dict]:
    """Description, Daily hint and image hint per element id: the pipeline's, with the admin's on top, cut to the
    Worker's limits; empty values are left out."""
    out: dict[str, dict] = {eid: dict(t) for eid, t in texts.items()}
    for edit in edits:
        out.setdefault(edit["element_id"], {}).update({k: edit[k] for k in TEXT_LIMITS if edit.get(k)})
    return {
        eid: {k: cut(str(t[k]), n) for k, n in TEXT_LIMITS.items() if t.get(k)}
        for eid, t in out.items()
        if any(t.get(k) for k in TEXT_LIMITS)
    }


def applied_revs(store: ContentStore, edits: Sequence[Mapping]) -> list[dict]:
    """`element_edits_applied`: the rev of every edit of an element this batch published."""
    return [{"element_id": e["element_id"], "rev": e["rev"]} for e in edits if e["element_id"] in store.elements]
