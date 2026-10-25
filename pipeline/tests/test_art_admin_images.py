"""Acceptance tests for docs/acceptance/art.md, AC-ART-13 phía pipeline (ADR 0016).

`GET /pipeline/state` trả `admin_images: [{element_id, image_key}]` (ảnh admin tải tay). Pipeline dùng nguyên khóa đó,
không vẽ phần tử ấy (không gọi adapter vẽ cho nó), coi nó là có ảnh dùng được khi tính tier (trừ khi ảnh bị chặn), và
graph/content đăng ra mang đúng khóa admin.

Test dựng thế giới "lõi chưa có ảnh nào" (ArtClient(core_drawn=False)) để mọi phần tử lõi đều đang chờ vẽ; phần tử P là
phần tử đầu hàng đợi vẽ (độ sâu lớn nhất trước, rồi tên đã fold - AC-ART-12), nên nếu admin không có ảnh cho P thì P
chắc chắn được vẽ ở đợt này. Gợi ý ảnh của P lấy từ file lõi; adapter vẽ ghi lại mọi prompt.
"""

from test_art_full_batch import ArtClient, Check, Draw, art_adapters, content_element, fold_name, llm_with_hints
from test_pipe_full_batch import FakeAdapter, FakeReporter
from test_tier import T, core_entries, eid, graph_tiers, make_state, real_core, table

ADMIN_IMG = "abcdef012345.webp"


def first_in_draw_queue() -> dict:
    """Phần tử lõi đứng đầu hàng đợi vẽ ở mẻ full đầu tiên (AC-ART-12): độ sâu giảm dần rồi tên đã fold."""
    return sorted(real_core()["elements"], key=lambda e: (-e["depth"], fold_name(e["name"])))[0]


def run_world(state: dict, draw=None):
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    client, reporter, draw = ArtClient(core_drawn=False), FakeReporter(), draw or Draw()
    client.state = state
    outcome = run_batch(
        mode="full",
        batch_at=T,
        core=real_core(),
        client=client,
        reporter=reporter,
        adapters=[FakeAdapter("RSS", [])],
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=llm_with_hints(),
        log=lambda msg: None,
        banned_words=[],
        art=art_adapters(draw, Check()),
    )
    return outcome, client, draw


def test_ac_art_13_pipeline_khong_ve_phan_tu_co_anh_admin_va_giu_khoa_admin_trong_content_va_graph():
    """AC-ART-13: state.admin_images có P với khóa K: không có lần vẽ nào dùng gợi ý ảnh của P (đối chứng: không có
    admin_images thì P được vẽ đầu tiên), các phần tử khác vẫn được vẽ, content và graph của mẻ giữ image_key K cho P,
    pipeline không tải K lên R2."""
    p = first_in_draw_queue()
    state = make_state()
    state["admin_images"] = [{"element_id": eid(p["name"]), "image_key": ADMIN_IMG}]

    _, _, control_draw = run_world(make_state())
    assert any(p["image_hint"] in prompt for prompt in control_draw.prompts), (
        "đối chứng: không có ảnh admin thì P được vẽ"
    )

    outcome, client, draw = run_world(state)
    assert outcome.ok is True
    assert draw.prompts, "các phần tử lõi khác vẫn được vẽ"
    assert not any(p["image_hint"] in prompt for prompt in draw.prompts)
    assert ADMIN_IMG not in [key for key, _ in client.puts]

    (body,) = client.success_posts
    assert content_element(body, p["name"])["image_key"] == ADMIN_IMG
    plains = [plain for r, plain in core_entries(body["graph"]) if r["result"] == p["name"]]
    assert plains and all(plain["image_key"] == ADMIN_IMG for plain in plains)


def test_ac_art_13_anh_admin_tinh_la_co_anh_dung_duoc_cho_tier_tru_khi_bi_chan():
    """AC-ART-13: P (độ sâu lớn nhất) có ảnh admin: auto_tier theo bảng với ảnh dùng được (không bị hạ về 3) và graph
    mang đúng tier đó; nếu ảnh của P nằm trong blocklist.images thì auto_tier hạ về 3 như mọi ảnh bị chặn."""
    p = first_in_draw_queue()
    pid = eid(p["name"])
    assert table(p["depth"], True) >= 4 and table(p["depth"], False) == 3

    def broken() -> Draw:
        # every draw fails, so no AI image can give P a usable image
        return Draw(exc=RuntimeError("draw down"))

    control_outcome, control_client, _ = run_world(make_state(), broken())
    assert control_outcome.ok is True
    (control_body,) = control_client.success_posts
    assert content_element(control_body, p["name"]).get("image_key") is None
    assert content_element(control_body, p["name"])["auto_tier"] == 3

    state = make_state()
    state["admin_images"] = [{"element_id": pid, "image_key": ADMIN_IMG}]
    outcome, client, _ = run_world(state, broken())
    assert outcome.ok is True
    (body,) = client.success_posts
    assert content_element(body, p["name"])["auto_tier"] == table(p["depth"], True)
    assert graph_tiers(body)[pid] == table(p["depth"], True)

    blocked = make_state(blocked_images=[pid])
    blocked["admin_images"] = [{"element_id": pid, "image_key": ADMIN_IMG}]
    outcome, client, _ = run_world(blocked, broken())
    assert outcome.ok is True
    (body,) = client.success_posts
    assert content_element(body, p["name"])["auto_tier"] == 3
