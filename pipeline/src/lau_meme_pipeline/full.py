"""Full batch (phase 2): crawl → dedupe → describe → moderate → link → judge → supplement → BFS → Daily → graph.

Pure: crawl results, LLM steps, the store from the previous batch and the batch time are passed in; the new store
comes out (ADR 0009). Every LLM answer goes through a per-batch cache, so re-running the same batch with the store
it wrote gives byte-identical output without calling the LLM again (AC-PIPE-10, AC-INV-05).
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone

from lau_meme_pipeline.art import ArtItem, ArtResult, apply_images, order_for_drawing
from lau_meme_pipeline.contrib import add_contributions
from lau_meme_pipeline.crawl import CrawlResult, crawl_report_line
from lau_meme_pipeline.daily import build_daily_block, select_daily
from lau_meme_pipeline.dedupe import dedupe, dedupe_key
from lau_meme_pipeline.graph import build_manifest, export_graph
from lau_meme_pipeline.ids import element_id, recipe_id
from lau_meme_pipeline.invariants import check_all, miss_rate_warning, simulate_miss_rate
from lau_meme_pipeline.judge import judge
from lau_meme_pipeline.linking import (
    Graph,
    bfs_depths,
    needs_supplement,
    simulate_plate,
    supplement_pairs,
    validate_links,
)
from lau_meme_pipeline.linkqueue import next_queue
from lau_meme_pipeline.llm import CachedLlm, QuotaExhausted
from lau_meme_pipeline.moderation import Concept, ModLists, is_held, moderate
from lau_meme_pipeline.seed import ACTIVE, CLASSIC, INACTIVE, ContentStore, StoredElement, StoredRecipe, load_core
from lau_meme_pipeline.text import fold
from lau_meme_pipeline.tier import apply_tiers

GMT7 = timezone(timedelta(hours=7))
MAX_ART_ATTEMPTS = 3  # batches an element may fail with transient errors before it keeps its emoji (ADR 0012)
MAX_ART_PENDING = 2000  # stored backlog; anything beyond is found again from the store (ADR 0009 row size)
MAX_NAME = 100  # D1/Worker limit of element name and fold (UTF-16 units, as the Worker counts)
MAX_EMOJI = 16
TREND = "trend"
# Where a source's memes come from (D1 element.origin).
ORIGIN_BY_SOURCE = {"Google Trends VN": "vn", "YouTube": "vn", "RSS": "vn", "Reddit": "intl", "Know Your Meme": "intl"}


@dataclass
class FullOutcome:
    graph: dict
    manifest: dict
    store: dict
    report: dict = field(default_factory=dict)
    content: ContentStore | None = None  # what was exported, for the publish body (batch._content)
    daily_element_id: str | None = None
    new_aliases: frozenset[str] = frozenset()  # MOD aliases found this batch (AC-MOD-06)


def _units(text: str) -> int:
    """Length as JavaScript counts it (UTF-16 code units): the Worker validates with `.length`."""
    return len(text.encode("utf-16-le")) // 2


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
            image_key=e.get("image_key"),
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
    draw: Callable[[list[ArtItem]], ArtResult] | None = None,
    tiers: Sequence[Mapping] = (),
    contributions: Sequence[Mapping] = (),
    first_versions: Mapping[str, int] | None = None,
) -> FullOutcome:
    version = _version(batch_at)
    batch_date: date = batch_at.astimezone(GMT7).date()
    used: dict = {}
    quota = {"hit": False}
    cache = CachedLlm(lambda step, payload: llm[step](payload), dict(store.get("llm_cache", {})))

    def ask(step: str, payload: object) -> object:
        try:
            answer = cache.ask(step, payload)
        except QuotaExhausted:
            if step == "classify":
                raise  # moderation queues the rest itself (AC-PIPE-12)
            # Any other step: no answer, never cached; what it would have added waits in the queue.
            quota["hit"] = True
            return {} if step == "judge" else []
        quota["hit"] = quota["hit"] or cache.quota_hit
        key = CachedLlm.key(step, payload)
        if key in cache.cache:  # a partial answer is not cached, so the next batch asks again
            used[key] = answer  # the new store keeps only this batch's answers
        return answer

    content = _combined(core, store)
    trend: dict[str, dict] = {e["id"]: dict(e) for e in store.get("elements", [])}
    trend_recipes: dict[str, dict] = {r["id"]: dict(r) for r in store.get("recipes", [])}
    report: dict = {"crawl": crawl_report_line(crawl_result)}

    # 1. Dedupe this batch's crawl against everything known (queued memes were deduped when they came in).
    queue = [dict(q) for q in store.get("queue", [])]
    known_names = [e.name for e in content.elements.values()] + [q["concept"]["name"] for q in queue]
    deduped = dedupe(crawl_result.concepts, known_names, lambda items: ask("same", items))
    too_long = [c for c in deduped.kept if _units(c.name) > MAX_NAME or _units(fold(c.name)) > MAX_NAME]
    report["dedupe"] = {"kept": len(deduped.kept) - len(too_long), "dropped": len(deduped.dropped)}
    if too_long:  # the Worker would refuse the whole batch for one long title (AC-PIPE-11)
        report["dedupe"]["too_long"] = len(too_long)
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
        if c not in too_long
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
            answer = by_key.get(i["key"])
            if not isinstance(answer, Mapping) or not 1 <= _units(str(answer.get("emoji", ""))) <= MAX_EMOJI:
                continue  # no usable answer (quota, truncated, bad emoji): described again next batch, from the queue
            i["described"] = {k: str(answer.get(k, "")) for k in ("emoji", "description", "daily_hint", "image_hint")}

    # 3. Moderate.
    concepts = [_concept_from(i, i.get("described", {})) for i in items]
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
    for p in moderated.passed:
        if not p.concept.emoji:  # not described this batch: never dropped silently, it waits in the queue
            item = by_key_item[p.concept.key]
            unlinked.append({**item, "reason": "quota"} if quota["hit"] else item)
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
    taken: set[str] = set()
    for r in judged.kept:
        # Two memes of this batch may get the same pair: the first keeps it, the other must not overwrite it and
        # lose its meme (AC-INV-02); without another recipe that meme goes back to the queue.
        if r["id"] in taken:
            continue
        taken.add(r["id"])
        kept_by_key.setdefault(r["key"], []).append(r)
    for p in passed:
        recipes_for = kept_by_key.get(p.concept.key, [])
        if not recipes_for:
            item = by_key_item[p.concept.key]
            unlinked.append({**item, "reason": "quota"} if quota["hit"] else item)
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
    report["quota"] = bool(moderated.queued) or quota["hit"]

    # 5b. Supplementary recipes (AC-PIPE-08): needy elements first, then the pairs most often on the plate together.
    asked_in = {(p[0], p[1]) for p in store.get("asked_pairs", [])}
    graph = _graph(_combined(core, _store_of(trend, trend_recipes)), frozenset(blocked))
    before = simulate_plate(graph)
    supplemented = _supplement(graph, before.presence, asked_in, ask)
    for r in supplemented.kept:
        trend_recipes[r["id"]] = {
            "id": r["id"],
            "a": r["a_id"],
            "b": r["b_id"],
            "result": r["result_id"],
            "score": r["score"],
            "supplement": True,
        }
    report["supplement"] = {
        "needed": 0,  # needed and miss_after are filled in after BFS below
        "asked": supplemented.asked,
        "added": len(supplemented.kept),
        "miss_before": [before.first20, before.overall],
        "miss_after": None,
    }

    # 6. Depth by BFS over everything; trend elements that lost every path are inactive (AC-INV-03).
    out_store = _store_of(trend, trend_recipes)
    content = _combined(core, out_store)
    # Approved contributions live in D1, not in the store (ADR 0013); the BFS below sets their depth.
    joined = add_contributions(
        content, contributions, version=version, first_versions=first_versions or {}, blocked=frozenset(blocked)
    )
    content = joined.store
    report["contributions_waiting"] = joined.waiting
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
    report["supplement"]["needed"] = report["supplement_needed"]
    after = simulate_plate(_graph(content, frozenset(blocked)))  # same graph as the exported one (AC-INV-12)
    report["supplement"]["miss_after"] = [after.first20, after.overall]

    # 6b. Illustrations (ADR 0012, AC-ART-01..04): `draw` holds the network side; without it nothing is tracked.
    if draw is not None:
        content = _illustrate(content, out_store, store.get("art_pending", []), blocked, version, draw, report)

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

    content = apply_tiers(content, tiers)
    graph_out = export_graph(content, version)
    manifest = build_manifest(content, version=version, batch_at=batch_at, daily=daily, previous_version=None)
    check_all(graph_out, manifest, content, lists)  # raises InvariantError: nothing of this batch is published
    try:  # warns only (AC-INV-12): a failing simulation never fails the batch
        report["miss_rate"] = list(simulate_miss_rate(graph_out, manifest["starters"]))
        report["miss_rate_warning"] = miss_rate_warning(*report["miss_rate"])
    except Exception as exc:
        report["miss_rate"], report["miss_rate_warning"] = None, f"Không chạy được mô phỏng: {type(exc).__name__}"
    out_store["queue"] = q.queue
    out_store["asked_pairs"] = [list(p) for p in sorted(asked_in | supplemented.rejected)]
    out_store["llm_cache"] = {k: used[k] for k in sorted(used)}
    report["quota"] = report["quota"] or quota["hit"]  # supplement steps may hit it too
    return FullOutcome(
        graph=graph_out,
        manifest=manifest,
        store=out_store,
        report=report,
        content=content,
        daily_element_id=chosen["element_id"],
        new_aliases=moderated.new_aliases,
    )


def _illustrate(
    content: ContentStore,
    out_store: dict,
    waiting: Sequence[str],
    blocked: frozenset[str],
    version: int,
    draw: Callable[[list[ArtItem]], ArtResult],
    report: dict,
) -> ContentStore:
    """Elements waiting from earlier batches first, then this batch's, then older ones never drawn (AC-ART-03).
    An element whose draws were refused, whose hint failed moderation, or that kept failing for MAX_ART_ATTEMPTS
    batches keeps its emoji for good (AC-ART-02). One with no hint yet is only skipped: a later hint is drawn."""
    trend = {e["id"]: e for e in out_store["elements"]}

    def drawable(eid: str) -> bool:
        e, el = trend.get(eid), content.elements.get(eid)
        return (
            e is not None
            and el is not None
            and el.status == ACTIVE
            and eid not in blocked
            and not e.get("image_key")
            and not e.get("image_fallback")
        )

    def item(eid: str) -> ArtItem:
        e = trend[eid]
        return ArtItem(eid, e["name"], e.get("image_hint", "") if e.get("image_hint_ok", True) else "")

    first = [eid for eid in dict.fromkeys(waiting) if drawable(eid)]
    rest = sorted(
        (e for e in out_store["elements"] if drawable(e["id"]) and e["id"] not in first),
        key=lambda e: (e.get("added_version") != version, e["id"]),
    )
    art = draw(order_for_drawing([item(i) for i in first], [item(e["id"]) for e in rest]))
    for eid, key in art.images.items():
        trend[eid]["image_key"] = key
    pending = list(art.pending)
    gave_up = []
    # An error counts against an element only when drawing worked for something else in this batch; otherwise it
    # is an outage (network, Worker, credentials) and holding it against the elements would lose their images.
    progress = bool(art.images or art.rejections or art.errors.get("draw_rejected") or art.errors.get("decode_error"))
    for eid in art.errored if progress else []:
        trend[eid]["art_attempts"] = trend[eid].get("art_attempts", 0) + 1
        if trend[eid]["art_attempts"] >= MAX_ART_ATTEMPTS:
            gave_up.append(eid)
    pending = [eid for eid in pending if eid not in gave_up]
    for eid in [*art.fallback, *gave_up]:
        e = trend[eid]
        if e.get("image_hint", "").strip() or not e.get("image_hint_ok", True) or eid in gave_up:
            e["image_fallback"] = True
    out_store["art_pending"] = pending[:MAX_ART_PENDING]
    report["art"] = {
        "drawn": len(art.images),
        "fallback": len(art.fallback) - len(art.skipped) + len(gave_up),
        "pending": len(pending),
        "draws": art.draws,
        "rejections": dict(sorted(art.rejections.items())),
        "errors": dict(sorted(art.errors.items())),
        "config_error": art.config_error,
    }
    return apply_images(content, art.images)


def _store_of(trend: Mapping[str, dict], trend_recipes: Mapping[str, dict]) -> dict:
    return {
        "elements": [trend[k] for k in sorted(trend)],
        "recipes": [trend_recipes[k] for k in sorted(trend_recipes)],
    }


@dataclass
class _Supplemented:
    kept: list[dict]
    rejected: set[tuple[str, str]]  # asked and not added: never asked again
    asked: int  # pairs the LLM answered (both steps)


def _supplement(
    graph: Graph, presence: Mapping[str, int], asked_before: set[tuple[str, str]], ask: Callable
) -> _Supplemented:
    """Both supplement steps share the rules of the link step: the result is an existing active element, the pair
    passes validate_links, then one judge call keeps scores >= 3 (AC-PIPE-08/09)."""
    by_fold = {fold(n): e for e, n in graph.elements.items() if e not in graph.inactive}
    proposed: dict[tuple[str, str], dict] = {}
    rejected: set[tuple[str, str]] = set()

    asked: set[tuple[str, str]] = set()  # pairs the LLM actually answered this batch

    def propose(a: str, b: str, result_name: object, owner: str | None) -> None:
        """Only an answered pair gets here. "Không hợp" (no result), a result that is not an active element and a
        result that is one of the inputs are the LLM's verdict: recorded, never asked again. A pair that already
        has a recipe or has an unusable input says nothing about the LLM's answer: skipped, not recorded."""
        pair = (a, b) if a <= b else (b, a)
        if pair in proposed or pair in asked_before or pair in asked:
            return
        asked.add(pair)
        result_id = by_fold.get(fold(result_name)) if isinstance(result_name, str) else None
        if result_id is None or result_id in pair:
            rejected.add(pair)
            return
        if not validate_links(result_id, [pair], graph).accepted:
            return
        names = (graph.elements[pair[0]], graph.elements[pair[1]])
        proposed[pair] = {
            "id": recipe_id(*names),
            "a": names[0],
            "b": names[1],
            "result": graph.elements[result_id],
            "a_id": pair[0],
            "b_id": pair[1],
            "result_id": result_id,
            "owner": owner,
        }

    # Step 1: elements used as an input by fewer than 3 recipes.
    out_count = {e: 0 for e in graph.elements if e not in graph.inactive}
    for pair in graph.recipes:
        for x in set(pair):
            if x in out_count:
                out_count[x] += 1
    needy = sorted(needs_supplement(graph), key=lambda e: graph.elements[e])
    need = {e: 3 - out_count[e] for e in needy}
    if needy:
        candidates = sorted(graph.elements[e] for e in out_count)
        answers = ask(
            "supplement_element",
            [{"name": graph.elements[e], "need": need[e], "candidates": candidates} for e in needy],
        )
        for item in answers if isinstance(answers, list) else []:
            owner = by_fold.get(fold(item.get("name", ""))) if isinstance(item, Mapping) else None
            if owner not in need:
                continue
            for r in item.get("recipes") or []:
                if not isinstance(r, Mapping) or not isinstance(r.get("with"), str):
                    continue
                partner = by_fold.get(fold(r["with"]))
                if partner is not None:
                    propose(owner, partner, r.get("result"), owner)

    # Step 2: pairs most often on the plate together that still have no recipe.
    pairs = supplement_pairs(graph, presence, asked=asked_before | asked)
    if pairs:
        answers = ask("supplement_pair", [{"a": graph.elements[a], "b": graph.elements[b]} for a, b in pairs])
        result_of = {}
        for item in answers if isinstance(answers, list) else []:
            if isinstance(item, Mapping) and isinstance(item.get("a"), str) and isinstance(item.get("b"), str):
                result_of[frozenset((fold(item["a"]), fold(item["b"])))] = item.get("result")
        for a, b in pairs:
            key = frozenset((fold(graph.elements[a]), fold(graph.elements[b])))
            if key in result_of:  # an unanswered pair (truncated or garbled answer) stays askable
                propose(a, b, result_of[key], None)

    candidates_judged = list(proposed.values())
    scores = (
        ask("judge", [{k: r[k] for k in ("id", "a", "b", "result")} for r in candidates_judged])
        if candidates_judged
        else {}
    )
    judged = judge(candidates_judged, scores if isinstance(scores, Mapping) else {})
    kept: list[dict] = []
    for r in judged.kept:
        owner = r["owner"]
        if owner is not None:
            if need[owner] <= 0:
                # Enough for this element: neither kept nor recorded, so a later batch may ask the pair again
                # (it was judged once already; the pair step skipped it this batch).
                continue
            need[owner] -= 1
        kept.append(r)
    kept_pairs = {(r["a_id"], r["b_id"]) for r in kept}
    rejected |= {(r["a_id"], r["b_id"]) for r in candidates_judged if r["id"] in judged.rejected}
    return _Supplemented(kept=kept, rejected=rejected - kept_pairs, asked=len(asked))


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
