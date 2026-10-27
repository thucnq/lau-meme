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
        "trend_peak": 0,  # mức mặn (AC-PIPE-16); added_version = mẻ đầu tiên phần tử có mặt trong kho
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


def test_ac_daily_01_uu_tien_trend_peak_giam_dan_roi_moi_den_seed():
    """AC-DAILY-01 (2026-10-23): xếp theo trend_peak giảm dần, rồi mẻ đầu tiên có mặt (added_version) giảm dần;
    nguồn trend/classic không còn quyết định thứ tự."""
    a = cand("A", trend_peak=5, added_version=10)
    b = cand("B", trend_peak=5, added_version=12)
    c = cand("C", trend_peak=0, added_version=12)
    for version in range(1, 15):
        assert chosen_id([a, b, c], [], version) == "B"
        assert chosen_id([c, a, b], [], version) == "B"
    # B là món của một trong 30 mẻ gần nhất -> A; cả A và B -> C
    assert chosen_id([a, b, c], [used("B", 6)]) == "A"
    assert chosen_id([a, b, c], [used("B", 6), used("A", 5)]) == "C"
    # mặn cao hơn thắng dù cũ hơn và dù là classic; trend mặn 0 mới hơn không thắng classic mặn 3
    classic_salty = cand("salty", source="classic", trend_peak=3, added_version=1)
    trend_bland = cand("bland", source="trend", trend_peak=0, added_version=99)
    for version in range(1, 10):
        assert chosen_id([trend_bland, classic_salty], [], version) == "salty"


def test_ac_daily_01_cung_trend_peak_va_added_version_thi_chon_tat_dinh_theo_version():
    """AC-DAILY-01: hòa cả mặn lẫn độ mới thì thứ tự tất định theo seed = version; version khác có thể ra món khác."""
    pool = [cand(f"s{i:02d}", depth=4 + i % 5, trend_peak=2, added_version=7) for i in range(12)]
    picks = [chosen_id(pool, [], version) for version in range(1, 13)]
    assert picks == [chosen_id(list(reversed(pool)), [], version) for version in range(1, 13)]
    assert len(set(picks)) >= 2, "seed theo version phải làm đổi món giữa các mẻ"


def test_ac_daily_01_cua_so_30_me_gan_nhat_tinh_theo_me_khong_theo_ngay():
    """AC-DAILY-01: món dùng cách đây 30 mẻ vẫn bị loại, cách đây 31 mẻ thì được chọn lại; đếm theo mẻ."""
    best = cand("best", trend_peak=9, added_version=50)
    rest = [cand(f"r{i}", trend_peak=0, added_version=1) for i in range(5)]
    # 30 mẻ gần nhất: versions 1..30, 'best' ở mẻ cũ nhất trong cửa sổ (mẻ 1) -> vẫn bị loại
    # (các mẻ còn lại dùng món khác, không nằm trong danh sách ứng viên hiện tại)
    window = [used("best", 1)] + [used(f"x{i}", 2 + i) for i in range(29)]
    assert len(window) == 30
    assert chosen_id([best, *rest], window, 31) != "best"
    # 31 mẻ: mẻ 1 rơi khỏi cửa sổ -> 'best' được chọn lại
    older = [used("best", 1)] + [used(f"x{i}", 2 + i) for i in range(30)]
    assert len(older) == 31
    assert chosen_id([best, *rest], older, 32) == "best"


def test_ac_daily_01_moi_ung_vien_nam_trong_30_me_thi_lay_mon_dung_cu_nhat():
    """AC-DAILY-01: mọi ứng viên đều nằm trong 30 mẻ gần nhất -> món có lần làm Món đặc biệt gần nhất cũ nhất,
    bất kể trend_peak hay độ mới."""
    a = cand("a", trend_peak=9, added_version=9)
    b = cand("b", trend_peak=0, added_version=1)
    c = cand("c", trend_peak=5, added_version=5)
    history = (
        [used("b", 10)]
        + [used("a", 11), used("c", 12)]
        + [used("a", 13 + i) if i % 2 else used("c", 13 + i) for i in range(10)]
    )
    for version in (30, 31, 99):
        assert chosen_id([a, b, c], history, version) == "b"


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
        [
            cand("held", held=True),
            cand("inactive", active=False),
            cand("far", reachable=False),
            cand("hint", hint_ok=False),
        ],
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
    """AC-DAILY-03: khối daily có element_id (băm tên đã fold), emoji, hint, depth và name (tên đọc được, 1-100)."""
    from lau_meme_pipeline.daily import build_daily_block
    from lau_meme_pipeline.ids import element_id

    dish = real_dish()
    block = build_daily_block(dish, "Món nóng hổi, ăn là nhớ")
    assert set(block) == {"element_id", "emoji", "hint", "depth", "name"}
    assert block["name"] == dish["name"]
    assert 1 <= len(block["name"]) <= 100
    assert block["element_id"] == element_id(dish["name"])
    assert len(block["element_id"]) == 43
    assert block["emoji"] == dish["emoji"]
    assert block["hint"] == "Món nóng hổi, ăn là nhớ"
    assert block["depth"] == dish["depth"]
    assert 4 <= block["depth"] <= 8


def test_ac_daily_03_manifest_chi_lo_ten_mon_trong_khoi_daily():
    """AC-DAILY-03: manifest.daily mang tên món; ngoài khối daily (và miss_lines) manifest không chứa tên món."""
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
    assert manifest["daily"]["name"] == dish["name"]
    text = json.dumps({k: v for k, v in manifest.items() if k not in ("miss_lines", "daily")}, ensure_ascii=False)
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
