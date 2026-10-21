"""One batch ("mẻ nhúng") end to end (AC-PIPE-01/11/13/14, ADR 0003/0006): `python -m lau_meme_pipeline.batch`.

Phase 1 only runs the core mode: no crawl, no LLM - new Món đặc biệt, graph + manifest of a new version, publish
through the Worker API, report as a GitHub Issue. `run_batch` takes the batch time and every adapter as arguments;
only `main` builds the network adapters.
"""

import argparse
import http.client
import json
import os
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from lau_meme_pipeline.art import ArtAdapters, ArtItem, ArtResult, UploadFailed, draw_images, image_key, to_webp_256
from lau_meme_pipeline.crawl import Http, crawl
from lau_meme_pipeline.daily import build_daily_block, select_daily
from lau_meme_pipeline.full import run_full
from lau_meme_pipeline.graph import build_manifest, decrypt_entry, export_graph
from lau_meme_pipeline.ids import element_id
from lau_meme_pipeline.invariants import InvariantError, check_all, miss_rate_warning, simulate_miss_rate
from lau_meme_pipeline.moderation import QUOTA_LABEL, ModLists
from lau_meme_pipeline.seed import ACTIVE, ContentStore, load_core
from lau_meme_pipeline.text import fold

STEPS = ("state", "seed", "daily", "export", "check", "invariants", "banned", "publish", "report")
GMT7 = timezone(timedelta(hours=7))
TIMEOUT_SECONDS = 30
# AC-PIPE-13: public meme data only - never anything about players. ADR 0009 adds the fields moderation needs; the
# rest are the structure of the steps (element names, recipe ids, counts - ADR 0011).
ALLOWED_LLM_FIELDS = frozenset(
    {"name", "quote", "context", "source_name", "element_name", "image_hint"}
    | {"key", "kind", "emoji", "description", "daily_hint"}
    | {"existing", "candidates", "need", "id", "a", "b", "result"}
)
MAX_TERM = 100  # banned_term.term_fold limit in D1
ART_BUDGET_SECONDS = 8 * 60  # drawing stops in time for the 15-minute batch (ADR 0012); the rest waits
MAX_STORE_BYTES = 1_900_000  # the Worker refuses a bigger pipeline store (one D1 row, ADR 0009)


def version_for(batch_at: datetime) -> int:
    """ADR 0006: the batch time in GMT+7 as YYYYMMDDHHmm - same batch, same version; later batch, larger."""
    if batch_at.tzinfo is None:
        raise ValueError("batch_at phải có múi giờ")
    return int(batch_at.astimezone(GMT7).strftime("%Y%m%d%H%M"))


def build_llm_payload(items: Sequence[Mapping]) -> list[dict]:
    """Every LLM payload (phase 2) goes through here; any field outside the allow-list is refused."""
    out: list[dict] = []
    for item in items:
        if not isinstance(item, Mapping):
            raise ValueError("Mỗi mục gửi LLM phải là object")
        extra = sorted(set(item) - ALLOWED_LLM_FIELDS)
        if extra:
            raise ValueError(f"Trường không được gửi cho LLM: {', '.join(extra)}")
        for field, value in item.items():  # flat values only: a nested object could carry any field
            if field == "candidates":
                if not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
                    raise ValueError("Trường candidates gửi LLM phải là danh sách chuỗi")
            elif not (isinstance(value, str | int | float | bool) or value is None):
                raise ValueError(f"Trường {field} gửi LLM phải là giá trị đơn")
        out.append(dict(item))
    return out


class BatchClient(Protocol):
    def get_state(self) -> dict: ...
    def get_store(self, version: int | None = None) -> dict: ...
    def post_batch(self, body: dict) -> dict: ...
    def patch_batch(self, run_id: str, issue_url: str) -> dict: ...
    def put_banned_terms(self, source: str, terms: list[str]) -> None: ...


class IssueReporter(Protocol):
    def create_issue(self, title: str, body: str) -> str: ...


@dataclass(frozen=True)
class BatchOutcome:
    ok: bool
    status: str
    version: int | None
    failed_step: str | None
    run_id: str | None
    issue_url: str | None
    report_title: str
    report_body: str


def banned_terms(words: Sequence[str]) -> list[str]:
    """Folded, deduplicated, sorted terms for the Worker's nickname filter (ADR 0005); over-long lines are dropped."""
    return sorted({t for t in (fold(w).strip() for w in words) if t and len(t) <= MAX_TERM})


def _iso(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _core_stats() -> dict:
    return {"crawled": 0, "added": 0, "blocked": {}, "queued": 0, "source_errors": [], "quota_used": 0}


def _pick_daily(store: ContentStore, core: Mapping, state: Mapping, version: int) -> dict:
    """Phase 1: only dishes with a hand-written hint in the core's `daily_examples` (open question 17).

    The blocklist only steers this choice: blocked elements/recipes are still published, the Worker's `block`
    table hides them at serve time (ADR 0003). Phase 2 must not assume the pipeline filters them.
    """
    blocked = set(state.get("blocklist", {}).get("elements", []))
    candidates = []
    for example in core.get("daily_examples", []):
        element = store.elements.get(element_id(example["target"]))
        if element is None:
            continue
        candidates.append(
            {
                "element_id": element.id,
                "name": element.name,
                "emoji": element.emoji,
                "depth": element.depth,
                "active": element.status == ACTIVE and element.id not in blocked,
                "reachable": True,  # load_core rejects a core with an unreachable element
                "held": False,  # hot deferral (AC-MOD-08) comes with MOD
                "hint": example.get("hint"),
                "hint_ok": True,  # written by hand in the core, reviewed by a human
                "source": "classic",
                "added_version": 0,
            }
        )
    history = [{"element_id": h["element_id"], "version": h["version"]} for h in state.get("daily_history", [])]
    chosen = select_daily(candidates, history, version)
    return build_daily_block(chosen, chosen["hint"])


def _content(store: ContentStore, daily_id: str) -> dict:
    elements = [store.elements[k] for k in sorted(store.elements) if store.elements[k].status == ACTIVE]
    active = {e.id for e in elements}
    recipes = [
        r
        for r in (store.recipes[k] for k in sorted(store.recipes))
        if r.status == ACTIVE and {r.a, r.b, r.result} <= active
    ]
    return {
        "elements": [
            {"id": e.id, "name": e.name, "fold": e.fold, "emoji": e.emoji, "depth": e.depth, "origin": e.origin}
            | ({"image_key": e.image_key} if e.image_key else {})
            for e in elements
        ],
        "recipes": [{"id": r.id, "a": r.a, "b": r.b, "result": r.result} for r in recipes],
        "starters": list(store.starters),
        "daily_element_id": daily_id,
    }


def _check(store: ContentStore, graph: Mapping, content: Mapping) -> None:
    """Invariants before publishing: every published recipe opens with its input names and gives its result."""
    names = {e.id: e.name for e in store.elements.values()}
    for r in content["recipes"]:
        entry = decrypt_entry(graph, names[r["a"]], names[r["b"]])
        if entry is None or entry["id"] != r["result"]:
            raise ValueError(f"graph không mở được công thức {r['id']}")


def _mod_lists(state: Mapping, banned_words: Sequence[str]) -> ModLists:
    """Layer-1 lists for AC-INV-07. `banned_aliases` is required: it carries the MOD aliases and the names the admin
    blocked (sources `mod` + `admin`), so a state without it must fail rather than check nothing. A term that is
    exactly the name of an element already in the blocklist is skipped: in core mode that element is still published
    and the Worker hides it at serve time (ADR 0003, open question 27)."""
    blocked = set(state["blocklist"]["elements"])
    return ModLists(
        banned_words=frozenset(w for w in banned_words if w.strip()),
        aliases=frozenset(t for t in state["banned_aliases"] if element_id(t) not in blocked),
    )


def _miss_rate(graph: Mapping, starters: Sequence[Mapping], log: Callable[[str], None]) -> tuple[float, float] | None:
    """AC-INV-12 only warns: a failing simulation is logged and never fails the batch."""
    try:
        return simulate_miss_rate(graph, starters)
    except Exception as exc:
        log(f"Không chạy được mô phỏng chơi ngẫu nhiên: {type(exc).__name__}")
        return None


def _render_report(
    *,
    version: int | None,
    batch_at: datetime,
    mode: str,
    failed_step: str | None,
    stats: Mapping,
    emoji: str | None,
    banned_count: int | None = None,
    miss: tuple[float, float] | None = None,
    quota_hit: bool = False,
    store_bytes: int | None = None,
    art_report: Mapping | None = None,
) -> tuple[str, str]:
    """Title shows the dish's emoji only, never its name (AC-PIPE-14)."""
    status = "error" if failed_step else "success"
    shown = str(version) if version is not None else "-"
    title = f"Mẻ nhúng v{shown} · {mode} · {status}"
    if emoji:
        title += f" · Món đặc biệt {emoji}"
    blocked = stats.get("blocked") or {}
    errors = stats.get("source_errors") or []
    lines = [
        f"- Version: {shown}",
        f"- batch_at: {_iso(batch_at)}",
        f"- Chế độ: {mode}",
        f"- Trạng thái: {status}",
    ]
    if failed_step:
        lines.append(f"- Bước lỗi: {failed_step} - bản hiện hành giữ nguyên")
    lines += [
        # Labels are the stats keys of the batch log (BatchStats), so the Issue reads like the admin page.
        f"- crawled: {stats.get('crawled', 0)} · added: {stats.get('added', 0)} · queued: {stats.get('queued', 0)}",
        "- blocked: " + (", ".join(f"{k} {v}" for k, v in sorted(blocked.items())) or "0"),
        "- Lỗi nguồn: " + (", ".join(f"{e.get('source')}: lỗi {e.get('error')}" for e in errors) or "không có"),
        f"- quota: {stats.get('quota_used', 0)} lượt gọi Gemini",
        *(["- ⚠️ Gemini hết quota: phần chưa xử lý nằm trong hàng chờ, đợt sau làm tiếp"] if quota_hit else []),
        *(
            [f"- Kho pipeline: {store_bytes // 1024} KB / {MAX_STORE_BYTES // 1024} KB"]
            if store_bytes is not None
            else []
        ),
        *_art_lines(art_report),
        f"- Món đặc biệt: {emoji or '-'}",
    ]
    # Only the count: the words themselves are secret (ADR 0005).
    if banned_count == 0:
        lines.append("- ⚠️ BANNED_WORDS trống - bộ lọc nickname chưa có từ cấm (đặt GitHub Secret, xem runbook)")
    elif banned_count is not None:
        lines.append(f"- Từ cấm nickname: {banned_count} từ đã đồng bộ")
    if miss is not None:
        lines.append(f"- Chơi ngẫu nhiên: trượt {miss[0]:.0%} ở 20 lượt đầu, {miss[1]:.0%} cả ván")
        warning = miss_rate_warning(*miss)
        if warning:
            lines.append(f"- {warning}")
    lines += [
        "- METRIC: chưa có số liệu (tính năng METRIC chưa làm)",
    ]
    return title, "\n".join(lines) + "\n"


class _CountedLlm(Mapping[str, Callable]):
    """Counts step calls (cache misses): the report's quota when the adapter does not count requests itself."""

    def __init__(self, llm: Mapping[str, Callable]) -> None:
        self._llm = llm
        self.n = 0

    def __getitem__(self, step: str) -> Callable:
        fn = self._llm[step]

        def call(payload: object) -> object:
            self.n += 1
            return fn(payload)

        return call

    def __iter__(self):
        return iter(self._llm)

    def __len__(self) -> int:
        return len(self._llm)

    def used(self, llm: object) -> int:
        calls = getattr(llm, "calls", None)
        return calls if isinstance(calls, int) else self.n


def _art_lines(report: Mapping | None) -> list[str]:
    """AC-ART-02/03: drawn, emoji fallbacks, waiting, rejections by reason (ADR 0012)."""
    if report is None:
        return []
    calls = f" · {report['calls']} lượt gọi Workers AI" if report.get("calls") is not None else ""
    lines = [
        f"- Ảnh: vẽ được {report['drawn']} · về emoji {report['fallback']} · chờ vẽ {report['pending']}"
        f" · {report['draws']} lần vẽ{calls}"
    ]
    if report.get("rejections"):
        lines.append("- Ảnh bị loại: " + ", ".join(f"{k} {v}" for k, v in report["rejections"].items()))
    if report.get("errors"):
        lines.append("- Ảnh lỗi: " + ", ".join(f"{k} {v}" for k, v in report["errors"].items()))
    if report.get("missing"):
        lines.append("- ⚠️ Chưa vẽ ảnh: thiếu WORKERS_AI_TOKEN / CLOUDFLARE_ACCOUNT_ID (ADR 0012), phần tử mới chờ vẽ")
    return lines


def _drawer(art: ArtAdapters | None, client: BatchClient) -> Callable[[list[ArtItem]], ArtResult]:
    """The `draw` of run_full (ADR 0012). Without adapters nothing is drawn and every element with a hint waits."""

    def save(webp: bytes) -> str:
        key = image_key(webp)  # already encoded by `to_webp_256`, the bytes the check saw
        try:
            if not client.image_exists(key):
                client.put_image(key, webp)
        except Exception as exc:
            raise UploadFailed(type(exc).__name__) from None
        return key

    if art is None:
        return lambda items: ArtResult(
            fallback=[i.id for i in items if not i.image_hint.strip()],
            pending=[i.id for i in items if i.image_hint.strip()],
        )

    def draw(items: list[ArtItem]) -> ArtResult:
        deadline = time.monotonic() + ART_BUDGET_SECONDS
        return draw_images(
            items, art.generate, art.check, save, encode=to_webp_256, deadline=deadline, clock=time.monotonic
        )

    return draw


def _send_aliases(client: BatchClient, state: Mapping, new_aliases: frozenset[str], log: Callable[[str], None]) -> None:
    """AC-MOD-06, after a successful publish only: a discarded batch never changes the alias list. The `mod` source
    is replaced whole, so the old aliases go with the new. A failure is logged; the next full batch sends them
    again, if it crawls them again (the classify answer is cached)."""
    if not new_aliases:
        return
    admin = set(state.get("admin_blocked", []))
    mod = {t for t in state["banned_aliases"] if t not in admin} | set(new_aliases)
    try:
        client.put_banned_terms("mod", sorted(t for t in mod if len(t) <= MAX_TERM))
    except Exception as exc:
        log(f"Không gửi được bí danh MOD: {type(exc).__name__}")


def run_batch(
    *,
    mode: str,
    batch_at: datetime,
    core: Mapping,
    client: BatchClient,
    reporter: IssueReporter,
    adapters: Sequence = (),
    crawl_http: Http | None = None,
    llm: Mapping[str, Callable] | None = None,
    log: Callable[[str], None] = print,
    banned_words: Sequence[str] = (),
    art: ArtAdapters | None = None,
) -> BatchOutcome:
    """Run one batch. Never raises: a failure posts an error run, keeps the current version and is reported.
    The core mode never touches `adapters`, `crawl_http` or `llm` (AC-PIPE-01); the full mode (ADR 0009) crawls,
    asks the LLM through `full.run_full` and publishes the new pipeline store with the version."""
    stats = _core_stats()
    counted = _CountedLlm(llm if mode == "full" and llm is not None else {})  # core never touches llm (AC-PIPE-01)
    quota_hit = False
    store_out: dict | None = None
    new_aliases: frozenset[str] = frozenset()
    store_bytes: int | None = None
    art_report: dict | None = None
    version: int | None = None
    emoji: str | None = None
    run_id: str | None = None
    failed_step: str | None = None
    banned_count: int | None = None
    miss: tuple[float, float] | None = None
    step = "state"
    try:
        if mode not in ("core", "full"):
            raise ValueError(f"chế độ {mode!r} không có (core hoặc full)")
        version = version_for(batch_at)
        if mode == "full":
            step = "llm"
            if llm is None or crawl_http is None:
                raise ValueError("mode full cần GEMINI_API_KEY (ADR 0011)")
            step = "state"
        state = client.get_state()
        if mode == "full":
            step = "store"
            previous = client.get_store()
            step = "seed"
            load_core(core, ContentStore.empty())  # a broken core fails here, before any crawl or LLM call
            step = "crawl"
            crawled = crawl(adapters, crawl_http)
            stats["crawled"] = len(crawled.concepts)
            stats["source_errors"] = [{"source": e["source"], "error": e["error"]} for e in crawled.errors]
            step = "full"
            lists = replace(_mod_lists(state, banned_words), admin_blocked=frozenset(state.get("admin_blocked", [])))
            full = run_full(
                core,
                previous,
                crawled,
                counted,
                batch_at,
                lists,
                blocked=frozenset(state["blocklist"]["elements"]),
                daily_history=state.get("daily_history", []),
                draw=_drawer(art, client),
            )
            store = full.content
            graph, manifest, store_out = full.graph, full.manifest, full.store
            emoji = manifest["daily"]["emoji"]
            quota_hit = bool(full.report.get("quota"))
            art_report = full.report.get("art")
            if art_report is not None:
                art_report = {
                    **art_report,
                    "missing": art is None,
                    "calls": getattr(art and art.generate, "calls", None),
                }
            new_aliases = full.new_aliases
            stats["added"] = sum(1 for e in store_out["elements"] if e.get("added_version") == version)
            stats["queued"] = len(store_out.get("queue", []))
            moderation = full.report.get("moderation") or {}
            stats["blocked"] = {k: v for k, v in sorted(moderation.items()) if k != QUOTA_LABEL}
            miss = tuple(full.report["miss_rate"]) if full.report.get("miss_rate") else None
            content = _content(store, full.daily_element_id)
            step = "check"
            _check(store, graph, content)  # run_full already checked the invariants (AC-INV)
        else:
            step = "seed"
            store = load_core(core, ContentStore.empty()).store
            step = "daily"
            daily = _pick_daily(store, core, state, version)
            emoji = daily["emoji"]
            step = "export"
            graph = export_graph(store, version)
            manifest = build_manifest(store, version=version, batch_at=batch_at, daily=daily, previous_version=None)
            content = _content(store, daily["element_id"])
            step = "check"
            _check(store, graph, content)
            step = "invariants"
            check_all(graph, manifest, store, _mod_lists(state, banned_words))
            miss = _miss_rate(graph, manifest["starters"], log)
        step = "banned"
        terms = banned_terms(banned_words)
        if terms:  # an empty secret never wipes the list already in D1
            client.put_banned_terms("wordlist", terms)
        banned_count = len(terms)
        if store_out is not None:
            step = "store_size"
            store_bytes = len(json.dumps(store_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if store_bytes > MAX_STORE_BYTES:  # caught here with a clear step, not as a 413 at publish
                raise ValueError(f"kho pipeline {store_bytes // 1024} KB vượt giới hạn {MAX_STORE_BYTES // 1024} KB")
        step = "publish"
        body = {
            "status": "success",
            "version": version,
            "batch_at": _iso(batch_at),
            "mode": mode,
            "manifest": manifest,
            "graph": graph,
            "content": content,
            "stats": stats,
        }
        if store_out is not None:
            body["store"] = store_out
        stats["quota_used"] = counted.used(llm if mode == "full" else None)
        run_id = client.post_batch(body).get("id")
        _send_aliases(client, state, new_aliases, log)
    except Exception as exc:  # every failure ends the same way: current version kept (AC-PIPE-11)
        if step == "publish" and version is not None and _published(client, version, log):
            _send_aliases(client, state, new_aliases, log)
            return _finish(
                reporter,
                client,
                None,
                version,
                batch_at,
                mode,
                None,
                stats,
                emoji,
                log,
                banned_count,
                miss,
                quota_hit,
                store_bytes,
                art_report,
            )
        failed_step, version = step, None
        # Network errors may carry the API host: the public workflow log only gets their type.
        # The banned words are secret (ADR 0005): that step's errors are logged by type only too.
        quiet = isinstance(exc, OSError) or step == "banned"
        detail = type(exc).__name__ if quiet else f"{type(exc).__name__}: {exc}"
        if isinstance(exc, InvariantError):
            # Which name matched a banned word would hint at the secret list: INV-07 is only counted.
            shown = [v for v in exc.violations if not v.startswith("INV-07")]
            hidden = len(exc.violations) - len(shown)
            detail = "; ".join(shown + ([f"INV-07: {hidden} phần tử khớp danh mục cấm"] if hidden else []))
        log(f"Mẻ thất bại ở bước {step}: {detail}")
        stats["quota_used"] = counted.used(llm if mode == "full" else None)
        error_body = {"status": "error", "batch_at": _iso(batch_at), "mode": mode, "failed_step": step, "stats": stats}
        try:
            run_id = client.post_batch(error_body).get("id")
        except Exception as post_exc:
            log(f"Không ghi được nhật ký đợt lỗi: {type(post_exc).__name__}")

    return _finish(
        reporter,
        client,
        run_id,
        version,
        batch_at,
        mode,
        failed_step,
        stats,
        emoji,
        log,
        banned_count,
        miss,
        quota_hit,
        store_bytes,
        art_report,
    )


def _published(client: BatchClient, version: int, log: Callable[[str], None]) -> bool:
    """The publish may have committed even though its response was lost: ask the Worker which version is live."""
    try:
        live = client.get_state().get("current_version") == version
    except Exception as exc:
        log(f"Không xác nhận được version hiện hành sau lỗi đăng: {type(exc).__name__}")
        return False
    if live:
        log(f"Mất phản hồi khi đăng nhưng version {version} đã là bản hiện hành.")
    return live


def _finish(
    reporter: IssueReporter,
    client: BatchClient,
    run_id: str | None,
    version: int | None,
    batch_at: datetime,
    mode: str,
    failed_step: str | None,
    stats: Mapping,
    emoji: str | None,
    log: Callable[[str], None],
    banned_count: int | None = None,
    miss: tuple[float, float] | None = None,
    quota_hit: bool = False,
    store_bytes: int | None = None,
    art_report: Mapping | None = None,
) -> BatchOutcome:
    title, report = _render_report(
        version=version,
        batch_at=batch_at,
        mode=mode,
        failed_step=failed_step,
        stats=stats,
        emoji=emoji,
        banned_count=banned_count,
        miss=miss,
        quota_hit=quota_hit,
        store_bytes=store_bytes,
        art_report=art_report,
    )
    return BatchOutcome(
        ok=failed_step is None,
        status="error" if failed_step else "success",
        version=version,
        failed_step=failed_step,
        run_id=run_id,
        issue_url=_report(reporter, client, run_id, title, report, log),
        report_title=title,
        report_body=report,
    )


def _report(
    reporter: IssueReporter, client: BatchClient, run_id: str | None, title: str, body: str, log: Callable[[str], None]
) -> str | None:
    """AC-PIPE-14: one Issue per batch; failing to create or link it is only logged, never fails the batch."""
    try:
        issue_url = reporter.create_issue(title, body)
    except Exception as exc:
        log(f"Không tạo được GitHub Issue báo cáo đợt: {type(exc).__name__}")
        return None
    if run_id is not None:
        try:
            client.patch_batch(run_id, issue_url)
        except Exception as exc:
            log(f"Không gắn được link Issue vào nhật ký đợt: {type(exc).__name__}")
    return issue_url


LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def parse_api_url(base_url: str) -> tuple[bool, str, int | None, str]:
    """(tls, host, port, prefix). Plain http only to a loopback Worker (`wrangler dev`, docs/dev/setup.md)."""
    parts = urlsplit(base_url)
    local = parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS
    if not (parts.scheme == "https" or local) or not parts.hostname:
        raise ValueError("URL phải có dạng https://<host>[/<tiền tố>] (http chỉ cho localhost)")
    return parts.scheme == "https", parts.hostname, parts.port, parts.path.rstrip("/")


def open_connection(tls: bool, host: str, port: int | None) -> http.client.HTTPConnection:
    cls = http.client.HTTPSConnection if tls else http.client.HTTPConnection
    return cls(host, port, timeout=TIMEOUT_SECONDS)


class _Https:
    def __init__(self, base_url: str, headers: Mapping[str, str]) -> None:
        self.tls, self.host, self.port, self.prefix = parse_api_url(base_url)
        self.headers = {"User-Agent": "lau-meme-pipeline", "Content-Type": "application/json", **headers}

    def send(self, method: str, path: str, body: bytes | None, headers: Mapping[str, str]) -> int:
        """Raw request (images): only the status matters; the body is read and dropped."""
        conn = open_connection(self.tls, self.host, self.port)
        try:
            conn.request(method, self.prefix + path, body=body, headers={**self.headers, **headers})
            res = conn.getresponse()
            res.read()
            return res.status
        finally:
            conn.close()

    def request(self, method: str, path: str, body: Mapping | None = None) -> dict:
        conn = open_connection(self.tls, self.host, self.port)
        try:
            payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
            conn.request(method, self.prefix + path, body=payload, headers=self.headers)
            res = conn.getresponse()
            raw = res.read()
        finally:
            conn.close()
        if not 200 <= res.status < 300:
            raise RuntimeError(f"{method} {path}: HTTP {res.status}")
        return json.loads(raw or b"{}")


class HttpBatchClient:
    """Network adapter: the Worker's `/api/pipeline/*` with the pipeline token (GitHub Secret)."""

    def __init__(self, base_url: str, token: str) -> None:
        self.http = _Https(base_url, {"Authorization": f"Bearer {token}"})

    def get_state(self) -> dict:
        return self.http.request("GET", "/api/pipeline/state")

    def get_store(self, version: int | None = None) -> dict:
        query = "" if version is None else f"?version={int(version)}"
        return self.http.request("GET", "/api/pipeline/store" + query)

    def post_batch(self, body: dict) -> dict:
        return self.http.request("POST", "/api/pipeline/batches", body)

    def patch_batch(self, run_id: str, issue_url: str) -> dict:
        return self.http.request("PATCH", f"/api/pipeline/batches/{run_id}", {"issue_url": issue_url})

    def put_banned_terms(self, source: str, terms: list[str]) -> None:
        self.http.request("PUT", f"/api/pipeline/banned-terms/{source}", {"terms": terms})

    def put_image(self, key: str, data: bytes) -> None:
        """ADR 0012: the Worker checks the key against the content hash before writing R2."""
        status = self.http.send("PUT", f"/api/pipeline/images/{key}", bytes(data), {"Content-Type": "image/webp"})
        if not 200 <= status < 300:
            raise RuntimeError(f"PUT ảnh: HTTP {status}")

    def image_exists(self, key: str) -> bool:
        return self.http.send("HEAD", f"/img/{key}", None, {}) == 200


class GitHubIssues:
    """Network adapter: GitHub REST "create an issue" with the workflow's GITHUB_TOKEN (issues: write)."""

    def __init__(self, repository: str, token: str) -> None:
        self.repository = repository
        self.http = _Https(
            "https://api.github.com",
            {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        )

    def create_issue(self, title: str, body: str) -> str:
        res = self.http.request("POST", f"/repos/{self.repository}/issues", {"title": title, "body": body})
        return str(res["html_url"])


class NoIssues:
    """Local runs (no GITHUB_REPOSITORY): no Issue is created; the report is only printed by main."""

    def create_issue(self, title: str, body: str) -> str:
        raise LookupError("GITHUB_REPOSITORY is not set")


def main(argv: list[str], *, client=None, reporter=None, now: Callable[[], datetime] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m lau_meme_pipeline.batch", description="Chạy một mẻ nhúng")
    parser.add_argument("--mode", choices=["core", "full"], default="core")
    parser.add_argument("--core", type=Path, required=True, help="đường dẫn noi-dung-loi.json")
    args = parser.parse_args(argv)
    core = json.loads(args.core.read_text(encoding="utf-8"))
    if client is None:
        client = HttpBatchClient(os.environ["API_BASE_URL"], os.environ["PIPELINE_TOKEN"])
    if reporter is None:
        repository = os.environ.get("GITHUB_REPOSITORY")
        reporter = GitHubIssues(repository, os.environ["GITHUB_TOKEN"]) if repository else NoIssues()
    batch_at = (now or (lambda: datetime.now(UTC)))().replace(microsecond=0)
    banned_words = os.environ.get("BANNED_WORDS", "").splitlines()  # GitHub Secret, one word per line
    adapters: list = []
    crawl_http: Http | None = None
    llm = None
    art: ArtAdapters | None = None
    if args.mode == "full":  # ADR 0009/0011; without the key run_batch fails at step "llm" before any network call
        from lau_meme_pipeline.crawl import default_adapters, http_get
        from lau_meme_pipeline.gemini import GeminiSteps

        adapters = default_adapters(os.environ)
        crawl_http = Http(http_get)
        key = os.environ.get("GEMINI_API_KEY", "")
        llm = GeminiSteps(key, os.environ.get("GEMINI_MODEL", "")) if key else None
        ai_token, account = os.environ.get("WORKERS_AI_TOKEN", ""), os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        if key and ai_token and account:  # ADR 0012; without them the batch runs and new elements wait
            from lau_meme_pipeline.gemini import GeminiImageCheck
            from lau_meme_pipeline.workers_ai import WorkersAiImages

            art = ArtAdapters(
                generate=WorkersAiImages(account, ai_token, os.environ.get("WORKERS_AI_MODEL", "")),
                check=GeminiImageCheck(key, os.environ.get("GEMINI_MODEL", "")),
            )
    outcome = run_batch(
        mode=args.mode,
        batch_at=batch_at,
        core=core,
        client=client,
        reporter=reporter,
        adapters=adapters,
        crawl_http=crawl_http,
        llm=llm,
        banned_words=banned_words,
        art=art,
    )
    print(outcome.report_title)
    print(outcome.report_body, end="")
    return 0 if outcome.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
