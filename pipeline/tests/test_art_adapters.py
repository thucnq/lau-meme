"""Acceptance tests for docs/acceptance/art.md, adapters wired into the full batch (ADR 0012).
AC-ART-01 (Workers AI call), AC-ART-02 (Gemini image check), AC-ART-03 (quota, retries), AC-ART-04 (upload).

Expected public surface:

    lau_meme_pipeline.workers_ai.WorkersAiImages(account_id, token, model="@cf/black-forest-labs/flux-1-schnell",
                                                 *, sleep)
        callable(prompt) -> image bytes; attribute calls (HTTP requests incl. retries)
    lau_meme_pipeline.gemini.GeminiImageCheck(api_key, model="gemini-2.5-flash", *, sleep)
        callable(image bytes) -> None (passes) | reason string
    lau_meme_pipeline.batch.HttpBatchClient(base_url, token).put_image(key, data) / .image_exists(key)

The network is mocked at http.client.HTTPSConnection; nothing real is contacted and no test sleeps (`sleep` is
injected). Imports of production modules happen inside the tests so a missing name fails at runtime.
"""

import base64
import http.client
import json

import pytest

from test_pipe_gemini import QUOTA_PER_DAY, FakeResponse, request_text

ACCOUNT = "acc0123456789"
FAKE_AI_BEARER = "cfai-test-token-not-a-secret-456"
API_KEY = "AIza-test-key-not-a-secret-123"
MODEL = "@cf/black-forest-labs/flux-1-schnell"
BASE_URL = "https://dinoduct.fun/lau-meme"
FAKE_PIPE_BEARER = "pipe-test-token-not-a-secret"
KEY = "abc123def456.webp"
PROMPT = "con ốc sên đội tờ lịch, vẽ tay bằng bút mực"
IMAGE = b"\x89PNG-fake-image-bytes\x00\x01\x02"
WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 \x01\x02\x03\x04\x05"


class Server:
    """Scripted server. `script`: one entry per request; an int is a status with an error body that echoes
    `echo`, a (status, body) tuple is a literal answer, None is the default answer. Beyond the script: default."""

    def __init__(self, default, script=(), echo=""):
        self.default = default
        self.script = list(script)
        self.echo = echo
        self.requests: list[dict] = []

    def respond(self, req):
        n = len(self.requests) - 1
        step = self.script[n] if n < len(self.script) else None
        if step is None:
            return FakeResponse(*self.default)
        if isinstance(step, tuple):
            return FakeResponse(*step)
        return FakeResponse(step, {"errors": [{"message": f"upstream said {self.echo}"}]})


def install(monkeypatch, server: Server) -> list[dict]:
    seen = server.requests

    class FakeConn:
        def __init__(self, host, *args, **kwargs):
            self.host = host

        def request(self, method, url, body=None, headers=None, **kwargs):
            seen.append({"host": self.host, "method": method, "path": url, "body": body, "headers": headers or {}})

        def getresponse(self):
            return server.respond(seen[-1])

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", FakeConn)
    return seen


def lower(headers) -> dict:
    return {k.lower(): v for k, v in headers.items()}


# ================================================================ Workers AI


def ai_ok(image=IMAGE):
    return (200, {"success": True, "result": {"image": base64.b64encode(image).decode()}})


def make_ai(model=None, sleeps=None):
    from lau_meme_pipeline.workers_ai import WorkersAiImages

    sleeps = sleeps if sleeps is not None else []
    if model is None:
        return WorkersAiImages(ACCOUNT, FAKE_AI_BEARER, sleep=sleeps.append), sleeps
    return WorkersAiImages(ACCOUNT, FAKE_AI_BEARER, model=model, sleep=sleeps.append), sleeps


def test_ac_art_01_workers_ai_goi_rest_dung_duong_dan_header_va_prompt(monkeypatch):
    """AC-ART-01: POST api.cloudflare.com /client/v4/accounts/<id>/ai/run/<model>, Authorization Bearer, body JSON có
    prompt đúng như truyền vào; trả về byte ảnh đã giải mã base64."""
    server = Server(ai_ok())
    seen = install(monkeypatch, server)
    draw, sleeps = make_ai()

    out = draw(PROMPT)

    assert out == IMAGE
    assert len(seen) == 1
    req = seen[0]
    assert req["host"].startswith("api.cloudflare.com")
    assert req["method"] == "POST"
    assert req["path"] == f"/client/v4/accounts/{ACCOUNT}/ai/run/{MODEL}"
    assert lower(req["headers"])["authorization"] == f"Bearer {FAKE_AI_BEARER}"
    assert json.loads(request_text(req))["prompt"] == PROMPT
    assert draw.calls == 1
    assert sleeps == []


def test_ac_art_01_model_la_tham_so_thi_duong_dan_doi(monkeypatch):
    """AC-ART-01: đổi model (WORKERS_AI_MODEL) thì đường dẫn đổi theo, không cần sửa code."""
    server = Server(ai_ok())
    seen = install(monkeypatch, server)
    draw, _ = make_ai(model="@cf/stabilityai/stable-diffusion-xl-base-1.0")

    draw(PROMPT)

    assert seen[0]["path"] == f"/client/v4/accounts/{ACCOUNT}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0"


def test_ac_art_03_workers_ai_429_la_het_han_muc_khong_retry(monkeypatch):
    """AC-ART-03: HTTP 429 từ Workers AI ném QuotaExhausted ngay, không thử lại, không ngủ."""
    from lau_meme_pipeline.llm import QuotaExhausted

    server = Server(ai_ok(), script=[429])
    install(monkeypatch, server)
    draw, sleeps = make_ai()

    with pytest.raises(QuotaExhausted):
        draw(PROMPT)

    assert draw.calls == 1
    assert len(server.requests) == 1
    assert sleeps == []


def test_ac_art_03_workers_ai_5xx_hai_lan_roi_thanh_cong_thi_backoff_2_4(monkeypatch):
    """AC-ART-03: 5xx hai lần rồi 200: chờ 2.0 rồi 4.0, trả ảnh, calls == 3."""
    server = Server(ai_ok(), script=[503, 500, None])
    install(monkeypatch, server)
    draw, sleeps = make_ai()

    assert draw(PROMPT) == IMAGE

    assert sleeps == [2.0, 4.0]
    assert draw.calls == 3
    assert len(server.requests) == 3


def test_ac_art_03_workers_ai_5xx_bon_lan_thi_nem_llm_error(monkeypatch):
    """AC-ART-03: 5xx liên tiếp 4 lần (1 + 3 lần thử lại) thì ném LlmError, không phải QuotaExhausted."""
    from lau_meme_pipeline.llm import LlmError, QuotaExhausted

    server = Server(ai_ok(), script=[500, 502, 503, 504])
    install(monkeypatch, server)
    draw, sleeps = make_ai()

    with pytest.raises(LlmError) as info:
        draw(PROMPT)

    assert not isinstance(info.value, QuotaExhausted)
    assert draw.calls == 4
    assert sleeps == [2.0, 4.0, 8.0]


@pytest.mark.parametrize(
    "answer",
    [(400, {"success": False, "errors": [{"message": "bad"}]}), (200, {"success": False, "result": None}), (200, "x{")],
    ids=["http400", "success_false", "not_json"],
)
def test_ac_art_03_workers_ai_tra_loi_hong_thi_nem_llm_error_de_lan_ve_do_hong(monkeypatch, answer):
    """AC-ART-03: HTTP 400, success=false hoặc thân không phải JSON thì lần vẽ đó hỏng (LlmError), không retry."""
    from lau_meme_pipeline.llm import LlmError

    server = Server(ai_ok(), script=[answer])
    install(monkeypatch, server)
    draw, sleeps = make_ai()

    with pytest.raises(LlmError):
        draw(PROMPT)

    assert len(server.requests) == 1
    assert sleeps == []


@pytest.mark.parametrize("script", [[429], [500, 500, 500, 500], [400], [403]], ids=["429", "5xx", "400", "403"])
def test_ac_pipe_13_workers_ai_token_khong_nam_trong_duong_dan_hay_thong_bao_loi(monkeypatch, script):
    """AC-PIPE-13: token chỉ nằm ở header Authorization; không có trong đường dẫn, body, thông báo hay repr của lỗi
    (kể cả khi máy chủ phản hồi lại token trong thân lỗi)."""
    server = Server(ai_ok(), script=script, echo=FAKE_AI_BEARER)
    seen = install(monkeypatch, server)
    draw, _ = make_ai()

    from lau_meme_pipeline.llm import LlmError, QuotaExhausted

    with pytest.raises((QuotaExhausted, LlmError)) as info:
        draw(PROMPT)

    message = str(info.value) + repr(info.value)
    assert FAKE_AI_BEARER not in message
    for req in seen:
        assert FAKE_AI_BEARER not in req["path"]
        assert FAKE_AI_BEARER not in request_text(req)
        assert [k.lower() for k, v in req["headers"].items() if FAKE_AI_BEARER in str(v)] == ["authorization"]


# ================================================================ Gemini image check


def gemini_answer(text):
    return (200, {"candidates": [{"content": {"parts": [{"text": text}]}}]})


def make_check(model=None, sleeps=None):
    from lau_meme_pipeline.gemini import GeminiImageCheck

    sleeps = sleeps if sleeps is not None else []
    if model is None:
        return GeminiImageCheck(API_KEY, sleep=sleeps.append), sleeps
    return GeminiImageCheck(API_KEY, model=model, sleep=sleeps.append), sleeps


def test_ac_art_02_gemini_kiem_anh_goi_rest_khoa_o_header_va_gui_inline_data(monkeypatch):
    """AC-ART-02: POST generativelanguage.googleapis.com /v1beta/models/<model>:generateContent, khóa chỉ ở header
    x-goog-api-key, body có part inline_data (mime_type image/*, data = base64 của ảnh), responseMimeType JSON."""
    server = Server(gemini_answer(json.dumps({"ok": True})))
    seen = install(monkeypatch, server)
    check, _ = make_check()

    assert check(IMAGE) is None

    assert len(seen) == 1
    req = seen[0]
    assert req["host"].startswith("generativelanguage.googleapis.com")
    assert req["method"] == "POST"
    assert req["path"] == "/v1beta/models/gemini-2.5-flash:generateContent"
    assert lower(req["headers"])["x-goog-api-key"] == API_KEY
    assert API_KEY not in req["path"]
    assert API_KEY not in request_text(req)
    body = json.loads(request_text(req))
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    parts = [p for c in body["contents"] for p in c["parts"]]
    inline = [p["inline_data"] for p in parts if "inline_data" in p]
    assert len(inline) == 1
    assert inline[0]["mime_type"].startswith("image/")
    assert base64.b64decode(inline[0]["data"]) == IMAGE


def test_ac_art_02_gemini_kiem_anh_model_la_tham_so(monkeypatch):
    """AC-ART-02: đổi model thì đường dẫn đổi theo."""
    server = Server(gemini_answer('{"ok": true}'))
    seen = install(monkeypatch, server)
    check, _ = make_check(model="gemini-2.0-flash")

    check(IMAGE)

    assert seen[0]["path"] == "/v1beta/models/gemini-2.0-flash:generateContent"


@pytest.mark.parametrize("reason", ["real_face", "logo", "copyright", "text", "banned_category"])
def test_ac_art_02_gemini_tra_ly_do_hop_le_thi_giu_nguyen(monkeypatch, reason):
    """AC-ART-02: {"ok": false, "reason": <một trong 5 lý do>} thì trả đúng lý do đó."""
    install(monkeypatch, Server(gemini_answer(json.dumps({"ok": False, "reason": reason}))))
    check, _ = make_check()
    assert check(IMAGE) == reason


def test_ac_art_02_gemini_ok_true_thi_dat(monkeypatch):
    """AC-ART-02: {"ok": true} thì ảnh đạt: trả None."""
    install(monkeypatch, Server(gemini_answer('{"ok": true}')))
    check, _ = make_check()
    assert check(IMAGE) is None


@pytest.mark.parametrize(
    "text",
    [
        json.dumps({"ok": False, "reason": "weird"}),
        json.dumps({"ok": False}),
        json.dumps({"reason": "text"}),
        "đây không phải JSON {",
        "",
        json.dumps(["ok"]),
        json.dumps({"ok": "yes"}),
    ],
    ids=["unknown_reason", "no_reason", "missing_ok", "not_json", "empty", "list", "ok_not_bool"],
)
def test_ac_art_02_gemini_ly_do_la_hoac_tra_loi_hong_thi_coi_la_banned_category(monkeypatch, text):
    """AC-ART-02: lý do lạ, thiếu ok, không phải JSON: fail closed, trả "banned_category" (không bao giờ cho qua)."""
    install(monkeypatch, Server(gemini_answer(text)))
    check, _ = make_check()
    assert check(IMAGE) == "banned_category"


def test_ac_art_03_gemini_kiem_anh_429_theo_ngay_thi_het_quota(monkeypatch):
    """AC-ART-03: 429 với QuotaFailure quotaId theo ngày (PerDay) thì ném QuotaExhausted, không retry."""
    from lau_meme_pipeline.llm import QuotaExhausted

    server = Server(gemini_answer('{"ok": true}'), script=[(429, QUOTA_PER_DAY)])
    install(monkeypatch, server)
    check, sleeps = make_check()

    with pytest.raises(QuotaExhausted):
        check(IMAGE)

    assert len(server.requests) == 1
    assert sleeps == []


def test_ac_pipe_13_gemini_kiem_anh_khoa_khong_ro_ri_trong_loi(monkeypatch):
    """AC-PIPE-13: lỗi HTTP khi kiểm ảnh không chứa khóa API (kể cả khi máy chủ phản hồi lại khóa)."""
    from lau_meme_pipeline.llm import LlmError

    server = Server(gemini_answer('{"ok": true}'), script=[(403, {"error": {"message": API_KEY}})])
    install(monkeypatch, server)
    check, _ = make_check()

    with pytest.raises(LlmError) as info:
        check(IMAGE)

    assert API_KEY not in str(info.value) + repr(info.value)


# ================================================================ HttpBatchClient: upload and exists


def test_ac_art_04_put_image_gui_put_dung_duong_dan_header_va_byte_tho(monkeypatch):
    """AC-ART-04: put_image gửi PUT /lau-meme/api/pipeline/images/<key> tới dinoduct.fun với Content-Type image/webp,
    Authorization Bearer, thân là đúng byte ảnh; 204 thì trả None."""
    from lau_meme_pipeline.batch import HttpBatchClient

    server = Server((204, ""))
    seen = install(monkeypatch, server)

    out = HttpBatchClient(BASE_URL, FAKE_PIPE_BEARER).put_image(KEY, WEBP)

    assert out is None
    assert len(seen) == 1
    req = seen[0]
    assert req["host"].startswith("dinoduct.fun")
    assert req["method"] == "PUT"
    assert req["path"] == f"/lau-meme/api/pipeline/images/{KEY}"
    headers = lower(req["headers"])
    assert headers["content-type"] == "image/webp"
    assert headers["authorization"] == f"Bearer {FAKE_PIPE_BEARER}"
    body = req["body"]
    assert (body.encode("latin-1") if isinstance(body, str) else bytes(body)) == WEBP
    assert FAKE_PIPE_BEARER not in req["path"]


@pytest.mark.parametrize("status", [401, 413, 415, 422, 500])
def test_ac_art_04_put_image_khong_phai_2xx_thi_nem_loi(monkeypatch, status):
    """AC-ART-04: Worker từ chối (không phải 2xx) thì put_image ném lỗi để mẻ biết ảnh chưa lên R2 (ảnh vào chờ vẽ)."""
    from lau_meme_pipeline.batch import HttpBatchClient

    body = {"type": "about:blank", "title": "x", "status": status}
    server = Server((204, ""), script=[(status, body)] * 5)
    install(monkeypatch, server)

    raised = None
    try:
        HttpBatchClient(BASE_URL, FAKE_PIPE_BEARER).put_image(KEY, WEBP)
    except Exception as exc:  # the error class is the adapter's choice
        raised = exc

    assert raised is not None, "a non-2xx answer must raise"
    assert FAKE_PIPE_BEARER not in str(raised) + repr(raised)


@pytest.mark.parametrize(("status", "expected"), [(200, True), (404, False)])
def test_ac_art_04_image_exists_dung_head_tren_duong_dan_img(monkeypatch, status, expected):
    """AC-ART-04: image_exists gửi HEAD /lau-meme/img/<key>; 200 thì True, 404 thì False (cùng nội dung thì không
    tải lên lại)."""
    from lau_meme_pipeline.batch import HttpBatchClient

    server = Server((200, ""), script=[(status, "")])
    seen = install(monkeypatch, server)

    got = HttpBatchClient(BASE_URL, FAKE_PIPE_BEARER).image_exists(KEY)

    assert got is expected
    assert [(r["method"], r["path"]) for r in seen] == [("HEAD", f"/lau-meme/img/{KEY}")]
    assert seen[0]["host"].startswith("dinoduct.fun")


# ================================================================ AC-ART-02: a refused request is a failed draw


@pytest.mark.parametrize("status", [400, 413, 422])
def test_ac_art_02_workers_ai_tu_choi_thi_nem_draw_rejected_khong_retry(monkeypatch, status):
    """AC-ART-02: Workers AI trả 400/403/422 (không phải 429, không phải 5xx): ném DrawRejected (lớp con của
    LlmError), không thử lại, không ngủ."""
    from lau_meme_pipeline.llm import DrawRejected, LlmError

    server = Server(ai_ok(), script=[status, status, status, status], echo=FAKE_AI_BEARER)
    install(monkeypatch, server)
    draw, sleeps = make_ai()

    with pytest.raises(DrawRejected) as info:
        draw(PROMPT)

    assert isinstance(info.value, LlmError)
    assert len(server.requests) == 1
    assert draw.calls == 1
    assert sleeps == []
    assert FAKE_AI_BEARER not in str(info.value) + repr(info.value)


@pytest.mark.parametrize("status", [400])
def test_ac_art_02_gemini_kiem_anh_tu_choi_thi_nem_draw_rejected(monkeypatch, status):
    """AC-ART-02: Gemini trả 400/403 khi kiểm ảnh: ném DrawRejected, không thử lại, khóa không lộ."""
    from lau_meme_pipeline.llm import DrawRejected

    server = Server(gemini_answer('{"ok": true}'), script=[(status, {"error": {"message": API_KEY}})] * 4)
    install(monkeypatch, server)
    check, sleeps = make_check()

    with pytest.raises(DrawRejected) as info:
        check(IMAGE)

    assert len(server.requests) == 1
    assert sleeps == []
    assert API_KEY not in str(info.value) + repr(info.value)


# ================================================================ AC-PIPE-10: deterministic seed


def seed_of(req) -> int:
    seed = json.loads(request_text(req))["seed"]
    assert isinstance(seed, int) and not isinstance(seed, bool)
    return seed


def test_ac_pipe_10_workers_ai_gui_seed_nguyen_cung_prompt_thi_cung_seed_o_lan_dau(monkeypatch):
    """AC-PIPE-10: body gửi Workers AI có seed là số nguyên; hai đối tượng WorkersAiImages mới, cùng prompt, gửi cùng
    seed ở lần gọi đầu (chạy lại cùng đợt cho cùng ảnh)."""
    server = Server(ai_ok())
    seen = install(monkeypatch, server)
    first, _ = make_ai()
    second, _ = make_ai()

    first(PROMPT)
    second(PROMPT)

    assert seed_of(seen[0]) == seed_of(seen[1])


def test_ac_pipe_10_workers_ai_ve_lai_cung_prompt_thi_seed_khac(monkeypatch):
    """AC-PIPE-10: trong cùng một đối tượng, lần gọi thứ hai với cùng prompt gửi seed khác lần đầu (vẽ lại phải ra
    tranh mới)."""
    server = Server(ai_ok())
    seen = install(monkeypatch, server)
    draw, _ = make_ai()

    draw(PROMPT)
    draw(PROMPT)

    assert seed_of(seen[0]) != seed_of(seen[1])


def test_ac_pipe_10_workers_ai_prompt_khac_thi_seed_khac(monkeypatch):
    """AC-PIPE-10: các prompt khác nhau cho các seed khác nhau ở lần gọi đầu."""
    server = Server(ai_ok())
    seen = install(monkeypatch, server)
    prompts = [f"{PROMPT} số {n}" for n in range(5)]

    for prompt in prompts:
        make_ai()[0](prompt)

    assert len({seed_of(r) for r in seen}) == len(prompts)


# ================================================================ AC-ART-03: configuration errors


@pytest.mark.parametrize("status", [401, 403, 404])
def test_ac_art_03_workers_ai_loi_cau_hinh_thi_nem_art_config_error_khong_retry(monkeypatch, status):
    """AC-ART-03: Workers AI trả 401/403/404 (token hoặc account sai): ném ArtConfigError (lớp con LlmError, không
    phải DrawRejected), không thử lại, token không lộ."""
    from lau_meme_pipeline.llm import ArtConfigError, DrawRejected, LlmError

    server = Server(ai_ok(), script=[status] * 4, echo=FAKE_AI_BEARER)
    install(monkeypatch, server)
    draw, sleeps = make_ai()

    with pytest.raises(ArtConfigError) as info:
        draw(PROMPT)

    assert isinstance(info.value, LlmError)
    assert not isinstance(info.value, DrawRejected)
    assert len(server.requests) == 1
    assert sleeps == []
    assert FAKE_AI_BEARER not in str(info.value) + repr(info.value)


@pytest.mark.parametrize("status", [401, 403, 404])
def test_ac_art_03_gemini_kiem_anh_loi_cau_hinh_thi_nem_art_config_error(monkeypatch, status):
    """AC-ART-03: Gemini trả 401/403/404 khi kiểm ảnh: ArtConfigError (không phải DrawRejected), không retry."""
    from lau_meme_pipeline.llm import ArtConfigError, DrawRejected

    server = Server(gemini_answer('{"ok": true}'), script=[(status, {"error": {"message": API_KEY}})] * 4)
    install(monkeypatch, server)
    check, sleeps = make_check()

    with pytest.raises(ArtConfigError) as info:
        check(IMAGE)

    assert not isinstance(info.value, DrawRejected)
    assert len(server.requests) == 1
    assert sleeps == []
    assert API_KEY not in str(info.value) + repr(info.value)


def test_ac_art_03_gemini_400_api_key_invalid_la_loi_cau_hinh(monkeypatch):
    """AC-ART-03: HTTP 400 có API_KEY_INVALID trong thân (khóa Gemini sai) là ArtConfigError."""
    from lau_meme_pipeline.llm import ArtConfigError

    body = {
        "error": {
            "code": 400,
            "message": "API key not valid. Please pass a valid API key.",
            "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}],
        }
    }
    server = Server(gemini_answer('{"ok": true}'), script=[(400, body)])
    install(monkeypatch, server)
    check, _ = make_check()

    with pytest.raises(ArtConfigError):
        check(IMAGE)

    assert len(server.requests) == 1


def test_ac_art_02_gemini_400_khac_van_la_draw_rejected(monkeypatch):
    """AC-ART-02: HTTP 400 không có API_KEY_INVALID (yêu cầu bị từ chối) vẫn là DrawRejected, không phải lỗi cấu
    hình."""
    from lau_meme_pipeline.llm import ArtConfigError, DrawRejected

    body = {"error": {"code": 400, "message": "Unable to process input image", "status": "INVALID_ARGUMENT"}}
    server = Server(gemini_answer('{"ok": true}'), script=[(400, body)])
    install(monkeypatch, server)
    check, _ = make_check()

    with pytest.raises(DrawRejected) as info:
        check(IMAGE)

    assert not isinstance(info.value, ArtConfigError)
