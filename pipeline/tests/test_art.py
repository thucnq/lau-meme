"""Acceptance tests for docs/acceptance/art.md, pipeline part: AC-ART-01, 02, 03, 04.

Expected NEW module `lau_meme_pipeline.art` (pure; Workers AI, Gemini and R2 are injected fakes, no network):

    STYLE_PROMPT: str                      the shared style paragraph, configured in this one place
    build_prompt(image_hint, name, mod_lists=None) -> str
    ArtItem(id, name, image_hint)          frozen dataclass (keyword construction)
    REJECT_REASONS                         ("real_face", "logo", "copyright", "text", "banned_category")
    ArtResult(images, fallback, pending, rejections, draws)
        images:     {item id: image key "<12 hex>.webp"}   (the key save() returned)
        fallback:   [item id]  no image, client shows the emoji (2 rejected drawings)
        pending:    [item id]  "chờ vẽ" (Workers AI quota exhausted), still in input order
        rejections: {reason: count of rejected images}     (the batch report)
        draws:      number of generate() calls made
    draw_images(items, generate, check, save) -> ArtResult
        generate(prompt) -> bytes                 raises llm.QuotaExhausted when the free quota is gone
        check(image_bytes) -> None | reason       None = image passed moderation, else one of REJECT_REASONS
        save(image_bytes) -> key                  stores a passed image, returns its key
        Per item: draw, check; on a violation draw ONE more time and check again; a second violation -> fallback.
        QuotaExhausted never propagates: the current item and every later one go to `pending`.
    order_for_drawing(pending, new) -> list[ArtItem]    pending first (input order), then new, no duplicate ids
    to_webp_256(data: bytes) -> bytes                   WebP, exactly 256x256 (Pillow)
    image_key(webp: bytes) -> str                       "<first 12 hex of sha256(webp)>.webp"
    R2_PREFIX = "img/"                                  the R2 object key is R2_PREFIX + image_key
    save_image(data: bytes, store) -> SavedImage(key, uploaded)
        store.exists(r2_key) -> bool ; store.put(r2_key, webp_bytes)
        encodes with to_webp_256, key = image_key(webp); uploads only when store.exists(...) is False
    apply_images(store: ContentStore, images: dict[str, str]) -> ContentStore
        element.image_key = key for the given element ids; the graph export then carries it in the encrypted result.

The element/graph/D1 `image_key` is the bare "<12 hex>.webp" (the shape of /img/{key}, the blocklist and D1).
Imports happen inside the tests so a missing module fails at runtime, not at collection.
"""

import hashlib
import io
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
HINT = "con ốc sên đội tờ lịch, bò chậm rãi"
KEY_RE = re.compile(r"^[0-9a-f]{12}\.webp$")


# ---------------------------------------------------------------- helpers


def item(n, hint=HINT):
    from lau_meme_pipeline.art import ArtItem

    return ArtItem(id=f"e{n:02d}", name=f"Món {n}", image_hint=hint)


class FakeGenerate:
    """generate(prompt) -> unique bytes per call; raises QuotaExhausted on call number quota_at (1-based)."""

    def __init__(self, quota_at=None):
        self.quota_at = quota_at
        self.prompts = []

    def __call__(self, prompt):
        from lau_meme_pipeline.llm import QuotaExhausted

        self.prompts.append(prompt)
        if self.quota_at is not None and len(self.prompts) >= self.quota_at:
            raise QuotaExhausted("hết hạn mức Workers AI")
        return f"img{len(self.prompts)}".encode()


class FakeCheck:
    """check(image) -> reason or None; `verdicts` maps image bytes -> reason."""

    def __init__(self, verdicts=None):
        self.verdicts = verdicts or {}
        self.seen = []

    def __call__(self, image):
        self.seen.append(image)
        return self.verdicts.get(image)


class FakeSave:
    def __init__(self):
        self.saved = []

    def __call__(self, image):
        self.saved.append(image)
        return hashlib.sha256(image).hexdigest()[:12] + ".webp"


def key_of(image: bytes) -> str:
    return hashlib.sha256(image).hexdigest()[:12] + ".webp"


class FakeStore:
    def __init__(self):
        self.objects = {}
        self.puts = []

    def exists(self, r2_key):
        return r2_key in self.objects

    def put(self, r2_key, data):
        self.puts.append(r2_key)
        self.objects[r2_key] = data


def png_bytes(size=(512, 300), color=(200, 30, 30)):
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format="PNG")
    return out.getvalue()


# ---------------------------------------------------------------- AC-ART-01


def test_ac_art_01_prompt_la_goi_y_anh_cong_doan_phong_cach_chung():
    """AC-ART-01: prompt = gợi ý ảnh + đoạn phong cách chung; gợi ý đứng trước, phong cách đúng một lần ở cuối."""
    from lau_meme_pipeline.art import STYLE_PROMPT, build_prompt

    prompt = build_prompt(HINT, "Ốc Sên Deadline")
    assert STYLE_PROMPT.strip()
    assert prompt.startswith(HINT)
    assert prompt.endswith(STYLE_PROMPT)
    assert prompt.count(STYLE_PROMPT) == 1
    assert prompt.count(HINT) == 1


def test_ac_art_01_phong_cach_cau_hinh_mot_cho_va_khong_con_sticker():
    """AC-ART-01: đoạn phong cách cấu hình một chỗ (đổi hằng số thì prompt đổi theo); mực + màu nước,
    không chữ/người thật/logo, không còn sticker."""
    import lau_meme_pipeline.art as art

    style = art.STYLE_PROMPT.lower()
    assert "sticker" not in style
    assert any(w in style for w in ("bút mực", "ink")), "phong cách vẽ tay bằng bút mực"
    assert any(w in style for w in ("màu nước", "watercolor", "watercolour"))
    assert any(w in style for w in ("không chữ", "no text", "no words", "no letters"))
    assert any(w in style for w in ("không người thật", "no real people", "no real person", "no real human"))
    assert any(w in style for w in ("không logo", "no logo"))


def test_ac_art_01_doi_hang_so_phong_cach_thi_prompt_doi(monkeypatch):
    """AC-ART-01: build_prompt đọc STYLE_PROMPT tại lúc gọi, không chép cứng đoạn phong cách ở chỗ khác."""
    import lau_meme_pipeline.art as art

    monkeypatch.setattr(art, "STYLE_PROMPT", "PHONG-CACH-THU-NGHIEM")
    prompt = art.build_prompt(HINT, "Ốc Sên Deadline")
    assert prompt.endswith("PHONG-CACH-THU-NGHIEM")
    assert prompt.startswith(HINT)


@pytest.mark.parametrize("name", ["ABC Xyz", "abc xyz", "A.B.C  Xyz", "ábc xyz"])
def test_ac_art_01_ten_nam_trong_danh_sach_chan_bi_danh_khong_vao_prompt(name):
    """AC-ART-01: tên phần tử trùng danh sách chặn bí danh (so khớp không dấu,
    hoa thường) không xuất hiện trong prompt."""
    from lau_meme_pipeline.art import build_prompt

    from lau_meme_pipeline.moderation import ModLists

    prompt = build_prompt(HINT, name, ModLists(aliases=frozenset({"abc xyz"})))
    flat = re.sub(r"[^a-z0-9]", "", prompt.lower())
    assert "abcxyz" not in flat
    assert name.lower() not in prompt.lower()
    assert prompt.startswith(HINT)


# ---------------------------------------------------------------- AC-ART-02


def test_ac_art_02_hai_lan_vi_pham_thi_ve_dung_hai_lan_roi_ve_emoji_va_dem_ly_do():
    """AC-ART-02: lần 1 "mặt người giống thật", lần 2 "chữ trong ảnh" -> đúng 2 lần vẽ, không có ảnh,
    báo cáo đếm từng lý do."""
    from lau_meme_pipeline.art import draw_images

    gen, save = FakeGenerate(), FakeSave()
    check = FakeCheck({b"img1": "real_face", b"img2": "text"})
    result = draw_images([item(1)], gen, check, save)

    assert result.draws == 2
    assert len(gen.prompts) == 2
    assert result.images == {}
    assert result.fallback == ["e01"]
    assert result.pending == []
    assert result.rejections == {"real_face": 1, "text": 1}
    assert save.saved == []


def test_ac_art_02_lan_hai_dat_thi_dung_anh_lan_hai():
    """AC-ART-02: lần 1 vi phạm, lần 2 đạt -> ảnh lần 2 được lưu và dùng; báo cáo vẫn đếm ảnh lần 1 bị loại."""
    from lau_meme_pipeline.art import draw_images

    gen, save = FakeGenerate(), FakeSave()
    result = draw_images([item(1)], gen, FakeCheck({b"img1": "logo"}), save)

    assert result.draws == 2
    assert save.saved == [b"img2"]
    assert result.images == {"e01": key_of(b"img2")}
    assert result.fallback == []
    assert result.rejections == {"logo": 1}


def test_ac_art_02_lan_dau_dat_thi_chi_ve_mot_lan():
    """AC-ART-02: ảnh lần 1 đạt thì không vẽ lại; không có lý do bị loại nào."""
    from lau_meme_pipeline.art import draw_images

    gen, save = FakeGenerate(), FakeSave()
    result = draw_images([item(1)], gen, FakeCheck(), save)

    assert result.draws == 1
    assert save.saved == [b"img1"]
    assert result.images == {"e01": key_of(b"img1")}
    assert result.rejections == {}
    assert result.fallback == []


def test_ac_art_02_bao_cao_dem_cong_don_theo_ly_do_nhieu_phan_tu():
    """AC-ART-02: nhiều phần tử: ảnh bị loại được đếm cộng dồn theo lý do (đủ cả 5 lý do hợp lệ)."""
    from lau_meme_pipeline.art import REJECT_REASONS, draw_images

    assert set(REJECT_REASONS) == {"real_face", "logo", "copyright", "text", "banned_category"}
    # draws: e01 -> img1 logo, img2 copyright (fallback); e02 -> img3 logo, img4 ok; e03 -> img5 banned_category,
    # img6 text
    verdicts = {b"img1": "logo", b"img2": "copyright", b"img3": "logo", b"img5": "banned_category", b"img6": "text"}
    result = draw_images([item(1), item(2), item(3)], FakeGenerate(), FakeCheck(verdicts), FakeSave())

    assert result.draws == 6
    assert result.rejections == {"logo": 2, "copyright": 1, "banned_category": 1, "text": 1}
    assert result.fallback == ["e01", "e03"]
    assert list(result.images) == ["e02"]


def test_ac_art_02_prompt_gui_ve_chua_goi_y_anh_va_phong_cach():
    """AC-ART-02: mỗi lần vẽ (kể cả vẽ lại) dùng prompt dựng theo AC-ART-01."""
    from lau_meme_pipeline.art import STYLE_PROMPT, draw_images

    gen = FakeGenerate()
    draw_images([item(1)], gen, FakeCheck({b"img1": "text"}), FakeSave())
    assert len(gen.prompts) == 2
    for prompt in gen.prompts:
        assert HINT in prompt
        assert STYLE_PROMPT in prompt


# ---------------------------------------------------------------- AC-ART-03


def test_ac_art_03_het_han_muc_sau_5_trong_12_thi_7_con_lai_cho_ve():
    """AC-ART-03: Workers AI báo hết hạn mức ở lần vẽ thứ 6 -> 5 phần tử có ảnh, 7 phần tử "chờ vẽ" đúng thứ tự,
    đợt không lỗi."""
    from lau_meme_pipeline.art import draw_images

    items = [item(n) for n in range(12)]
    gen, save = FakeGenerate(quota_at=6), FakeSave()
    result = draw_images(items, gen, FakeCheck(), save)  # must not raise

    assert list(result.images) == [f"e{n:02d}" for n in range(5)]
    assert result.pending == [f"e{n:02d}" for n in range(5, 12)]
    assert result.fallback == []
    assert len(gen.prompts) == 6, "hết hạn mức thì dừng, không gọi thêm"
    assert len(save.saved) == 5
    decided = set(result.images) | set(result.pending) | set(result.fallback)
    assert decided == {i.id for i in items}


def test_ac_art_03_het_han_muc_ngay_tu_dau_thi_tat_ca_cho_ve_khong_nem_loi():
    """AC-ART-03: hết hạn mức ngay lần đầu -> mọi phần tử chờ vẽ, không ảnh, không ngoại lệ."""
    from lau_meme_pipeline.art import draw_images

    items = [item(n) for n in range(3)]
    result = draw_images(items, FakeGenerate(quota_at=1), FakeCheck(), FakeSave())
    assert result.images == {}
    assert result.pending == ["e00", "e01", "e02"]
    assert result.rejections == {}


def test_ac_art_03_het_han_muc_giua_luc_ve_lai_thi_phan_tu_do_va_phan_con_lai_cho_ve():
    """AC-ART-03: hết hạn mức khi vẽ lại lần 2 của phần tử đang xét
    -> phần tử đó cũng "chờ vẽ" (không bị coi là về emoji)."""
    from lau_meme_pipeline.art import draw_images

    gen = FakeGenerate(quota_at=2)  # e00 first draw ok-but-rejected, redraw hits the quota
    result = draw_images([item(0), item(1)], gen, FakeCheck({b"img1": "text"}), FakeSave())
    assert result.images == {}
    assert result.fallback == []
    assert result.pending == ["e00", "e01"]


def test_ac_art_03_dot_sau_ve_phan_tu_cho_ve_truoc_phan_tu_moi():
    """AC-ART-03: đợt sau xếp các phần tử "chờ vẽ" trước phần tử mới, không trùng id."""
    from lau_meme_pipeline.art import order_for_drawing

    pending = [item(5), item(6), item(7)]
    new = [item(20), item(6), item(21)]
    ordered = order_for_drawing(pending, new)
    assert [i.id for i in ordered] == ["e05", "e06", "e07", "e20", "e21"]
    assert [i.id for i in order_for_drawing([], new)] == ["e20", "e06", "e21"]


def test_ac_art_03_dot_sau_ve_bu_cac_phan_tu_cho_ve_va_het_cho():
    """AC-ART-03: vòng đầy đủ - đợt 1 hết hạn mức,
    đợt 2 (còn hạn mức) vẽ bù phần "chờ vẽ" trước rồi mới tới phần tử mới."""
    from lau_meme_pipeline.art import draw_images, order_for_drawing

    first = draw_images([item(n) for n in range(4)], FakeGenerate(quota_at=3), FakeCheck(), FakeSave())
    assert first.pending == ["e02", "e03"]

    carried = [item(n) for n in (2, 3)]
    gen = FakeGenerate()
    second_items = order_for_drawing(carried, [item(10)])
    second = draw_images(second_items, gen, FakeCheck(), FakeSave())
    assert list(second.images) == ["e02", "e03", "e10"]
    assert second.pending == []
    assert len(gen.prompts) == 3


# ---------------------------------------------------------------- AC-ART-04


def test_ac_art_04_chuyen_webp_256x256():
    """AC-ART-04: ảnh đạt kiểm duyệt (PNG bất kỳ cỡ) được chuyển thành WebP đúng 256x256."""
    from lau_meme_pipeline.art import to_webp_256
    from PIL import Image

    for size in ((512, 300), (1024, 1024), (100, 400)):
        out = to_webp_256(png_bytes(size))
        assert out[:4] == b"RIFF" and out[8:12] == b"WEBP"
        with Image.open(io.BytesIO(out)) as im:
            assert im.format == "WEBP"
            assert im.size == (256, 256)


def test_ac_art_04_khoa_la_12_ky_tu_dau_sha256_noi_dung_webp():
    """AC-ART-04: khóa ảnh = 12 ký tự đầu sha256 của nội dung, đuôi .webp; R2 lưu ở img/<khóa>."""
    from lau_meme_pipeline.art import R2_PREFIX, image_key, save_image, to_webp_256

    webp = to_webp_256(png_bytes())
    expected = hashlib.sha256(webp).hexdigest()[:12] + ".webp"
    assert image_key(webp) == expected
    assert KEY_RE.match(expected)
    assert R2_PREFIX == "img/"

    store = FakeStore()
    saved = save_image(png_bytes(), store)
    assert saved.key == expected
    assert list(store.objects) == ["img/" + expected]
    assert store.objects["img/" + expected] == webp


def test_ac_art_04_cung_noi_dung_cung_khoa_va_khong_tai_len_lai():
    """AC-ART-04: lưu cùng một ảnh hai lần -> cùng khóa, chỉ một lần tải lên; ảnh khác -> khóa khác, tải lên."""
    from lau_meme_pipeline.art import save_image

    store = FakeStore()
    first = save_image(png_bytes(), store)
    second = save_image(png_bytes(), store)
    assert first.key == second.key
    assert first.uploaded is True
    assert second.uploaded is False
    assert store.puts == ["img/" + first.key]

    other = save_image(png_bytes(color=(10, 10, 200)), store)
    assert other.key != first.key
    assert other.uploaded is True
    assert len(store.puts) == 2


def test_ac_art_04_anh_da_co_san_tren_r2_thi_khong_tai_len_lai():
    """AC-ART-04: R2 đã có khóa đó (từ đợt trước) -> không tải lên lại."""
    from lau_meme_pipeline.art import image_key, save_image, to_webp_256

    store = FakeStore()
    key = image_key(to_webp_256(png_bytes()))
    store.objects["img/" + key] = b"da-co"
    saved = save_image(png_bytes(), store)
    assert saved.key == key
    assert saved.uploaded is False
    assert store.puts == []
    assert store.objects["img/" + key] == b"da-co"


def test_ac_art_04_phan_tu_luu_khoa_anh_va_graph_chua_khoa_trong_ket_qua_ma_hoa():
    """AC-ART-04: phần tử lưu khóa ảnh; graph xuất ra chứa image_key trong kết quả giải mã được,
    phần tử khác vẫn None."""
    from lau_meme_pipeline.art import apply_images, draw_images, save_image

    from lau_meme_pipeline.graph import decrypt_entry, export_graph
    from lau_meme_pipeline.ids import element_id
    from lau_meme_pipeline.seed import ContentStore, load_core

    core = json.loads(CORE_PATH.read_text(encoding="utf-8"))
    store = load_core(core, ContentStore.empty()).store
    recipes = core["recipes"]
    target_name = recipes[0]["result"]
    other_name = next(r["result"] for r in recipes if r["result"] != target_name)
    target_id = element_id(target_name)

    from lau_meme_pipeline.art import ArtItem

    blobs = FakeStore()
    result = draw_images(
        [ArtItem(id=target_id, name=target_name, image_hint=HINT)],
        lambda prompt: png_bytes(),
        lambda image: None,
        lambda image: save_image(image, blobs).key,
    )
    key = result.images[target_id]
    assert KEY_RE.match(key)

    with_images = apply_images(store, result.images)
    assert with_images.elements[target_id].image_key == key
    assert with_images.elements[element_id(other_name)].image_key is None

    graph = export_graph(with_images, 3)
    r0 = recipes[0]
    got = decrypt_entry(graph, r0["a"], r0["b"])
    assert got is not None and got["name"] == target_name
    assert got["image_key"] == key
    other = next(r for r in recipes if r["result"] == other_name)
    assert decrypt_entry(graph, other["a"], other["b"])["image_key"] is None
