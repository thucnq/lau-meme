"""Full batch (phase 2): crawl → dedupe → describe → moderate → link → judge → BFS → Daily → graph + manifest.

Pure: crawl results, LLM steps, the store from the previous batch and the batch time are passed in; the new store
comes out (ADR 0009). Every LLM answer goes through a per-batch cache, so re-running the same batch with the store
it wrote gives byte-identical output without calling the LLM again (AC-PIPE-10, AC-INV-05).
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone

from lau_meme_pipeline.crawl import CrawlResult, crawl_report_line
from lau_meme_pipeline.daily import build_daily_block, select_daily
from lau_meme_pipeline.dedupe import dedupe, dedupe_key
from lau_meme_pipeline.graph import build_manifest, export_graph
from lau_meme_pipeline.ids import element_id, recipe_id
from lau_meme_pipeline.judge import judge
from lau_meme_pipeline.linking import Graph, bfs_depths, needs_supplement, validate_links
from lau_meme_pipeline.linkqueue import next_queue
from lau_meme_pipeline.llm import CachedLlm
from lau_meme_pipeline.moderation import Concept, ModLists, is_held, moderate
from lau_meme_pipeline.seed import ACTIVE, CLASSIC, ContentStore, StoredElement, StoredRecipe, load_core
from lau_meme_pipeline.text import fold

GMT7 = timezone(timedelta(hours=7))
TREND = "trend"
INACTIVE = "inactive"
# Where a source's memes come from (D1 element.origin).
ORIGIN_BY_SOURCE = {"Google Trends VN": "vn", "YouTube": "vn", "RSS": "vn", "Reddit": "intl", "Know Your Meme": "intl"}


@dataclass
class FullOutcome:
    graph: dict
    manifest: dict
    store: dict
    report: dict = field(default_factory=dict)


def _version(batch_at: datetime) -> int:
    return int(batch_at.astimezone(GMT7).strftime("%Y%m%d%H%M"))  # ADR 0006, same as batch.version_for


def _combined(core: Mapping, store: Mapping) -> ContentStore:
    """Core classic content plus the trend elements and recipes kept in the store."""
    base = load_core(core, ContentStore.empty()).store
    elements = dict(base.elements)
    recipes = dict(base.recipes)
    for e in store.get("elements", []):
        elements[e["id"]] = StoredElement(
            id=e["id"],
            name=e["name"],
            fold=fold(e["name"]),
            emoji=e["emoji"],
            origin=e.get("origin", "vn"),
            depth=e.get("depth", 0),
            image_hint=e.get("image_hint", "") if e.get("image_hint_ok", True) else "",
            batch=str(e["added_version"]),
            status=ACTIVE,
        )
    for r in store.get("recipes", []):
        recipes[r["id"]] = StoredRecipe(id=r["id"], a=r["a"], b=r["b"], result=r["result"], batch=TREND, status=ACTIVE)
    return replace(base, elements=elements, recipes=recipes)


def _graph(content: ContentStore, inactive: frozenset[str] = frozenset()) -> Graph:
    pairs = {tuple(sorted((r.a, r.b))): r.result for r in content.recipes.values() if r.status == ACTIVE}
    return Graph(
        starters=tuple(content.starters),
        elements={e.id: e.name for e in content.elements.values()},
        recipes=pairs,
        inactive=inactive | frozenset(e.id for e in content.elements.values() if e.status != ACTIVE),
    )


def _concept_from(item: Mapping, described: Mapping) -> Concept:
    raw = item["concept"]
    return Concept(
        key=item["key"],
        name=raw["name"],
        emoji=described.get("emoji", ""),
        description=described.get("description", ""),
        daily_hint=described.get("daily_hint", ""),
        image_hint=described.get("image_hint", ""),
        context=raw.get("context", ""),
        source_name=raw.get("source_name", ""),
    )


def run_full(
    core: Mapping,
    store: Mapping,
    crawl_result: CrawlResult,
    llm: Mapping[str, Callable],
    batch_at: datetime,
    lists: ModLists,
    *,
    blocked: frozenset[str] = frozenset(),
    daily_history: Sequence[Mapping] = (),
) -> FullOutcome:
    version = _version(batch_at)
    batch_date: date = batch_at.astimezone(GMT7).date()
    used: dict = {}
    cache = CachedLlm(lambda step, payload: llm[step](payload), dict(store.get("llm_cache", {})))

    def ask(step: str, payload: object) -> object:
        answer = cache.ask(step, payload)
        used[CachedLlm.key(step, payload)] = answer  # the new store keeps only this batch's answers
        return answer

    content = _combined(core, store)
    trend: dict[str, dict] = {e["id"]: dict(e) for e in store.get("elements", [])}
    trend_recipes: dict[str, dict] = {r["id"]: dict(r) for r in store.get("recipes", [])}
    report: dict = {"crawl": crawl_report_line(crawl_result)}

    # 1. Dedupe this batch's crawl against everything known (queued memes were deduped when they came in).
    queue = [dict(q) for q in store.get("queue", [])]
    known_names = [e.name for e in content.elements.values()] + [q["concept"]["name"] for q in queue]
    deduped = dedupe(crawl_result.concepts, known_names, lambda items: ask("same", items))
    report["dedupe"] = {"kept": len(deduped.kept), "dropped": len(deduped.dropped)}
    new_items = [
        {
            "key": dedupe_key(c.name),
            "concept": {
                "name": c.name,
                "quote": c.quote,
                "context": c.context,
                "source_name": c.source_name,
                "source_url": c.source_url,
            },
        }
        for c in deduped.kept
    ]
    queued_keys = {q["key"] for q in queue}
    items = [*queue, *[i for i in new_items if i["key"] not in queued_keys]]  # AC-PIPE-07: queue first

    # 2. Describe new memes (emoji, description, hints); queued ones keep what they had.
    to_describe = [i for i in items if "described" not in i]
    if to_describe:
        payload = [
            {k: i["concept"][k] for k in ("name", "quote", "context", "source_name")} | {"key": i["key"]}
            for i in to_describe
        ]
        answers = ask("describe", payload)
        by_key = {a.get("key"): a for a in answers if isinstance(a, Mapping)} if isinstance(answers, list) else {}
        for i in to_describe:
            i["described"] = {
                k: str(by_key.get(i["key"], {}).get(k, ""))
                for k in ("emoji", "description", "daily_hint", "image_hint")
            }

    # 3. Moderate.
    concepts = [_concept_from(i, i["described"]) for i in items]
    moderated = moderate(concepts, lists, lambda reqs: ask("classify", reqs), batch_date)
    report["moderation"] = moderated.counts
    by_key_item = {i["key"]: i for i in items}

    # 4. Link each passed meme to existing elements; 5. judge the new recipes.
    linked: set[str] = set()
    unlinked: list[dict] = []
    graph = _graph(content, frozenset(blocked))
    name_to_id = {fold(e.name): e.id for e in content.elements.values()}
    candidates = sorted(e.name for e in content.elements.values() if e.id not in graph.inactive)
    passed = [p for p in moderated.passed if p.concept.emoji]
    link_answers = (
        ask("link", [{"key": p.concept.key, "name": p.concept.name, "candidates": candidates} for p in passed])
        if passed
        else []
    )
    pairs_by_key = (
        {a.get("key"): a.get("pairs", []) for a in link_answers if isinstance(a, Mapping)}
        if isinstance(link_answers, list)
        else {}
    )
    proposed: list[dict] = []
    for p in passed:
        new_id = element_id(p.concept.name)
        proposals = []
        for pair in pairs_by_key.get(p.concept.key, []) or []:
            if isinstance(pair, list | tuple) and len(pair) == 2 and all(isinstance(x, str) for x in pair):
                proposals.append((name_to_id.get(fold(pair[0]), pair[0]), name_to_id.get(fold(pair[1]), pair[1])))
        checked = validate_links(new_id, proposals, graph)
        for a, b in checked.accepted:
            names = (graph.elements[a], graph.elements[b])
            proposed.append(
                {
                    "id": recipe_id(*names),
                    "a": names[0],
                    "b": names[1],
                    "result": p.concept.name,
                    "key": p.concept.key,
                    "a_id": a,
                    "b_id": b,
                    "result_id": new_id,
                }
            )
    scores = ask("judge", [{k: r[k] for k in ("id", "a", "b", "result")} for r in proposed]) if proposed else {}
    judged = judge(proposed, scores if isinstance(scores, Mapping) else {})
    report["judge"] = {"kept": len(judged.kept), "rejected": len(judged.rejected)}
    kept_by_key: dict[str, list[dict]] = {}
    for r in judged.kept:
        kept_by_key.setdefault(r["key"], []).append(r)
    for p in passed:
        recipes_for = kept_by_key.get(p.concept.key, [])
        if not recipes_for:
            unlinked.append(by_key_item[p.concept.key])
            continue
        linked.add(p.concept.key)
        new_id = recipes_for[0]["result_id"]
        trend[new_id] = {
            "id": new_id,
            "name": p.concept.name,
            "emoji": p.concept.emoji,
            "description": p.concept.description,
            "daily_hint": p.concept.daily_hint if p.hint_ok else "",
            "image_hint": p.concept.image_hint,
            "hint_ok": p.hint_ok,
            "image_hint_ok": p.image_hint_ok,
            "held_until": p.held_until.isoformat() if p.held_until else None,
            "source": by_key_item[p.concept.key]["concept"].get("source_name", ""),
            "origin": ORIGIN_BY_SOURCE.get(by_key_item[p.concept.key]["concept"].get("source_name", ""), "vn"),
            "added_version": version,
        }
        for r in recipes_for:
            trend_recipes[r["id"]] = {
                "id": r["id"],
                "a": r["a_id"],
                "b": r["b_id"],
                "result": new_id,
                "score": r["score"],
            }
    for c in moderated.queued:
        unlinked.append({**by_key_item[c.key], "reason": "quota"})
    q = next_queue(queue, unlinked, linked)
    report["queue"] = {"linked": len(linked), "queued": len(q.queue), "dropped": q.dropped}
    report["quota"] = bool(moderated.queued)

    # 6. Depth by BFS over everything; trend elements that lost every path are inactive (AC-INV-03).
    out_store = {
        "elements": [trend[k] for k in sorted(trend)],
        "recipes": [trend_recipes[k] for k in sorted(trend_recipes)],
    }
    content = _combined(core, out_store)
    depths = bfs_depths(_graph(content, frozenset(blocked)))
    elements = {}
    for eid, e in content.elements.items():
        held = trend.get(eid, {}).get("held_until")
        held_now = is_held(date.fromisoformat(held), batch_date) if held else False
        elements[eid] = replace(
            e,
            depth=depths.get(eid, e.depth),
            status=e.status if eid in depths else INACTIVE,
            batch=CLASSIC if held_now else e.batch,  # no "MỚI" while held (AC-MOD-08)
        )
    content = replace(content, elements=elements)
    for e in out_store["elements"]:
        e["depth"] = depths.get(e["id"], 0)
    report["supplement_needed"] = len(needs_supplement(_graph(content, frozenset(blocked))))

    # 7. Daily: core examples, plus trend elements with an approved hint that are not held.
    candidates_daily = []
    for ex in core.get("daily_examples", []):
        e = content.elements.get(element_id(ex["target"]))
        if e:
            candidates_daily.append(_candidate(e, ex.get("hint"), "classic", 0, False, blocked))
    for t in out_store["elements"]:
        e = content.elements[t["id"]]
        held = is_held(date.fromisoformat(t["held_until"]), batch_date) if t.get("held_until") else False
        if t.get("daily_hint") and t.get("hint_ok", True) and _hint_valid(e, t["daily_hint"]):
            candidates_daily.append(_candidate(e, t["daily_hint"], TREND, t["added_version"], held, blocked))
    history = [{"element_id": h["element_id"], "version": h["version"]} for h in daily_history]
    chosen = select_daily(candidates_daily, history, version)
    daily = build_daily_block(chosen, chosen["hint"])

    graph_out = export_graph(content, version)
    manifest = build_manifest(content, version=version, batch_at=batch_at, daily=daily, previous_version=None)
    out_store["queue"] = q.queue
    out_store["llm_cache"] = {k: used[k] for k in sorted(used)}
    return FullOutcome(graph=graph_out, manifest=manifest, store=out_store, report=report)


def _hint_valid(e: StoredElement, hint: str) -> bool:
    """An LLM hint that gives the name away (or is too long) cannot announce the dish (AC-DAILY-03)."""
    try:
        build_daily_block({"name": e.name, "emoji": e.emoji, "depth": e.depth}, hint)
    except ValueError:
        return False
    return True


def _candidate(
    e: StoredElement, hint: str | None, source: str, added: int, held: bool, blocked: frozenset[str]
) -> dict:
    return {
        "element_id": e.id,
        "name": e.name,
        "emoji": e.emoji,
        "depth": e.depth,
        "active": e.status == ACTIVE and e.id not in blocked,
        "reachable": e.status == ACTIVE,
        "held": held,
        "hint": hint,
        "hint_ok": True,
        "source": source,
        "added_version": added,
    }
