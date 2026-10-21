"""Acceptance tests for docs/acceptance/art.md, ART wired into `run_batch(mode="full")` (ADR 0012).
AC-ART-02 (moderation -> emoji), AC-ART-03 (waiting list across batches), AC-ART-04 (content-addressed upload,
element and graph carry the key).

Expected public surface:

    lau_meme_pipeline.batch.run_batch(mode="full", ..., llm=..., art=ArtAdapters | None)
    lau_meme_pipeline.art.ArtAdapters(generate=callable(prompt) -> bytes, check=callable(bytes) -> str | None)
    client.put_image(key, data) / client.image_exists(key)      (HttpBatchClient, faked here)
    PipelineStore.art_pending: [element id] in the published store ("chờ vẽ")

No network, no sleeping, no real clock. Imports of production names happen inside the tests.
"""

import hashlib
import io
import itertools
import re

import pytest

from test_pipe_full_batch import MEME, T2, FakeAdapter, FakeClient, FakeReporter, T, _describe, make_llm, real_core

MEME2 = "Meme Thử Hai"
HINT = "con ốc sên đội tờ lịch"
HINT2 = "chú mèo ôm cái laptop"
HINTS = {MEME: HINT, MEME2: HINT2}
MANY_NAMES = [f"Meme Ảnh {n:02d}" for n in range(22)]
ALL_NAMES = [MEME, MEME2, *MANY_NAMES]
KEY_RE = re.compile(r"^[0-9a-f]{12}\.webp$")


# ---------------------------------------------------------------- helpers


class ArtClient(FakeClient):
    """FakeClient plus the two upload calls. `exists=True` makes every image look already uploaded."""

    def __init__(self, store=None, exists=False, fail_put=False):
        super().__init__(store=store)
        self.exists = exists
        self.fail_put = fail_put
        self.puts: list[tuple[str, bytes]] = []

    def put_image(self, key, data):
        self.calls.append("put_image")
        if self.fail_put:
            raise RuntimeError("upload failed")
        self.puts.append((key, bytes(data)))

    def image_exists(self, key):
        self.calls.append("image_exists")
        return self.exists or any(k == key for k, _ in self.puts)


def png_64(prompt: str = "") -> bytes:
    """A 64x64 PNG whose colour comes from sha256(prompt): same prompt, same image; other prompt, other image."""
    from PIL import Image

    r, g, b = hashlib.sha256(prompt.encode("utf-8")).digest()[:3]
    out = io.BytesIO()
    Image.new("RGB", (64, 64), (r, g, b)).save(out, format="PNG")
    return out.getvalue()


class Draw:
    """generate(prompt) -> a real small PNG; raises `exc` when set."""

    def __init__(self, exc=None):
        self.exc = exc
        self.prompts: list[str] = []

    def __call__(self, prompt):
        self.prompts.append(prompt)
        if self.exc is not None:
            raise self.exc
        return png_64(prompt)


class Check:
    """check(image) -> next verdict from `verdicts` (None = passes); passes once the list runs out."""

    def __init__(self, verdicts=()):
        self.verdicts = list(verdicts)
        self.seen: list[bytes] = []

    def __call__(self, image):
        self.seen.append(image)
        return self.verdicts.pop(0) if self.verdicts else None


def llm_with_hints():
    def describe(items):
        out = _describe(items)
        for d, item in zip(out, items, strict=True):
            d["image_hint"] = HINTS.get(item["name"], f"hình {item['name']}")
        return out

    def link(items):
        # A pair makes one result only (AC-INV-02): give each meme its own pair, stable across batches.
        out = []
        for item in items:
            cands = item.get("candidates") or []
            k = ALL_NAMES.index(item["name"]) if item["name"] in ALL_NAMES else len(ALL_NAMES)
            if len(cands) >= 2 * k + 2:
                pairs = [[cands[2 * k], cands[2 * k + 1]]]
            else:
                pairs = [list(p) for p in itertools.islice(itertools.combinations(cands, 2), k, k + 1)]
            out.append({"key": item["key"], "pairs": pairs})
        return out

    return make_llm(describe=describe, link=link)


def run(client, reporter, names, art, batch_at=T):
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    return run_batch(
        mode="full",
        batch_at=batch_at,
        core=real_core(),
        client=client,
        reporter=reporter,
        adapters=[FakeAdapter("RSS", names)],
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=llm_with_hints(),
        log=lambda msg: None,
        banned_words=[],
        art=art,
    )


def art_adapters(generate, check):
    from lau_meme_pipeline.art import ArtAdapters

    return ArtAdapters(generate=generate, check=check)


def content_element(body, name):
    (found,) = [e for e in body["content"]["elements"] if e["name"] == name]
    return found


def store_element(body, name):
    (found,) = [e for e in body["store"]["elements"] if e["name"] == name]
    return found


def pending_of(body):
    return list(body["store"].get("art_pending") or [])


def key_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12] + ".webp"


# ================================================================ AC-ART-04: key, upload, element, graph


def test_ac_art_04_meme_moi_duoc_ve_tai_len_theo_bam_va_phan_tu_luu_khoa_anh():
    """AC-ART-04: meme mới có image_hint: generate gọi 1 lần với prompt chứa gợi ý (không chứa tên meme); put_image gọi
    1 lần với khóa = 12 hex đầu sha256 của dữ liệu tải lên + ".webp", dữ liệu bắt đầu bằng RIFF; phần tử trong content
    và store đều có image_key đó; art_pending rỗng."""
    client, reporter, draw = ArtClient(), FakeReporter(), Draw()
    outcome = run(client, reporter, [MEME], art_adapters(draw, Check()))

    assert outcome.ok is True and outcome.status == "success"
    assert len(draw.prompts) == 1
    assert HINT in draw.prompts[0]
    assert MEME not in draw.prompts[0]
    (put,) = client.puts
    key, data = put
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    assert key == key_of(data)
    assert KEY_RE.match(key)
    (body,) = client.success_posts
    assert content_element(body, MEME)["image_key"] == key
    assert store_element(body, MEME)["image_key"] == key
    assert pending_of(body) == []
    assert client.calls.index("put_image") < client.calls.index("post_batch"), "ảnh lên R2 trước khi đăng mẻ"


def test_ac_art_04_graph_chua_khoa_anh_trong_ket_qua_ma_hoa():
    """AC-ART-04: graph của mẻ mang khóa ảnh: giải mã mục của công thức tạo ra meme thì image_key == khóa tải lên."""
    from lau_meme_pipeline.graph import decrypt_entry

    client = ArtClient()
    run(client, FakeReporter(), [MEME], art_adapters(Draw(), Check()))
    [(key, _data)] = client.puts
    (body,) = client.success_posts

    meme_id = content_element(body, MEME)["id"]
    names = {e["id"]: e["name"] for e in body["content"]["elements"]}
    (recipe,) = [r for r in body["content"]["recipes"] if r["result"] == meme_id]
    entry = decrypt_entry(body["graph"], names[recipe["a"]], names[recipe["b"]])

    assert entry is not None and entry["name"] == MEME
    assert entry["image_key"] == key


def test_ac_art_04_anh_da_co_tren_r2_thi_khong_tai_len_lai_nhung_van_dang_khoa():
    """AC-ART-04: image_exists trả True: put_image không được gọi, khóa ảnh vẫn được đăng ở phần tử."""
    client = ArtClient(exists=True)
    outcome = run(client, FakeReporter(), [MEME], art_adapters(Draw(), Check()))

    assert outcome.ok is True
    assert "put_image" not in client.calls
    assert "image_exists" in client.calls
    (body,) = client.success_posts
    key = content_element(body, MEME)["image_key"]
    assert key is not None and KEY_RE.match(key)
    assert store_element(body, MEME)["image_key"] == key
    assert pending_of(body) == []


def test_ac_art_04_tai_len_loi_thi_me_van_thanh_cong_khong_co_khoa_anh_va_vao_cho_ve():
    """AC-ART-04: put_image ném lỗi: mẻ vẫn success, phần tử không có image_key (không tham chiếu ảnh chưa lên R2),
    id nằm trong art_pending để đợt sau vẽ lại."""
    client = ArtClient(fail_put=True)
    outcome = run(client, FakeReporter(), [MEME], art_adapters(Draw(), Check()))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    meme_id = content_element(body, MEME)["id"]
    assert content_element(body, MEME).get("image_key") is None
    assert store_element(body, MEME).get("image_key") is None
    assert pending_of(body) == [meme_id]


# ================================================================ AC-ART-03: waiting list


def test_ac_art_03_het_han_muc_thi_meme_cho_ve_dot_khong_loi_issue_ghi_so_cho_ve():
    """AC-ART-03: generate ném QuotaExhausted: mẻ success, id meme nằm trong store.art_pending, content image_key
    None, không tải gì lên, Issue ghi số phần tử "chờ vẽ"."""
    from lau_meme_pipeline.llm import QuotaExhausted

    client, reporter = ArtClient(), FakeReporter()
    outcome = run(client, reporter, [MEME], art_adapters(Draw(QuotaExhausted("hết hạn mức")), Check()))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    meme_id = content_element(body, MEME)["id"]
    assert len(meme_id) == 43
    assert pending_of(body) == [meme_id]
    assert content_element(body, MEME).get("image_key") is None
    assert client.puts == []
    text = reporter.issues[0][1]
    assert "chờ vẽ" in text
    assert re.search(r"chờ vẽ[^\n]*\b1\b|\b1\b[^\n]*chờ vẽ", text)


def test_ac_art_03_dot_sau_ve_bu_phan_tu_cho_ve_truoc_phan_tu_moi():
    """AC-ART-03: đợt 1 hết hạn mức; đợt 2 (kho của đợt 1, Workers AI còn hạn mức, thêm meme mới): lần vẽ đầu tiên là
    của meme đang chờ, ảnh của nó được đăng, art_pending không còn nó."""
    from lau_meme_pipeline.llm import QuotaExhausted

    first = ArtClient()
    run(first, FakeReporter(), [MEME], art_adapters(Draw(QuotaExhausted("hết hạn mức")), Check()))
    (first_body,) = first.success_posts
    meme_id = content_element(first_body, MEME)["id"]
    assert pending_of(first_body) == [meme_id]

    second, draw = ArtClient(store=first_body["store"]), Draw()
    outcome = run(second, FakeReporter(), [MEME2], art_adapters(draw, Check()), batch_at=T2)

    assert outcome.ok is True
    assert len(draw.prompts) == 2
    assert HINT in draw.prompts[0], "phần tử chờ vẽ được vẽ trước phần tử mới"
    assert HINT2 in draw.prompts[1]
    (body,) = second.success_posts
    assert meme_id not in pending_of(body)
    assert pending_of(body) == []
    assert content_element(body, MEME)["image_key"] is not None
    assert KEY_RE.match(content_element(body, MEME)["image_key"])
    assert content_element(body, MEME2)["image_key"] is not None
    assert len(second.puts) == 2


def test_ac_art_03_khong_co_adapter_ve_thi_meme_vao_cho_ve_va_issue_canh_bao_workers_ai_token():
    """AC-ART-03: art=None (thiếu WORKERS_AI_TOKEN hoặc CLOUDFLARE_ACCOUNT_ID): mẻ vẫn success, meme vào art_pending,
    Issue có cảnh báo nhắc WORKERS_AI_TOKEN."""
    client, reporter = ArtClient(), FakeReporter()
    outcome = run(client, reporter, [MEME], None)

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    meme_id = content_element(body, MEME)["id"]
    assert pending_of(body) == [meme_id]
    assert content_element(body, MEME).get("image_key") is None
    assert client.puts == []
    assert "WORKERS_AI_TOKEN" in reporter.issues[0][1]


def test_ac_art_03_vuot_20_anh_moi_dot_thi_phan_du_cho_ve():
    """AC-ART-03: 22 meme mới trong một đợt: đúng 20 lần vẽ và tải lên, 2 meme còn lại vào art_pending."""
    names = MANY_NAMES
    client, draw = ArtClient(), Draw()
    outcome = run(client, FakeReporter(), names, art_adapters(draw, Check()))

    assert outcome.ok is True
    assert len(draw.prompts) == 20
    assert len(client.puts) == 20
    (body,) = client.success_posts
    assert len(pending_of(body)) == 2


# ================================================================ AC-ART-02: moderation -> emoji


def test_ac_art_02_kiem_duyet_loai_hai_lan_thi_ve_emoji_va_issue_dem_ly_do():
    """AC-ART-02: check loại hai lần ("real_face" rồi "text"): generate gọi đúng 2 lần, không put_image, image_key
    None, meme KHÔNG nằm trong art_pending (về emoji là dứt điểm), Issue ghi cả hai lý do kèm số lượng."""
    client, reporter = ArtClient(), FakeReporter()
    draw, check = Draw(), Check(["real_face", "text"])
    outcome = run(client, reporter, [MEME], art_adapters(draw, check))

    assert outcome.ok is True and outcome.status == "success"
    assert len(draw.prompts) == 2
    assert len(check.seen) == 2
    assert client.puts == []
    (body,) = client.success_posts
    assert content_element(body, MEME).get("image_key") is None
    assert store_element(body, MEME).get("image_key") is None
    assert pending_of(body) == []
    text = reporter.issues[0][1]
    assert re.search(r"real_face\W{1,8}1\b", text)
    assert re.search(r"\btext\W{1,8}1\b", text)


def test_ac_art_02_lan_hai_dat_thi_dung_anh_lan_hai_va_issue_van_dem_anh_bi_loai():
    """AC-ART-02: lần 1 bị loại ("logo"), lần 2 đạt: có ảnh, tải lên 1 lần, Issue đếm logo 1."""
    client, reporter = ArtClient(), FakeReporter()
    draw = Draw()
    run(client, reporter, [MEME], art_adapters(draw, Check(["logo"])))

    assert len(draw.prompts) == 2
    assert len(client.puts) == 1
    (body,) = client.success_posts
    assert content_element(body, MEME)["image_key"] == client.puts[0][0]
    assert re.search(r"logo\W{1,8}1\b", reporter.issues[0][1])


@pytest.mark.parametrize("hint", ["", "   "])
def test_ac_art_01_meme_khong_co_goi_y_anh_thi_khong_ve_va_dung_emoji(hint):
    """AC-ART-01: describe không trả image_hint (rỗng): generate không được gọi, meme dùng emoji dứt điểm (không vào
    art_pending), mẻ vẫn success."""

    def no_hint(items):
        return [{**d, "image_hint": hint} for d in _describe(items)]

    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    client, draw = ArtClient(), Draw()
    outcome = run_batch(
        mode="full",
        batch_at=T,
        core=real_core(),
        client=client,
        reporter=FakeReporter(),
        adapters=[FakeAdapter("RSS", [MEME])],
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=make_llm(describe=no_hint),
        log=lambda msg: None,
        banned_words=[],
        art=art_adapters(draw, Check()),
    )

    assert outcome.ok is True
    assert draw.prompts == []
    (body,) = client.success_posts
    assert content_element(body, MEME).get("image_key") is None
    assert pending_of(body) == []
