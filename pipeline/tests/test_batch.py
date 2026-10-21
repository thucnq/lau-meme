"""Acceptance tests for docs/acceptance/pipe.md, phase 1: AC-PIPE-01, 02, 11, 13, 14 (core mode).

Expected module `lau_meme_pipeline.batch` (see the contract in docs/api/openapi.yaml: /pipeline/state,
/pipeline/batches, /pipeline/batches/{id}; ADR 0006 for the version number):

    STEPS = ("state", "seed", "daily", "export", "check", "publish", "report")
    version_for(batch_at) -> int
    BatchClient: get_state() / post_batch(body) / patch_batch(run_id, issue_url)
    IssueReporter: create_issue(title, body) -> html_url
    BatchOutcome(ok, status, version, failed_step, run_id, issue_url, report_title, report_body)
    run_batch(*, mode, batch_at, core, client, reporter, adapters=(), llm=None, log=print) -> BatchOutcome
    build_llm_payload(items) -> list[dict]
    main(argv, *, client=None, reporter=None, now=None) -> int

No network, no sleeping, no real clock: the batch time is always passed in. Imports happen inside the tests so a
missing module fails at runtime, not at collection.
"""

import copy
import json
import re
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "batch.yml"
BATCH_SOURCE = ROOT / "pipeline" / "src" / "lau_meme_pipeline" / "batch.py"

T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)  # 00:00 on 2026-10-21 GMT+7
T_ISO = "2026-10-20T17:00:00Z"
T_VERSION = 202610210000
STARTERS = ["Cay", "Cười", "Toang", "Deadline"]

SUCCESS_KEYS = {"status", "version", "batch_at", "mode", "manifest", "graph", "content", "stats"}
ERROR_KEYS = {"status", "batch_at", "mode", "failed_step", "stats"}
EMPTY_STATS = {"crawled": 0, "added": 0, "queued": 0, "source_errors": [], "quota_used": 0, "blocked": {}}


# ---------------------------------------------------------------- helpers


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def example_targets() -> list[str]:
    return [e["target"] for e in real_core()["daily_examples"]]


def eid(name: str) -> str:
    from lau_meme_pipeline.ids import element_id

    return element_id(name)


def make_state(history: list | None = None, blocked_elements: list | None = None) -> dict:
    return {
        "current_version": None,
        "blocklist": {"elements": list(blocked_elements or []), "recipes": [], "images": []},
        "banned_aliases": [],
        "daily_history": list(history or []),
        "feedback": [],
    }


def hist(name: str, version: int) -> dict:
    return {"version": version, "element_id": eid(name), "batch_at": f"2026-10-1{version % 10}T17:00:00Z"}


class Untouchable:
    """Every attribute access and call raises: proves the object is never used."""

    def __getattr__(self, name):
        raise AssertionError(f"object must not be touched (attribute {name!r})")

    def __call__(self, *args, **kwargs):
        raise AssertionError("object must not be called")


class FakeClient:
    def __init__(self, state=None, fail_state=False, fail_success=False, fail_all_posts=False):
        self.state = state if state is not None else make_state()
        self.fail_state = fail_state
        self.fail_success = fail_success
        self.fail_all_posts = fail_all_posts
        self.calls: list[str] = []
        self.posted: list[dict] = []  # only posts that did not raise
        self.patches: list[tuple] = []
        self._n = 0

    def get_state(self):
        self.calls.append("get_state")
        if self.fail_state:
            raise RuntimeError("state unavailable")
        return copy.deepcopy(self.state)

    def post_batch(self, body):
        self.calls.append("post_batch")
        if self.fail_all_posts or (self.fail_success and body.get("status") == "success"):
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
    def __init__(self, fail=False):
        self.fail = fail
        self.issues: list[tuple[str, str]] = []

    def create_issue(self, title, body):
        self.issues.append((title, body))
        if self.fail:
            raise RuntimeError("github down")
        return f"https://github.com/o/r/issues/{len(self.issues)}"


def run(client=None, reporter=None, core=None, mode="core", batch_at=T, log=None, **kw):
    from lau_meme_pipeline.batch import run_batch

    client = client if client is not None else FakeClient()
    reporter = reporter if reporter is not None else FakeReporter()
    return run_batch(
        mode=mode,
        batch_at=batch_at,
        core=core if core is not None else real_core(),
        client=client,
        reporter=reporter,
        log=log if log is not None else (lambda msg: None),
        **kw,
    )


def daily_name_of(body: dict) -> str:
    """Name of the dish chosen in a success body (looked up through the id in the content)."""
    dish_id = body["content"]["daily_element_id"]
    return next(e["name"] for e in body["content"]["elements"] if e["id"] == dish_id)


# ---------------------------------------------------------------- version_for (ADR 0006)


def test_ac_pipe_01_version_for_doi_gio_sang_gmt7():
    """AC-PIPE-01: version = batch_at theo GMT+7 viết YYYYMMDDHHmm (ADR 0006); giờ naive bị từ chối."""
    from lau_meme_pipeline.batch import version_for

    assert version_for(T) == T_VERSION
    assert version_for(datetime(2026, 10, 20, 5, 0, 0, tzinfo=UTC)) == 202610201200
    # cùng một thời điểm ở múi giờ khác cho cùng version
    assert version_for(T.astimezone(timezone(timedelta(hours=7)))) == T_VERSION
    assert version_for(T.astimezone(timezone(timedelta(hours=-5)))) == T_VERSION
    with pytest.raises(ValueError):
        version_for(datetime(2026, 10, 20, 17, 0, 0))


# ---------------------------------------------------------------- AC-PIPE-01


def test_ac_pipe_01_che_do_loi_khong_cham_adapter_va_llm():
    """AC-PIPE-01: mode=core không gọi adapter crawl nào và không gọi LLM; đăng đúng một mẻ success."""
    client, reporter = FakeClient(), FakeReporter()
    outcome = run(client, reporter, adapters=(Untouchable(), Untouchable()), llm=Untouchable())
    assert outcome.ok is True
    assert outcome.status == "success"
    assert outcome.failed_step is None
    assert outcome.version == T_VERSION
    assert len(client.success_posts) == 1
    assert client.error_posts == []


def test_ac_pipe_01_body_dang_mau_dung_khop_hop_dong_publish_batch_request():
    """AC-PIPE-01: body gửi /pipeline/batches có đúng các khóa của PublishBatchRequest (success) và thống kê rỗng."""
    client = FakeClient()
    run(client)
    (body,) = client.success_posts
    assert set(body) == SUCCESS_KEYS
    assert body["status"] == "success"
    assert body["version"] == T_VERSION
    assert body["batch_at"] == T_ISO
    assert body["mode"] == "core"
    assert body["stats"] == EMPTY_STATS
    assert set(body["content"]) == {"elements", "recipes", "starters", "daily_element_id"}


def test_ac_pipe_01_graph_la_export_graph_cua_kho_loi_o_version_moi():
    """AC-PIPE-01: graph trong body = export_graph(kho lõi, version); giải mã được công thức lõi."""
    from lau_meme_pipeline.graph import decrypt_entry, export_graph
    from lau_meme_pipeline.seed import ContentStore, load_core

    client = FakeClient()
    run(client)
    (body,) = client.success_posts
    store = load_core(real_core(), ContentStore.empty()).store
    assert body["graph"] == export_graph(store, T_VERSION)
    assert body["graph"]["version"] == T_VERSION
    path = real_core()["daily_examples"][0]["path"]
    a, b, result = path[0]
    got = decrypt_entry(body["graph"], a, b)
    assert got is not None and got["name"] == result
    assert decrypt_entry(body["graph"], b, a)["name"] == result


def test_ac_pipe_01_manifest_co_batch_at_la_t_va_khoi_daily_khong_lo_ten():
    """AC-PIPE-01: manifest.batch_at = T, version mới, daily có element_id/emoji/hint/depth và không có tên đọc được."""
    client = FakeClient()
    run(client)
    (body,) = client.success_posts
    manifest = body["manifest"]
    assert manifest["version"] == T_VERSION
    assert manifest["batch_at"] == T_ISO
    assert manifest["graph_url"] == f"/api/graph/{T_VERSION}"
    assert "policy_version" not in manifest
    assert [s["name"] for s in manifest["starters"]] == STARTERS
    assert set(manifest["daily"]) == {"element_id", "emoji", "hint", "depth"}
    assert 4 <= manifest["daily"]["depth"] <= 8
    assert manifest["daily"]["element_id"] == body["content"]["daily_element_id"]
    name = daily_name_of(body)
    text = json.dumps({k: v for k, v in manifest.items() if k != "miss_lines"}, ensure_ascii=False)
    assert name not in text


def test_ac_pipe_01_content_phan_tu_cong_thuc_va_khoi_dau_khop_kho_loi():
    """AC-PIPE-01: content gồm đủ phần tử/công thức của lõi (id băm, fold, depth), 4 món khởi đầu, món đặc biệt."""
    from lau_meme_pipeline.ids import recipe_id
    from lau_meme_pipeline.text import fold

    core = real_core()
    client = FakeClient()
    run(client)
    (body,) = client.success_posts
    content = body["content"]
    assert content["starters"] == [eid(s) for s in STARTERS]
    by_name = {e["name"]: e for e in content["elements"]}
    assert set(by_name) == {e["name"] for e in core["elements"]}
    for e in core["elements"]:
        got = by_name[e["name"]]
        assert got["id"] == eid(e["name"])
        assert got["fold"] == fold(e["name"])
        assert got["emoji"] == e["emoji"]
        assert got["depth"] == e["depth"]
        assert (
            {"id", "name", "fold", "emoji", "depth"}
            <= set(got)
            <= {"id", "name", "fold", "emoji", "depth", "origin", "image_key"}
        )
        if "origin" in got:
            assert got["origin"] in ("vn", "intl")
    assert len(content["recipes"]) == len(core["recipes"]) == 363
    expected = {recipe_id(r["a"], r["b"]): eid(r["result"]) for r in core["recipes"]}
    assert {r["id"]: r["result"] for r in content["recipes"]} == expected
    for r in content["recipes"]:
        assert set(r) <= {"id", "a", "b", "result", "score"} and {"id", "a", "b", "result"} <= set(r)
    ids = {e["id"] for e in content["elements"]}
    assert all(r["a"] in ids and r["b"] in ids and r["result"] in ids for r in content["recipes"])


def test_ac_pipe_01_mon_dac_biet_lay_tu_daily_examples_voi_goi_y_cua_loi():
    """AC-PIPE-01: lịch sử rỗng thì Món đặc biệt là một target của daily_examples, gợi ý đúng theo file lõi."""
    core = real_core()
    client = FakeClient()
    run(client)
    (body,) = client.success_posts
    name = daily_name_of(body)
    example = next((e for e in core["daily_examples"] if e["target"] == name), None)
    assert example is not None
    assert body["manifest"]["daily"]["hint"] == example["hint"]
    emoji = next(e["emoji"] for e in core["elements"] if e["name"] == name)
    assert body["manifest"]["daily"]["emoji"] == emoji


def test_ac_pipe_01_mon_dac_biet_khong_lap_lai_mon_da_dung():
    """AC-PIPE-01: lịch sử đã gồm mọi target trừ một thì chọn đúng target còn lại (AC-DAILY-01)."""
    targets = example_targets()
    assert len(targets) >= 2
    for remaining in targets:
        history = [hist(t, i + 1) for i, t in enumerate(x for x in targets if x != remaining)]
        client = FakeClient(make_state(history=history))
        run(client)
        (body,) = client.success_posts
        assert daily_name_of(body) == remaining


def test_ac_pipe_01_mon_dac_biet_khong_chon_phan_tu_bi_chan():
    """AC-PIPE-01: phần tử trong blocklist.elements không bao giờ được chọn, kể cả khi nó là món dùng lâu nhất."""
    targets = example_targets()
    history = [hist(t, i + 1) for i, t in enumerate(targets)]  # món đầu là món dùng cũ nhất
    client = FakeClient(make_state(history=history, blocked_elements=[eid(targets[0])]))
    run(client)
    (body,) = client.success_posts
    assert daily_name_of(body) == targets[1]
    assert body["content"]["daily_element_id"] != eid(targets[0])


def test_ac_pipe_01_moi_target_bi_chan_thi_that_bai_o_buoc_daily():
    """AC-PIPE-01: mọi target bị chặn ⇒ không chọn được Món đặc biệt (AC-DAILY-02): mẻ lỗi ở bước daily, không đăng."""
    blocked = [eid(t) for t in example_targets()]
    client, reporter = FakeClient(make_state(blocked_elements=blocked)), FakeReporter()
    outcome = run(client, reporter)
    assert outcome.ok is False
    assert outcome.status == "error"
    assert outcome.failed_step == "daily"
    assert client.success_posts == []
    assert [b["failed_step"] for b in client.error_posts] == ["daily"]


def test_ac_pipe_01_ghi_bao_cao_va_gan_link_issue_vao_dot():
    """AC-PIPE-01: sau khi đăng, báo cáo đợt tạo đúng một Issue và PATCH link vào đợt; chỉ dùng 3 lời gọi API."""
    client, reporter = FakeClient(), FakeReporter()
    outcome = run(client, reporter)
    assert len(reporter.issues) == 1
    assert outcome.run_id == "00000000-0000-4000-8000-000000000001"
    assert outcome.issue_url == "https://github.com/o/r/issues/1"
    assert client.patches == [(outcome.run_id, outcome.issue_url)]
    assert client.calls[0] == "get_state"
    assert client.calls.index("post_batch") < client.calls.index("patch_batch")


def test_ac_pipe_01_chay_lai_cung_dau_vao_cho_body_giong_het_byte():
    """AC-PIPE-01: cùng kho lõi, trạng thái và batch_at ⇒ body đăng giống hệt từng byte (tất định)."""
    bodies = []
    for _ in range(2):
        client = FakeClient(make_state(history=[hist(example_targets()[0], 1)]))
        run(client)
        bodies.append(json.dumps(client.success_posts[0], sort_keys=True, ensure_ascii=False))
    assert bodies[0] == bodies[1]


# ---------------------------------------------------------------- AC-PIPE-02


def workflow_text() -> str:
    assert WORKFLOW_PATH.is_file(), "thiếu .github/workflows/batch.yml"
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def test_ac_pipe_02_lich_chay_hai_cron_00_va_12_gio_gmt7():
    """AC-PIPE-02: có schedule với cron '0 17 * * *' và '0 5 * * *'."""
    text = workflow_text()
    assert re.search(r"^\s*schedule:", text, re.M)
    assert re.search(r"cron:\s*['\"]0 17 \* \* \*['\"]", text)
    assert re.search(r"cron:\s*['\"]0 5 \* \* \*['\"]", text)


def test_ac_pipe_02_chay_tay_co_tham_so_che_do_core_full():
    """AC-PIPE-02: workflow_dispatch có tham số chế độ cho chọn core hoặc full."""
    text = workflow_text()
    match = re.search(r"^\s*workflow_dispatch:(.*?)(?=^\S|^\s{0,2}\w[\w-]*:\s*$)", text, re.M | re.S)
    assert match, "thiếu workflow_dispatch"
    block = match.group(1)
    assert "inputs:" in block
    assert re.search(r"\bmode\b", block)
    assert re.search(r"\bcore\b", block) and re.search(r"\bfull\b", block)


def test_ac_pipe_02_timeout_15_phut_va_concurrency_khong_huy_mau_dang_chay():
    """AC-PIPE-02: timeout-minutes 15; concurrency dùng nhóm batch-… (chung tiền tố với rollback)
    và không hủy mẻ đang chạy."""
    text = workflow_text()
    assert re.search(r"timeout-minutes:\s*15\b", text)
    match = re.search(r"^concurrency:\s*\n((?:[ \t]+.*\n)+)", text, re.M)
    assert match, "thiếu khối concurrency ở cấp workflow"
    assert re.search(r"group:\s*['\"]?batch-", match.group(1))
    assert re.search(r"cancel-in-progress:\s*false", match.group(1))
    assert "group: batch-" in (ROOT / ".github" / "workflows" / "rollback.yml").read_text(encoding="utf-8")


def test_ac_pipe_02_chay_module_batch_voi_quyen_tao_issue_va_secret():
    """AC-PIPE-02: chạy `python -m lau_meme_pipeline.batch`, quyền issues: write,
    dùng secret PIPELINE_TOKEN và API_BASE_URL (biến vars, không phải secret)."""
    text = workflow_text()
    assert "python -m lau_meme_pipeline.batch" in text
    assert re.search(r"issues:\s*write", text)
    assert "secrets.PIPELINE_TOKEN" in text
    assert re.search(r"vars\.API_BASE_URL", text)


# ---------------------------------------------------------------- AC-PIPE-11


def assert_failed_cleanly(outcome, client, reporter, step: str):
    assert outcome.ok is False
    assert outcome.status == "error"
    assert outcome.version is None
    assert outcome.failed_step == step
    assert client.success_posts == [], "không được ghi nhận bản success nào"
    assert len(client.error_posts) == 1
    body = client.error_posts[0]
    assert set(body) == ERROR_KEYS
    assert body["status"] == "error"
    assert body["failed_step"] == step
    assert body["mode"] == "core"
    assert body["batch_at"] == T_ISO
    assert isinstance(body["stats"], dict)
    assert outcome.run_id is not None
    assert len(reporter.issues) == 1
    title, text = reporter.issues[0]
    assert step in text
    assert "error" in (title + text).lower()
    assert outcome.failed_step == step


def test_ac_pipe_11_loi_o_buoc_state_khong_dang_gi_va_ghi_dot_loi():
    """AC-PIPE-11: get_state ném lỗi ⇒ failed_step 'state', không đăng success, có đợt lỗi và Issue báo cáo."""
    client, reporter = FakeClient(fail_state=True), FakeReporter()
    outcome = run(client, reporter)
    assert_failed_cleanly(outcome, client, reporter, "state")


def test_ac_pipe_11_loi_o_buoc_seed_khi_kho_loi_khong_hop_le():
    """AC-PIPE-11: công thức tham chiếu phần tử không tồn tại ⇒ failed_step 'seed', không đăng success."""
    core = real_core()
    core["recipes"].append({"a": "Không Có A", "b": "Không Có B", "result": "Không Có C", "best": False})
    client, reporter = FakeClient(), FakeReporter()
    outcome = run(client, reporter, core=core)
    assert_failed_cleanly(outcome, client, reporter, "seed")


def test_ac_pipe_11_loi_deploy_khi_dang_giu_nguyen_ban_cu():
    """AC-PIPE-11: post_batch(success) ném lỗi ⇒ failed_step 'publish'; không bản success nào được ghi nhận."""
    client, reporter = FakeClient(fail_success=True), FakeReporter()
    outcome = run(client, reporter)
    assert_failed_cleanly(outcome, client, reporter, "publish")
    assert client.calls.count("post_batch") == 2  # một lần success bị lỗi + một đợt lỗi ghi nhật ký


def test_ac_pipe_11_khong_ghi_duoc_dot_loi_van_khong_nem_ngoai_le():
    """AC-PIPE-11: ghi đợt lỗi cũng ném lỗi ⇒ run_batch vẫn trả kết quả ok False, run_id None, vẫn tạo Issue."""
    client, reporter = FakeClient(fail_state=True, fail_all_posts=True), FakeReporter()
    outcome = run(client, reporter)
    assert outcome.ok is False
    assert outcome.status == "error"
    assert outcome.failed_step == "state"
    assert outcome.run_id is None
    assert client.posted == []
    assert len(reporter.issues) == 1 and "state" in reporter.issues[0][1]
    assert "patch_batch" not in client.calls


def test_ac_pipe_11_cli_tra_1_khi_that_bai_va_0_khi_thanh_cong():
    """AC-PIPE-11: main trả 1 khi mẻ lỗi (workflow đỏ) và 0 khi mẻ đăng thành công."""
    from lau_meme_pipeline.batch import main

    argv = ["--mode", "core", "--core", str(CORE_PATH)]
    ok_client, ok_reporter = FakeClient(), FakeReporter()
    assert main(argv, client=ok_client, reporter=ok_reporter, now=lambda: T) == 0
    assert len(ok_client.success_posts) == 1
    assert ok_client.success_posts[0]["batch_at"] == T_ISO
    bad_client = FakeClient(fail_success=True)
    assert main(argv, client=bad_client, reporter=FakeReporter(), now=lambda: T) == 1
    assert bad_client.success_posts == []


# ---------------------------------------------------------------- AC-PIPE-13


ALLOWED = {
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


def test_ac_pipe_13_payload_llm_chi_giu_truong_duoc_phep():
    """AC-PIPE-13: build_llm_payload trả bản sao chỉ gồm các trường công khai được phép."""
    from lau_meme_pipeline.batch import ALLOWED_LLM_FIELDS, build_llm_payload

    assert frozenset(ALLOWED) == ALLOWED_LLM_FIELDS
    items = [
        {"name": "Còn Cái Nịt", "quote": "còn cái nịt", "context": "bình luận", "source_name": "Reddit"},
        {"element_name": "Cay", "image_hint": "quả ớt đỏ"},
    ]
    payload = build_llm_payload(items)
    assert payload == items
    assert payload[0] is not items[0]
    assert build_llm_payload([]) == []
    for item in payload:
        assert set(item) <= ALLOWED


@pytest.mark.parametrize(
    "extra",
    [
        {"player_id": "p1"},
        {"uuid": "0190b1c2-0000-7000-8000-000000000000"},
        {"nickname": "Bạn A"},
        {"ip": "203.0.113.5"},
        {"steps": 12},
        {"url": "https://example.com/x"},
    ],
)
def test_ac_pipe_13_payload_llm_tu_choi_truong_ngoai_danh_sach(extra):
    """AC-PIPE-13: item có bất kỳ khóa nào ngoài danh sách cho phép (dữ liệu người chơi...)
    bị từ chối bằng ValueError."""
    from lau_meme_pipeline.batch import build_llm_payload

    with pytest.raises(ValueError):
        build_llm_payload([{"name": "Meme"}, {"name": "Meme 2", **extra}])


def test_ac_pipe_13_ma_nguon_khong_tham_chieu_bang_hay_endpoint_nguoi_choi():
    """AC-PIPE-13: mã batch không nhắc tới endpoint/bảng người chơi (me, players, discovery, consent, daily_result)."""
    assert BATCH_SOURCE.is_file(), "thiếu pipeline/src/lau_meme_pipeline/batch.py"
    source = BATCH_SOURCE.read_text(encoding="utf-8").lower()
    for needle in ("/api/me", "/api/players", "discovery", "consent", "daily_result"):
        assert needle not in source, needle


def test_ac_pipe_13_chi_goi_ba_phuong_thuc_api_cua_pipeline():
    """AC-PIPE-13: một mẻ chỉ gọi get_state / post_batch / patch_batch trên client."""
    client = FakeClient()
    outcome = run(client)
    assert outcome.ok is True
    assert set(client.calls) <= {"get_state", "post_batch", "patch_batch"}
    failing = FakeClient(fail_success=True)
    run(failing)
    assert set(failing.calls) <= {"get_state", "post_batch", "patch_batch"}


# ---------------------------------------------------------------- AC-PIPE-14


def test_ac_pipe_14_tieu_de_co_version_trang_thai_che_do_emoji_khong_lo_ten():
    """AC-PIPE-14: tiêu đề Issue có version, trạng thái, chế độ, emoji Món đặc biệt; không có tên (cả dạng fold)."""
    from lau_meme_pipeline.text import fold

    client, reporter = FakeClient(), FakeReporter()
    outcome = run(client, reporter)
    (body,) = client.success_posts
    name = daily_name_of(body)
    title = outcome.report_title
    assert title == reporter.issues[0][0]
    assert str(T_VERSION) in title
    assert "success" in title
    assert "core" in title
    assert body["manifest"]["daily"]["emoji"] in title
    assert name not in title
    assert fold(name) not in fold(title)


def test_ac_pipe_14_noi_dung_bao_cao_du_so_lieu():
    """AC-PIPE-14: nội dung có version, batch_at, chế độ, trạng thái, số crawl/thêm/chặn/hàng chờ,
    lỗi nguồn, quota, METRIC."""
    client, reporter = FakeClient(), FakeReporter()
    outcome = run(client, reporter)
    text = outcome.report_body
    assert text == reporter.issues[0][1]
    assert str(T_VERSION) in text
    assert T_ISO in text
    assert "core" in text
    assert "success" in text
    for label in ("crawled", "added", "blocked", "queued"):
        assert re.search(rf"{label}\W{{1,4}}0", text, re.I), label
    assert re.search(r"source[ _]errors|lỗi nguồn|nguồn", text, re.I)
    assert re.search(r"quota\W{1,4}0", text, re.I)
    assert "METRIC" in text


def test_ac_pipe_14_loi_tao_issue_chi_ghi_log_khong_lam_dot_that_bai():
    """AC-PIPE-14: create_issue ném lỗi ⇒ mẻ vẫn thành công, issue_url None, lỗi chỉ ghi log, không PATCH."""
    client, reporter = FakeClient(), FakeReporter(fail=True)
    logs: list[str] = []
    outcome = run(client, reporter, log=logs.append)
    assert outcome.ok is True
    assert outcome.status == "success"
    assert outcome.issue_url is None
    assert len(client.success_posts) == 1
    assert "patch_batch" not in client.calls
    assert len(reporter.issues) == 1
    assert any("github down" in m or "issue" in m.lower() for m in logs)


def test_ac_pipe_14_chay_local_khong_co_github_repository_van_dang_me(monkeypatch, capsys):
    """AC-PIPE-14: chạy local (không có GITHUB_REPOSITORY) ⇒ không tạo Issue, mẻ vẫn đăng, báo cáo in ra màn hình."""
    from lau_meme_pipeline.batch import main

    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    client = FakeClient()
    assert main(["--mode", "core", "--core", str(CORE_PATH)], client=client, now=lambda: T) == 0
    assert len(client.success_posts) == 1
    assert "patch_batch" not in client.calls
    assert capsys.readouterr().out.strip() != ""


def test_ac_pipe_14_bao_cao_dot_loi_ghi_trang_thai_va_buoc_loi():
    """AC-PIPE-14: đợt lỗi vẫn có Issue với trạng thái error và bước lỗi trong tiêu đề hoặc nội dung."""
    client, reporter = FakeClient(fail_success=True), FakeReporter()
    outcome = run(client, reporter)
    assert outcome.status == "error"
    assert "error" in outcome.report_title
    assert "core" in outcome.report_title
    assert "publish" in outcome.report_body
    assert "error" in outcome.report_body
    assert "core" in outcome.report_body
    assert T_ISO in outcome.report_body
    assert client.patches == [(outcome.run_id, outcome.issue_url)]
