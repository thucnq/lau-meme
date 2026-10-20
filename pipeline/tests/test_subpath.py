"""Acceptance tests for docs/acceptance/subpath.md, phần pipeline: AC-SUBPATH-12.

Expected public surface (see docs/api/openapi.yaml, servers /lau-meme/api):

    lau_meme_pipeline.batch.HttpBatchClient(base_url, token)
        get_state() / post_batch(body) / patch_batch(run_id, issue_url)
    lau_meme_pipeline.rollback.HttpRollbackClient(base_url, token)
        post_rollback(version)

With base_url = "https://dinoduct.fun/lau-meme" every request path must start with /lau-meme/api/.
The network is mocked at the connection layer (http.client.HTTPSConnection); nothing real is contacted.
"""

import http.client
import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
BASE_URL = "https://dinoduct.fun/lau-meme"
TOKEN = "test-token-not-a-secret"
RUN_ID = "00000000-0000-4000-8000-000000000001"

STATE = {
    "current_version": None,
    "blocklist": {"elements": [], "recipes": [], "images": []},
    "banned_aliases": [],
    "daily_history": [],
    "feedback": [],
}


class FakeResponse:
    def __init__(self, status: int, body: dict):
        self.status = status
        self.reason = "OK"
        self._raw = json.dumps(body).encode("utf-8")
        self.headers = {"Content-Type": "application/json"}

    def read(self, *args):
        return self._raw

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def getheaders(self):
        return list(self.headers.items())


def install_fake_https(monkeypatch) -> list[dict]:
    """Replace http.client.HTTPSConnection; return the list of recorded requests."""
    seen: list[dict] = []

    class FakeHTTPSConnection:
        def __init__(self, host, *args, **kwargs):
            self.host = host

        def request(self, method, url, body=None, headers=None, **kwargs):
            seen.append({"host": self.host, "method": method, "path": url, "body": body, "headers": headers or {}})

        def getresponse(self):
            last = seen[-1]
            path = last["path"].split("?")[0]
            if path.endswith("/pipeline/state"):
                return FakeResponse(200, STATE)
            if path.endswith("/pipeline/rollback"):
                return FakeResponse(200, {"status": "rollback", "rollback_to": 7, "version": None})
            if last["method"] == "PATCH":
                return FakeResponse(200, {"id": RUN_ID, "issue_url": "https://github.com/o/r/issues/1"})
            return FakeResponse(
                201,
                {
                    "id": RUN_ID,
                    "version": None,
                    "batch_at": "2026-10-20T17:00:00Z",
                    "mode": "core",
                    "status": "error",
                    "failed_step": "check",
                    "stats": {},
                    "issue_url": None,
                    "created_at": "2026-10-20T17:00:00Z",
                },
            )

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", FakeHTTPSConnection)
    return seen


def error_batch_body() -> dict:
    return {
        "status": "error",
        "batch_at": "2026-10-20T17:00:00Z",
        "mode": "core",
        "failed_step": "check",
        "stats": {"crawled": 0, "added": 0, "queued": 0, "source_errors": [], "quota_used": 0, "blocked": {}},
    }


def test_ac_subpath_12_state_di_qua_tien_to(monkeypatch):
    """AC-SUBPATH-12: HttpBatchClient.get_state gọi GET /lau-meme/api/pipeline/state."""
    from lau_meme_pipeline.batch import HttpBatchClient

    seen = install_fake_https(monkeypatch)
    HttpBatchClient(BASE_URL, TOKEN).get_state()
    assert [(r["method"], r["path"]) for r in seen] == [("GET", "/lau-meme/api/pipeline/state")]
    assert seen[0]["host"].startswith("dinoduct.fun")


def test_ac_subpath_12_dang_me_di_qua_tien_to(monkeypatch):
    """AC-SUBPATH-12: HttpBatchClient.post_batch gọi POST /lau-meme/api/pipeline/batches."""
    from lau_meme_pipeline.batch import HttpBatchClient

    seen = install_fake_https(monkeypatch)
    HttpBatchClient(BASE_URL, TOKEN).post_batch(error_batch_body())
    assert [(r["method"], r["path"]) for r in seen] == [("POST", "/lau-meme/api/pipeline/batches")]


def test_ac_subpath_12_gan_issue_di_qua_tien_to(monkeypatch):
    """AC-SUBPATH-12: HttpBatchClient.patch_batch gọi PATCH /lau-meme/api/pipeline/batches/<id>."""
    from lau_meme_pipeline.batch import HttpBatchClient

    seen = install_fake_https(monkeypatch)
    HttpBatchClient(BASE_URL, TOKEN).patch_batch(RUN_ID, "https://github.com/o/r/issues/1")
    assert [(r["method"], r["path"]) for r in seen] == [("PATCH", f"/lau-meme/api/pipeline/batches/{RUN_ID}")]


def test_ac_subpath_12_rollback_di_qua_tien_to(monkeypatch):
    """AC-SUBPATH-12: HttpRollbackClient.post_rollback gọi POST /lau-meme/api/pipeline/rollback."""
    from lau_meme_pipeline.rollback import HttpRollbackClient

    seen = install_fake_https(monkeypatch)
    HttpRollbackClient(BASE_URL, TOKEN).post_rollback(None)
    assert [(r["method"], r["path"]) for r in seen] == [("POST", "/lau-meme/api/pipeline/rollback")]


def test_ac_subpath_12_base_url_co_dau_gach_cheo_cuoi_van_dung(monkeypatch):
    """AC-SUBPATH-12: base_url có dấu / ở cuối không sinh đường dẫn // hay mất tiền tố."""
    from lau_meme_pipeline.batch import HttpBatchClient

    seen = install_fake_https(monkeypatch)
    HttpBatchClient(BASE_URL + "/", TOKEN).get_state()
    assert seen[0]["path"] == "/lau-meme/api/pipeline/state"


def test_ac_subpath_12_graph_url_van_la_duong_dan_tuong_doi_voi_tien_to():
    """AC-SUBPATH-12: manifest.graph_url vẫn là /api/graph/<version> (không có tiền tố)."""
    from lau_meme_pipeline.graph import build_manifest
    from lau_meme_pipeline.seed import ContentStore, load_core

    core = json.loads(CORE_PATH.read_text(encoding="utf-8"))
    store = load_core(core, ContentStore.empty()).store
    daily_id = next(i for i, e in store.elements.items() if e.depth >= 4)
    daily = {"element_id": daily_id, "emoji": "🍲", "hint": "Gợi ý hôm nay", "depth": 4}
    batch_at = datetime(2026, 10, 20, 5, 30, 0, tzinfo=UTC)
    manifest = build_manifest(store, version=3, batch_at=batch_at, daily=daily, previous_version=2)
    assert manifest["graph_url"] == "/api/graph/3"
