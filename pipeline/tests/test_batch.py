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


def make_state(history: list | None = None, blocked_elements: list | None = None, catalog: list | None = None) -> dict:
    return {
        "catalog": list(catalog or []),
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
    assert len(content["recipes"]) == len(core["recipes"]) == 518
    expected = {recipe_id(r["a"], r["b"]): eid(r["result"]) for r in core["recipes"]}
    assert {r["id"]: r["result"] for r in content["recipes"]} == expected
    for r in content["recipes"]:
        assert set(r) <= {"id", "a", "b", "result", "score"} and {"id", "a", "b", "result"} <= set(r)
    ids = {e["id"] for e in content["elements"]}
    assert all(r["a"] in ids and r["b"] in ids and r["result"] in ids for r in content["recipes"])


def hinted_core_names(core: dict | None = None) -> list[str]:
    """Core elements that can be a daily dish: depth 4-8 with a hand-written `daily_hint` (AC-DAILY-01, 2026-10-23)."""
    core = core or real_core()
    return [e["name"] for e in core["elements"] if 4 <= e["depth"] <= 8 and e.get("daily_hint")]


def test_ac_pipe_01_mon_dac_biet_lay_tu_phan_tu_loi_co_daily_hint():
    """AC-PIPE-01 / AC-DAILY-01: lịch sử rỗng thì Món đặc biệt là phần tử lõi depth 4-8 có daily_hint,
    gợi ý và emoji đúng theo file lõi."""
    core = real_core()
    client = FakeClient()
    run(client)
    (body,) = client.success_posts
    name = daily_name_of(body)
    assert name in hinted_core_names(core)
    element = next(e for e in core["elements"] if e["name"] == name)
    assert body["manifest"]["daily"]["hint"] == element["daily_hint"]
    assert body["manifest"]["daily"]["emoji"] == element["emoji"]


def test_ac_pipe_01_mon_dac_biet_khong_lap_lai_mon_trong_30_me_gan_nhat():
    """AC-PIPE-01 / AC-DAILY-01: 30 mẻ gần nhất đã dùng 30 món lõi thì mẻ mới chọn món khác, không báo pool cạn."""
    names = hinted_core_names()
    assert len(names) >= 31
    recent = names[:30]
    history = [hist(t, i + 1) for i, t in enumerate(recent)]
    client, reporter = FakeClient(make_state(history=history)), FakeReporter()
    outcome = run(client, reporter)
    (body,) = client.success_posts
    assert daily_name_of(body) not in recent
    assert not body["stats"].get("daily_pool_exhausted")
    assert "Pool thử thách cạn" not in outcome.report_body


def test_ac_pipe_01_mon_dac_biet_khong_chon_phan_tu_bi_chan():
    """AC-PIPE-01: phần tử trong blocklist.elements không bao giờ được chọn, kể cả khi nó đứng đầu bảng xếp."""
    first = FakeClient()
    run(first)
    top = daily_name_of(first.success_posts[0])
    client = FakeClient(make_state(blocked_elements=[eid(top)]))
    run(client)
    (body,) = client.success_posts
    assert daily_name_of(body) != top
    assert body["content"]["daily_element_id"] != eid(top)


def test_ac_pipe_01_moi_target_bi_chan_thi_that_bai_o_buoc_daily():
    """AC-PIPE-01: mọi ứng viên lõi bị chặn ⇒ không chọn được Món đặc biệt (AC-DAILY-02).

    Mẻ lỗi ở bước daily, không đăng.
    """
    blocked = [eid(t) for t in hinted_core_names()]
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


STAGING_CRON = r"0 \*/2 \* \* \*"
EVEN_HOURS = "0,2,4,6,8,10,12,14,16,18,20,22"


def test_ac_pipe_02_staging_cron_moi_2_tieng_ben_canh_hai_cron_production():
    """AC-PIPE-02 (2026-10-23): ngoài '0 17 * * *' và '0 5 * * *' còn cron '0 */2 * * *' cho staging."""
    text = workflow_text()
    assert re.search(rf"cron:\s*['\"]{STAGING_CRON}['\"]", text)
    assert re.search(r"cron:\s*['\"]0 17 \* \* \*['\"]", text)
    assert re.search(r"cron:\s*['\"]0 5 \* \* \*['\"]", text)


def test_ac_pipe_02_moi_truong_chon_theo_github_event_schedule():
    """AC-PIPE-02: cron nào kích hoạt thì chọn môi trường đó qua github.event.schedule: cron '0 */2 * * *' ⇒ staging,
    hai cron còn lại ⇒ production; chạy tay vẫn theo inputs.target."""
    text = workflow_text()
    assert "github.event.schedule" in text
    assert re.search(rf"github\.event\.schedule\s*[=!]=\s*['\"]{STAGING_CRON}['\"]", text), (
        "môi trường phải được chọn bằng cách so github.event.schedule với cron staging"
    )
    env_line = re.search(r"^\s*environment:\s*(.+)$", text, re.M)
    assert env_line, "thiếu environment ở job"
    assert "github.event.schedule" in env_line.group(1) or "needs." in env_line.group(1)
    assert "inputs.target" in env_line.group(1) or "needs." in env_line.group(1)
    assert "staging" in env_line.group(1) or "needs." in env_line.group(1)


def test_ac_pipe_02_batch_hours_utc_khop_lich_cron_cua_moi_truong():
    """AC-PIPE-02 / AC-DAILY-12: workflow đặt BATCH_HOURS_UTC cho bước chạy mẻ; staging 0,2,...,22, production 5,17."""
    text = workflow_text()
    assert "BATCH_HOURS_UTC" in text
    assert EVEN_HOURS in text.replace(" ", ""), "thiếu lịch staging 0,2,4,...,22"
    assert re.search(r"(?<![\d,])5,\s*17(?![\d,])", text), "thiếu lịch production 5,17"


def test_ac_pipe_02_chay_tay_chon_che_do_va_moi_truong():
    """AC-PIPE-02: workflow_dispatch có input mode (core/full) và input target (staging/production)."""
    text = workflow_text()
    match = re.search(r"^\s*workflow_dispatch:(.*?)(?=^\S|^\s{0,2}\w[\w-]*:\s*$)", text, re.M | re.S)
    assert match, "thiếu workflow_dispatch"
    block = match.group(1)
    assert re.search(r"^\s*mode:", block, re.M) and re.search(r"^\s*target:", block, re.M)
    assert "staging" in block and "production" in block


def test_ac_pipe_02_concurrency_theo_moi_truong_khong_de_hai_me_cung_moi_truong_chay_chung():
    """AC-PIPE-02: nhóm concurrency phụ thuộc môi trường (cả chạy tay lẫn cron) để cron staging và cron production
    không chung một nhóm, còn hai mẻ cùng môi trường thì xếp hàng (không hủy mẻ đang chạy)."""
    text = workflow_text()
    match = re.search(r"^concurrency:\s*\n((?:[ \t]+.*\n)+)", text, re.M)
    assert match, "thiếu khối concurrency ở cấp workflow"
    block = match.group(1)
    group = re.search(r"group:\s*(.+)", block)
    assert group and "${{" in group.group(1), "group phải là biểu thức theo môi trường, không phải hằng số"
    assert "inputs.target" in group.group(1)
    assert "github.event.schedule" in group.group(1) or "needs." in group.group(1)
    assert re.search(r"cancel-in-progress:\s*false", block)
    assert re.search(r"timeout-minutes:\s*15\b", text)


# ---------------------------------------------------------------- AC-DAILY-12 (pipeline): BATCH_HOURS_UTC


def run_main(monkeypatch, hours: str | None):
    from lau_meme_pipeline.batch import main

    if hours is None:
        monkeypatch.delenv("BATCH_HOURS_UTC", raising=False)
    else:
        monkeypatch.setenv("BATCH_HOURS_UTC", hours)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    client = FakeClient()
    rc = main(["--mode", "core", "--core", str(CORE_PATH)], client=client, now=lambda: T)
    return rc, client


def test_ac_daily_12_pipeline_mac_dinh_lich_5_17_khi_khong_dat_batch_hours_utc(monkeypatch):
    """AC-DAILY-12: không đặt BATCH_HOURS_UTC thì manifest.schedule_hours_utc = [5, 17]."""
    rc, client = run_main(monkeypatch, None)
    assert rc == 0
    assert client.success_posts[0]["manifest"]["schedule_hours_utc"] == [5, 17]


def test_ac_daily_12_pipeline_doc_lich_tu_batch_hours_utc(monkeypatch):
    """AC-DAILY-12: BATCH_HOURS_UTC='5,17' và '0,2,...,22' được đưa vào manifest.schedule_hours_utc."""
    rc, client = run_main(monkeypatch, "5,17")
    assert rc == 0
    assert client.success_posts[0]["manifest"]["schedule_hours_utc"] == [5, 17]
    rc, client = run_main(monkeypatch, EVEN_HOURS)
    assert rc == 0
    assert client.success_posts[0]["manifest"]["schedule_hours_utc"] == list(range(0, 24, 2))


@pytest.mark.parametrize("hours", ["", "24", "-1", "5,5", "abc", "5,,17", "5.5", "17,25", "0,2,2"])
def test_ac_daily_12_pipeline_lich_khong_hop_le_thi_me_that_bai_theo_pipe_11(monkeypatch, hours):
    """AC-DAILY-12: BATCH_HOURS_UTC ngoài 0-23, rỗng, trùng hay không phải số ⇒ mẻ thất bại: main trả 1,
    không đăng bản success, có đợt lỗi (AC-PIPE-11)."""
    rc, client = run_main(monkeypatch, hours)
    assert rc == 1
    assert client.success_posts == []
    assert len(client.error_posts) == 1
    assert client.error_posts[0]["status"] == "error"


# ---------------------------------------------------------------- AC-DAILY-01 (pool cạn) / AC-DAILY-18


def hist_at(name: str, version: int) -> dict:
    return {"version": version, "element_id": eid(name), "batch_at": f"2026-09-{(version % 28) + 1:02d}T17:00:00Z"}


def core_with_only(names: list[str]) -> dict:
    """Real core where only `names` keep their daily_hint or daily_examples entry (so only they can be a dish)."""
    core = real_core()
    for e in core["elements"]:
        if e["name"] not in names:
            e.pop("daily_hint", None)
    core["daily_examples"] = [ex for ex in core.get("daily_examples", []) if ex["target"] in names]
    assert sorted(hinted_core_names(core)) == sorted(names)
    return core


def test_ac_daily_01_pool_can_thi_lay_mon_cu_nhat_va_bao_cao_canh_bao():
    """AC-DAILY-01: mọi ứng viên đều nằm trong 30 mẻ gần nhất ⇒ chọn món có lần làm Món đặc biệt gần nhất cũ nhất,
    stats.daily_pool_exhausted = true và báo cáo đợt ghi "Pool thử thách cạn"; mẻ vẫn thành công."""
    pool = ["Stonks", "Bao Giờ Cưới", "Mẹ Giữ Hộ"]
    history = [hist_at(pool[i % 3], i + 1) for i in range(30)]  # lần dùng gần nhất: pool[0] ở mẻ 28 là cũ nhất
    client, reporter = FakeClient(make_state(history=history)), FakeReporter()
    outcome = run(client, reporter, core=core_with_only(pool))
    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert daily_name_of(body) == pool[0]
    assert body["stats"]["daily_pool_exhausted"] is True
    assert "Pool thử thách cạn" in outcome.report_body
    assert "Pool thử thách cạn" in reporter.issues[0][1]


def test_ac_daily_01_con_ung_vien_ngoai_cua_so_thi_khong_bao_pool_can():
    """AC-DAILY-01: cửa sổ tính theo mẻ - món dùng cách đây 31 mẻ được chọn lại và không có cảnh báo; món dùng cách
    đây 30 mẻ vẫn bị loại (pool cạn)."""
    pool = ["Stonks", "Mì Tôm"]
    core = core_with_only(pool)
    # 31 mẻ: Stonks ở mẻ 1 rơi khỏi cửa sổ 30 mẻ gần nhất, 30 mẻ sau toàn Mì Tôm
    older = [hist_at("Stonks", 1)] + [hist_at("Mì Tôm", v) for v in range(2, 32)]
    client, reporter = FakeClient(make_state(history=older)), FakeReporter()
    outcome = run(client, reporter, core=core)
    (body,) = client.success_posts
    assert daily_name_of(body) == "Stonks"
    assert not body["stats"].get("daily_pool_exhausted")
    assert "Pool thử thách cạn" not in outcome.report_body
    # 30 mẻ: Stonks ở mẻ 2 vẫn nằm trong cửa sổ -> cả hai bị loại -> cạn, lấy món cũ nhất = Stonks
    inside = [hist_at("Stonks", 2)] + [hist_at("Mì Tôm", v) for v in range(3, 32)]
    assert len(inside) == 30
    client2, reporter2 = FakeClient(make_state(history=inside)), FakeReporter()
    outcome2 = run(client2, reporter2, core=core)
    (body2,) = client2.success_posts
    assert daily_name_of(body2) == "Stonks"
    assert body2["stats"]["daily_pool_exhausted"] is True
    assert "Pool thử thách cạn" in outcome2.report_body


OLD_FIRST_VERSION = 202610202349  # mẻ đầu tiên của 139 phần tử lõi cũ
NEW_FIRST_VERSION = 202610221029  # mẻ đầu tiên của 35 phần tử thêm vào lõi ngày 22/10


def core_catalog() -> list[dict]:
    """Worker state `catalog` (GET /pipeline/state): first 139 core elements present since an earlier batch, the 35
    appended on 2026-10-22 (indices 139..173) since a later one; all trend_peak = 0."""
    elements = real_core()["elements"]
    assert len(elements) == 174
    return [
        {
            "id": eid(e["name"]),
            "first_version": OLD_FIRST_VERSION if i < len(elements) - 35 else NEW_FIRST_VERSION,
            "trend_peak": 0,
        }
        for i, e in enumerate(elements)
    ]


_SIM: dict[int, list[str]] = {}


def simulate_core_batches(count: int) -> list[str]:
    """Run `count` consecutive core batches (12 hours apart, versions ascending), feeding each pick back as history."""
    if count in _SIM:
        return _SIM[count]
    history: list[dict] = []
    picks: list[str] = []
    catalog = core_catalog()
    for i in range(count):
        batch_at = T + timedelta(hours=12 * i)
        client = FakeClient(make_state(history=history, catalog=catalog))
        outcome = run(client, batch_at=batch_at)
        assert outcome.ok is True, f"mẻ {i + 1} thất bại ở bước {outcome.failed_step}"
        (body,) = client.success_posts
        picks.append(daily_name_of(body))
        history.append(
            {
                "version": body["version"],
                "element_id": body["content"]["daily_element_id"],
                "batch_at": body["batch_at"],
            }
        )
        assert not body["stats"].get("daily_pool_exhausted"), f"mẻ {i + 1} không được báo pool cạn"
    _SIM[count] = picks
    return picks


def test_ac_daily_18_90_me_core_59_mon_dau_khac_nhau_khong_lap_trong_30_me():
    """AC-DAILY-18: 90 mẻ core liên tiếp trên lõi thật: 59 mẻ đầu 59 món khác nhau, mọi cửa sổ 30 mẻ không lặp,
    không mẻ nào thất bại, mọi món là phần tử lõi depth 4-8 có daily_hint."""
    names = hinted_core_names()
    assert len(names) == 59
    picks = simulate_core_batches(90)
    assert len(picks) == 90
    assert len(set(picks[:59])) == 59
    assert set(picks[:59]) == set(names)
    assert set(picks) <= set(names)
    for start in range(0, 90 - 30 + 1):
        window = picks[start : start + 30]
        assert len(set(window)) == 30, f"lặp món trong cửa sổ bắt đầu ở mẻ {start + 1}"


def test_ac_daily_18_35_phan_tu_moi_cua_loi_dung_truoc_phan_loi_cu():
    """AC-DAILY-18: 35 phần tử thêm vào lõi ngày 22/10 (35 phần tử cuối trong file lõi) có mặt từ mẻ muộn hơn nên
    mọi mẻ chọn trong số chúng đứng trước phần lõi cũ khi cùng trend_peak = 0."""
    core = real_core()
    new_elements = {e["name"] for e in core["elements"][-35:]}
    new_candidates = {n for n in hinted_core_names(core) if n in new_elements}
    assert new_candidates, "35 phần tử cuối của lõi phải có ứng viên Món đặc biệt"
    picks = simulate_core_batches(90)
    assert set(picks[: len(new_candidates)]) == new_candidates


def test_ac_daily_18_chay_lai_cung_chuoi_version_ra_cung_chuoi_mon():
    """AC-DAILY-18: chạy lại cùng chuỗi version cho đúng cùng chuỗi món (tất định)."""
    first = simulate_core_batches(90)
    _SIM.pop(90)
    second = simulate_core_batches(90)
    assert first == second


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
    # whole path segment: "/api/metrics" (AC-METRIC-06, aggregate numbers only) is not "/api/me"
    assert not re.search(r"/api/me(?![a-z0-9_-])", source), "/api/me"
    for needle in ("/api/players", "discovery", "consent", "daily_result"):
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
