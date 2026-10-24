"""Acceptance tests for docs/acceptance/pipe.md, phase 2: `run_batch(mode="full")` wired end to end
(crawl + Gemini + store). AC-PIPE-01, 03, 07, 10, 11, 12, 13, 14 at batch level.

Expected public surface (ADR 0009, ADR 0011):

    lau_meme_pipeline.batch.run_batch(mode="full", batch_at, core, client, reporter, adapters, crawl_http, llm,
                                      log, banned_words)
    client: get_state() / get_store(version=None) / post_batch(body) / patch_batch(run_id, issue_url) /
            put_banned_terms(source, terms)
    lau_meme_pipeline.batch.main(argv, *, client=None, reporter=None, now=None) -> int

No network, no sleeping, no real clock. Imports happen inside the tests so a missing module fails at runtime.
"""

import copy
import http.client
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)
T_VERSION = 202610210000
T2 = T + timedelta(hours=12)
STEPS = ("same", "describe", "classify", "link", "judge", "supplement_element", "supplement_pair")
STORE_KEYS = {"elements", "recipes", "queue", "asked_pairs", "llm_cache", "art_pending", "core_art"}
SUCCESS_KEYS_FULL = {"status", "version", "batch_at", "mode", "manifest", "graph", "content", "stats", "store"}
ERROR_KEYS = {"status", "batch_at", "mode", "failed_step", "stats"}


# ---------------------------------------------------------------- helpers


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def make_state() -> dict:
    return {
        "current_version": None,
        "blocklist": {"elements": [], "recipes": [], "images": []},
        "banned_aliases": [],
        "admin_blocked": [],
        "daily_history": [],
        "feedback": [],
    }


class FakeClient:
    def __init__(self, store=None, fail_store=False, fail_success=False):
        self.state = make_state()
        self.store = store if store is not None else {}
        self.fail_store = fail_store
        self.fail_success = fail_success
        self.calls: list[str] = []
        self.store_versions: list = []
        self.posted: list[dict] = []
        self.patches: list[tuple] = []
        self.banned: list[tuple] = []
        self._n = 0

    def get_state(self):
        self.calls.append("get_state")
        return copy.deepcopy(self.state)

    def get_store(self, version=None):
        self.calls.append("get_store")
        self.store_versions.append(version)
        if self.fail_store:
            raise RuntimeError("store unavailable")
        return copy.deepcopy(self.store)

    def put_banned_terms(self, source, terms):
        self.calls.append("put_banned_terms")
        self.banned.append((source, list(terms)))

    def post_batch(self, body):
        self.calls.append("post_batch")
        if self.fail_success and body.get("status") == "success":
            raise RuntimeError("deploy failed")
        self._n += 1
        self.posted.append(copy.deepcopy(body))
        return {
            "id": f"00000000-0000-4000-8000-{self._n:012d}",
            "version": body.get("version"),
            "batch_at": body["batch_at"],
            "mode": body["mode"],
            "status": body["status"],
            "failed_step": body.get("failed_step"),
            "stats": body["stats"],
            "issue_url": None,
            "created_at": body["batch_at"],
        }

    def patch_batch(self, run_id, issue_url):
        self.calls.append("patch_batch")
        self.patches.append((run_id, issue_url))
        return {"id": run_id, "issue_url": issue_url}

    @property
    def success_posts(self):
        return [b for b in self.posted if b["status"] == "success"]

    @property
    def error_posts(self):
        return [b for b in self.posted if b["status"] == "error"]


class FakeReporter:
    def __init__(self):
        self.issues: list[tuple[str, str]] = []

    def create_issue(self, title, body):
        self.issues.append((title, body))
        return f"https://github.com/o/r/issues/{len(self.issues)}"


class FakeAdapter:
    def __init__(self, name, names=(), error=None):
        self.name = name
        self._names = list(names)
        self._error = error

    def fetch(self, http):
        if self._error is not None:
            raise self._error
        from lau_meme_pipeline.crawl import RawConcept

        return [
            RawConcept(
                name=n,
                quote=f"câu nói {n}",
                context=f"ngữ cảnh {n}",
                source_url=f"https://ex.com/{i}",
                source_name=self.name,
            )
            for i, n in enumerate(self._names)
        ]


class Counting:
    def __init__(self, fn):
        self.fn = fn
        self.calls = 0

    def __call__(self, payload):
        self.calls += 1
        return self.fn(payload)


class Recording(Counting):
    def __init__(self, fn):
        super().__init__(fn)
        self.payloads: list = []

    def __call__(self, payload):
        self.payloads.append(payload)
        return super().__call__(payload)


def _same(items):
    return [False for _ in items]


def _classify(items):
    return [
        {
            "key": i["key"],
            "category": "safe",
            "confidence": 0.95,
            "person": {"targets": False, "name": None, "aliases": []},
            "accusation": False,
            "hot_person": False,
            "flagged_fields": [],
        }
        for i in items
    ]


def _describe(items):
    return [
        {
            "key": i.get("key", i["name"]),
            "emoji": "🔥",
            "description": f"Mô tả {i['name']}",
            "daily_hint": f"Gợi ý {i['name']}",
            "image_hint": f"Ảnh {i['name']}",
        }
        for i in items
    ]


def _link(items):
    fallback = [["AFK", "Aura"], ["AFK", "Bom Hàng"], ["AFK", "Brainrot"]]
    out = []
    for n, i in enumerate(items):
        cands = i.get("candidates") or []
        pairs = [[cands[0], cands[1]]] if len(cands) >= 2 else fallback[n % 3 : n % 3 + 1]
        out.append({"key": i["key"], "pairs": pairs})
    return out


def _link_nothing(items):
    return [{"key": i["key"], "pairs": []} for i in items]


def _judge(items):
    return {i["id"]: 4 for i in items}


def _supplement_element(items):
    return [{"name": i["name"], "recipes": []} for i in items]


def _supplement_pair(items):
    return [{"a": i["a"], "b": i["b"], "result": None} for i in items]


def make_llm(**over):
    fns = {
        "same": _same,
        "classify": _classify,
        "describe": _describe,
        "link": _link,
        "judge": _judge,
        "supplement_element": _supplement_element,
        "supplement_pair": _supplement_pair,
    }
    fns.update(over)
    return {k: v if isinstance(v, Counting) else Counting(v) for k, v in fns.items()}


def _raise(exc):
    def f(items):
        raise exc

    return f


def total_calls(llm) -> int:
    return sum(f.calls for f in llm.values())


def run_full_batch(client, reporter, adapters, llm, core=None, batch_at=T):
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    return run_batch(
        mode="full",
        batch_at=batch_at,
        core=core if core is not None else real_core(),
        client=client,
        reporter=reporter,
        adapters=adapters,
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=llm,
        log=lambda msg: None,
        banned_words=[],
    )


MEME = "Meme Thử Một"


# ================================================================ AC-PIPE-01 (full)


def test_ac_pipe_01_full_dang_mot_me_success_kem_store_va_meme_moi():
    """AC-PIPE-01: mode=full với một adapter trả 1 meme và LLM nối được: đăng ĐÚNG một mẻ success, mode full, có
    store (5 khóa của PipelineStore) chứa meme mới, content có meme mới, crawled 1, added 1; đã đọc kho."""
    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm())

    assert outcome.ok is True and outcome.status == "success"
    assert outcome.version == T_VERSION
    assert client.error_posts == []
    (body,) = client.success_posts
    assert set(body) == SUCCESS_KEYS_FULL
    assert body["mode"] == "full"
    assert body["version"] == T_VERSION
    assert set(body["store"]) <= STORE_KEYS
    assert {"elements", "recipes", "queue", "asked_pairs", "llm_cache"} <= set(body["store"])
    assert MEME in {e["name"] for e in body["store"]["elements"]}
    assert MEME in {e["name"] for e in body["content"]["elements"]}
    assert body["stats"]["crawled"] == 1
    assert body["stats"]["added"] == 1
    assert body["stats"]["queued"] == 0
    assert "get_store" in client.calls
    assert client.calls.index("get_store") < client.calls.index("post_batch")


# ================================================================ AC-PIPE-03


def test_ac_pipe_03_full_mot_nguon_loi_van_thanh_cong_va_bao_cao_ghi_loi_nguon():
    """AC-PIPE-03: adapter Reddit ném TimeoutError, adapter khác trả meme: mẻ vẫn success, stats.source_errors ghi
    Reddit/TimeoutError, Issue ghi "Reddit: lỗi TimeoutError"."""
    client, reporter = FakeClient(), FakeReporter()
    adapters = [FakeAdapter("Reddit", error=TimeoutError("timed out")), FakeAdapter("RSS", [MEME])]
    outcome = run_full_batch(client, reporter, adapters, make_llm())

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert body["stats"]["source_errors"] == [{"source": "Reddit", "error": "TimeoutError"}]
    assert body["stats"]["crawled"] == 1
    assert MEME in {e["name"] for e in body["content"]["elements"]}
    assert len(reporter.issues) == 1
    assert "Reddit: lỗi TimeoutError" in reporter.issues[0][1]


# ================================================================ AC-PIPE-07


def test_ac_pipe_07_full_meme_khong_noi_duoc_vao_hang_cho_voi_so_lan_thu_1():
    """AC-PIPE-07: LLM liên kết không trả cặp nào: mẻ vẫn success, meme vào store.queue với attempts 1, stats.queued
    1, KHÔNG nằm trong content."""
    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm(link=_link_nothing))

    assert outcome.ok is True
    (body,) = client.success_posts
    queue = body["store"]["queue"]
    assert [(i["concept"]["name"], i["attempts"], i["reason"]) for i in queue] == [(MEME, 1, "unlinked")]
    assert body["stats"]["queued"] == 1
    assert body["stats"]["added"] == 0
    assert MEME not in {e["name"] for e in body["content"]["elements"]}
    assert MEME not in {e["name"] for e in body["store"]["elements"]}


def test_ac_pipe_07_full_dot_sau_thu_lai_meme_trong_hang_cho_truoc_meme_moi():
    """AC-PIPE-07: đợt sau đọc kho có hàng chờ: meme chờ được gửi bước liên kết TRƯỚC meme mới, vẫn không nối được
    thì attempts = 2."""
    first_client = FakeClient()
    run_full_batch(first_client, FakeReporter(), [FakeAdapter("RSS", [MEME])], make_llm(link=_link_nothing))
    store1 = first_client.success_posts[0]["store"]

    link = Recording(_link_nothing)
    client = FakeClient(store=store1)
    run_full_batch(client, FakeReporter(), [FakeAdapter("RSS", ["Meme Thử Hai"])], make_llm(link=link), batch_at=T2)

    names = [p.get("name") for payload in link.payloads for p in payload]
    assert MEME in names and "Meme Thử Hai" in names
    assert names.index(MEME) < names.index("Meme Thử Hai")
    (body,) = client.success_posts
    attempts = {i["concept"]["name"]: i["attempts"] for i in body["store"]["queue"]}
    assert attempts[MEME] == 2
    assert attempts["Meme Thử Hai"] == 1


# ================================================================ AC-PIPE-10


def test_ac_pipe_10_full_chay_lai_cung_batch_at_cho_graph_va_manifest_giong_het_va_khong_goi_llm():
    """AC-PIPE-10: chạy lại cùng batch_at, cùng crawl, kho đầu vào giống mẻ đầu, kèm phản hồi LLM đã lưu:
    LLM không bị gọi, graph và manifest giống hệt mẻ đầu."""
    first_client = FakeClient()
    first_llm = make_llm()
    run_full_batch(first_client, FakeReporter(), [FakeAdapter("RSS", [MEME, "Meme Thử Hai"])], first_llm)
    assert total_calls(first_llm) > 0
    (first,) = first_client.success_posts

    def forbidden(step):
        def f(payload):
            raise AssertionError(f"LLM step {step!r} must not be called again")

        return Counting(f)

    second_llm = {step: forbidden(step) for step in STEPS}
    second_client = FakeClient(store={"llm_cache": first["store"]["llm_cache"]})
    outcome = run_full_batch(second_client, FakeReporter(), [FakeAdapter("RSS", [MEME, "Meme Thử Hai"])], second_llm)

    assert outcome.ok is True
    assert total_calls(second_llm) == 0
    (second,) = second_client.success_posts
    assert json.dumps(second["graph"], sort_keys=True) == json.dumps(first["graph"], sort_keys=True)
    assert json.dumps(second["manifest"], sort_keys=True) == json.dumps(first["manifest"], sort_keys=True)


# ================================================================ AC-PIPE-11


def assert_no_success(outcome, client, step=None):
    assert outcome.ok is False
    assert outcome.status == "error"
    assert client.success_posts == []
    assert len(client.error_posts) == 1
    body = client.error_posts[0]
    assert set(body) == ERROR_KEYS
    assert body["mode"] == "full"
    assert isinstance(body["failed_step"], str) and body["failed_step"]
    assert outcome.failed_step == body["failed_step"]
    if step is not None:
        assert body["failed_step"] == step


def test_ac_pipe_11_full_khong_doc_duoc_kho_thi_khong_dang_gi_loi_o_buoc_store():
    """AC-PIPE-11: get_store ném lỗi: không có mẻ success nào được đăng, đợt lỗi ghi failed_step "store"."""
    client, reporter = FakeClient(fail_store=True), FakeReporter()
    llm = make_llm()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], llm)
    assert_no_success(outcome, client, "store")
    assert total_calls(llm) == 0
    assert len(reporter.issues) == 1 and "store" in reporter.issues[0][1]


def test_ac_pipe_11_full_llm_loi_thuong_thi_khong_dang_success():
    """AC-PIPE-11: bước describe ném Exception thường (không phải hết quota): không đăng success, đợt lỗi được ghi."""
    client, reporter = FakeClient(), FakeReporter()
    llm = make_llm(describe=_raise(RuntimeError("boom")))
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], llm)
    assert_no_success(outcome, client)
    assert outcome.failed_step != "publish"
    assert len(reporter.issues) == 1


def test_ac_pipe_11_full_kho_loi_khong_hop_le_thi_khong_dang_success():
    """AC-PIPE-11: kho lõi có công thức tham chiếu phần tử không tồn tại (kiểm tra bất biến hỏng): không đăng
    success, lỗi ở bước seed."""
    core = real_core()
    core["recipes"].append({"a": "Không Có A", "b": "Không Có B", "result": "Không Có C", "best": False})
    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm(), core=core)
    assert_no_success(outcome, client, "seed")


def test_ac_pipe_11_full_deploy_loi_thi_khong_co_ban_success():
    """AC-PIPE-11: post_batch(success) ném lỗi: failed_step "publish", không bản success nào được ghi nhận."""
    client, reporter = FakeClient(fail_success=True), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm())
    assert_no_success(outcome, client, "publish")


# ================================================================ AC-PIPE-12


def test_ac_pipe_12_full_classify_het_quota_van_dang_va_khai_niem_vao_hang_cho_quota():
    """AC-PIPE-12: classify ném QuotaExhausted: mẻ vẫn success, các meme vào store.queue với reason "quota", không
    vào content, Issue ghi "hết quota"."""
    from lau_meme_pipeline.llm import QuotaExhausted

    client, reporter = FakeClient(), FakeReporter()
    names = [MEME, "Meme Thử Hai"]
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", names)], make_llm(classify=_raise(QuotaExhausted())))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    queue = body["store"]["queue"]
    assert {i["concept"]["name"] for i in queue} == set(names)
    assert all(i["reason"] == "quota" for i in queue)
    assert body["stats"]["queued"] == 2
    content_names = {e["name"] for e in body["content"]["elements"]}
    assert not content_names & set(names)
    assert "hết quota" in reporter.issues[0][1]


def test_ac_pipe_12_full_link_het_quota_sau_khi_classify_xong_meme_khong_mat():
    """AC-PIPE-12: link ném QuotaExhausted sau khi classify đã qua: mẻ vẫn success, meme nằm trong hàng chờ (không
    mất, không vào content), Issue ghi "hết quota"."""
    from lau_meme_pipeline.llm import QuotaExhausted

    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm(link=_raise(QuotaExhausted())))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    queue = body["store"]["queue"]
    assert [i["concept"]["name"] for i in queue] == [MEME]
    assert queue[0]["reason"] == "quota"
    assert MEME not in {e["name"] for e in body["content"]["elements"]}
    assert "hết quota" in reporter.issues[0][1]


# ================================================================ AC-PIPE-13


def test_ac_pipe_13_full_thieu_khoa_gemini_thi_that_bai_o_buoc_llm_khong_cham_mang(monkeypatch):
    """AC-PIPE-13: main --mode full khi GEMINI_API_KEY không đặt: trả 1, đợt lỗi failed_step "llm", không đăng
    success, không mở kết nối mạng nào."""
    from lau_meme_pipeline.batch import main

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    def no_network(*args, **kwargs):
        raise AssertionError("network must not be touched")

    monkeypatch.setattr(http.client, "HTTPSConnection", no_network)
    monkeypatch.setattr(http.client, "HTTPConnection", no_network)

    client, reporter = FakeClient(), FakeReporter()
    code = main(["--mode", "full", "--core", str(CORE_PATH)], client=client, reporter=reporter, now=lambda: T)

    assert code == 1
    assert client.success_posts == []
    assert [b["failed_step"] for b in client.error_posts] == ["llm"]
    assert client.error_posts[0]["mode"] == "full"


# ================================================================ AC-PIPE-14


def test_ac_pipe_14_full_issue_co_version_che_do_trang_thai_va_so_lieu():
    """AC-PIPE-14: Issue của mẻ full: tiêu đề có version, "full", "success"; nội dung có crawled/added/queued và
    dòng quota đúng số lời gọi LLM thật đã gửi."""
    client, reporter = FakeClient(), FakeReporter()
    llm = make_llm()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], llm)

    title, text = reporter.issues[0]
    assert outcome.report_title == title and outcome.report_body == text
    assert str(T_VERSION) in title
    assert "full" in title
    assert "success" in title
    for label, value in (("crawled", 1), ("added", 1), ("queued", 0)):
        assert re.search(rf"{label}\W{{1,4}}{value}\b", text, re.I), label
    used = total_calls(llm)
    assert used > 0
    assert re.search(rf"quota[^\n]*\b{used}\b", text, re.I)


def test_ac_pipe_14_full_quota_used_bang_so_lan_goi_llm_khi_llm_la_dict_thuong():
    """AC-PIPE-14: llm là dict thường (không có thuộc tính calls): stats.quota_used = số lần gọi các bước LLM."""
    client = FakeClient()
    llm = make_llm()
    run_full_batch(client, FakeReporter(), [FakeAdapter("RSS", [MEME])], llm)
    (body,) = client.success_posts
    assert body["stats"]["quota_used"] == total_calls(llm) > 0


def test_ac_pipe_14_full_quota_used_lay_tu_llm_calls_khi_co():
    """AC-PIPE-14: llm có thuộc tính calls (số lời gọi HTTP thật, gồm retry) thì stats.quota_used = llm.calls."""

    class GeminiLike(dict):
        calls = 7

    llm = GeminiLike(make_llm())
    client = FakeClient()
    run_full_batch(client, FakeReporter(), [FakeAdapter("RSS", [MEME])], llm)
    (body,) = client.success_posts
    assert body["stats"]["quota_used"] == 7


# ================================================================ AC-PIPE-13 (list)


def test_ac_pipe_13_danh_sach_truong_llm_cho_phep_sau_adr_0009():
    """AC-PIPE-13: ALLOWED_LLM_FIELDS đúng bằng tập mở rộng theo ADR 0009 (chỉ dữ liệu meme công khai)."""
    from lau_meme_pipeline.batch import ALLOWED_LLM_FIELDS, build_llm_payload

    expected = frozenset(
        {
            "key",
            "kind",
            "name",
            "quote",
            "context",
            "source_name",
            "element_name",
            "image_hint",
            "emoji",
            "description",
            "daily_hint",
            "existing",
            "candidates",
            "need",
            "id",
            "a",
            "b",
            "result",
        }
    )
    assert expected == ALLOWED_LLM_FIELDS
    for forbidden in ("player_id", "uuid", "nickname", "ip", "steps", "url"):
        assert forbidden not in ALLOWED_LLM_FIELDS
        with pytest.raises(ValueError):
            build_llm_payload([{"name": "Meme", forbidden: "x"}])


# ================================================================ review fixes


def published_names(body) -> set[str]:
    names = {e["name"] for e in body["content"]["elements"]}
    names |= {e["name"] for e in body["store"]["elements"]}
    names |= {i["concept"]["name"] for i in body["store"]["queue"]}
    return names


def test_ac_pipe_04_ten_dai_150_ky_tu_bi_loai_meme_thuong_van_dang():
    """AC-PIPE-04: khái niệm có tên 150 ký tự (Worker giới hạn 100) không vào content, store hay hàng chờ; meme
    thường cùng đợt vẫn được đăng; mẻ vẫn success (AC-PIPE-11)."""
    long_name = "Meme Dài " + "d" * 141
    assert len(long_name) == 150
    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [long_name, MEME])], make_llm())

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert long_name not in published_names(body)
    assert not [n for n in published_names(body) if len(n) > 100]
    assert MEME in {e["name"] for e in body["content"]["elements"]}
    assert all(len(e["name"]) <= 100 and len(e["fold"]) <= 100 for e in body["content"]["elements"])


def test_ac_pipe_11_emoji_qua_16_ky_tu_thi_meme_vao_hang_cho_khong_vao_content():
    """AC-PIPE-11: bước describe trả emoji dài 20 ký tự (Worker giới hạn 16): mẻ vẫn success, meme KHÔNG vào
    content, vào store.queue để thử lại sau."""

    def long_emoji(items):
        return [{**d, "emoji": "🔥" * 20} for d in _describe(items)]

    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm(describe=long_emoji))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert MEME not in {e["name"] for e in body["content"]["elements"]}
    assert MEME not in {e["name"] for e in body["store"]["elements"]}
    assert [i["concept"]["name"] for i in body["store"]["queue"]] == [MEME]
    assert all(len(e["emoji"]) <= 16 for e in body["content"]["elements"])


def test_ac_pipe_05_gan_trung_ma_buoc_same_het_quota_thi_khong_dang_ban_gan_trung():
    """AC-PIPE-05: khái niệm gần giống phần tử lõi "Còn Cái Nịt" (không trùng fold) mà bước same hết quota: mẻ vẫn
    success và bản gần giống KHÔNG được đăng (không vào content, không vào store.elements)."""
    from lau_meme_pipeline.llm import QuotaExhausted

    variant = "Còn Cái Nịt Nè"
    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [variant])], make_llm(same=_raise(QuotaExhausted())))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert variant not in {e["name"] for e in body["content"]["elements"]}
    assert variant not in {e["name"] for e in body["store"]["elements"]}


def test_ac_pipe_10_cau_tra_loi_mot_phan_khong_duoc_cache_nen_chay_lai_van_goi_llm():
    """AC-PIPE-10: describe ném PartialAnswer (chỉ trả lời meme đầu) thì phản hồi đó không vào llm_cache của kho; chạy
    lại với llm_cache đã lưu thì describe VẪN được gọi lại."""
    from lau_meme_pipeline.llm import PartialAnswer

    def partial_describe(items):
        raise PartialAnswer(_describe(items[:1]))

    names = [MEME, "Meme Thử Hai"]
    first_client = FakeClient()
    run_full_batch(first_client, FakeReporter(), [FakeAdapter("RSS", names)], make_llm(describe=partial_describe))
    assert len(first_client.success_posts) == 1
    first_store = first_client.success_posts[0]["store"]

    describe = Recording(_describe)
    second_client = FakeClient(store={"llm_cache": first_store["llm_cache"]})
    run_full_batch(second_client, FakeReporter(), [FakeAdapter("RSS", names)], make_llm(describe=describe))

    assert describe.calls >= 1


def test_ac_pipe_11_bi_danh_chi_gui_sau_khi_dang_thanh_cong():
    """AC-MOD-06: kiểm duyệt đánh dấu cáo buộc kèm bí danh "Nguyen Van Abc": put_banned_terms("mod", ...) được gọi
    SAU post_batch và chứa "nguyen van abc"."""

    def accusation(items):
        out = _classify(items)
        for d in out:
            d["accusation"] = True
            d["person"] = {"targets": True, "name": "Nguyen Van Abc", "aliases": ["Nguyen Van Abc"]}
        return out

    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm(classify=accusation))

    assert outcome.ok is True
    mod_terms = [terms for source, terms in client.banned if source == "mod"]
    assert len(mod_terms) == 1
    assert "nguyen van abc" in mod_terms[0]
    assert client.calls.index("post_batch") < client.calls.index("put_banned_terms")


def test_ac_pipe_11_dang_loi_thi_khong_gui_bi_danh_mod():
    """AC-PIPE-11: post_batch(success) ném lỗi thì put_banned_terms KHÔNG bao giờ được gọi với nguồn "mod"."""

    def accusation(items):
        out = _classify(items)
        for d in out:
            d["accusation"] = True
            d["person"] = {"targets": True, "name": "Nguyen Van Abc", "aliases": ["Nguyen Van Abc"]}
        return out

    client, reporter = FakeClient(fail_success=True), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm(classify=accusation))

    assert outcome.ok is False
    assert client.success_posts == []
    assert [source for source, _ in client.banned if source == "mod"] == []


def test_ac_pipe_11_kho_dau_vao_qua_lon_thi_loi_o_buoc_store_size():
    """AC-PIPE-11: kho đọc về có asked_pairs làm JSON vượt 1.900.000 byte: không đăng success, failed_step
    "store_size", Issue nêu kích thước kho."""
    pairs = [[f"{i:043d}", f"{i + 1:043d}"] for i in range(25000)]
    assert len(json.dumps({"asked_pairs": pairs})) > 1_900_000
    client, reporter = FakeClient(store={"asked_pairs": pairs}), FakeReporter()
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm())

    assert_no_success(outcome, client, "store_size")
    assert len(reporter.issues) == 1
    assert re.search(r"\d+\s*KB", reporter.issues[0][1])


def test_ac_pipe_14_issue_thanh_cong_ghi_kich_thuoc_kho_theo_kb():
    """AC-PIPE-14: Issue của mẻ full thành công có dòng kích thước kho tính bằng KB."""
    client, reporter = FakeClient(), FakeReporter()
    run_full_batch(client, reporter, [FakeAdapter("RSS", [MEME])], make_llm())

    assert re.search(r"[Kk]ho[^\n]*\d+\s*KB", reporter.issues[0][1])
