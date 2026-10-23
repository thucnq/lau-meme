"""Acceptance tests for docs/acceptance/art.md: AC-ART-11 (vẽ bù ảnh cho phần tử lõi, thêm 2026-10-23).

Reuses the fakes of test_art_full_batch.py / test_pipe_full_batch.py. Same public surface as AC-ART-09/10:

    run_batch(mode="full" | "core", ..., art=ArtAdapters | None)    client.put_image / client.image_exists
    PipelineStore.art_pending; PipelineStore.core_art = [{id, name, image_key?, art_attempts?, image_fallback?}]
    one entry per core element (core elements are NOT in store.elements)
    batch report (GitHub Issue) line "Lõi còn chưa có ảnh: N"

Core elements come from docs/input/noi-dung-loi.json (174 elements, every one has an image_hint). The expected drawing
order is computed here from that file (depth ascending, then the accent-stripped lower-case name), never with production
code. The store a batch starts from is built by running a first batch with art=None (nothing is drawn) and then editing
the published store JSON, so the tests only rely on the store shape the other ART tests already rely on.

No network, no sleeping, no real clock. Imports of production names happen inside the tests.
"""

import copy
import re
import unicodedata
from datetime import timedelta

from test_art_full_batch import (
    HINT,
    HINT2,
    MANY_NAMES,
    MEME2,
    Check,
    Draw,
    DrawFailingOn,
    art_adapters,
    content_element,
    pending_of,
    run,
)
from test_art_full_batch import ArtClient as _ArtClient
from test_pipe_full_batch import MEME, T2, FakeReporter, T, real_core

CAP = 20
PRESET_KEY = "0123456789ab.webp"
REPORT_LINE = re.compile(r"Lõi còn chưa có ảnh: (\d+)")


# ---------------------------------------------------------------- helpers


def plain_fold(text: str) -> str:
    """Independent accent-stripping lower-casing (test-side only)."""
    text = text.replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn").lower()


def core_order() -> list[dict]:
    """Core elements in the order AC-ART-11 draws them: depth ascending, then folded name."""
    return sorted(real_core()["elements"], key=lambda e: (e["depth"], plain_fold(e["name"])))


def core_hint(element: dict) -> str:
    return element["image_hint"]


class ArtClient(_ArtClient):
    """The shared ArtClient, but with core images NOT already drawn (this file is about drawing them)."""

    def __init__(self, store=None, exists=False, fail_put=False, core_drawn=False):
        super().__init__(store=store, exists=exists, fail_put=fail_put, core_drawn=core_drawn)


def core_entry(store_or_body: dict, name: str) -> dict:
    """The store.core_art entry of a core element (accepts a store or a posted batch body)."""
    store = store_or_body.get("store", store_or_body)
    (found,) = [e for e in store["core_art"] if e["name"] == name]
    return found


def mutate(store: dict, name: str, **attrs) -> None:
    core_entry(store, name).update(attrs)


def base_store(pending_names):
    """Run a batch that crawls `pending_names` but cannot draw (art=None); return (body, store) where the store waits
    exactly on those meme ids (core elements are not part of the waiting list)."""
    client = ArtClient()
    outcome = run(client, FakeReporter(), pending_names, None)
    assert outcome.ok is True
    (body,) = client.success_posts
    store = copy.deepcopy(body["store"])
    store["art_pending"] = [content_element(body, n)["id"] for n in pending_names]
    return body, store


def core_names() -> set[str]:
    return {e["name"] for e in real_core()["elements"]}


def report_count(reporter) -> int:
    (match,) = REPORT_LINE.findall(reporter.issues[0][1])
    return int(match)


def draw_second_batch(store, names, draw=None, check=None, client=None, reporter=None, batch_at=T2):
    client = client if client is not None else ArtClient(store=store)
    reporter = reporter if reporter is not None else FakeReporter()
    draw = draw if draw is not None else Draw()
    outcome = run(
        client, reporter, names, art_adapters(draw, check if check is not None else Check()), batch_at=batch_at
    )
    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    return body, client, reporter, draw


# ================================================================ AC-ART-11


def test_ac_art_11_thu_tu_ve_cho_ve_roi_moi_roi_loi_dung_3_5_12():
    """AC-ART-11: art_pending có 3 phần tử, đợt có 5 phần tử mới, 174 phần tử lõi chưa có ảnh: đúng 20 lần vẽ theo thứ
    tự 3 phần tử chờ vẽ (theo thứ tự trong art_pending), rồi 5 phần tử mới, rồi 12 phần tử lõi đầu tiên xếp theo depth
    tăng dần rồi tên đã fold; 20 ảnh được tải lên trước khi đăng mẻ."""
    pending_names, new_names = MANY_NAMES[0:3], MANY_NAMES[3:8]
    _first, store = base_store(pending_names)
    _body, client, _reporter, draw = draw_second_batch(store, new_names)

    assert len(draw.prompts) == CAP
    for i, name in enumerate(pending_names):
        assert f"hình {name}" in draw.prompts[i], f"phần tử chờ vẽ thứ {i} phải được vẽ trước"
    for name in new_names:
        assert sum(f"hình {name}" in p for p in draw.prompts[3:8]) == 1, f"{name} vẽ sau phần tử chờ vẽ, trước lõi"
    expected_core = core_order()[:12]
    for i, element in enumerate(expected_core):
        assert core_hint(element) in draw.prompts[8 + i], f"lõi thứ {i}: {element['name']} (depth {element['depth']})"
    assert len(client.puts) == CAP
    last_put = max(i for i, c in enumerate(client.calls) if c == "put_image")
    assert last_put < client.calls.index("post_batch")


def test_ac_art_11_anh_loi_duoc_dang_voi_image_key_va_loi_con_lai_khong_co_anh():
    """AC-ART-11: 12 phần tử lõi được vẽ mang image_key đúng khóa đã tải lên trong graph/content; phần tử lõi thứ 13
    (hết chỗ trong 20 ảnh) chưa có ảnh; art_pending không chứa phần tử lõi nào (phần chưa vẽ không phải "chờ vẽ")."""
    _first, store = base_store(MANY_NAMES[0:3])
    body, client, _reporter, _draw = draw_second_batch(store, MANY_NAMES[3:8])

    ordered = core_order()
    uploaded = {key for key, _ in client.puts}
    keys = [content_element(body, e["name"]).get("image_key") for e in ordered[:12]]
    assert all(keys)
    assert set(keys) <= uploaded
    assert content_element(body, ordered[12]["name"]).get("image_key") is None
    core_ids = {content_element(body, e["name"])["id"] for e in ordered}
    assert not (set(pending_of(body)) & core_ids)
    assert pending_of(body) == []


def test_ac_art_11_bao_cao_dot_ghi_loi_con_chua_co_anh():
    """AC-ART-11: sau đợt 3 + 5 + 12, báo cáo đợt có dòng "Lõi còn chưa có ảnh: 162" (174 - 12)."""
    _first, store = base_store(MANY_NAMES[0:3])
    _body, _client, reporter, _draw = draw_second_batch(store, MANY_NAMES[3:8])

    assert report_count(reporter) == 162


def test_ac_art_11_kho_moi_chua_co_anh_nao_thi_dot_dau_ve_meme_roi_19_loi():
    """AC-ART-11: kho trống (174 lõi chưa có ảnh), 1 meme mới: meme vẽ trước, 19 phần tử lõi đầu tiên theo thứ tự
    depth/tên fold vẽ sau, báo cáo còn 155."""
    client, reporter, draw = ArtClient(), FakeReporter(), Draw()
    outcome = run(client, reporter, [MEME], art_adapters(draw, Check()))

    assert outcome.ok is True
    assert len(draw.prompts) == CAP
    assert HINT in draw.prompts[0]
    for i, element in enumerate(core_order()[:19]):
        assert core_hint(element) in draw.prompts[1 + i]
    assert report_count(reporter) == 155


def test_ac_art_11_loi_da_co_anh_het_luot_an_hoac_chan_thi_khong_ve_lai():
    """AC-ART-11: bốn phần tử lõi: một đã có image_key, một hết lượt thử (art_attempts 3, giữ emoji), hai bị chặn
    (blocklist.elements; "ẩn" trong pipeline là bị chặn hoặc không còn đường tới, không có trường status); hai phần tử
    bị chặn là phần tử lá (không bao giờ là nguyên liệu của công thức nào, không phải starter) nên không làm phần tử
    khác mất kết nối: không phần tử nào bị vẽ; phần tử chờ vẽ, meme
    mới rồi 18 phần tử lõi kế tiếp (bỏ qua bốn phần tử trên) được vẽ; ảnh sẵn có giữ nguyên khóa; N = 174 - 4 - 18."""
    _first, store = base_store([MEME])
    ordered = core_order()
    core = real_core()
    starters = {s if isinstance(s, str) else s["name"] for s in core["starters"]}
    ingredients = {r["a"] for r in core["recipes"]} | {r["b"] for r in core["recipes"]}
    leaves = [e for e in ordered if e["name"] not in ingredients and e["name"] not in starters]
    assert len(leaves) >= 2
    has_image, exhausted = ordered[0], ordered[1]
    blocked, blocked2 = leaves[-2], leaves[-1]
    skipped_names = {e["name"] for e in (has_image, exhausted, blocked, blocked2)}
    assert len(skipped_names) == 4
    mutate(store, has_image["name"], image_key=PRESET_KEY)
    mutate(store, exhausted["name"], art_attempts=3, image_fallback=True)
    client = ArtClient(store=store)
    client.state["blocklist"]["elements"] = [core_entry(store, e["name"])["id"] for e in (blocked, blocked2)]

    body, client, reporter, draw = draw_second_batch(store, [MEME2], client=client)

    assert len(draw.prompts) == CAP
    assert HINT in draw.prompts[0], "phần tử chờ vẽ trước"
    assert HINT2 in draw.prompts[1], "rồi phần tử mới"
    for skipped in (has_image, exhausted, blocked, blocked2):
        assert not any(core_hint(skipped) in p for p in draw.prompts), f"{skipped['name']} không được vẽ lại"
    expected_core = [e for e in ordered if e["name"] not in skipped_names][:18]
    for i, element in enumerate(expected_core):
        assert core_hint(element) in draw.prompts[2 + i]
    assert content_element(body, has_image["name"])["image_key"] == PRESET_KEY
    assert content_element(body, exhausted["name"]).get("image_key") is None
    assert report_count(reporter) == 174 - 4 - 18, "trừ 4 phần tử không vẽ và 18 phần tử vừa vẽ"


def test_ac_art_11_moi_loi_deu_da_co_anh_thi_chi_ve_meme_va_bao_cao_con_0():
    """AC-ART-11: cả 174 phần tử lõi đã có image_key: chỉ phần tử chờ vẽ và meme mới được vẽ, không phần tử lõi nào bị
    vẽ lại, báo cáo "Lõi còn chưa có ảnh: 0"."""
    _first, store = base_store([MEME])
    for element in real_core()["elements"]:
        mutate(store, element["name"], image_key=PRESET_KEY)

    _body, client, reporter, draw = draw_second_batch(store, [MEME2])

    assert len(draw.prompts) == 2
    assert HINT in draw.prompts[0] and HINT2 in draw.prompts[1]
    assert len(client.puts) == 2
    assert report_count(reporter) == 0


def test_ac_art_11_anh_loi_bi_gemini_loai_hai_lan_thi_ve_emoji_dut_diem_khong_cho_ve():
    """AC-ART-11: Gemini loại ảnh của phần tử lõi đầu tiên hai lần ("real_face" rồi "text"): 2 lần vẽ cho đúng phần tử
    đó, không image_key, không nằm trong art_pending, báo cáo đếm cả hai lý do; đợt sau không vẽ lại phần tử đó."""
    first_core = core_order()[0]
    client, reporter, draw = ArtClient(), FakeReporter(), Draw()
    check = Check([None, "real_face", "text"])  # meme passes, then the first core image fails twice
    outcome = run(client, reporter, [MEME], art_adapters(draw, check))

    assert outcome.ok is True and outcome.status == "success"
    assert sum(core_hint(first_core) in p for p in draw.prompts) == 2
    (body,) = client.success_posts
    assert content_element(body, first_core["name"]).get("image_key") is None
    assert content_element(body, first_core["name"])["id"] not in pending_of(body)
    text = reporter.issues[0][1]
    assert re.search(r"real_face\W{1,8}1\b", text)
    assert re.search(r"\btext\W{1,8}1\b", text)

    body2, _client2, _reporter2, draw2 = draw_second_batch(body["store"], [MEME2])
    assert not any(core_hint(first_core) in p for p in draw2.prompts)
    assert content_element(body2, first_core["name"]).get("image_key") is None


def test_ac_art_11_anh_loi_dat_o_lan_hai_thi_dung_anh_lan_hai():
    """AC-ART-11: ảnh lõi đầu tiên bị loại một lần ("logo") rồi đạt: có image_key, tải lên đủ, báo cáo đếm logo 1."""
    first_core = core_order()[0]
    client, reporter, draw = ArtClient(), FakeReporter(), Draw()
    run(client, reporter, [MEME], art_adapters(draw, Check([None, "logo"])))

    (body,) = client.success_posts
    key = content_element(body, first_core["name"]).get("image_key")
    assert key and key in {k for k, _ in client.puts}
    assert sum(core_hint(first_core) in p for p in draw.prompts) == 2
    assert re.search(r"logo\W{1,8}1\b", reporter.issues[0][1])


def test_ac_art_11_loi_tam_thoi_cho_ve_roi_ba_dot_het_luot_thi_giu_emoji_khong_ve_lai():
    """AC-ART-11: phần tử lõi đầu tiên gặp lỗi tạm thời (LlmError) trong khi các phần tử khác vẽ được: art_attempts của
    nó là 1, 2, 3 qua ba đợt liên tiếp; còn trong art_pending sau đợt 1 và 2 (và được vẽ trước phần tử mới ở đợt sau),
    hết chờ vẽ sau đợt 3 và giữ emoji; đợt 4 không vẽ lại."""
    from lau_meme_pipeline.llm import LlmError

    target = core_order()[0]
    plan = [
        ([MEME], T),
        ([MEME2], T2),
        ([MANY_NAMES[0]], T + timedelta(hours=24)),
        ([MANY_NAMES[1]], T + timedelta(hours=36)),
    ]
    store, bodies, draws = {}, [], []
    for names, batch_at in plan:
        client = ArtClient(store=store)
        draw = DrawFailingOn(core_hint(target), LlmError("HTTP 503"))
        outcome = run(client, FakeReporter(), names, art_adapters(draw, Check()), batch_at=batch_at)
        assert outcome.ok is True and outcome.status == "success"
        (body,) = client.success_posts
        bodies.append(body)
        draws.append(draw)
        store = body["store"]

    target_id = content_element(bodies[0], target["name"])["id"]
    assert [core_entry(b, target["name"]).get("art_attempts", 0) for b in bodies[:3]] == [1, 2, 3]
    assert target_id in pending_of(bodies[0])
    assert target_id in pending_of(bodies[1])
    assert target_id not in pending_of(bodies[2])
    assert content_element(bodies[2], target["name"]).get("image_key") is None
    assert core_hint(target) in draws[1].prompts[0], "phần tử lõi chờ vẽ được vẽ trước phần tử mới"
    assert HINT2 in draws[1].prompts[1]
    assert not any(core_hint(target) in p for p in draws[3].prompts), "hết lượt thử thì không vẽ lại"
    assert target_id not in pending_of(bodies[3])
    assert content_element(bodies[3], target["name"]).get("image_key") is None
    other = core_order()[1]
    assert content_element(bodies[0], other["name"]).get("image_key"), "phần tử lõi khác vẫn vẽ được"


def test_ac_art_11_loi_cau_hinh_dung_ngay_khong_tinh_lan_thu_cho_phan_tu_loi():
    """AC-ART-11: Workers AI trả lỗi cấu hình (ArtConfigError) ngay lần vẽ đầu: đúng 1 lần vẽ, mẻ vẫn success, không
    tải lên, không phần tử lõi nào bị tính art_attempts hay đánh dấu image_fallback."""
    from lau_meme_pipeline.llm import ArtConfigError

    client, reporter, draw = ArtClient(), FakeReporter(), Draw(ArtConfigError("token sai"))
    outcome = run(client, reporter, [MEME], art_adapters(draw, Check()))

    assert outcome.ok is True and outcome.status == "success"
    assert len(draw.prompts) == 1
    assert client.puts == []
    (body,) = client.success_posts
    for name in core_names():
        element = core_entry(body, name)
        assert element.get("art_attempts", 0) == 0
        assert not element.get("image_fallback")
        assert content_element(body, name).get("image_key") is None


def test_ac_art_11_thieu_cau_hinh_ve_thi_khong_ve_phan_tu_loi_va_me_van_thanh_cong():
    """AC-ART-11: AC-ART-10a (art=None): không phần tử lõi nào được vẽ hay bị tính lượt thử, mẻ vẫn success."""
    client, reporter = ArtClient(), FakeReporter()
    outcome = run(client, reporter, [MEME], None)

    assert outcome.ok is True and outcome.status == "success"
    assert client.puts == []
    (body,) = client.success_posts
    for name in core_names():
        assert core_entry(body, name).get("art_attempts", 0) == 0
        assert content_element(body, name).get("image_key") is None


def test_ac_art_11_tai_len_loi_thi_phan_tu_loi_khong_co_khoa_va_vao_cho_ve():
    """AC-ART-11: put_image lỗi: phần tử lõi vừa vẽ không có image_key (không tham chiếu ảnh chưa lên R2) và nằm trong
    art_pending để đợt sau vẽ lại; mẻ vẫn success."""
    first_core = core_order()[0]
    client = ArtClient(fail_put=True)
    outcome = run(client, FakeReporter(), [MEME], art_adapters(Draw(), Check()))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert content_element(body, first_core["name"]).get("image_key") is None
    assert content_element(body, first_core["name"])["id"] in pending_of(body)


def test_ac_art_11_me_core_khong_ve_gi():
    """AC-ART-11: mẻ `core` (không đổi) không vẽ: generate không được gọi, không tải ảnh lên, mẻ success, không phần tử
    lõi nào có image_key."""
    from lau_meme_pipeline.batch import run_batch

    client, draw = ArtClient(), Draw()
    outcome = run_batch(
        mode="core",
        batch_at=T,
        core=real_core(),
        client=client,
        reporter=FakeReporter(),
        log=lambda msg: None,
        art=art_adapters(draw, Check()),
    )

    assert outcome.ok is True and outcome.status == "success"
    assert draw.prompts == []
    assert client.puts == []
    assert "put_image" not in client.calls
    (body,) = client.success_posts
    assert all(not e.get("image_key") for e in body["content"]["elements"])
