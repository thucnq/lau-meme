"""One batch ("mẻ nhúng") end to end (AC-PIPE-01/11/13/14, ADR 0003/0006): `python -m lau_meme_pipeline.batch`.

Phase 1 only runs the core mode: no crawl, no LLM — new Món đặc biệt, graph + manifest of a new version, publish
through the Worker API, report as a GitHub Issue. `run_batch` takes the batch time and every adapter as arguments;
only `main` builds the network adapters.
"""

import argparse
import http.client
import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from lau_meme_pipeline.daily import build_daily_block, select_daily
from lau_meme_pipeline.graph import build_manifest, decrypt_entry, export_graph
from lau_meme_pipeline.ids import element_id
from lau_meme_pipeline.seed import ACTIVE, ContentStore, load_core
from lau_meme_pipeline.text import fold

STEPS = ("state", "seed", "daily", "export", "check", "banned", "publish", "report")
GMT7 = timezone(timedelta(hours=7))
TIMEOUT_SECONDS = 30
# AC-PIPE-13: public meme data only — never anything about players.
ALLOWED_LLM_FIELDS = frozenset({"name", "quote", "context", "source_name", "element_name", "image_hint"})
MAX_TERM = 100  # banned_term.term_fold limit in D1


def version_for(batch_at: datetime) -> int:
    """ADR 0006: the batch time in GMT+7 as YYYYMMDDHHmm — same batch, same version; later batch, larger."""
    if batch_at.tzinfo is None:
        raise ValueError("batch_at phải có múi giờ")
    return int(batch_at.astimezone(GMT7).strftime("%Y%m%d%H%M"))


def build_llm_payload(items: Sequence[Mapping]) -> list[dict]:
    """Every LLM payload (phase 2) goes through here; any field outside the allow-list is refused."""
    out: list[dict] = []
    for item in items:
        extra = sorted(set(item) - ALLOWED_LLM_FIELDS)
        if extra:
            raise ValueError(f"Trường không được gửi cho LLM: {', '.join(extra)}")
        out.append(dict(item))
    return out


class BatchClient(Protocol):
    def get_state(self) -> dict: ...
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


def _render_report(
    *,
    version: int | None,
    batch_at: datetime,
    mode: str,
    failed_step: str | None,
    stats: Mapping,
    emoji: str | None,
    banned_count: int | None = None,
) -> tuple[str, str]:
    """Title shows the dish's emoji only, never its name (AC-PIPE-14)."""
    status = "error" if failed_step else "success"
    shown = str(version) if version is not None else "—"
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
        lines.append(f"- Bước lỗi: {failed_step} — bản hiện hành giữ nguyên")
    lines += [
        # Labels are the stats keys of the batch log (BatchStats), so the Issue reads like the admin page.
        f"- crawled: {stats.get('crawled', 0)} · added: {stats.get('added', 0)} · queued: {stats.get('queued', 0)}",
        "- blocked: " + (", ".join(f"{k} {v}" for k, v in sorted(blocked.items())) or "0"),
        "- Lỗi nguồn: " + (", ".join(f"{e.get('source')}: lỗi {e.get('error')}" for e in errors) or "không có"),
        f"- quota: {stats.get('quota_used', 0)} lượt gọi Gemini",
        f"- Món đặc biệt: {emoji or '—'}",
    ]
    # Only the count: the words themselves are secret (ADR 0005).
    if banned_count == 0:
        lines.append("- ⚠️ BANNED_WORDS trống — bộ lọc nickname chưa có từ cấm (đặt GitHub Secret, xem runbook)")
    elif banned_count is not None:
        lines.append(f"- Từ cấm nickname: {banned_count} từ đã đồng bộ")
    lines += [
        "- METRIC: chưa có số liệu (tính năng METRIC chưa làm)",
    ]
    return title, "\n".join(lines) + "\n"


def run_batch(
    *,
    mode: str,
    batch_at: datetime,
    core: Mapping,
    client: BatchClient,
    reporter: IssueReporter,
    adapters: Sequence = (),
    llm: object | None = None,
    log: Callable[[str], None] = print,
    banned_words: Sequence[str] = (),
) -> BatchOutcome:
    """Run one batch. Never raises: a failure posts an error run, keeps the current version and is reported."""
    del adapters, llm  # phase 2 (crawl + LLM); the core mode never touches them (AC-PIPE-01)
    stats = _core_stats()
    version: int | None = None
    emoji: str | None = None
    run_id: str | None = None
    failed_step: str | None = None
    banned_count: int | None = None
    step = "state"
    try:
        if mode != "core":
            raise ValueError(f"chế độ {mode!r} chưa có ở giai đoạn 1 (chỉ core)")
        version = version_for(batch_at)
        state = client.get_state()
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
        step = "banned"
        terms = banned_terms(banned_words)
        if terms:  # an empty secret never wipes the list already in D1
            client.put_banned_terms("wordlist", terms)
        banned_count = len(terms)
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
        run_id = client.post_batch(body).get("id")
    except Exception as exc:  # every failure ends the same way: current version kept (AC-PIPE-11)
        if step == "publish" and version is not None and _published(client, version, log):
            return _finish(reporter, client, None, version, batch_at, mode, None, stats, emoji, log, banned_count)
        failed_step, version = step, None
        # Network errors may carry the API host: the public workflow log only gets their type.
        # The banned words are secret (ADR 0005): that step's errors are logged by type only too.
        quiet = isinstance(exc, OSError) or step == "banned"
        detail = type(exc).__name__ if quiet else f"{type(exc).__name__}: {exc}"
        log(f"Mẻ thất bại ở bước {step}: {detail}")
        error_body = {"status": "error", "batch_at": _iso(batch_at), "mode": mode, "failed_step": step, "stats": stats}
        try:
            run_id = client.post_batch(error_body).get("id")
        except Exception as post_exc:
            log(f"Không ghi được nhật ký đợt lỗi: {type(post_exc).__name__}")

    return _finish(reporter, client, run_id, version, batch_at, mode, failed_step, stats, emoji, log, banned_count)


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
) -> BatchOutcome:
    title, report = _render_report(
        version=version,
        batch_at=batch_at,
        mode=mode,
        failed_step=failed_step,
        stats=stats,
        emoji=emoji,
        banned_count=banned_count,
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


class _Https:
    def __init__(self, base_url: str, headers: Mapping[str, str]) -> None:
        parts = urlsplit(base_url)
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError("URL phải có dạng https://<host>")
        self.host, self.port, self.prefix = parts.hostname, parts.port, parts.path.rstrip("/")
        self.headers = {"User-Agent": "lau-meme-pipeline", "Content-Type": "application/json", **headers}

    def request(self, method: str, path: str, body: Mapping | None = None) -> dict:
        conn = http.client.HTTPSConnection(self.host, self.port, timeout=TIMEOUT_SECONDS)
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

    def post_batch(self, body: dict) -> dict:
        return self.http.request("POST", "/api/pipeline/batches", body)

    def patch_batch(self, run_id: str, issue_url: str) -> dict:
        return self.http.request("PATCH", f"/api/pipeline/batches/{run_id}", {"issue_url": issue_url})

    def put_banned_terms(self, source: str, terms: list[str]) -> None:
        self.http.request("PUT", f"/api/pipeline/banned-terms/{source}", {"terms": terms})


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


def main(argv: list[str], *, client=None, reporter=None, now: Callable[[], datetime] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m lau_meme_pipeline.batch", description="Chạy một mẻ nhúng")
    parser.add_argument("--mode", choices=["core", "full"], default="core")
    parser.add_argument("--core", type=Path, required=True, help="đường dẫn noi-dung-loi.json")
    args = parser.parse_args(argv)
    core = json.loads(args.core.read_text(encoding="utf-8"))
    if client is None:
        client = HttpBatchClient(os.environ["API_BASE_URL"], os.environ["PIPELINE_TOKEN"])
    if reporter is None:
        reporter = GitHubIssues(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_TOKEN"])
    batch_at = (now or (lambda: datetime.now(UTC)))().replace(microsecond=0)
    banned_words = os.environ.get("BANNED_WORDS", "").splitlines()  # GitHub Secret, one word per line
    outcome = run_batch(
        mode=args.mode, batch_at=batch_at, core=core, client=client, reporter=reporter, banned_words=banned_words
    )
    print(outcome.report_title)
    print(outcome.report_body, end="")
    return 0 if outcome.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
