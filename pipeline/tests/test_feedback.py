"""Acceptance tests for docs/acceptance/feedback.md, pipeline part: AC-FEEDBACK-04.

Expected module `lau_meme_pipeline.feedback` (does not exist yet; the pure rule, no I/O, no clock):

    hidden_recipes(feedback: list[dict]) -> Collection[str]
        `feedback` is PipelineState.feedback (docs/api/openapi.yaml): items {recipe_id, votes, nhat},
        anonymous, no UUID.
        Returns the recipe ids that must be hidden: votes >= 10 and nhat / votes >= 0.6 (default threshold, open
        question 15). Both bounds are inclusive. Order of the input does not matter; entries with 0 votes never divide.

The batch integration goes through the existing `lau_meme_pipeline.batch.run_batch` (same call shape as
test_batch.py): the state returned by the client carries `feedback`, and the hidden recipe must be missing from the
new graph (`body["graph"]["entries"]` keys and `body["content"]["recipes"]` ids are the recipe ids of ADR 0002),
while a recipe that is the only one keeping an element reachable stays in the graph and only produces a warning.
The batch report (`outcome.report_body`) lists hidden recipes on a line that contains the word "Nhạt" and the names of
both input elements of the recipe. All data come from the real core (docs/input/noi-dung-loi.json); the recipes used
are picked from that file by shape, so no number is computed with production code.
"""

import copy
import json
import re
import unicodedata
from base64 import urlsafe_b64encode
from collections import defaultdict
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------- helpers (ADR 0002, independent of production code)


def fold(s: str) -> str:
    s = s.lower().replace("đ", "d")
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s).strip()


def recipe_id(a: str, b: str) -> str:
    x, y = sorted([fold(a), fold(b)])
    digest = sha256(f"lm1|k|{x}\0{y}".encode()).digest()
    return urlsafe_b64encode(digest).decode().rstrip("=")


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def make_state(feedback: list | None = None) -> dict:
    return {
        "catalog": [],
        "current_version": None,
        "blocklist": {"elements": [], "recipes": [], "images": []},
        "banned_aliases": [],
        "daily_history": [],
        "feedback": list(feedback or []),
    }


class FakeClient:
    def __init__(self, state):
        self.state = state
        self.posted: list[dict] = []
        self._n = 0

    def get_state(self):
        return copy.deepcopy(self.state)

    def post_batch(self, body):
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
        return {"id": run_id, "issue_url": issue_url}


class FakeReporter:
    def __init__(self):
        self.issues: list[tuple[str, str]] = []

    def create_issue(self, title, body):
        self.issues.append((title, body))
        return f"https://github.com/o/r/issues/{len(self.issues)}"


def run(feedback):
    from lau_meme_pipeline.batch import run_batch

    client = FakeClient(make_state(feedback))
    outcome = run_batch(
        mode="core",
        batch_at=T,
        core=real_core(),
        client=client,
        reporter=FakeReporter(),
        log=lambda msg: None,
    )
    return outcome, client


# ---------------------------------------------------------------- picking recipes from the core by shape


def pick_recipes() -> dict:
    """X: result with >= 2 equally-deep recipes (hiding X keeps every depth); Y: any disjoint recipe;
    S: the only recipe that produces its result (hiding it would make that element unreachable)."""
    core = real_core()
    depth = {e["name"]: e["depth"] for e in core["elements"]}
    by_result: dict[str, list[dict]] = defaultdict(list)
    for r in core["recipes"]:
        by_result[r["result"]].append(r)

    def level(r):
        return max(depth[r["a"]], depth[r["b"]]) + 1

    def names(r):
        return {r["a"], r["b"], r["result"]}

    x = next(
        r
        for res, rs in by_result.items()
        if depth[res] >= 1
        for r in rs
        if r["a"] != r["b"] and sum(1 for o in rs if level(o) == depth[res]) >= 2 and level(r) == depth[res]
    )
    y = next(r for r in core["recipes"] if r["a"] != r["b"] and not (names(r) & names(x)))
    s = next(
        rs[0]
        for res, rs in by_result.items()
        if len(rs) == 1 and depth[res] >= 1 and rs[0]["a"] != rs[0]["b"] and not (names(rs[0]) & (names(x) | names(y)))
    )
    return {"x": x, "y": y, "s": s}


def rid(r: dict) -> str:
    return recipe_id(r["a"], r["b"])


def fb(r: dict, votes: int, nhat: int) -> dict:
    return {"recipe_id": rid(r), "votes": votes, "nhat": nhat}


def recipe_ids_in(body: dict) -> set[str]:
    return {r["id"] for r in body["content"]["recipes"]}


def graph_keys(body: dict) -> set[str]:
    return set(body["graph"]["entries"].keys())


def lines_about(report: str, r: dict, word: str) -> list[str]:
    return [ln for ln in report.splitlines() if word in ln and r["a"] in ln and r["b"] in ln]


@pytest.fixture(scope="module")
def picked() -> dict:
    return pick_recipes()


@pytest.fixture(scope="module")
def baseline(picked):
    outcome, client = run([])
    assert outcome.ok is True
    return client.posted[0]


@pytest.fixture(scope="module")
def with_votes(picked):
    """X: 12 votes, 8 Nhạt; Y: 5 votes, 5 Nhạt; S (only recipe of its result): 20 votes, 18 Nhạt."""
    outcome, client = run([fb(picked["x"], 12, 8), fb(picked["y"], 5, 5), fb(picked["s"], 20, 18)])
    return outcome, client.posted[0]


# ---------------------------------------------------------------- pure rule: hidden_recipes


def test_ac_feedback_04_hidden_recipes_vi_du_trong_ac():
    """AC-FEEDBACK-04: X (12 phiếu, 8 Nhạt) bị ẩn; Y (5 phiếu, 5 Nhạt) chưa đủ phiếu nên giữ."""
    from lau_meme_pipeline.feedback import hidden_recipes

    x, y = recipe_id("Cay", "Cười"), recipe_id("Toang", "Deadline")
    out = hidden_recipes([{"recipe_id": x, "votes": 12, "nhat": 8}, {"recipe_id": y, "votes": 5, "nhat": 5}])
    assert set(out) == {x}


@pytest.mark.parametrize(
    ("votes", "nhat", "hidden"),
    [
        (10, 6, True),  # đúng ngưỡng: >= 10 phiếu và >= 60 %
        (10, 5, False),  # 50 %
        (10, 10, True),
        (9, 9, False),  # 100 % Nhạt nhưng chưa đủ 10 phiếu
        (9, 6, False),
        (11, 6, False),  # 54,5 %
        (11, 7, True),  # 63,6 %
        (100, 59, False),
        (100, 60, True),
        (10, 0, False),
        (0, 0, False),  # không chia cho 0
    ],
)
def test_ac_feedback_04_hidden_recipes_bien_nguong(votes, nhat, hidden):
    """AC-FEEDBACK-04: ngưỡng mặc định >= 10 phiếu và >= 60 % Nhạt, cả hai biên đều tính."""
    from lau_meme_pipeline.feedback import hidden_recipes

    r = recipe_id("Cay", "Cười")
    assert (r in set(hidden_recipes([{"recipe_id": r, "votes": votes, "nhat": nhat}]))) is hidden


def test_ac_feedback_04_hidden_recipes_khong_phu_thuoc_thu_tu_va_khong_sua_dau_vao():
    """AC-FEEDBACK-04: thứ tự đầu vào không đổi kết quả; hàm không sửa danh sách tổng hợp; rỗng trả rỗng."""
    from lau_meme_pipeline.feedback import hidden_recipes

    items = [
        {"recipe_id": recipe_id("Cay", "Cười"), "votes": 12, "nhat": 8},
        {"recipe_id": recipe_id("Toang", "Deadline"), "votes": 5, "nhat": 5},
        {"recipe_id": recipe_id("Cay", "Toang"), "votes": 30, "nhat": 30},
    ]
    snapshot = copy.deepcopy(items)
    forward = set(hidden_recipes(items))
    assert forward == {items[0]["recipe_id"], items[2]["recipe_id"]}
    assert set(hidden_recipes(list(reversed(items)))) == forward
    assert items == snapshot
    assert set(hidden_recipes([])) == set()


# ---------------------------------------------------------------- batch integration


def test_ac_feedback_04_doi_chung_x_co_trong_graph_khi_chua_co_phieu(picked, baseline):
    """AC-FEEDBACK-04: đối chứng, không có phiếu thì X, Y, S đều có trong graph và công thức của mẻ."""
    for key in ("x", "y", "s"):
        assert rid(picked[key]) in recipe_ids_in(baseline)
        assert rid(picked[key]) in graph_keys(baseline)


def test_ac_feedback_04_x_bi_an_khoi_graph_moi(picked, with_votes):
    """AC-FEEDBACK-04: X (>= 10 phiếu, >= 60 % Nhạt) không còn trong graph mới và danh sách công thức;
    mẻ vẫn thành công."""
    outcome, body = with_votes
    assert outcome.ok is True
    assert body["status"] == "success"
    assert rid(picked["x"]) not in graph_keys(body)
    assert rid(picked["x"]) not in recipe_ids_in(body)


def test_ac_feedback_04_y_giu_nguyen_vi_chua_du_phieu(picked, baseline, with_votes):
    """AC-FEEDBACK-04: Y (5 phiếu, 5 Nhạt) chưa đủ phiếu nên vẫn trong graph;
    chỉ X (và không công thức nào khác ngoài đường duy nhất) mất."""
    _, body = with_votes
    assert rid(picked["y"]) in graph_keys(body)
    assert rid(picked["y"]) in recipe_ids_in(body)
    assert recipe_ids_in(baseline) - recipe_ids_in(body) == {rid(picked["x"])}


def test_ac_feedback_04_cong_thuc_duy_nhat_giu_phan_tu_tuoi_duoc_van_con_va_chi_canh_bao(picked, with_votes):
    """AC-FEEDBACK-04: S là công thức duy nhất cho phần tử của nó, dù 18/20 Nhạt vẫn ở lại graph;
    báo cáo đợt nhắc tới S."""
    outcome, body = with_votes
    s = picked["s"]
    assert rid(s) in graph_keys(body)
    assert rid(s) in recipe_ids_in(body)
    assert outcome.ok is True
    report_lines = outcome.report_body.splitlines()
    assert any(s["a"] in ln and s["b"] in ln for ln in report_lines), "báo cáo phải có cảnh báo về S"


def test_ac_feedback_04_bao_cao_dot_liet_ke_cong_thuc_bi_an_do_nhat(picked, with_votes):
    """AC-FEEDBACK-04: báo cáo đợt có dòng chứa "Nhạt" cùng tên hai phần tử của X;
    Y không bị liệt kê là bị ẩn do Nhạt."""
    outcome, _ = with_votes
    assert lines_about(outcome.report_body, picked["x"], "Nhạt"), outcome.report_body
    assert lines_about(outcome.report_body, picked["y"], "Nhạt") == []


def test_ac_feedback_04_khong_co_phieu_thi_bao_cao_khong_nhac_nhat(picked):
    """AC-FEEDBACK-04: không công thức nào đạt ngưỡng thì graph giữ đủ công thức
    và báo cáo không liệt kê công thức bị ẩn do Nhạt."""
    outcome, client = run([fb(picked["x"], 9, 9), fb(picked["y"], 10, 5)])
    body = client.posted[0]
    assert outcome.ok is True
    assert rid(picked["x"]) in graph_keys(body)
    assert rid(picked["y"]) in graph_keys(body)
    assert lines_about(outcome.report_body, picked["x"], "Nhạt") == []
    assert lines_about(outcome.report_body, picked["y"], "Nhạt") == []


def test_ac_feedback_04_phieu_cua_cong_thuc_khong_ton_tai_bi_bo_qua(picked):
    """AC-FEEDBACK-04: tổng hợp có recipe_id lạ (công thức đã rút khỏi core) không làm mẻ lỗi."""
    ghost = {"recipe_id": recipe_id("Rp Không Có", "Cũng Không Có"), "votes": 50, "nhat": 50}
    outcome, client = run([ghost])
    assert outcome.ok is True
    assert len(client.posted) == 1
    assert client.posted[0]["status"] == "success"
