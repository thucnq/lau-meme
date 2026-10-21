"""Acceptance tests for docs/acceptance/art.md, hardening of `lau_meme_pipeline.art` (ADR 0012).
AC-ART-01 (no hint -> no drawing), AC-ART-02 (unknown reason), AC-ART-03 (20 images per batch, failed draws wait),
AC-ART-04 (corrupt or hostile images).

Expected changes to the pure module `lau_meme_pipeline.art`:

    draw_images(items, generate, check, save, limit=20) -> ArtResult
        at most `limit` items are drawn per call; the rest go to result.pending in input order
        an item whose image_hint is empty or blank is never drawn: its id goes to result.fallback
        a reason not in REJECT_REASONS counts as "banned_category" in result.rejections
        generate raising something other than QuotaExhausted (LlmError, OSError, ...): that id goes to
        result.pending, later items are still drawn, nothing propagates
        save raising (corrupt image): redraw once; a second failure -> fallback; result.errors counts
        {"decode_error": n}
    to_webp_256(data) raises for input over 8 MB, images over 4096*4096 pixels, and formats other than
    PNG / JPEG / WEBP.

Imports of production names happen inside the tests so a missing name fails at runtime, not at collection.
"""

import io

import pytest

from test_art import FakeCheck, FakeGenerate, FakeSave, item, key_of, png_bytes

MB = 1024 * 1024


class RaisingGenerate(FakeGenerate):
    """Raises `exc` on the listed 1-based call numbers, otherwise behaves like FakeGenerate."""

    def __init__(self, exc, on_calls):
        super().__init__()
        self.exc = exc
        self.on_calls = set(on_calls)

    def __call__(self, prompt):
        n = len(self.prompts) + 1
        if n in self.on_calls:
            self.prompts.append(prompt)
            raise self.exc
        return super().__call__(prompt)


class FlakySave(FakeSave):
    """Raises `exc` on the listed 1-based call numbers, otherwise saves like FakeSave."""

    def __init__(self, exc, on_calls):
        super().__init__()
        self.exc = exc
        self.on_calls = set(on_calls)
        self.attempts = 0

    def __call__(self, image):
        self.attempts += 1
        if self.attempts in self.on_calls:
            raise self.exc
        return super().__call__(image)


def image_bytes(fmt, size=(64, 64), mode="RGB"):
    from PIL import Image

    out = io.BytesIO()
    Image.new(mode, size, "white" if mode == "1" else (20, 120, 220)).save(out, format=fmt)
    return out.getvalue()


def failure_of(fn, *args):
    """Return the exception `fn(*args)` raises (any Exception), or None when it returns normally."""
    try:
        fn(*args)
    except Exception as exc:
        return exc
    return None


# ================================================================ AC-ART-03: 20 images per batch


def test_ac_art_03_25_phan_tu_chi_ve_20_5_phan_tu_con_lai_cho_ve_dung_thu_tu():
    """AC-ART-03: 25 phần tử, mọi ảnh đều đạt, limit=20: đúng 20 lần vẽ, 5 id còn lại vào "chờ vẽ" theo thứ tự."""
    from lau_meme_pipeline.art import draw_images

    items = [item(n) for n in range(25)]
    gen, save = FakeGenerate(), FakeSave()

    result = draw_images(items, gen, FakeCheck(), save, limit=20)

    assert len(gen.prompts) == 20
    assert result.draws == 20
    assert list(result.images) == [f"e{n:02d}" for n in range(20)]
    assert result.pending == [f"e{n:02d}" for n in range(20, 25)]
    assert result.fallback == []
    assert len(save.saved) == 20


def test_ac_art_03_gioi_han_mac_dinh_la_20_anh_moi_dot():
    """AC-ART-03: không truyền limit thì mặc định cũng là 20 ảnh mỗi đợt (ADR 0012)."""
    from lau_meme_pipeline.art import draw_images

    gen = FakeGenerate()
    result = draw_images([item(n) for n in range(23)], gen, FakeCheck(), FakeSave())

    assert len(gen.prompts) == 20
    assert result.pending == ["e20", "e21", "e22"]


def test_ac_art_03_it_hon_gioi_han_thi_ve_het_khong_co_cho_ve():
    """AC-ART-03: số phần tử không vượt limit thì không ai phải chờ vẽ."""
    from lau_meme_pipeline.art import draw_images

    result = draw_images([item(n) for n in range(3)], FakeGenerate(), FakeCheck(), FakeSave(), limit=20)

    assert list(result.images) == ["e00", "e01", "e02"]
    assert result.pending == []


@pytest.mark.parametrize("exc_name", ["LlmError", "OSError", "TimeoutError"])
def test_ac_art_03_lan_ve_loi_khong_phai_het_han_muc_thi_phan_tu_do_cho_ve_phan_con_lai_van_ve(exc_name):
    """AC-ART-03: generate ném lỗi thường (không phải QuotaExhausted) ở một phần tử: id đó vào "chờ vẽ", các phần tử
    sau vẫn được vẽ, không ném ngoại lệ."""
    import lau_meme_pipeline.llm as llm
    from lau_meme_pipeline.art import draw_images

    makers = {"LlmError": llm.LlmError, "OSError": OSError, "TimeoutError": TimeoutError}
    exc = makers[exc_name]("boom")
    gen = RaisingGenerate(exc, on_calls=[2])  # e01's first draw fails

    result = draw_images([item(0), item(1), item(2)], gen, FakeCheck(), FakeSave())

    assert result.pending == ["e01"]
    assert list(result.images) == ["e00", "e02"]
    assert result.fallback == []
    assert len(gen.prompts) == 3


# ================================================================ AC-ART-01: no hint, no drawing


@pytest.mark.parametrize("blank", ["", " ", "   ", "\t\n"])
def test_ac_art_01_goi_y_anh_rong_thi_khong_ve_va_ve_emoji(blank):
    """AC-ART-01: phần tử có image_hint rỗng hoặc toàn khoảng trắng không bao giờ được gửi vào generate; id nằm trong
    fallback (client dùng emoji); phần tử có gợi ý vẫn được vẽ."""
    from lau_meme_pipeline.art import draw_images

    gen = FakeGenerate()
    result = draw_images([item(0, hint=blank), item(1)], gen, FakeCheck(), FakeSave())

    assert len(gen.prompts) == 1
    assert result.fallback == ["e00"]
    assert list(result.images) == ["e01"]
    assert result.pending == []
    assert result.draws == 1


def test_ac_art_01_nhieu_phan_tu_khong_goi_y_deu_vao_fallback_theo_thu_tu():
    """AC-ART-01: hai phần tử không có gợi ý (rỗng và khoảng trắng) đều vào fallback theo thứ tự, generate không gọi."""
    from lau_meme_pipeline.art import draw_images

    gen = FakeGenerate()
    result = draw_images([item(0, hint=""), item(1, hint="  ")], gen, FakeCheck(), FakeSave())

    assert gen.prompts == []
    assert result.fallback == ["e00", "e01"]
    assert result.images == {} and result.pending == []


# ================================================================ AC-ART-02: unknown reason


def test_ac_art_02_ly_do_la_tinh_la_banned_category():
    """AC-ART-02: check trả lý do không thuộc 5 lý do hợp lệ ("weird"): ảnh vẫn bị loại và được đếm là
    "banned_category" trong báo cáo."""
    from lau_meme_pipeline.art import draw_images

    gen, save = FakeGenerate(), FakeSave()
    result = draw_images([item(0)], gen, FakeCheck({b"img1": "weird"}), save)

    assert result.rejections == {"banned_category": 1}
    assert "weird" not in result.rejections
    assert result.draws == 2
    assert result.images == {"e00": key_of(b"img2")}


def test_ac_art_02_ly_do_la_hai_lan_thi_ve_emoji_va_dem_hai_lan():
    """AC-ART-02: hai lần liên tiếp lý do lạ thì về emoji, báo cáo đếm banned_category 2."""
    from lau_meme_pipeline.art import draw_images

    result = draw_images([item(0)], FakeGenerate(), FakeCheck({b"img1": "weird", b"img2": "other"}), FakeSave())

    assert result.rejections == {"banned_category": 2}
    assert result.fallback == ["e00"]
    assert result.images == {}


# ================================================================ AC-ART-04: corrupt image


def test_ac_art_04_luu_loi_lan_dau_thi_ve_lai_va_dung_anh_lan_hai():
    """AC-ART-04: save ném lỗi giải mã ở lần vẽ đầu, lần hai ổn: generate được gọi 2 lần cho phần tử đó, ảnh lần hai
    được lưu và dùng, errors đếm decode_error 1."""
    from lau_meme_pipeline.art import draw_images

    gen, save = FakeGenerate(), FlakySave(ValueError("corrupt image"), on_calls=[1])
    result = draw_images([item(0)], gen, FakeCheck(), save)

    assert len(gen.prompts) == 2
    assert save.saved == [b"img2"]
    assert result.images == {"e00": key_of(b"img2")}
    assert result.fallback == []
    assert result.errors == {"decode_error": 1}


@pytest.mark.parametrize("exc", [OSError("cannot identify image"), ValueError("corrupt image")], ids=["os", "value"])
def test_ac_art_04_luu_loi_ca_hai_lan_thi_ve_emoji_va_dem_decode_error(exc):
    """AC-ART-04: save lỗi cả hai lần: id vào fallback (không phải chờ vẽ), không ảnh, errors đếm decode_error 2,
    mẻ không ném ngoại lệ và phần tử sau vẫn được vẽ."""
    from lau_meme_pipeline.art import draw_images

    gen, save = FakeGenerate(), FlakySave(exc, on_calls=[1, 2])
    result = draw_images([item(0), item(1)], gen, FakeCheck(), save)

    assert result.fallback == ["e00"]
    assert result.pending == []
    assert list(result.images) == ["e01"]
    assert result.errors == {"decode_error": 2}
    assert len(gen.prompts) == 3


def test_ac_art_04_khong_co_loi_giai_ma_thi_errors_rong():
    """AC-ART-04: không có ảnh hỏng thì result.errors rỗng."""
    from lau_meme_pipeline.art import draw_images

    result = draw_images([item(0)], FakeGenerate(), FakeCheck(), FakeSave())

    assert result.errors == {}


# ================================================================ AC-ART-04: untrusted image decoding


def test_ac_art_04_anh_binh_thuong_van_chuyen_duoc_webp_256():
    """AC-ART-04: PNG 512x512 bình thường vẫn chuyển được WebP 256x256 sau khi siết giới hạn."""
    from PIL import Image

    from lau_meme_pipeline.art import to_webp_256

    out = to_webp_256(png_bytes((512, 512)))
    assert out[:4] == b"RIFF" and out[8:12] == b"WEBP"
    with Image.open(io.BytesIO(out)) as im:
        assert im.size == (256, 256)


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_ac_art_04_chi_nhan_png_jpeg_webp(fmt):
    """AC-ART-04: PNG, JPEG, WEBP đều được nhận và chuyển thành WebP."""
    from lau_meme_pipeline.art import to_webp_256

    out = to_webp_256(image_bytes(fmt))
    assert out[:4] == b"RIFF" and out[8:12] == b"WEBP"


@pytest.mark.parametrize("fmt", ["GIF", "BMP"])
def test_ac_art_04_gif_va_bmp_bi_tu_choi(fmt):
    """AC-ART-04: GIF hoặc BMP (hợp lệ nhưng không thuộc PNG/JPEG/WEBP) bị từ chối bằng một ngoại lệ."""
    from lau_meme_pipeline.art import to_webp_256

    data = image_bytes(fmt)
    assert failure_of(to_webp_256, data) is not None


def test_ac_art_04_dau_vao_qua_8mb_bi_tu_choi_du_la_png_hop_le():
    """AC-ART-04: đầu vào lớn hơn 8 MB bị từ chối dù phần đầu là PNG hợp lệ (chỉ giới hạn kích thước mới loại được)."""
    from lau_meme_pipeline.art import to_webp_256

    small = png_bytes((64, 64))
    assert failure_of(to_webp_256, small) is None
    padded = small + b"\x00" * (8 * MB + 1 - len(small))
    assert len(padded) > 8 * MB
    assert failure_of(to_webp_256, padded) is not None


def test_ac_art_04_anh_vuot_4096x4096_diem_anh_bi_tu_choi():
    """AC-ART-04: ảnh 5000x5000 điểm (PNG 1 bit, nhỏ khi nén) vượt 4096*4096 điểm ảnh nên bị từ chối bằng ngoại lệ,
    không được giải mã và phóng to trong bộ nhớ."""
    from lau_meme_pipeline.art import to_webp_256

    data = image_bytes("PNG", size=(5000, 5000), mode="1")
    assert len(data) < 8 * MB
    assert failure_of(to_webp_256, data) is not None


@pytest.mark.parametrize("junk", [b"", b"not an image at all", b"\x89PNG\r\n\x1a\n" + b"\xff" * 64, b"<svg></svg>"])
def test_ac_art_04_du_lieu_khong_phai_anh_bi_tu_choi(junk):
    """AC-ART-04: dữ liệu rác (rỗng, văn bản, PNG cụt, SVG) bị từ chối bằng một ngoại lệ."""
    from lau_meme_pipeline.art import to_webp_256

    assert failure_of(to_webp_256, junk) is not None
