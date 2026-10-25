"""Acceptance tests for docs/acceptance/contrib.md, phần pipeline: AC-CONTRIB-08 và AC-CONTRIB-09 (ADR 0013).

Phủ sóng:
  AC-CONTRIB-08  `lau_meme_pipeline.contrib.add_contributions(store, rows, *, version, first_versions,
                 blocked=frozenset()) -> Joined(store, waiting)`: đề xuất đã duyệt thành phần tử mới
                 + công thức của cặp, depth theo BFS (cha sâu nhất + 1), không sửa kho đầu vào; cha
                 bị chặn thì chưa vào graph và được đếm ở `waiting`; cha hoạt động lại thì vào.
                 Ở mức mẻ full: phần tử vào content + graph, `stats.contributions_waiting` và báo
                 cáo đợt ghi số đề xuất chưa vào được graph, chạy lại cùng mẻ cho kết quả giống hệt.
  AC-CONTRIB-09  emoji lấy từ đề xuất, thiếu thì "🍲", trùng emoji phần tử có sẵn vẫn được; ảnh
                 chỉ vẽ từ gợi ý ảnh của admin; tên và gợi ý ảnh không bao giờ nằm trong payload
                 gửi cho LLM.

Hợp đồng dùng: GET /pipeline/state `contributions: [{element_id, name, emoji | null, a, b,
image_hint, approved_at}]` (docs/api/openapi.yaml, PipelineState). Các helper (FakeClient,
FakeReporter, FakeAdapter, make_llm, Recording, run_full) dùng lại từ test_pipe_full_batch.py,
test_tier.py và test_art_full_batch.py. Không có mạng, không có đồng hồ thật.
"""

import json
import re

from test_art_full_batch import ArtClient, Check, Draw, art_adapters, llm_with_hints
from test_pipe_full_batch import (
    MEME,
    FakeAdapter,
    FakeClient,
    FakeReporter,
    Recording,
    T,
    _classify,
    _describe,
    _judge,
    _link,
    _same,
    _supplement_element,
    _supplement_pair,
    make_llm,
    run_full_batch,
)
from test_tier import content_by_id, eid, make_state, real_core, run_full

VERSION = 202610210000
NAME = "Cà Phê Chạy Deadline"
NAME2 = "Meme Đóng Góp Hai"
HINT = "một ly cà phê đen đang chạy deadline"
HINT2 = "một cái nồi lẩu đang sôi"
DEFAULT_EMOJI = "🍲"
APPROVED_AT = "2026-10-20T01:00:00Z"


# ---------------------------------------------------------------- helpers


def row(name: str, a: str, b: str, emoji=None, hint: str = HINT, at: str = APPROVED_AT) -> dict:
    """Một dòng `contributions` của /pipeline/state: chỉ trường game, không mô tả, link ảnh, tài khoản hay nickname."""
    return {
        "element_id": eid(name),
        "name": name,
        "emoji": emoji,
        "a": eid(a),
        "b": eid(b),
        "image_hint": hint,
        "approved_at": at,
    }


def free_pairs(count: int) -> list[tuple[str, str]]:
    """`count` cặp phần tử lõi chưa có công thức, không chung phần tử nào với nhau."""
    core = real_core()
    used = {frozenset((r["a"], r["b"])) for r in core["recipes"]}
    names = [e["name"] for e in core["elements"]]
    out: list[tuple[str, str]] = []
    taken: set[str] = set()
    for i, a in enumerate(names):
        if a in taken:
            continue
        for b in names[i + 1 :]:
            if b in taken or frozenset((a, b)) in used:
                continue
            out.append((a, b))
            taken |= {a, b}
            break
        if len(out) == count:
            return out
    raise AssertionError("lõi không đủ cặp trống")


def deep_pair() -> tuple[str, str, int]:
    """(a, b, depth mong đợi): a ở độ sâu 5, b ở độ sâu 3, cặp chưa có công thức, BFS cho max + 1 = 6."""
    core = real_core()
    depth = {e["name"]: e["depth"] for e in core["elements"]}
    used = {frozenset((r["a"], r["b"])) for r in core["recipes"]}
    a = next(n for n in depth if depth[n] == 5)
    b = next(n for n in depth if depth[n] == 3 and frozenset((a, n)) not in used)
    return a, b, max(depth[a], depth[b]) + 1


def leaf_name(min_depth: int = 3) -> str:
    """Phần tử lõi không là nguyên liệu của công thức nào và không phải món khởi đầu.

    Chặn nó không làm vỡ phần tử khác."""
    core = real_core()
    ingredients = {r["a"] for r in core["recipes"]} | {r["b"] for r in core["recipes"]}
    starters = {s if isinstance(s, str) else s["name"] for s in core["starters"]}
    return next(
        e["name"]
        for e in core["elements"]
        if e["depth"] >= min_depth and e["name"] not in ingredients and e["name"] not in starters
    )


def store_of():
    from lau_meme_pipeline.seed import ContentStore, load_core

    return load_core(real_core(), ContentStore.empty()).store


def waiting_count(waiting) -> int:
    """`waiting` có thể là số hoặc tập các đề xuất chưa vào được; cả hai đều đếm được."""
    return waiting if isinstance(waiting, int) else len(waiting)


def join(store, rows, blocked=frozenset()):
    from lau_meme_pipeline.contrib import add_contributions

    return add_contributions(store, rows, version=VERSION, first_versions={}, blocked=blocked)


def decrypted(body: dict, a: str, b: str) -> dict:
    from lau_meme_pipeline.graph import decrypt_entry

    plain = decrypt_entry(body["graph"], a, b)
    assert plain is not None, f"graph không có mục của cặp ({a}, {b})"
    return plain


def with_blocked(state: dict, *names: str) -> dict:
    state["blocklist"]["elements"] = [eid(n) for n in names]
    return state


def run_full_with(state: dict, names: list[str], llm: dict):
    """Mẻ full với state và LLM tùy biến; trả (outcome, client, reporter)."""
    client, reporter = FakeClient(), FakeReporter()
    client.state = state
    outcome = run_full_batch(client, reporter, [FakeAdapter("RSS", names)], llm)
    return outcome, client, reporter


def run_full_art(state: dict, draw: Draw):
    """Mẻ full trong thế giới mà 174 phần tử lõi đã có ảnh: chỉ meme đóng góp cần vẽ."""
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    client, reporter = ArtClient(), FakeReporter()
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
        log=lambda m: None,
        banned_words=[],
        art=art_adapters(draw, Check()),
    )
    return outcome, client


# ---------------------------------------------------------------- AC-CONTRIB-08: add_contributions


def test_ac_contrib_08_add_contributions_tao_phan_tu_va_cong_thuc_cua_cap_depth_theo_bfs():
    """AC-CONTRIB-08: đề xuất đã duyệt cho cặp (a độ sâu 5, b độ sâu 3) thành phần tử mới, depth BFS = 6.

    Công thức của cặp (không phụ thuộc thứ tự) trỏ tới phần tử đó; không còn đề xuất nào chờ."""
    from lau_meme_pipeline.ids import recipe_id

    a, b, depth = deep_pair()
    joined = join(store_of(), [row(NAME, a, b)])
    el = joined.store.elements[eid(NAME)]
    assert el.depth == depth == 6
    assert el.status == "active"
    rec = joined.store.recipes[recipe_id(a, b)]
    assert rec.result == eid(NAME)
    assert rec.status == "active"
    assert recipe_id(a, b) == recipe_id(b, a)
    assert waiting_count(joined.waiting) == 0
    assert len(joined.store.elements) == 175
    assert len(joined.store.recipes) == 519


def test_ac_contrib_08_add_contributions_nhieu_de_xuat_va_khong_sua_kho_dau_vao():
    """AC-CONTRIB-08: nhiều đề xuất cùng lúc đều vào; kho đầu vào không bị sửa tại chỗ; gọi lại cho cùng kết quả."""
    from lau_meme_pipeline.ids import recipe_id

    p1, p2 = free_pairs(2)
    store = store_of()
    rows = [row(NAME, *p1), row(NAME2, *p2, emoji="☕", at="2026-10-20T02:00:00Z")]
    first = join(store, rows)
    assert len(store.elements) == 174 and len(store.recipes) == 518, "kho đầu vào không được đổi"
    assert eid(NAME) not in store.elements
    assert {eid(NAME), eid(NAME2)} <= set(first.store.elements)
    assert first.store.recipes[recipe_id(*p1)].result == eid(NAME)
    assert first.store.recipes[recipe_id(*p2)].result == eid(NAME2)
    second = join(store, rows)
    assert second.store == first.store
    assert waiting_count(second.waiting) == waiting_count(first.waiting) == 0


def test_ac_contrib_08_cha_bi_chan_thi_chua_vao_graph_va_duoc_dem_o_waiting():
    """AC-CONTRIB-08: một phần tử cha nằm trong `blocked`: phần tử đóng góp không hoạt động trong kho.

    (Không có hoặc không "active"), công thức của cặp cũng vậy, đếm 1 ở `waiting`; đề xuất khác vẫn vào."""
    from lau_meme_pipeline.ids import recipe_id

    p1, p2 = free_pairs(2)
    rows = [row(NAME, *p1), row(NAME2, *p2)]
    joined = join(store_of(), rows, blocked=frozenset({eid(p1[0])}))
    waiting_el = joined.store.elements.get(eid(NAME))
    waiting_rec = joined.store.recipes.get(recipe_id(*p1))
    assert waiting_el is None or waiting_el.status != "active"
    assert waiting_rec is None or waiting_rec.status != "active"
    assert waiting_count(joined.waiting) == 1
    assert joined.store.elements[eid(NAME2)].status == "active"
    assert joined.store.recipes[recipe_id(*p2)].result == eid(NAME2)


def test_ac_contrib_08_cha_hoat_dong_lai_thi_phan_tu_vao_graph():
    """AC-CONTRIB-08: đề xuất đang chờ vì cha bị chặn; mẻ sau cha hoạt động lại (blocked rỗng).

    Nạp tiếp trên kho của mẻ trước: phần tử và công thức hoạt động, `waiting` về 0."""
    from lau_meme_pipeline.ids import recipe_id

    (p1,) = free_pairs(1)
    first = join(store_of(), [row(NAME, *p1)], blocked=frozenset({eid(p1[1])}))
    assert waiting_count(first.waiting) == 1
    later = join(first.store, [row(NAME, *p1)])
    assert later.store.elements[eid(NAME)].status == "active"
    assert later.store.recipes[recipe_id(*p1)].result == eid(NAME)
    assert waiting_count(later.waiting) == 0


# ---------------------------------------------------------------- AC-CONTRIB-08: mẻ full


def test_ac_contrib_08_me_full_dua_phan_tu_vao_content_va_graph_voi_depth_bfs():
    """AC-CONTRIB-08: mẻ full đọc đề xuất đã duyệt từ /pipeline/state.

    Phần tử vào content với depth BFS, có công thức của cặp, graph giải mã ra phần tử (tên đúng),
    mẻ thành công, không đề xuất nào chờ."""
    a, b, depth = deep_pair()
    outcome, client = run_full(make_state(contributions=[row(NAME, a, b)]), names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    el = content_by_id(body)[eid(NAME)]
    assert el["name"] == NAME and el["depth"] == depth
    recipes = [r for r in body["content"]["recipes"] if r["result"] == eid(NAME)]
    assert len(recipes) == 1
    assert {recipes[0]["a"], recipes[0]["b"]} == {eid(a), eid(b)}
    plain = decrypted(body, a, b)
    assert plain["name"] == NAME and plain["id"] == eid(NAME) and plain["depth"] == depth
    assert body["stats"].get("contributions_waiting", 0) == 0


def test_ac_contrib_08_cha_bi_chan_thi_me_full_khong_dua_vao_graph_va_bao_cao_ghi_so_cho():
    """AC-CONTRIB-08: cha bị chặn (blocklist.elements) ở mẻ full: mẻ vẫn thành công.

    Phần tử đóng góp KHÔNG có trong content hay graph, stats.contributions_waiting = 1,
    báo cáo đợt ghi con số này."""
    from lau_meme_pipeline.graph import decrypt_entry

    parent = leaf_name()
    state = with_blocked(make_state(contributions=[row(NAME, parent, "Cay")]), parent)
    outcome, client, reporter = run_full_with(state, [], make_llm())
    assert outcome.ok is True
    (body,) = client.success_posts
    assert eid(NAME) not in content_by_id(body)
    assert decrypt_entry(body["graph"], parent, "Cay") is None
    assert body["stats"]["contributions_waiting"] == 1
    text = reporter.issues[0][1]
    assert re.search(r"(?i)đề xuất[^\n]*\b1\b", text), "báo cáo đợt phải ghi 1 đề xuất chưa vào được graph"


def test_ac_contrib_08_me_ke_tiep_khi_cha_hoat_dong_lai_thi_phan_tu_vao_graph():
    """AC-CONTRIB-08: cùng đề xuất, mẻ trước cha bị chặn thì chờ, mẻ sau blocklist rỗng thì vào graph và content."""
    parent = leaf_name()
    contributions = [row(NAME, parent, "Cay")]
    _, blocked_client = run_full(with_blocked(make_state(contributions=contributions), parent), names=())
    (blocked_body,) = blocked_client.success_posts
    assert eid(NAME) not in content_by_id(blocked_body)

    outcome, client = run_full(make_state(contributions=contributions), names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    assert content_by_id(body)[eid(NAME)]["name"] == NAME
    assert decrypted(body, parent, "Cay")["name"] == NAME
    assert body["stats"].get("contributions_waiting", 0) == 0


def test_ac_contrib_08_chay_lai_cung_me_cho_ket_qua_giong_het():
    """AC-CONTRIB-08: cùng state có đề xuất, cùng batch_at: body đăng giống hệt (không đồng hồ, không ngẫu nhiên)."""
    (p1,) = free_pairs(1)
    bodies = []
    for _ in range(2):
        _, client = run_full(make_state(contributions=[row(NAME, *p1)]), names=())
        bodies.append(json.dumps(client.success_posts[0], sort_keys=True, ensure_ascii=False))
    assert bodies[0] == bodies[1]


# ---------------------------------------------------------------- AC-CONTRIB-09


def test_ac_contrib_09_emoji_cua_de_xuat_hoac_mac_dinh_o_content_va_graph():
    """AC-CONTRIB-09: đề xuất có emoji "☕" thì phần tử dùng "☕"; không có emoji (null) dùng mặc định "🍲".

    Cả content và bản rõ trong graph khớp nhau."""
    p1, p2 = free_pairs(2)
    rows = [row(NAME, *p1, emoji="☕"), row(NAME2, *p2, emoji=None)]
    outcome, client = run_full(make_state(contributions=rows), names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    by_id = content_by_id(body)
    assert by_id[eid(NAME)]["emoji"] == "☕"
    assert by_id[eid(NAME2)]["emoji"] == DEFAULT_EMOJI
    assert decrypted(body, *p1)["emoji"] == "☕"
    assert decrypted(body, *p2)["emoji"] == DEFAULT_EMOJI


def test_ac_contrib_09_emoji_trung_voi_phan_tu_co_san_van_duoc_chap_nhan():
    """AC-CONTRIB-09: hai đề xuất dùng lại emoji của một phần tử lõi và trùng nhau cũng được.

    Đây là ngoại lệ của luật emoji duy nhất: mẻ vẫn thành công, cả hai giữ emoji đó."""
    core = real_core()
    taken = next(e["emoji"] for e in core["elements"] if e["name"] not in ("Cay", "Cười", "Toang", "Deadline"))
    p1, p2 = free_pairs(2)
    rows = [row(NAME, *p1, emoji=taken), row(NAME2, *p2, emoji=taken)]
    outcome, client = run_full(make_state(contributions=rows), names=())
    assert outcome.ok is True, "emoji trùng không được làm hỏng mẻ"
    (body,) = client.success_posts
    by_id = content_by_id(body)
    assert by_id[eid(NAME)]["emoji"] == taken
    assert by_id[eid(NAME2)]["emoji"] == taken
    assert any(e["emoji"] == taken and e["name"] not in (NAME, NAME2) for e in body["content"]["elements"])


def test_ac_contrib_09_khong_gui_ten_va_goi_y_anh_de_xuat_cho_llm():
    """AC-CONTRIB-09: mẻ full có meme crawl (nên LLM thật sự được gọi) và đề xuất đã duyệt.

    Không payload nào gửi cho bước LLM nào chứa tên hay gợi ý ảnh của đề xuất (kể cả dạng fold)."""
    (p1,) = free_pairs(1)
    steps = {
        "same": _same,
        "classify": _classify,
        "describe": _describe,
        "link": _link,
        "judge": _judge,
        "supplement_element": _supplement_element,
        "supplement_pair": _supplement_pair,
    }
    llm = make_llm(**{k: Recording(v) for k, v in steps.items()})
    outcome, client, _ = run_full_with(make_state(contributions=[row(NAME, *p1, hint=HINT2)]), [MEME], llm)
    assert outcome.ok is True
    assert sum(step.calls for step in llm.values()) > 0, "phải có gọi LLM thì kiểm tra mới có nghĩa"
    dump = json.dumps([p for step in llm.values() for p in step.payloads], ensure_ascii=False).lower()
    for text in (NAME, "ca phe chay deadline", HINT2):
        assert text.lower() not in dump, f"payload gửi LLM chứa nội dung đề xuất: {text!r}"
    (body,) = client.success_posts
    assert NAME in {e["name"] for e in body["content"]["elements"]}


def test_ac_contrib_09_anh_ve_tu_goi_y_cua_admin_khong_dung_ten_hay_link():
    """AC-CONTRIB-09: ART vẽ phần tử đóng góp như phần tử mới.

    Prompt chứa gợi ý ảnh do admin viết, không chứa tên đề xuất; phần tử nhận image_key của ảnh vừa tải lên."""
    (p1,) = free_pairs(1)
    draw = Draw()
    outcome, client = run_full_art(make_state(contributions=[row(NAME, *p1, hint=HINT2)]), draw)
    assert outcome.ok is True
    assert len(draw.prompts) == 1, "chỉ phần tử đóng góp cần vẽ"
    assert HINT2 in draw.prompts[0]
    assert NAME not in draw.prompts[0]
    assert "https://" not in draw.prompts[0]
    ((key, _data),) = client.puts
    (body,) = client.success_posts
    assert content_by_id(body)[eid(NAME)]["image_key"] == key


def test_ac_contrib_09_de_xuat_da_duyet_co_ten_trong_danh_sach_cam_khong_vao_kho_va_tinh_vao_waiting():
    """AC-CONTRIB-09: đề xuất đã duyệt có tên khớp từ cấm (lists=ModLists) không vào kho, được đếm ở `waiting`.

    Đề xuất sạch khác vẫn vào; công thức của cặp bị cấm không được tạo."""
    from lau_meme_pipeline.contrib import add_contributions
    from lau_meme_pipeline.ids import recipe_id
    from lau_meme_pipeline.moderation import ModLists

    p1, p2 = free_pairs(2)
    lists = ModLists(banned_words=frozenset({"ca phe chay deadline"}))
    joined = add_contributions(
        store_of(),
        [row(NAME, *p1), row(NAME2, *p2)],
        version=VERSION,
        first_versions={},
        blocked=frozenset(),
        lists=lists,
    )
    banned_el = joined.store.elements.get(eid(NAME))
    banned_rec = joined.store.recipes.get(recipe_id(*p1))
    assert banned_el is None or banned_el.status != "active"
    assert banned_rec is None or banned_rec.status != "active"
    assert waiting_count(joined.waiting) == 1
    assert joined.store.elements[eid(NAME2)].status == "active"
    assert joined.store.recipes[recipe_id(*p2)].result == eid(NAME2)


def test_ac_contrib_09_me_full_co_de_xuat_ten_bi_cam_khong_that_bai_va_bao_cho_ghi_so_cho():
    """AC-CONTRIB-09: mẻ full có đề xuất đã duyệt mà tên bị chặn (banned_aliases của state): mẻ vẫn thành công.

    Không InvariantError, phần tử không vào content, stats.contributions_waiting >= 1."""
    (p1,) = free_pairs(1)
    state = make_state(contributions=[row(NAME, *p1)])
    state["banned_aliases"] = ["ca phe chay deadline"]
    outcome, client = run_full(state, names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    assert eid(NAME) not in content_by_id(body)
    assert body["stats"]["contributions_waiting"] >= 1
