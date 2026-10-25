"""Acceptance tests for docs/acceptance/art.md: AC-ART-12 (ưu tiên vẽ ảnh cho món sắp lên Vàng/Đỏ, thêm 2026-10-24).

Dùng lại các fake và helper của AC-ART-11 (test_art_core_backfill.py) và AC-TIER-04 (test_tier.py). Bề mặt public:

    run_batch(mode="full", ..., art=ArtAdapters | None)            (qua helper `run` / `draw_second_batch`)
    client.state["tiers"] = [{element_id, tier}]                   (tier admin gán)
    client.state["blocklist"]["images"] = [element id]             (ảnh bị chặn / ẩn)
    PipelineStore.core_art = [{id, name, image_key?, ...}]         (một mục cho mỗi phần tử lõi)
    báo cáo đợt (GitHub Issue): dòng "Vàng/Đỏ thiếu ảnh: <tên>"

Thứ tự vẽ kỳ vọng được tính ngay trong file này từ docs/input/noi-dung-loi.json (độ sâu giảm dần rồi tên đã bỏ dấu cho
nhóm ưu tiên; độ sâu tăng dần rồi tên đã bỏ dấu cho lõi), không bằng code production. Không mạng, không sleep, không
đồng hồ thật.
"""

import re

from test_art_core_backfill import (
    CAP,
    PRESET_KEY,
    ArtClient,
    base_store,
    core_entry,
    core_hint,
    core_order,
    draw_second_batch,
    mutate,
    plain_fold,
)
from test_art_full_batch import (
    MANY_NAMES,
    Check,
    DrawFailingOn,
    art_adapters,
    content_element,
    run,
)
from test_pipe_full_batch import T2, FakeReporter, real_core
from test_tier import eid, graph_tiers, names_at_depth, table

MISSING_LINE = re.compile(r"Vàng/Đỏ thiếu ảnh:([^\n]*)")


# ---------------------------------------------------------------- helpers


def depth_of(name: str) -> int:
    (found,) = [e["depth"] for e in real_core()["elements"] if e["name"] == name]
    return found


def priority_order(names) -> list[str]:
    """Nhóm ưu tiên: độ sâu giảm dần, rồi tên đã bỏ dấu (độc lập với code production)."""
    return sorted(names, key=lambda n: (-depth_of(n), plain_fold(n)))


def hint_of(name: str) -> str:
    (found,) = [e for e in real_core()["elements"] if e["name"] == name]
    return core_hint(found)


class World:
    """Kho đầu vào của AC-ART-12: 3 phần tử chờ vẽ, mọi lõi đã có ảnh trừ nhóm chỉ định."""

    def __init__(self, unimaged, admin=(), blocked=(), pending=MANY_NAMES[0:3]):
        self.pending = list(pending)
        _first, self.store = base_store(self.pending)
        unimaged = set(unimaged)
        for element in real_core()["elements"]:
            if element["name"] not in unimaged:
                mutate(self.store, element["name"], image_key=PRESET_KEY)
        for name in unimaged:
            assert not core_entry(self.store, name).get("image_key")
        self.admin = list(admin)
        self.blocked = list(blocked)

    def client(self) -> ArtClient:
        client = ArtClient(store=self.store)
        client.state["tiers"] = [{"element_id": eid(n), "tier": t} for n, t in self.admin]
        client.state["blocklist"]["images"] = [eid(n) for n in self.blocked]
        return client


def mixed_world():
    """4 phần tử sâu >= 5 chưa có ảnh (hai độ sâu 7, hai độ sâu 5), Z độ sâu 6 admin gán Vàng mà ảnh bị chặn, và 30 phần
    tử lõi nông chưa có ảnh. Trả (world, deep4, z, shallow30)."""
    deep4 = names_at_depth(7)[:2] + names_at_depth(5)[:2]
    z = names_at_depth(6)[0]
    taken = {*deep4, z}
    shallow30 = [e["name"] for e in core_order() if e["name"] not in taken][:30]
    assert all(depth_of(n) < 5 for n in shallow30)
    world = World(unimaged=[*deep4, *shallow30], admin=[(z, 4)], blocked=[z])
    return world, deep4, z, shallow30


# ================================================================ AC-ART-12


def expected_sections(body, group_core, pending, new, shallow_core):
    """Thứ tự vẽ kỳ vọng tính từ độ sâu đã đăng, độc lập với code production. Trả (nhóm ưu tiên, chờ vẽ ngoài nhóm,
    mới ngoài nhóm, lõi). Nhóm ưu tiên = phần tử lõi trong `group_core` + meme chờ vẽ/mới sâu >= 5 chưa có ảnh, xếp độ
    sâu giảm dần rồi tên đã fold. Lõi lấp phần chỗ còn lại của 20 ảnh."""
    deep_memes = [n for n in [*pending, *new] if content_element(body, n)["depth"] >= 5]
    depth = {n: depth_of(n) for n in group_core}
    depth.update({n: content_element(body, n)["depth"] for n in deep_memes})
    marker = {n: hint_of(n) for n in group_core}
    marker.update({n: f"hình {n}" for n in deep_memes})
    group = sorted(depth, key=lambda n: (-depth[n], plain_fold(n)))
    rest_pending = [n for n in pending if n not in deep_memes]
    rest_new = [n for n in new if n not in deep_memes]
    left = CAP - len(group) - len(rest_pending) - len(rest_new)
    core = [e for e in core_order() if e["name"] in set(shallow_core)][: max(left, 0)]
    return [marker[n] for n in group], [f"hình {n}" for n in rest_pending], [f"hình {n}" for n in rest_new], core


def test_ac_art_12_thu_tu_ve_uu_tien_vang_do_roi_cho_ve_roi_moi_roi_loi_5_3_5_7():
    """AC-ART-12: 4 phần tử sâu >= 5 chưa có ảnh + 1 phần tử admin Vàng bị chặn ảnh + 3 chờ vẽ + 5 mới + 30 lõi chưa có
    ảnh: đúng 20 lần vẽ theo thứ tự nhóm ưu tiên (độ sâu giảm dần, rồi tên đã fold; Z độ sâu 6 xen giữa), rồi 3 chờ vẽ,
    rồi 5 mới, rồi 7 lõi đầu tiên theo AC-ART-11."""
    world, deep4, z, shallow30 = mixed_world()
    new_names = MANY_NAMES[3:8]
    body, _client, _reporter, draw = draw_second_batch(world.store, new_names, client=world.client())

    # Nhóm ưu tiên là MỌI phần tử Vàng/Đỏ thiếu ảnh: lõi sâu, Z (admin) và meme chờ vẽ/mới có độ sâu đã đăng >= 5.
    group, rest_pending, rest_new, core = expected_sections(body, [*deep4, z], world.pending, new_names, shallow30)
    assert len(draw.prompts) == CAP
    assert len(group) >= 5
    for i, mark in enumerate(group):
        assert mark in draw.prompts[i], f"ưu tiên thứ {i}"
    pos = len(group)
    for i, mark in enumerate(rest_pending):
        assert mark in draw.prompts[pos + i], f"chờ vẽ ngoài nhóm thứ {i}"
    pos += len(rest_pending)
    window = draw.prompts[pos : pos + len(rest_new)]
    for mark in rest_new:
        assert sum(mark in p for p in window) == 1, f"{mark} vẽ sau chờ vẽ, trước lõi"
    pos += len(rest_new)
    for i, element in enumerate(core):
        assert core_hint(element) in draw.prompts[pos + i], f"lõi thứ {i}: {element['name']}"
    assert pos + len(core) == CAP
    for name in shallow30:
        if name not in {e["name"] for e in core}:
            assert not any(hint_of(name) in p for p in draw.prompts), f"{name} hết chỗ trong 20 ảnh"


def test_ac_art_12_phan_tu_admin_vang_do_mat_anh_hoan_toan_cung_vao_nhom_uu_tien():
    """AC-ART-12: phần tử W độ sâu thấp admin gán Đỏ (tier 5) mà không có ảnh nào: vẽ đầu tiên, trước phần tử chờ vẽ và
    phần tử mới; phần tử lõi khác đã có ảnh không bị vẽ lại."""
    w = names_at_depth(2)[0]
    pending, new = MANY_NAMES[0:1], MANY_NAMES[1:2]
    world = World(unimaged=[w], admin=[(w, 5)], pending=pending)
    body, _client, _reporter, draw = draw_second_batch(world.store, new, client=world.client())

    # meme sâu >= 5 chưa có ảnh cũng thuộc nhóm ưu tiên và có thể đứng trước W nếu sâu hơn
    group, rest_pending, rest_new, _core = expected_sections(body, [w], pending, new, [])
    expected = [*group, *rest_pending, *rest_new]
    assert hint_of(w) in group
    assert len(draw.prompts) == len(expected) == 3
    for i, mark in enumerate(expected):
        assert mark in draw.prompts[i], f"vị trí {i}"


def test_ac_art_12_co_anh_hop_le_thi_len_tier_tu_dong_dung_do_sau_ngay_trong_me_do():
    """AC-ART-12: 4 phần tử sâu >= 5 chưa có ảnh được vẽ và qua kiểm duyệt: ngay trong graph và content.auto_tier của
    mẻ đó có image_key và tier theo bảng đầy đủ (Đỏ cho độ sâu 7, Vàng cho độ sâu 5), không bị giữ ở Xanh dương; khi
    không vẽ được (art=None) cùng phần tử đó vẫn ở Xanh dương (3)."""
    deep4 = names_at_depth(7)[:2] + names_at_depth(5)[:2]
    world = World(unimaged=deep4)
    body, _client, _reporter, _draw = draw_second_batch(world.store, MANY_NAMES[3:4], client=world.client())

    tiers = graph_tiers(body)
    for name in deep4:
        element = content_element(body, name)
        assert element.get("image_key"), f"{name} phải có ảnh vừa vẽ"
        want = table(element["depth"], True)
        assert want in (4, 5)
        assert element["auto_tier"] == want, name
        assert tiers[element["id"]] == want, name

    held = World(unimaged=deep4)
    client = held.client()
    outcome = run(client, FakeReporter(), MANY_NAMES[3:4], None, batch_at=T2)
    assert outcome.ok is True
    (held_body,) = client.success_posts
    held_tiers = graph_tiers(held_body)
    for name in deep4:
        element = content_element(held_body, name)
        assert element.get("image_key") is None
        assert element["auto_tier"] == 3 and held_tiers[element["id"]] == 3, name


def test_ac_art_12_admin_vang_do_khong_con_anh_sau_khi_ve_thi_ghi_bao_cao_va_van_dang_graph():
    """AC-ART-12: Z (admin gán Vàng, ảnh bị chặn) mà lần vẽ lại gặp lỗi tạm thời nên vẫn không có ảnh hợp lệ: mẻ vẫn
    success và graph vẫn đăng (Z giữ tier admin 4), báo cáo đợt có dòng "Vàng/Đỏ thiếu ảnh: <tên Z>"; phần tử tier tự
    động không nằm trong dòng đó."""
    from lau_meme_pipeline.llm import LlmError

    world, deep4, z, _shallow = mixed_world()
    draw = DrawFailingOn(hint_of(z), LlmError("HTTP 503"))
    reporter = FakeReporter()
    client = world.client()
    outcome = run(client, reporter, MANY_NAMES[3:8], art_adapters(draw, Check()), batch_at=T2)

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert any(hint_of(z) in p for p in draw.prompts), "Z phải được thử vẽ"
    assert graph_tiers(body)[eid(z)] == 4
    lines = MISSING_LINE.findall(reporter.issues[0][1])
    assert lines, 'báo cáo phải có dòng "Vàng/Đỏ thiếu ảnh: <tên>"'
    assert any(z in line for line in lines)
    for name in deep4:
        assert not any(name in line for line in lines), f"{name} là tier tự động, không phải admin gán"


def test_ac_art_12_admin_vang_do_mat_anh_ve_duoc_thi_khong_vao_dong_thieu_anh():
    """AC-ART-12: W admin gán Vàng, chưa có ảnh, lần vẽ qua kiểm duyệt: có image_key, không nằm trong dòng "Vàng/Đỏ
    thiếu ảnh"."""
    w = names_at_depth(3)[0]
    world = World(unimaged=[w], admin=[(w, 4)], pending=MANY_NAMES[0:1])
    body, _client, reporter, _draw = draw_second_batch(world.store, MANY_NAMES[1:2], client=world.client())

    assert content_element(body, w).get("image_key")
    lines = MISSING_LINE.findall(reporter.issues[0][1])
    assert not any(w in line for line in lines)


def test_ac_art_12_cung_dau_vao_cho_cung_thu_tu_ve():
    """AC-ART-12: xác định: hai lần chạy cùng kho, cùng batch cho đúng cùng danh sách prompt theo cùng thứ tự và cùng
    bộ khóa ảnh."""
    runs = []
    for _ in range(2):
        world, _deep4, _z, _shallow = mixed_world()
        _body, client, _reporter, draw = draw_second_batch(world.store, MANY_NAMES[3:8], client=world.client())
        runs.append((list(draw.prompts), [key for key, _ in client.puts]))

    assert runs[0] == runs[1]
    assert len(runs[0][0]) == CAP
