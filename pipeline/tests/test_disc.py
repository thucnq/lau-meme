"""Acceptance tests for docs/acceptance/disc.md, pipeline part: AC-DISC-03 (sync of the banned wordlist, ADR 0005).

Expected additions to `lau_meme_pipeline.batch`:

    run_batch(..., banned_words=())            # new keyword argument
    client.put_banned_terms(source, terms)     # called with ("wordlist", sorted unique folded terms) before post_batch
    main(argv, *, client, reporter, now)       # reads env BANNED_WORDS (newline-separated)

No network, no clock. Expected terms are written out by hand (never computed with production code).
"""

import copy
import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)

SECRET = "Từ Cấm Siêu Bí Mật"
SECRET_FOLD = "tu cam sieu bi mat"


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def make_state() -> dict:
    return {
        "current_version": None,
        "blocklist": {"elements": [], "recipes": [], "images": []},
        "banned_aliases": [],
        "daily_history": [],
        "feedback": [],
    }


class FakeClient:
    def __init__(self, fail_put=False):
        self.fail_put = fail_put
        self.calls: list[str] = []
        self.puts: list[tuple[str, list[str]]] = []
        self.posted: list[dict] = []
        self.patches: list[tuple] = []

    def get_state(self):
        self.calls.append("get_state")
        return copy.deepcopy(make_state())

    def put_banned_terms(self, source, terms):
        self.calls.append("put_banned_terms")
        if self.fail_put:
            raise RuntimeError("banned terms unavailable")
        self.puts.append((source, list(terms)))

    def post_batch(self, body):
        self.calls.append("post_batch")
        self.posted.append(copy.deepcopy(body))
        return {
            "id": f"00000000-0000-4000-8000-{len(self.posted):012d}",
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


class FakeReporter:
    def __init__(self):
        self.issues: list[tuple[str, str]] = []

    def create_issue(self, title, body):
        self.issues.append((title, body))
        return f"https://github.com/o/r/issues/{len(self.issues)}"


def run(client, reporter=None, log=None, **kw):
    from lau_meme_pipeline.batch import run_batch

    return run_batch(
        mode="core",
        batch_at=T,
        core=real_core(),
        client=client,
        reporter=reporter if reporter is not None else FakeReporter(),
        log=log if log is not None else (lambda msg: None),
        **kw,
    )


def test_ac_disc_03_dong_bo_wordlist_da_fold_sap_xep_bo_trung_truoc_khi_dang_mau():
    """AC-DISC-03: banned_words được fold, bỏ trùng, bỏ dòng rỗng, sắp xếp rồi PUT 'wordlist' trước post_batch."""
    client = FakeClient()
    words = ["Từ Cấm", "TU CAM", "  Zed  ", "", "   ", "Đồ Xấu", "a" * 101]
    outcome = run(client, banned_words=words)
    assert outcome.ok is True
    assert client.puts == [("wordlist", ["do xau", "tu cam", "zed"])]
    assert client.calls.index("put_banned_terms") < client.calls.index("post_batch")
    assert len(client.success_posts) == 1


def test_ac_disc_03_danh_sach_rong_khong_goi_put_de_khong_xoa_trang_danh_sach():
    """AC-DISC-03: banned_words rỗng (mặc định hoặc chỉ dòng trống) thì KHÔNG gọi put_banned_terms."""
    for kw in ({}, {"banned_words": ()}, {"banned_words": []}, {"banned_words": ["", "  "]}):
        client = FakeClient()
        outcome = run(client, **kw)
        assert outcome.ok is True, kw
        assert "put_banned_terms" not in client.calls, kw
        assert client.puts == []


def test_ac_disc_03_tu_cam_khong_xuat_hien_trong_log_hay_bao_cao():
    """AC-DISC-03: từ cấm (bản gốc và bản fold) không bao giờ có trong log, tiêu đề hay nội dung báo cáo."""
    client, reporter = FakeClient(), FakeReporter()
    logs: list[str] = []
    outcome = run(client, reporter, log=logs.append, banned_words=[SECRET, "Zed"])
    assert client.puts == [("wordlist", ["tu cam sieu bi mat", "zed"])]
    haystack = "\n".join([*logs, outcome.report_title, outcome.report_body, *(t + b for t, b in reporter.issues)]).lower()
    assert SECRET.lower() not in haystack
    assert SECRET_FOLD not in haystack
    assert "sieu bi mat" not in haystack


def test_ac_disc_03_put_loi_thi_khong_dang_mau_success():
    """AC-DISC-03: put_banned_terms ném lỗi thì không đăng bản success nào (như AC-PIPE-11) và từ cấm không lộ ra log."""
    client, reporter = FakeClient(fail_put=True), FakeReporter()
    logs: list[str] = []
    outcome = run(client, reporter, log=logs.append, banned_words=[SECRET])
    assert outcome.ok is False
    assert outcome.status == "error"
    assert client.success_posts == []
    haystack = "\n".join([*logs, outcome.report_title, outcome.report_body]).lower()
    assert SECRET.lower() not in haystack
    assert SECRET_FOLD not in haystack


def test_ac_disc_03_main_doc_bien_moi_truong_banned_words(monkeypatch):
    """AC-DISC-03: main đọc BANNED_WORDS (mỗi dòng một từ) và truyền vào run_batch."""
    from lau_meme_pipeline.batch import main

    monkeypatch.setenv("BANNED_WORDS", "Từ Cấm\n\nZed\n  \nTU CAM\n")
    client = FakeClient()
    code = main(["--mode", "core", "--core", str(CORE_PATH)], client=client, reporter=FakeReporter(), now=lambda: T)
    assert code == 0
    assert client.puts == [("wordlist", ["tu cam", "zed"])]
    assert len(client.success_posts) == 1


def test_ac_disc_03_main_khong_co_banned_words_thi_khong_goi_put(monkeypatch):
    """AC-DISC-03: không đặt BANNED_WORDS (hoặc rỗng) thì main không gọi put_banned_terms."""
    from lau_meme_pipeline.batch import main

    for value in (None, ""):
        if value is None:
            monkeypatch.delenv("BANNED_WORDS", raising=False)
        else:
            monkeypatch.setenv("BANNED_WORDS", value)
        client = FakeClient()
        code = main(["--mode", "core", "--core", str(CORE_PATH)], client=client, reporter=FakeReporter(), now=lambda: T)
        assert code == 0
        assert "put_banned_terms" not in client.calls


def test_ac_disc_03_tu_dai_hon_100_ky_tu_bi_bo():
    """AC-DISC-03: từ dài hơn 100 ký tự bị bỏ (khớp giới hạn 1–100 của hợp đồng); từ đúng 100 ký tự được giữ."""
    client = FakeClient()
    run(client, banned_words=["b" * 101, "c" * 100])
    assert client.puts == [("wordlist", ["c" * 100])]
