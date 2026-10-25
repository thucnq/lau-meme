"""Acceptance tests for docs/acceptance/art.md: AC-ART-09 (full batch draws images for new elements) and
AC-ART-10 (missing config or long drawing failures never break the batch), ADR 0012.

Reuses the fakes of test_art_full_batch.py / test_pipe_full_batch.py / test_art_adapters.py. Same public surface:

    run_batch(mode="full", ..., art=ArtAdapters | None)   client.put_image / client.image_exists
    PipelineStore.art_pending, element.art_attempts, element.image_key

No network, no sleeping, no real clock. Imports of production names happen inside the tests.

The 8-minute drawing budget is tested with a fake `time` in lau_meme_pipeline.batch. "Đã có object cùng khóa thì không
tải lại" is covered through run_batch(mode="full") by the AC-ART-04 test in test_art_full_batch.py (image_exists True).
"""

import http.client
import io
import json
import re
from datetime import timedelta

import pytest

from test_art_adapters import PROMPT, Server, ai_ok, install, make_ai, seed_of
from test_art_full_batch import (
    HINT,
    MANY_NAMES,
    MEME2,
    ArtClient,
    Check,
    Draw,
    DrawFailingOn,
    art_adapters,
    content_element,
    key_of,
    meme_hint,
    pending_of,
    priority_first,
    run,
    store_element,
)
from test_pipe_full_batch import CORE_PATH, MEME, T2, FakeClient, FakeReporter, T

# ================================================================ AC-ART-09


def names_by_id(body) -> dict[str, str]:
    return {e["id"]: e["name"] for e in body["store"]["elements"]}


def test_ac_art_09_22_meme_moi_ve_dung_20_anh_tai_len_truoc_khi_dang_va_2_vao_cho_ve():
    """AC-ART-09: 22 meme mới có gợi ý ảnh, kho vào có art_pending rỗng: đúng 20 lần vẽ và 20 lần tải lên, mọi lần tải
    lên xảy ra TRƯỚC post_batch, 20 phần tử trong graph đăng ra mang image_key đúng khóa đã tải lên, 2 phần tử còn lại
    nằm trong store.art_pending và không có image_key."""
    client, draw = ArtClient(store={"art_pending": []}), Draw()
    outcome = run(client, FakeReporter(), MANY_NAMES, art_adapters(draw, Check()))

    assert outcome.ok is True and outcome.status == "success"
    assert len(draw.prompts) == 20
    assert len(client.puts) == 20
    (body,) = client.success_posts
    uploaded = {key for key, _ in client.puts}
    assert len(uploaded) == 20

    last_put = max(i for i, c in enumerate(client.calls) if c == "put_image")
    assert last_put < client.calls.index("post_batch"), "mọi ảnh lên R2 trước khi đăng mẻ"

    with_key = [content_element(body, n) for n in MANY_NAMES if content_element(body, n).get("image_key")]
    without = [n for n in MANY_NAMES if not content_element(body, n).get("image_key")]
    assert len(with_key) == 20
    assert {e["image_key"] for e in with_key} == uploaded
    assert len(without) == 2
    pending = pending_of(body)
    assert len(pending) == 2
    assert {names_by_id(body)[i] for i in pending} == set(without)


def test_ac_art_09_dot_sau_ve_2_phan_tu_cho_ve_truoc_phan_tu_moi():
    """AC-ART-09: 2 phần tử dư của đợt 22 meme nằm trong art_pending; đợt sau (kho của đợt trước, thêm 1 meme mới)
    vẽ hai phần tử đó trước phần tử mới, rồi art_pending rỗng và cả ba có image_key."""
    first = ArtClient()
    run(first, FakeReporter(), MANY_NAMES, art_adapters(Draw(), Check()))
    (first_body,) = first.success_posts
    left = [names_by_id(first_body)[i] for i in pending_of(first_body)]
    assert len(left) == 2

    second, draw = ArtClient(store=first_body["store"]), Draw()
    outcome = run(second, FakeReporter(), [MEME2], art_adapters(draw, Check()), batch_at=T2)

    assert outcome.ok is True
    assert len(draw.prompts) == 3
    (body,) = second.success_posts
    # AC-ART-12 comes first: elements at depth >= 5 (auto tier 4/5, no image yet) are drawn before the rest, deepest
    # first. Among the rest, AC-ART-09 holds: the two waiting elements before the new one.
    priority, rest = priority_first(body, [*left, MEME2])
    for i, name in enumerate(priority):
        assert meme_hint(name) in draw.prompts[i], f"ưu tiên thứ {i}: {name}"
    rest_waiting = [n for n in rest if n in left]
    rest_new = [n for n in rest if n == MEME2]
    start = len(priority)
    window = draw.prompts[start : start + len(rest_waiting)]
    for name in rest_waiting:
        assert any(name in p or f"hình {name}" in p for p in window), f"{name} phải được vẽ trước phần tử mới"
    for i, name in enumerate(rest_new):
        assert meme_hint(name) in draw.prompts[start + len(rest_waiting) + i]
    assert pending_of(body) == []
    for name in [*left, MEME2]:
        assert content_element(body, name).get("image_key")


def test_ac_art_09_gemini_kiem_chinh_byte_webp_256_se_duoc_tai_len():
    """AC-ART-09: byte đưa cho check là WebP 256x256 và đúng là byte tải lên PUT images; khóa = 12 hex đầu sha256 của
    byte đó."""
    from PIL import Image

    client, check = ArtClient(), Check()
    run(client, FakeReporter(), [MEME, MEME2], art_adapters(Draw(), check))

    assert len(check.seen) == 2
    assert sorted(data for _, data in client.puts) == sorted(check.seen)
    for key, data in client.puts:
        assert key == key_of(data)
        image = Image.open(io.BytesIO(data))
        assert image.format == "WEBP"
        assert image.size == (256, 256)


def test_ac_art_09_tai_len_loi_mot_anh_thi_me_thanh_cong_phan_tu_do_khong_co_khoa_va_cho_ve():
    """AC-ART-09: put_image lỗi cho đúng một ảnh: mẻ success, phần tử đó không có image_key (graph và content) và nằm
    trong art_pending; phần tử kia vẫn có image_key đúng khóa đã lên R2."""

    class FailFirstPut(ArtClient):
        def put_image(self, key, data):
            if not self.puts and not getattr(self, "failed", False):
                self.failed = True
                self.calls.append("put_image")
                raise RuntimeError("upload failed")
            return super().put_image(key, data)

    client = FailFirstPut()
    outcome = run(client, FakeReporter(), [MEME, MEME2], art_adapters(Draw(), Check()))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    (uploaded_key, _) = client.puts[0]
    keyed = [n for n in (MEME, MEME2) if content_element(body, n).get("image_key")]
    unkeyed = [n for n in (MEME, MEME2) if not content_element(body, n).get("image_key")]
    assert len(keyed) == 1 and len(unkeyed) == 1
    assert content_element(body, keyed[0])["image_key"] == uploaded_key
    assert store_element(body, unkeyed[0]).get("image_key") is None
    assert pending_of(body) == [content_element(body, unkeyed[0])["id"]]


def test_ac_art_09_issue_ghi_so_anh_ve_duoc_ve_emoji_cho_ve_so_lan_ve_va_ly_do_bi_loai():
    """AC-ART-09: 3 meme, Gemini loại một meme hai lần ("real_face" rồi "text"): Issue ghi vẽ được 2, về emoji 1, chờ
    vẽ 0, số lần vẽ 4, và từng lý do bị loại kèm số lượng 1."""
    client, reporter = ArtClient(), FakeReporter()
    draw = Draw()
    run(client, reporter, [MEME, MEME2, MANY_NAMES[0]], art_adapters(draw, Check(["real_face", "text"])))

    assert len(draw.prompts) == 4
    text = reporter.issues[0][1]
    assert re.search(r"^- Ảnh: vẽ được 2 · về emoji 1 · chờ vẽ 0 · 4 lần vẽ\b", text, re.M)
    assert re.search(r"^- Ảnh bị loại: .*\breal_face 1\b", text, re.M)
    assert re.search(r"^- Ảnh bị loại: .*\btext 1\b", text, re.M)


def test_ac_art_09_chay_lai_cung_me_cho_cung_khoa_anh():
    """AC-ART-09: chạy lại cùng batch_at, cùng crawl, kho vào như nhau (vẽ lại từ đầu): tập khóa ảnh được đăng ở hai
    lần chạy giống hệt nhau."""
    runs = []
    for _ in range(2):
        client = ArtClient()
        run(client, FakeReporter(), [MEME, MEME2], art_adapters(Draw(), Check()))
        (body,) = client.success_posts
        runs.append({n: content_element(body, n)["image_key"] for n in (MEME, MEME2)})
        assert sorted(k for k, _ in client.puts) == sorted(runs[-1].values())

    assert runs[0] == runs[1]


def test_ac_art_09_adapter_workers_ai_gui_cung_seed_cho_cung_prompt_o_lan_dau(monkeypatch):
    """AC-ART-09: hai đối tượng WorkersAiImages mới cùng prompt gửi cùng seed nguyên ở lần gọi đầu (AC-PIPE-10), nên
    chạy lại cùng mẻ ra cùng ảnh và cùng khóa."""
    server = Server(ai_ok())
    seen = install(monkeypatch, server)
    first, _ = make_ai()
    second, _ = make_ai()

    first(PROMPT)
    second(PROMPT)

    assert seed_of(seen[0]) == seed_of(seen[1])


def test_ac_art_09_het_8_phut_thi_ngung_ve_phan_con_lai_cho_dot_sau(monkeypatch):
    """AC-ART-09: bước vẽ dừng khi quá 8 phút: đồng hồ giả, mỗi lần vẽ tốn 60 giây; vẽ đến khi vượt 480 giây (9 ảnh)
    thì ngừng, 13 phần tử còn lại vào art_pending không có image_key, mẻ vẫn đăng thành công."""
    import types

    from lau_meme_pipeline import batch

    now = [0.0]
    monkeypatch.setattr(batch, "time", types.SimpleNamespace(monotonic=lambda: now[0]))

    class SlowDraw(Draw):
        def __call__(self, prompt):
            now[0] += 60
            return super().__call__(prompt)

    client, draw = ArtClient(store={"art_pending": []}), SlowDraw()
    outcome = run(client, FakeReporter(), MANY_NAMES, art_adapters(draw, Check()))

    assert batch.ART_BUDGET_SECONDS == 8 * 60
    assert outcome.ok is True and outcome.status == "success"
    assert len(draw.prompts) == 9
    assert len(client.puts) == 9
    (body,) = client.success_posts
    without = {n for n in MANY_NAMES if not content_element(body, n).get("image_key")}
    assert len(without) == 13
    assert {names_by_id(body)[i] for i in pending_of(body)} == without


# ================================================================ AC-ART-10


def attempts_of(body, name) -> int:
    return store_element(body, name).get("art_attempts", 0)


def test_ac_art_10_a_thieu_cau_hinh_ve_thi_bo_buoc_ve_meme_vao_cho_ve_va_issue_canh_bao():
    """AC-ART-10: (a) art=None (thiếu WORKERS_AI_TOKEN hoặc CLOUDFLARE_ACCOUNT_ID): mẻ success đăng cả hai meme không
    ảnh, cả hai vào art_pending, không tải gì lên, Issue cảnh báo thiếu cấu hình (nhắc WORKERS_AI_TOKEN)."""
    client, reporter = ArtClient(), FakeReporter()
    outcome = run(client, reporter, [MEME, MEME2], None)

    assert outcome.ok is True and outcome.status == "success"
    assert client.error_posts == []
    (body,) = client.success_posts
    ids = {content_element(body, n)["id"] for n in (MEME, MEME2)}
    assert set(pending_of(body)) == ids
    assert all(content_element(body, n).get("image_key") is None for n in (MEME, MEME2))
    assert client.puts == []
    assert "WORKERS_AI_TOKEN" in reporter.issues[0][1]
    assert all(attempts_of(body, n) == 0 for n in (MEME, MEME2))


@pytest.mark.parametrize("where", ["draw", "check"])
def test_ac_art_10_b_loi_cau_hinh_thi_dung_ngay_moi_phan_tu_cho_ve_khong_tinh_lan_thu(where):
    """AC-ART-10: (b) Workers AI hoặc Gemini trả 401/403/404 (ArtConfigError): mẻ success, bước vẽ dừng ngay (đúng 1
    lần vẽ dù có 3 meme), cả 3 meme giữ art_pending, không art_attempts, không tải lên, Issue cảnh báo lỗi cấu hình."""
    from lau_meme_pipeline.llm import ArtConfigError

    names = [MEME, MEME2, MANY_NAMES[0]]

    def failing_check(image):
        raise ArtConfigError("khóa Gemini sai")

    draw = Draw(ArtConfigError("token sai")) if where == "draw" else Draw()
    check = Check() if where == "draw" else failing_check
    client, reporter = ArtClient(), FakeReporter()
    outcome = run(client, reporter, names, art_adapters(draw, check))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert len(draw.prompts) == 1, "dừng ngay khi gặp lỗi cấu hình"
    assert set(pending_of(body)) == {content_element(body, n)["id"] for n in names}
    assert client.puts == []
    for n in names:
        assert attempts_of(body, n) == 0
        assert not store_element(body, n).get("image_fallback")
        assert content_element(body, n).get("image_key") is None
    assert re.search(r"WORKERS_AI_TOKEN|GEMINI_API_KEY|cấu hình", reporter.issues[0][1])


@pytest.mark.parametrize("failure", ["timeout", "http503"])
def test_ac_art_10_c_loi_tam_thoi_ba_dot_lien_tiep_tang_art_attempts_roi_het_cho_ve(failure):
    """AC-ART-10: (c) một phần tử gặp lỗi tạm thời (mạng hoặc 5xx) ở 3 đợt liên tiếp trong khi phần tử khác vẫn vẽ
    được: art_attempts của nó là 1, 2, 3 sau từng đợt; còn trong art_pending sau đợt 1 và 2, hết chờ vẽ sau đợt 3 và giữ
    emoji (không image_key)."""
    from lau_meme_pipeline.llm import LlmError

    exc = TimeoutError("timed out") if failure == "timeout" else LlmError("HTTP 503")
    plan = [
        ([MEME, MANY_NAMES[1]], T),
        ([MEME2, MANY_NAMES[2]], T2),
        ([MANY_NAMES[0], MANY_NAMES[3]], T + timedelta(hours=24)),
    ]
    store, bodies = {}, []
    for names, batch_at in plan:
        client = ArtClient(store=store)
        draw = DrawFailingOn(HINT, exc)
        outcome = run(client, FakeReporter(), names, art_adapters(draw, Check()), batch_at=batch_at)
        assert outcome.ok is True and outcome.status == "success"
        (body,) = client.success_posts
        bodies.append(body)
        store = body["store"]

    meme_id = content_element(bodies[0], MEME)["id"]
    assert [attempts_of(b, MEME) for b in bodies] == [1, 2, 3]
    assert meme_id in pending_of(bodies[0])
    assert meme_id in pending_of(bodies[1])
    assert meme_id not in pending_of(bodies[2])
    assert content_element(bodies[2], MEME).get("image_key") is None
    assert content_element(bodies[0], MANY_NAMES[1]).get("image_key"), "phần tử khác vẫn vẽ được"


def test_ac_art_10_d_moi_lan_ve_deu_loi_mang_thi_khong_tinh_lan_thu_va_issue_dem_loi_theo_loai():
    """AC-ART-10: (d) mọi lần vẽ của một đợt đều ConnectionError (sự cố chung): mẻ success, không phần tử nào bị tính
    art_attempts, cả 3 vẫn trong art_pending, không tải lên."""
    names = [MEME, MEME2, MANY_NAMES[0]]
    client = ArtClient()
    outcome = run(client, FakeReporter(), names, art_adapters(Draw(ConnectionError("down")), Check()))

    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert set(pending_of(body)) == {content_element(body, n)["id"] for n in names}
    for n in names:
        assert attempts_of(body, n) == 0
        assert not store_element(body, n).get("image_fallback")
    assert client.puts == []


def test_ac_art_10_d_issue_dem_loi_ve_theo_loai():
    """AC-ART-10: (d) báo cáo đợt đếm lỗi theo loại: một meme, một lần vẽ lỗi ConnectionError thì Issue ghi
    "ConnectionError" kèm số 1."""
    client, reporter = ArtClient(), FakeReporter()
    run(client, reporter, [MEME], art_adapters(Draw(ConnectionError("down")), Check()))

    assert re.search(r"^- Ảnh lỗi: .*\bConnectionError 1\b", reporter.issues[0][1], re.M)


def test_ac_art_10_thieu_gemini_api_key_thi_me_full_that_bai_du_da_co_cau_hinh_ve(monkeypatch):
    """AC-ART-10: khác ART, thiếu GEMINI_API_KEY (ADR 0011) thì mẻ full thất bại dù WORKERS_AI_TOKEN và
    CLOUDFLARE_ACCOUNT_ID đã đặt: trả 1, đợt lỗi failed_step "llm", không đăng success, không chạm mạng."""
    from lau_meme_pipeline.batch import main

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("WORKERS_AI_TOKEN", "cfai-test-token-not-a-secret-456")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acc0123456789")

    def no_network(*args, **kwargs):
        raise AssertionError("network must not be touched")

    monkeypatch.setattr(http.client, "HTTPSConnection", no_network)
    monkeypatch.setattr(http.client, "HTTPConnection", no_network)

    client, reporter = FakeClient(), FakeReporter()
    code = main(["--mode", "full", "--core", str(CORE_PATH)], client=client, reporter=reporter, now=lambda: T)

    assert code == 1
    assert client.success_posts == []
    assert [b["failed_step"] for b in client.error_posts] == ["llm"]
    assert json.dumps(client.error_posts[0])  # the error batch is a well-formed body
