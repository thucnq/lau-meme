"""Acceptance tests for docs/acceptance/daily.md (pipeline part: AC-DAILY-01, 02, 03).

Expected module `lau_meme_pipeline.daily` (pure, no network/clock/randomness):

    select_daily(candidates, history, version) -> Mapping   # returns the chosen candidate mapping
    build_daily_block(element, hint) -> dict                 # manifest["daily"] block
    class NoDailyCandidate(Exception)                        # message contains "không chọn được Món đặc biệt"

A candidate is a mapping with keys:
    element_id, name, emoji, depth, source ("trend" | "classic"), added_version,
    active, reachable, held (hot-deferred, AC-MOD-08), hint, hint_ok (passed moderation)
history is a list of {"element_id", "version"} (the version at which the element was the daily dish).
Imports happen inside the tests so a missing module fails at runtime, not at collection.
"""

import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
BATCH_AT = datetime(2026, 10, 20, 5, 30, 0, tzinfo=UTC)
STARTERS = ["Cay", "Cười", "Toang", "Deadline"]


def cand(eid: str, depth: int = 5, source: str = "classic", added_version: int = 0, **over) -> dict:
    base = {
        "element_id": eid,
        "name": f"Món {eid}",
        "emoji": "🍲",
        "depth": depth,
        "source": source,
        "added_version": added_version,
        "active": True,
        "reachable": True,
        "held": False,
        "hint": f"Gợi ý {eid}",
        "hint_ok": True,
    }
    base.update(over)
    return base


def used(eid: str, version: int) -> dict:
    return {"element_id": eid, "version": version}


def chosen_id(candidates: list, history: list, version: int = 7) -> str:
    from lau_meme_pipeline.daily import select_daily

    return select_daily(candidates, history, version)["element_id"]


INELIGIBLE = [
    cand("d3", depth=3),
    cand("d9", depth=9),
    cand("inactive", active=False),
    cand("unreachable", reachable=False),
    cand("held", held=True),
    cand("badhint", hint_ok=False),
    cand("nohint", hint=None, hint_ok=False),
    cand("used", depth=6),
]


def test_ac_daily_01_chi_chon_ung_vien_thoa_moi_dieu_kien():
    """AC-DAILY-01: depth [4,8], hoạt động, tới được, không hoãn nóng, gợi ý đạt, chưa từng chọn; còn lại bị bỏ qua."""
    good = cand("good", depth=6)
    candidates = [*INELIGIBLE, good]
    history = [used("used", 2)]
    assert chosen_id(candidates, history) == "good"
    # mọi version đều không chọn nhầm ứng viên không hợp lệ
    for version in range(1, 25):
        assert chosen_id(candidates, history, version) == "good"
    # trend không hợp lệ cũng không thắng classic hợp lệ
    bad_trend = cand("trend_held", source="trend", added_version=99, held=True)
    assert chosen_id([bad_trend, good], history) == "good"


def test_ac_daily_01_depth_bien_4_va_8_deu_hop_le():
    """AC-DAILY-01: depth 4 và depth 8 nằm trong khoảng; 3 và 9 nằm ngoài."""
    for depth in (4, 8):
        assert chosen_id([cand("edge", depth=depth), cand("d3", depth=3), cand("d9", depth=9)], []) == "edge"


def test_ac_daily_01_uu_tien_trend_moi_nhat_roi_moi_den_classic():
    """AC-DAILY-01: có trend chưa dùng thì lấy trend có added_version lớn nhất; không có trend thì classic."""
    classic = [cand(f"c{i}", depth=4 + i % 5) for i in range(6)]
    trends = [
        cand("t_old", source="trend", added_version=10),
        cand("t_new", source="trend", added_version=12),
        cand("t_mid", source="trend", added_version=11),
    ]
    for version in range(1, 15):
        assert chosen_id([*classic, *trends], [], version) == "t_new"
    # trend mới nhất đã dùng -> trend chưa dùng mới nhất còn lại
    assert chosen_id([*classic, *trends], [used("t_new", 3)]) == "t_mid"
    # không có trend -> classic
    assert chosen_id(classic, []).startswith("c")


def test_ac_daily_01_tat_dinh_theo_version_va_khong_phu_thuoc_thu_tu_dau_vao():
    """AC-DAILY-01: cùng (đầu vào, version) cho cùng kết quả, kể cả khi đảo thứ tự danh sách ứng viên."""
    classic = [cand(f"c{i:02d}", depth=4 + i % 5) for i in range(12)]
    for version in (1, 2, 3, 10, 11, 12):
        first = chosen_id(classic, [], version)
        assert first == chosen_id(classic, [], version)
        assert first == chosen_id(list(reversed(classic)), [], version)
        assert first in {c["element_id"] for c in classic}


def test_ac_daily_01_chua_dung_thang_da_dung_ke_ca_khi_da_dung_la_trend():
    """AC-DAILY-01: còn ứng viên chưa từng chọn thì không lặp lại món đã dùng."""
    trend = cand("t1", source="trend", added_version=5)
    classic = cand("c1")
    assert chosen_id([trend, classic], [used("t1", 4)]) == "c1"


def test_ac_daily_01_het_ung_vien_chua_dung_thi_lay_mon_da_dung_lau_nhat():
    """AC-DAILY-01: tất cả đã dùng -> chọn món có lần dùng cũ nhất trong số thỏa các điều kiện còn lại."""
    a, b, c = cand("a", depth=4), cand("b", depth=5), cand("c", depth=6)
    held_oldest = cand("held_oldest", depth=7, held=True)
    history = [used("a", 3), used("b", 1), used("c", 2), used("held_oldest", 0)]
    for version in (4, 9, 17):
        assert chosen_id([a, b, c, held_oldest], history, version) == "b"
    # dùng nhiều lần: tính theo lần dùng gần nhất
    history2 = [used("a", 1), used("a", 8), used("b", 2), used("c", 5)]
    assert chosen_id([a, b, c], history2, 9) == "b"


def test_ac_daily_02_khong_co_ung_vien_nao_thi_bao_loi_ro_rang():
    """AC-DAILY-02: không ứng viên thỏa điều kiện -> NoDailyCandidate, thông điệp "không chọn được Món đặc biệt"."""
    from lau_meme_pipeline.daily import NoDailyCandidate, select_daily

    cases = [
        [],
        [cand("d3", depth=3), cand("d9", depth=9)],
        [cand("held", held=True), cand("inactive", active=False), cand("far", reachable=False), cand("hint", hint_ok=False)],
    ]
    for candidates in cases:
        with pytest.raises(NoDailyCandidate) as info:
            select_daily(candidates, [], 5)
        assert "không chọn được Món đặc biệt" in str(info.value)
    assert issubclass(NoDailyCandidate, Exception)


def real_dish() -> dict:
    core = json.loads(CORE_PATH.read_text(encoding="utf-8"))
    dishes = [e for e in core["elements"] if e["depth"] >= 4 and e["name"] not in STARTERS]
    return max(dishes, key=lambda e: len(e["name"]))


def test_ac_daily_03_khoi_daily_chi_co_khoa_bam_emoji_goi_y_depth():
    """AC-DAILY-03: khối daily có đúng element_id (băm tên đã fold), emoji, hint, depth; không có tên."""
    from lau_meme_pipeline.daily import build_daily_block
    from lau_meme_pipeline.ids import element_id

    dish = real_dish()
    block = build_daily_block(dish, "Món nóng hổi, ăn là nhớ")
    assert set(block) == {"element_id", "emoji", "hint", "depth"}
    assert block["element_id"] == element_id(dish["name"])
    assert len(block["element_id"]) == 43
    assert block["emoji"] == dish["emoji"]
    assert block["hint"] == "Món nóng hổi, ăn là nhớ"
    assert block["depth"] == dish["depth"]
    assert 4 <= block["depth"] <= 8


def test_ac_daily_03_manifest_khong_chua_ten_mon_dang_doc_duoc():
    """AC-DAILY-03: manifest có daily nhưng không chứa tên món (cả dạng gốc lẫn fold) ngoài miss_lines."""
    from lau_meme_pipeline.daily import build_daily_block
    from lau_meme_pipeline.graph import build_manifest
    from lau_meme_pipeline.seed import ContentStore, load_core
    from lau_meme_pipeline.text import fold

    core = json.loads(CORE_PATH.read_text(encoding="utf-8"))
    store = load_core(core, ContentStore.empty()).store
    dish = real_dish()
    block = build_daily_block(dish, "Món nóng hổi, ăn là nhớ")
    manifest = build_manifest(store, version=3, batch_at=BATCH_AT, daily=block, previous_version=2)
    assert manifest["daily"] == block
    text = json.dumps({k: v for k, v in manifest.items() if k != "miss_lines"}, ensure_ascii=False)
    for form in (dish["name"], fold(dish["name"])):
        assert not re.search(r"(?<!\w)" + re.escape(form) + r"(?!\w)", text, re.IGNORECASE), form


def test_ac_daily_03_goi_y_co_ten_mon_bi_tu_choi():
    """AC-DAILY-03: gợi ý chứa tên món (kể cả không dấu, khác hoa thường) bị từ chối bằng ValueError."""
    from lau_meme_pipeline.daily import build_daily_block
    from lau_meme_pipeline.text import fold

    dish = real_dish()
    for hint in (f"Đó là {dish['name']}!", f"đó là {fold(dish['name']).upper()}"):
        with pytest.raises(ValueError):
            build_daily_block(dish, hint)
