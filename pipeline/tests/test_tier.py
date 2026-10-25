"""Acceptance tests for docs/acceptance/tier.md, phần pipeline: AC-TIER-01, AC-TIER-04, AC-TIER-05 (phía pipeline).

Cập nhật 2026-10-24 (ADR 0016): tier mặc định tính theo độ sâu, admin gán thì thắng, Vàng/Đỏ phải có ảnh.

Phủ sóng:
  AC-TIER-01  tier mặc định theo độ sâu cho phần tử lõi / meme crawl / meme đóng góp không chọn tier; tier admin gán
              (P = 4) được giữ qua mẻ core và full kế tiếp; chạy lại cùng mẻ giống hệt byte; graph cũ giữ tier cũ
              (rollback); tier ngoài 1-5 thì bước check thất bại và không đăng; tier chỉ nằm trong bản mã.
  AC-TIER-04  hàm thuần `auto_tier(depth, has_image)` (bảng 0,2,3,4,5,6,7,9 và luật ảnh); mỗi mẻ core/full tính lại theo
              độ sâu BFS của mẻ và ảnh dùng được (có image_key, không nằm trong blocklist.images); phần tử đổi độ sâu
              giữa
              hai mẻ thì đổi tier tự động (5 -> 3 thì về Xanh lá); `content.elements[].auto_tier` có cho mọi phần tử, kể
              cả phần tử admin đã gán; báo cáo đợt có dòng "Tier: ..." và "Chờ ảnh để lên Vàng/Đỏ: N"; lõi hiện tại phân
              bố
              53 / 62 / 29 / 26 / 4.
  AC-TIER-05  (phía pipeline) tier admin gán thắng tier tự động dù độ sâu đổi; khi Worker bỏ dòng tier (về "Tự động")
  thì
              mẻ kế tiếp trả phần tử về tier tự động.

Hợp đồng dùng (docs/api/openapi.yaml, ADR 0013, ADR 0016):
  GET /pipeline/state trả `tiers: [{element_id, tier}]` (chỉ dòng admin gán), `blocklist.images`, `admin_images`.
  Bản rõ của mỗi mục graph có `tier` (1-5). `POST /pipeline/batches` mang `content.elements[].auto_tier`.
  Bảng tier tự động (câu hỏi mở 67, 69): độ sâu 0-2 -> 1; 3 -> 2; 4 -> 3; 5-6 -> 4; >= 7 -> 5; ra 4 hoặc 5 mà không có
  ảnh
  dùng được thì 3. Bảng được viết lại ngay trong file test (hàm `table`), không tính số kỳ vọng bằng code production.

Các helper (FakeClient, FakeReporter, FakeAdapter, make_llm, run_full_batch) dùng lại từ test_pipe_full_batch.py;
ArtClient,
Draw, Check, llm_with_hints từ test_art_full_batch.py cho các thế giới "lõi đã có ảnh".
"""

import copy
import json
import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from test_art_full_batch import ArtClient, Check, Draw, art_adapters, llm_with_hints
from test_pipe_full_batch import MEME, FakeAdapter, FakeClient, FakeReporter, make_llm, run_full_batch

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)
T2 = T + timedelta(hours=12)
PLAIN_KEYS = {"id", "name", "emoji", "depth", "added_version", "image_key", "tier"}
CONTRIB = "Món Đóng Góp Thử"
TIER_LINE = re.compile(r"Tier: Xám (\d+) · Xanh lá (\d+) · Xanh dương (\d+) · Vàng (\d+) · Đỏ (\d+)")
WAIT_LINE = re.compile(r"Chờ ảnh để lên Vàng/Đỏ: (\d+)")


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def eid(name: str) -> str:
    from lau_meme_pipeline.ids import element_id

    return element_id(name)


def make_state(tiers=(), contributions=(), blocked_images=()) -> dict:
    return {
        "current_version": None,
        "blocklist": {"elements": [], "recipes": [], "images": list(blocked_images)},
        "banned_aliases": [],
        "admin_blocked": [],
        "daily_history": [],
        "feedback": [],
        "catalog": [],
        "tiers": [copy.deepcopy(t) for t in tiers],
        "contributions": [copy.deepcopy(c) for c in contributions],
        "admin_images": [],
    }


def tier_row(name: str, tier) -> dict:
    return {"element_id": eid(name), "tier": tier}


def table(depth: int, has_image: bool) -> int:
    """Bảng của AC-TIER-04 viết lại phía test (độc lập với code production)."""
    if depth <= 2:
        tier = 1
    elif depth == 3:
        tier = 2
    elif depth == 4:
        tier = 3
    elif depth <= 6:
        tier = 4
    else:
        tier = 5
    if tier >= 4 and not has_image:
        tier = 3
    return tier


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


def run_core(state: dict, batch_at=T, core=None):
    from lau_meme_pipeline.batch import run_batch

    client, reporter = FakeClient(), FakeReporter()
    client.state = state
    outcome = run_batch(
        mode="core",
        batch_at=batch_at,
        core=core if core is not None else real_core(),
        client=client,
        reporter=reporter,
        log=lambda m: None,
    )
    return outcome, client, reporter


def run_full(state: dict, names=(MEME,), batch_at=T):
    client, reporter = FakeClient(), FakeReporter()
    client.state = state
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", list(names))], make_llm(), batch_at=batch_at)
    return outcome, client


def run_full_drawn(state: dict, names=(), batch_at=T, core=None):
    """Mẻ full trong thế giới mà cả 174 phần tử lõi đã có ảnh (store.core_art): không có gì để vẽ, ảnh dùng được trừ
    phần tử có id trong blocklist.images."""
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    client, reporter = ArtClient(), FakeReporter()
    client.state = state
    outcome = run_batch(
        mode="full",
        batch_at=batch_at,
        core=core if core is not None else real_core(),
        client=client,
        reporter=reporter,
        adapters=[FakeAdapter("RSS", list(names))],
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=llm_with_hints(),
        log=lambda m: None,
        banned_words=[],
        art=art_adapters(Draw(), Check()),
    )
    return outcome, client, reporter


def core_entries(graph: dict) -> list[tuple[dict, dict]]:
    """(công thức lõi, bản rõ đã giải mã) cho mọi công thức của lõi."""
    from lau_meme_pipeline.graph import decrypt_entry

    out = []
    for r in real_core()["recipes"]:
        plain = decrypt_entry(graph, r["a"], r["b"])
        assert plain is not None, (r["a"], r["b"])
        out.append((r, plain))
    return out


def content_by_id(body: dict) -> dict:
    return {e["id"]: e for e in body["content"]["elements"]}


def graph_tiers(body: dict) -> dict:
    """id phần tử -> tier trong graph (giải mã mọi công thức của content); mọi mục cùng kết quả phải cùng tier."""
    from lau_meme_pipeline.graph import decrypt_entry

    names = {e["id"]: e["name"] for e in body["content"]["elements"]}
    seen: dict[str, set] = {}
    for r in body["content"]["recipes"]:
        plain = decrypt_entry(body["graph"], names[r["a"]], names[r["b"]])
        assert plain is not None, r
        seen.setdefault(plain["id"], set()).add(plain["tier"])
    assert all(len(v) == 1 for v in seen.values()), "cùng một phần tử phải cùng tier ở mọi mục graph"
    return {k: next(iter(v)) for k, v in seen.items()}


def expected_tiers(body: dict, admin: dict | None = None, blocked_images=()) -> dict:
    """Tier hiệu lực mong đợi cho mọi phần tử của content: admin gán thì giữ, không thì bảng theo độ sâu + ảnh."""
    admin = admin or {}
    out = {}
    for e in body["content"]["elements"]:
        usable = bool(e.get("image_key")) and e["id"] not in set(blocked_images)
        out[e["id"]] = admin.get(e["id"], table(e["depth"], usable))
    return out


def file_depth(name: str) -> int:
    (found,) = [e["depth"] for e in real_core()["elements"] if e["name"] == name]
    return found


def names_at_depth(depth: int) -> list[str]:
    return [e["name"] for e in real_core()["elements"] if e["depth"] == depth]


def shorter_core(depth_from: int = 5) -> tuple[dict, str]:
    """Bản lõi mà MỘT phần tử lá độ sâu `depth_from` có thêm công thức từ hai phần tử độ sâu <= 2 (cặp chưa dùng) nên
    BFS đưa nó lên độ sâu 3. Phần tử lá nên không phần tử nào khác đổi độ sâu. Trả (lõi mới, tên phần tử)."""
    core = real_core()
    ingredients = {r["a"] for r in core["recipes"]} | {r["b"] for r in core["recipes"]}
    starters = {s if isinstance(s, str) else s["name"] for s in core["starters"]}
    leaves = [
        e["name"]
        for e in core["elements"]
        if e["depth"] == depth_from and e["name"] not in ingredients and e["name"] not in starters
    ]
    assert leaves, f"lõi phải có phần tử lá độ sâu {depth_from}"
    target = leaves[0]
    depth = {e["name"]: e["depth"] for e in core["elements"]}
    used = {frozenset((r["a"], r["b"])) for r in core["recipes"]}
    low = [n for n in depth if depth[n] <= 2 and n != target]
    pair = next(
        (a, b)
        for i, a in enumerate(low)
        for b in low[i + 1 :]
        if frozenset((a, b)) not in used and max(depth[a], depth[b]) == 2
    )
    new = copy.deepcopy(core)
    for e in new["elements"]:
        if e["name"] == target:
            e["depth"] = 3
    new["recipes"].append({"a": pair[0], "b": pair[1], "result": target, "best": False})
    return new, target


# ---------------------------------------------------------------- AC-TIER-01


def test_ac_tier_01_phan_tu_loi_va_moi_batch_tier_tu_dong_theo_do_sau_cung_cho_voi_ten():
    """AC-TIER-01: kho lõi vừa nạp, không ai gán tier: mỗi mục graph có tier số nguyên cùng bản rõ với tên/emoji, bằng
    tier tự động theo độ sâu của mẻ (AC-TIER-04), không còn mặc định Xám cho mọi phần tử."""
    outcome, client, _ = run_core(make_state())
    assert outcome.ok is True
    (body,) = client.success_posts
    want = expected_tiers(body)
    entries = core_entries(body["graph"])
    assert len(entries) == 518
    for r, plain in entries:
        assert set(plain) == PLAIN_KEYS, r
        assert plain["name"] == r["result"]
        assert type(plain["tier"]) is int, r
        assert plain["tier"] == want[plain["id"]], (r, plain["depth"], plain["tier"])
    assert {plain["tier"] for _, plain in entries} >= {1, 2, 3}, "không còn mặc định Xám cho mọi phần tử"


def test_ac_tier_01_graph_van_chi_co_ba_khoa_va_khong_lo_tier_ra_ngoai():
    """AC-TIER-01: tier chỉ nằm trong bản mã (AC-GRAPH-02): graph chỉ có format/version/entries, không chữ "tier"."""
    from lau_meme_pipeline.graph import graph_to_bytes

    _, client, _ = run_core(make_state(tiers=[tier_row(real_core()["recipes"][0]["result"], 5)]))
    (body,) = client.success_posts
    assert set(body["graph"]) == {"format", "version", "entries"}
    assert b"tier" not in graph_to_bytes(body["graph"])
    assert "tier" not in json.dumps(body["manifest"], ensure_ascii=False)


def test_ac_tier_01_phan_tu_p_giu_tier_4_qua_me_core_va_me_full_tiep_theo():
    """AC-TIER-01: P đã được admin gán tier 4: mẻ core rồi mẻ full kế tiếp đều ghi 4 cho P và tier tự động theo độ sâu
    cho
    phần tử khác; pipeline không tự đổi tier admin."""
    core = real_core()
    p = core["recipes"][0]["result"]
    state = make_state(tiers=[tier_row(p, 4)])

    outcome, client, _ = run_core(copy.deepcopy(state), T)
    assert outcome.ok is True
    (core_body,) = client.success_posts
    full_outcome, full_client = run_full(copy.deepcopy(state), batch_at=T2)
    assert full_outcome.ok is True
    (full_body,) = full_client.success_posts

    for body in (core_body, full_body):
        want = expected_tiers(body, admin={eid(p): 4})
        entries = core_entries(body["graph"])
        assert sum(1 for r, _ in entries if r["result"] == p) >= 1
        for r, plain in entries:
            assert plain["tier"] == (4 if r["result"] == p else want[plain["id"]]), (r, plain["tier"])


def test_ac_tier_01_meme_crawl_moi_tier_tu_dong_theo_do_sau_con_p_van_giu_tier_cua_admin():
    """AC-TIER-01: meme crawl mới trong mẻ full có tier tự động theo độ sâu của nó (không có ảnh nên Vàng/Đỏ hạ về
    Xanh dương), tên đúng; phần tử đã gán không bị ảnh hưởng."""
    from lau_meme_pipeline.graph import decrypt_entry

    core = real_core()
    p = core["recipes"][0]["result"]
    outcome, client = run_full(make_state(tiers=[tier_row(p, 4)]))
    assert outcome.ok is True
    (body,) = client.success_posts
    content = body["content"]
    name_of = {e["id"]: e["name"] for e in content["elements"]}
    meme = content_by_id(body)[eid(MEME)]
    new_recipes = [r for r in content["recipes"] if r["result"] == eid(MEME)]
    assert new_recipes, "meme crawl mới phải được nối vào một công thức"
    for r in new_recipes:
        plain = decrypt_entry(body["graph"], name_of[r["a"]], name_of[r["b"]])
        assert plain is not None
        assert plain["name"] == MEME
        assert plain["tier"] == table(meme["depth"], bool(meme.get("image_key")))
        assert plain["tier"] == meme["auto_tier"]
        assert set(plain) == PLAIN_KEYS
    assert all(pl["tier"] == 4 for r, pl in core_entries(body["graph"]) if r["result"] == p)


def test_ac_tier_01_meme_dong_gop_duyet_khong_chon_tier_nhan_tier_tu_dong():
    """AC-TIER-01: đề xuất đã duyệt, admin không gán tier (không có dòng trong tiers): mục graph của nó có tier tự động
    theo độ sâu (AC-TIER-04), bằng content.auto_tier."""
    from lau_meme_pipeline.graph import decrypt_entry

    core = real_core()
    a, b = unused_pair(core)
    outcome, client = run_full(make_state(contributions=[contribution_row(a, b)]), names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    plain = decrypt_entry(body["graph"], a, b)
    assert plain is not None, "đề xuất đã duyệt phải vào graph"
    assert plain["name"] == CONTRIB
    el = content_by_id(body)[eid(CONTRIB)]
    assert plain["tier"] == table(el["depth"], bool(el.get("image_key")))
    assert plain["tier"] == el["auto_tier"]


def test_ac_tier_01_meme_dong_gop_duoc_admin_gan_tier_khi_duyet_giu_tier_do():
    """AC-TIER-01: đề xuất duyệt kèm tier 3 (Worker đưa vào tiers khi duyệt): graph ghi tier 3, tier admin thắng tier
    tự động."""
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


# ---------------------------------------------------------------- AC-TIER-04


@pytest.mark.parametrize(
    ("depth", "tier"),
    [(0, 1), (2, 1), (3, 2), (4, 3), (5, 4), (6, 4), (7, 5), (9, 5)],
)
def test_ac_tier_04_ham_auto_tier_theo_bang_do_sau_khi_co_anh(depth, tier):
    """AC-TIER-04: auto_tier(depth, True): độ sâu 0, 2 -> 1; 3 -> 2; 4 -> 3; 5, 6 -> 4; 7, 9 -> 5."""
    from lau_meme_pipeline.tier import auto_tier

    result = auto_tier(depth, True)
    assert type(result) is int
    assert result == tier == table(depth, True)


@pytest.mark.parametrize(
    ("depth", "tier"),
    [(0, 1), (2, 1), (3, 2), (4, 3), (5, 3), (6, 3), (7, 3), (9, 3)],
)
def test_ac_tier_04_ham_auto_tier_chua_co_anh_thi_vang_do_ha_ve_xanh_duong(depth, tier):
    """AC-TIER-04: auto_tier(depth, False): chỉ Vàng/Đỏ bị hạ về 3, các bậc thấp hơn giữ nguyên."""
    from lau_meme_pipeline.tier import auto_tier

    assert auto_tier(depth, False) == tier == table(depth, False)


def test_ac_tier_04_ham_auto_tier_la_ham_thuan_cung_dau_vao_cung_ket_qua():
    """AC-TIER-04: hàm thuần của (độ sâu, có ảnh): gọi lặp lại và xen kẽ cho cùng kết quả, không phụ thuộc lần gọi
    trước."""
    from lau_meme_pipeline.tier import auto_tier

    first = [(d, h, auto_tier(d, h)) for d in range(0, 12) for h in (True, False)]
    for d, h, t in reversed(first):
        assert auto_tier(d, h) == t
    assert all(1 <= t <= 5 for _, _, t in first)


def test_ac_tier_04_phan_bo_loi_hien_tai_53_62_29_26_4():
    """AC-TIER-04: với lõi hiện tại (174 phần tử) và ảnh đầy đủ, số phần tử mỗi tier là 53 / 62 / 29 / 26 / 4 (độ sâu
    BFS
    lấy từ content của mẻ core; file lõi cho cùng phân bố độ sâu)."""
    from lau_meme_pipeline.tier import auto_tier

    _, client, _ = run_core(make_state())
    (body,) = client.success_posts
    depths = [e["depth"] for e in body["content"]["elements"]]
    assert len(depths) == 174
    counts = Counter(auto_tier(d, True) for d in depths)
    assert [counts[t] for t in (1, 2, 3, 4, 5)] == [53, 62, 29, 26, 4]
    by_file = Counter(table(e["depth"], True) for e in real_core()["elements"])
    assert [by_file[t] for t in (1, 2, 3, 4, 5)] == [53, 62, 29, 26, 4]


def test_ac_tier_04_me_core_tier_do_thi_graph_va_content_auto_tier_khop_bang_do_sau():
    """AC-TIER-04: mẻ core: mỗi phần tử có content.auto_tier = bảng(độ sâu BFS, ảnh dùng được), mục graph mang đúng tier
    đó; phần tử độ sâu >= 5 mà không có image_key nhận 3, không có tier 4 hay 5 nào khi không có ảnh nào."""
    _, client, _ = run_core(make_state())
    (body,) = client.success_posts
    want = expected_tiers(body)
    for e in body["content"]["elements"]:
        assert type(e["auto_tier"]) is int, e["name"]
        assert e["auto_tier"] == want[e["id"]], (e["name"], e["depth"])
        if e["depth"] >= 5 and not e.get("image_key"):
            assert e["auto_tier"] == 3, (e["name"], e["depth"])
    got = graph_tiers(body)
    assert got
    assert all(got[i] == want[i] for i in got)


def test_ac_tier_04_me_full_co_anh_thi_vang_do_theo_do_sau():
    """AC-TIER-04: mẻ full khi 174 phần tử lõi đều có ảnh: tier theo bảng đầy đủ, phân bố 53 / 62 / 29 / 26 / 4, mục
    graph
    khớp content.auto_tier."""
    outcome, client, _ = run_full_drawn(make_state())
    assert outcome.ok is True
    (body,) = client.success_posts
    core_ids = {eid(e["name"]) for e in real_core()["elements"]}
    core_elems = [e for e in body["content"]["elements"] if e["id"] in core_ids]
    counts = Counter(e["auto_tier"] for e in core_elems)
    assert [counts[t] for t in (1, 2, 3, 4, 5)] == [53, 62, 29, 26, 4]
    want = expected_tiers(body)
    assert all(e["auto_tier"] == want[e["id"]] for e in body["content"]["elements"])
    got = graph_tiers(body)
    assert all(got[i] == want[i] for i in got)


def test_ac_tier_04_anh_bi_chan_thi_vang_do_ha_ve_3_va_tier_admin_van_thang_nhung_auto_tier_van_duoc_gui():
    """AC-TIER-04: phần tử độ sâu 6 (Y) có ảnh nhưng id nằm trong blocklist.images: graph và auto_tier là 3; phần tử độ
    sâu
    7 (Z) cũng bị chặn ảnh nhưng admin gán 5: graph 5 (admin thắng), content.auto_tier vẫn là 3 (đã hạ); phần tử độ
    sâu 6 và 7 khác còn ảnh giữ 4 và 5."""
    y, other6 = names_at_depth(6)[0], names_at_depth(6)[1]
    z, other7 = names_at_depth(7)[0], names_at_depth(7)[1]
    state = make_state(tiers=[tier_row(z, 5)], blocked_images=[eid(y), eid(z)])
    outcome, client, _ = run_full_drawn(state)
    assert outcome.ok is True
    (body,) = client.success_posts
    by_id = content_by_id(body)
    got = graph_tiers(body)

    assert by_id[eid(y)]["auto_tier"] == 3 and got[eid(y)] == 3
    assert by_id[eid(z)]["auto_tier"] == 3 and got[eid(z)] == 5
    assert by_id[eid(other6)]["auto_tier"] == 4 and got[eid(other6)] == 4
    assert by_id[eid(other7)]["auto_tier"] == 5 and got[eid(other7)] == 5


def test_ac_tier_04_bao_cao_dot_co_dong_tier_va_cho_anh_de_len_vang_do_me_core():
    """AC-TIER-04: báo cáo của mẻ core có dòng "Tier: Xám a · Xanh lá b · Xanh dương c · Vàng d · Đỏ e" (số phần tử mỗi
    tier
    hiệu lực, cộng lại bằng tổng phần tử) và "Chờ ảnh để lên Vàng/Đỏ: N" (số phần tử tính ra Vàng/Đỏ nhưng chưa có
    ảnh)."""
    _, client, reporter = run_core(make_state())
    (body,) = client.success_posts
    text = reporter.issues[0][1]
    (counts,) = TIER_LINE.findall(text)
    want = Counter(expected_tiers(body).values())
    assert [int(n) for n in counts] == [want[t] for t in (1, 2, 3, 4, 5)]
    assert sum(int(n) for n in counts) == len(body["content"]["elements"])
    (waiting,) = WAIT_LINE.findall(text)
    lowered = sum(1 for e in body["content"]["elements"] if table(e["depth"], True) >= 4 and not e.get("image_key"))
    assert int(waiting) == lowered
    assert lowered > 0, "lõi chưa có ảnh ở mẻ core nên phần tử độ sâu >= 5 đang chờ ảnh"


def test_ac_tier_04_bao_cao_dot_khong_dem_phan_tu_admin_gan_vao_cho_anh():
    """AC-TIER-04: mẻ full trong thế giới lõi đã có ảnh, Y (độ sâu 6) bị chặn ảnh và Z (độ sâu 7) bị chặn ảnh nhưng
    admin
    gán 5: "Chờ ảnh để lên Vàng/Đỏ: 1" (chỉ Y), dòng Tier đếm tier hiệu lực (Z tính là Đỏ)."""
    y, z = names_at_depth(6)[0], names_at_depth(7)[0]
    state = make_state(tiers=[tier_row(z, 5)], blocked_images=[eid(y), eid(z)])
    outcome, client, reporter = run_full_drawn(state)
    assert outcome.ok is True
    (body,) = client.success_posts
    text = reporter.issues[0][1]
    (waiting,) = WAIT_LINE.findall(text)
    assert int(waiting) == 1
    (counts,) = TIER_LINE.findall(text)
    want = Counter(expected_tiers(body, admin={eid(z): 5}, blocked_images=[eid(y), eid(z)]).values())
    assert [int(n) for n in counts] == [want[t] for t in (1, 2, 3, 4, 5)]
    assert want[5] == 4, "4 phần tử độ sâu 7: Z do admin gán 5, ba phần tử còn lại có ảnh"
    assert want[4] == 26 - 1, "26 phần tử độ sâu 5-6, trừ Y bị chặn ảnh"


def test_ac_tier_04_phan_tu_ha_do_sau_giua_hai_me_doi_tier_tu_dong():
    """AC-TIER-04: phần tử lá độ sâu 5 (tier 4) có thêm công thức ngắn hơn nên BFS đưa lên độ sâu 3: mẻ sau tính lại
    Xanh lá
    (tier 2), content.auto_tier cũng 2; mọi phần tử khác giữ nguyên tier."""
    core2, x = shorter_core(5)
    _, c1, _ = run_full_drawn(make_state(), batch_at=T)
    _, c2, _ = run_full_drawn(make_state(), batch_at=T2, core=core2)
    (b1,) = c1.success_posts
    (b2,) = c2.success_posts
    e1, e2 = content_by_id(b1)[eid(x)], content_by_id(b2)[eid(x)]
    assert (e1["depth"], e2["depth"]) == (5, 3)
    t1, t2 = graph_tiers(b1), graph_tiers(b2)
    assert (t1[eid(x)], e1["auto_tier"]) == (4, 4)
    assert (t2[eid(x)], e2["auto_tier"]) == (2, 2)
    assert {k: v for k, v in t1.items() if k != eid(x)} == {k: v for k, v in t2.items() if k != eid(x)}


def test_ac_tier_04_chay_lai_cung_me_cho_ket_qua_giong_het_byte_khong_co_tier_admin():
    """AC-TIER-04: không có tier admin, chạy lại cùng mẻ (cùng state, cùng batch_at) cho body giống hệt byte (graph,
    content.auto_tier, manifest)."""
    bodies = []
    for _ in range(2):
        _, client, _ = run_core(make_state())
        bodies.append(json.dumps(client.success_posts[0], sort_keys=True, ensure_ascii=False))
    assert bodies[0] == bodies[1]
    assert '"auto_tier"' in bodies[0]


# ---------------------------------------------------------------- AC-TIER-05 (phía pipeline)


def test_ac_tier_05_tier_admin_gan_thang_tier_tu_dong_du_do_sau_doi():
    """AC-TIER-05: P (lá độ sâu 5) được admin gán 4: mẻ trước và mẻ sau khi độ sâu của P xuống 3 đều ghi 4 trong graph,
    trong khi content.auto_tier của P đổi theo độ sâu (4 rồi 2)."""
    core2, p = shorter_core(5)
    state = make_state(tiers=[tier_row(p, 4)])
    _, c1, _ = run_full_drawn(copy.deepcopy(state), batch_at=T)
    _, c2, _ = run_full_drawn(copy.deepcopy(state), batch_at=T2, core=core2)
    (b1,) = c1.success_posts
    (b2,) = c2.success_posts
    assert content_by_id(b2)[eid(p)]["depth"] == 3
    assert graph_tiers(b1)[eid(p)] == 4
    assert graph_tiers(b2)[eid(p)] == 4
    assert content_by_id(b1)[eid(p)]["auto_tier"] == 4
    assert content_by_id(b2)[eid(p)]["auto_tier"] == 2


def test_ac_tier_05_bo_dong_tier_admin_thi_me_ke_tiep_tra_ve_tier_tu_dong():
    """AC-TIER-05: Q (độ sâu 3) đang được admin gán 5; sau khi Worker bỏ dòng tier (admin chọn "Tự động") mẻ kế tiếp ghi
    tier tự động của Q (2), mẻ trước vẫn 5."""
    q = names_at_depth(3)[0]
    _, c1, _ = run_full_drawn(make_state(tiers=[tier_row(q, 5)]), batch_at=T)
    _, c2, _ = run_full_drawn(make_state(), batch_at=T2)
    (b1,) = c1.success_posts
    (b2,) = c2.success_posts
    assert graph_tiers(b1)[eid(q)] == 5
    assert graph_tiers(b2)[eid(q)] == 2
    assert content_by_id(b1)[eid(q)]["auto_tier"] == 2
    assert content_by_id(b2)[eid(q)]["auto_tier"] == 2
