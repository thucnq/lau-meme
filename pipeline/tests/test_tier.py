"""Acceptance tests for docs/acceptance/tier.md, pipeline part: AC-TIER-01.

Contract used (docs/api/openapi.yaml, ADR 0013):
  GET /pipeline/state returns `tiers: [{element_id, tier}]` (only rows the admin set; others are tier 1), plus
  `catalog` and `contributions` (other features). The pipeline writes `tier` (1-5) into the plaintext of every graph
  entry next to name/emoji, keeps nothing of its own between batches (the Worker keeps the tier), never changes a tier
  by itself, and fails the `check` step (no success is published) when a tier is outside 1-5.

The helpers (FakeClient, FakeReporter, FakeAdapter, make_llm, run_full_batch) are reused from test_pipe_full_batch.py;
only the state the fake client returns is replaced so it carries the new keys.
"""

import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from test_pipe_full_batch import MEME, FakeAdapter, FakeClient, FakeReporter, make_llm, run_full_batch

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)
T2 = T + timedelta(hours=12)
PLAIN_KEYS = {"id", "name", "emoji", "depth", "added_version", "image_key", "tier"}
CONTRIB = "Món Đóng Góp Thử"


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def eid(name: str) -> str:
    from lau_meme_pipeline.ids import element_id

    return element_id(name)


def make_state(tiers=(), contributions=()) -> dict:
    return {
        "current_version": None,
        "blocklist": {"elements": [], "recipes": [], "images": []},
        "banned_aliases": [],
        "admin_blocked": [],
        "daily_history": [],
        "feedback": [],
        "catalog": [],
        "tiers": [copy.deepcopy(t) for t in tiers],
        "contributions": [copy.deepcopy(c) for c in contributions],
    }


def tier_row(name: str, tier) -> dict:
    return {"element_id": eid(name), "tier": tier}


def unused_pair(core: dict) -> tuple[str, str]:
    """Hai phần tử lõi khác nhau chưa có công thức: chỗ để đề xuất đóng góp ghép vào."""
    used = {frozenset((r["a"], r["b"])) for r in core["recipes"]}
    names = [e["name"] for e in core["elements"]]
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            if frozenset((a, b)) not in used:
                return a, b
    raise AssertionError("lõi không còn cặp trống")


def contribution_row(a: str, b: str) -> dict:
    return {
        "element_id": eid(CONTRIB),
        "name": CONTRIB,
        "emoji": None,
        "a": eid(a),
        "b": eid(b),
        "image_hint": "một nồi lẩu đang sôi",
        "approved_at": "2026-10-20T01:00:00Z",
    }


def run_core(state: dict, batch_at=T):
    from lau_meme_pipeline.batch import run_batch

    client, reporter = FakeClient(), FakeReporter()
    client.state = state
    outcome = run_batch(
        mode="core", batch_at=batch_at, core=real_core(), client=client, reporter=reporter, log=lambda m: None
    )
    return outcome, client, reporter


def run_full(state: dict, names=(MEME,), batch_at=T):
    client, reporter = FakeClient(), FakeReporter()
    client.state = state
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", list(names))], make_llm(), batch_at=batch_at)
    return outcome, client


def core_entries(graph: dict) -> list[tuple[dict, dict]]:
    """(công thức lõi, bản rõ đã giải mã) cho mọi công thức của lõi."""
    from lau_meme_pipeline.graph import decrypt_entry

    out = []
    for r in real_core()["recipes"]:
        plain = decrypt_entry(graph, r["a"], r["b"])
        assert plain is not None, (r["a"], r["b"])
        out.append((r, plain))
    return out


# ---------------------------------------------------------------- AC-TIER-01


def test_ac_tier_01_phan_tu_loi_va_moi_batch_mac_dinh_tier_1_cung_cho_voi_ten():
    """AC-TIER-01: kho lõi vừa nạp, không ai gán tier: mọi mục graph có tier 1 (số nguyên) cùng bản rõ với tên/emoji."""
    outcome, client, _ = run_core(make_state())
    assert outcome.ok is True
    (body,) = client.success_posts
    entries = core_entries(body["graph"])
    assert len(entries) == 518
    for r, plain in entries:
        assert set(plain) == PLAIN_KEYS, r
        assert plain["name"] == r["result"]
        assert type(plain["tier"]) is int and plain["tier"] == 1, r


def test_ac_tier_01_graph_van_chi_co_ba_khoa_va_khong_lo_tier_ra_ngoai():
    """AC-TIER-01: tier chỉ nằm trong bản mã (AC-GRAPH-02): graph chỉ có format/version/entries, không chữ "tier"."""
    from lau_meme_pipeline.graph import graph_to_bytes

    _, client, _ = run_core(make_state(tiers=[tier_row(real_core()["recipes"][0]["result"], 5)]))
    (body,) = client.success_posts
    assert set(body["graph"]) == {"format", "version", "entries"}
    assert b"tier" not in graph_to_bytes(body["graph"])
    assert "tier" not in json.dumps(body["manifest"], ensure_ascii=False)


def test_ac_tier_01_phan_tu_p_giu_tier_4_qua_me_core_va_me_full_tiep_theo():
    """AC-TIER-01: P đã được admin gán tier 4: mẻ core rồi mẻ full kế tiếp đều ghi 4 cho P và 1 cho phần tử khác;
    pipeline không tự đổi tier."""
    core = real_core()
    p = core["recipes"][0]["result"]
    state = make_state(tiers=[tier_row(p, 4)])

    outcome, client, _ = run_core(copy.deepcopy(state), T)
    assert outcome.ok is True
    (core_body,) = client.success_posts
    # mẻ full kế tiếp: cùng state (Worker vẫn trả tier 4 cho P)
    full_outcome, full_client = run_full(copy.deepcopy(state), batch_at=T2)
    assert full_outcome.ok is True
    (full_body,) = full_client.success_posts

    for body in (core_body, full_body):
        entries = core_entries(body["graph"])
        assert sum(1 for r, _ in entries if r["result"] == p) >= 1
        for r, plain in entries:
            assert plain["tier"] == (4 if r["result"] == p else 1), (r, plain["tier"])


def test_ac_tier_01_meme_crawl_moi_mac_dinh_tier_1_con_p_van_giu_tier_cua_admin():
    """AC-TIER-01: meme crawl mới trong mẻ full có tier 1 (Xám), tên đúng; phần tử đã gán không bị ảnh hưởng."""
    from lau_meme_pipeline.graph import decrypt_entry

    core = real_core()
    p = core["recipes"][0]["result"]
    outcome, client = run_full(make_state(tiers=[tier_row(p, 4)]))
    assert outcome.ok is True
    (body,) = client.success_posts
    content = body["content"]
    name_of = {e["id"]: e["name"] for e in content["elements"]}
    new_recipes = [r for r in content["recipes"] if r["result"] == eid(MEME)]
    assert new_recipes, "meme crawl mới phải được nối vào một công thức"
    for r in new_recipes:
        plain = decrypt_entry(body["graph"], name_of[r["a"]], name_of[r["b"]])
        assert plain is not None
        assert plain["name"] == MEME
        assert plain["tier"] == 1
        assert set(plain) == PLAIN_KEYS
    assert all(pl["tier"] == 4 for r, pl in core_entries(body["graph"]) if r["result"] == p)


def test_ac_tier_01_meme_dong_gop_duyet_khong_chon_tier_mac_dinh_tier_1():
    """AC-TIER-01: đề xuất đã duyệt, admin không gán tier (không có dòng trong tiers): mục graph của nó có tier 1."""
    from lau_meme_pipeline.graph import decrypt_entry

    core = real_core()
    a, b = unused_pair(core)
    outcome, client = run_full(make_state(contributions=[contribution_row(a, b)]), names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    plain = decrypt_entry(body["graph"], a, b)
    assert plain is not None, "đề xuất đã duyệt phải vào graph"
    assert plain["name"] == CONTRIB
    assert plain["tier"] == 1


def test_ac_tier_01_meme_dong_gop_duoc_admin_gan_tier_khi_duyet_giu_tier_do():
    """AC-TIER-01: đề xuất duyệt kèm tier 3 (Worker đưa vào tiers khi duyệt): graph ghi tier 3, không bị về 1."""
    from lau_meme_pipeline.graph import decrypt_entry

    a, b = unused_pair(real_core())
    state = make_state(tiers=[tier_row(CONTRIB, 3)], contributions=[contribution_row(a, b)])
    outcome, client = run_full(state, names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    plain = decrypt_entry(body["graph"], a, b)
    assert plain is not None and plain["tier"] == 3


def test_ac_tier_01_chay_lai_cung_me_cho_graph_giong_het_byte():
    """AC-TIER-01: chạy lại cùng mẻ (cùng state có tier, cùng batch_at): body giống hệt; đổi tier thì graph đổi."""
    core = real_core()
    p = core["recipes"][0]["result"]
    bodies = []
    for _ in range(2):
        _, client, _ = run_core(make_state(tiers=[tier_row(p, 4)]))
        bodies.append(json.dumps(client.success_posts[0], sort_keys=True, ensure_ascii=False))
    assert bodies[0] == bodies[1]
    _, other, _ = run_core(make_state(tiers=[tier_row(p, 5)]))
    assert json.dumps(other.success_posts[0], sort_keys=True, ensure_ascii=False) != bodies[0]


def test_ac_tier_01_graph_cu_giu_tier_cua_ban_cu_khi_ban_moi_doi_tier():
    """AC-TIER-01: rollback trả về graph cũ nguyên vẹn: graph đã đăng trước đó vẫn giải ra tier cũ (4) dù mẻ sau đã
    đổi P sang tier 2; không có chỗ nào sửa graph cũ tại chỗ."""
    core = real_core()
    p = core["recipes"][0]["result"]
    _, c1, _ = run_core(make_state(tiers=[tier_row(p, 4)]), T)
    old_graph = copy.deepcopy(c1.success_posts[0]["graph"])
    _, c2, _ = run_core(make_state(tiers=[tier_row(p, 2)]), T2)
    new_graph = c2.success_posts[0]["graph"]
    assert new_graph["version"] > old_graph["version"]
    assert old_graph == c1.success_posts[0]["graph"]
    assert all(pl["tier"] == 4 for r, pl in core_entries(old_graph) if r["result"] == p)
    assert all(pl["tier"] == 2 for r, pl in core_entries(new_graph) if r["result"] == p)


@pytest.mark.parametrize("bad", [0, 6, -1, 2.5, "4", None, 10**12])
def test_ac_tier_01_tier_ngoai_1_den_5_thi_kiem_tra_graph_that_bai_va_khong_dang(bad):
    """AC-TIER-01: tier ngoài 1-5 (hoặc không phải số nguyên) trong state: bước check thất bại, không đăng success
    nào (AC-PIPE-11), có đúng một đợt lỗi."""
    p = real_core()["recipes"][0]["result"]
    outcome, client, reporter = run_core(make_state(tiers=[tier_row(p, bad)]))
    assert outcome.ok is False
    assert outcome.status == "error"
    assert outcome.failed_step == "check"
    assert client.success_posts == []
    assert [b["failed_step"] for b in client.error_posts] == ["check"]
    assert len(reporter.issues) == 1


def test_ac_tier_01_tier_ngoai_khoang_o_me_full_cung_khong_dang():
    """AC-TIER-01: như trên ở mẻ full: tier 6 cho P thì không đăng success."""
    p = real_core()["recipes"][0]["result"]
    outcome, client = run_full(make_state(tiers=[tier_row(p, 6)]))
    assert outcome.ok is False
    assert client.success_posts == []
    assert len(client.error_posts) == 1
