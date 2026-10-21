"""Acceptance tests for docs/acceptance/pipe.md, phase 2: the Gemini adapter (ADR 0011).
AC-PIPE-09 (judge merge), AC-PIPE-12 (batching, backoff, quota),
AC-PIPE-13 (nothing but public meme data, no key leak).

Expected public surface:

    lau_meme_pipeline.gemini.GeminiSteps(api_key, model="gemini-3.8-flash", *, sleep, batch_size=10)
        Mapping step name -> callable(payload); steps: same, describe, classify, link, judge,
        supplement_element, supplement_pair. Attributes: calls (HTTP requests incl. retries), quota_hit.
    lau_meme_pipeline.llm.QuotaExhausted / LlmError

The network is mocked at the connection layer (http.client.HTTPSConnection); nothing real is contacted and no
test sleeps: `sleep` is injected. Imports happen inside the tests so a missing module fails at runtime.
"""

import http.client
import json

import pytest

API_KEY = "AIza-test-key-not-a-secret-123"
HOST = "generativelanguage.googleapis.com"
STEPS = {"same", "describe", "classify", "link", "judge", "supplement_element", "supplement_pair"}

QUOTA_PER_DAY = {
    "error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "message": "quota",
        "details": [
            {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                "violations": [
                    {
                        "quotaMetric": "generate_content_free_tier_requests",
                        "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                    }
                ],
            }
        ],
    }
}
QUOTA_PER_MINUTE = {
    "error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "message": "slow down",
        "details": [
            {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                "violations": [
                    {
                        "quotaMetric": "generate_content_free_tier_requests",
                        "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                    }
                ],
            }
        ],
    }
}


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.reason = "X"
        self._raw = (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        self.headers = {"Content-Type": "application/json"}

    def read(self, *args):
        return self._raw

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def getheaders(self):
        return list(self.headers.items())


def request_text(req) -> str:
    body = req["body"]
    return body.decode("utf-8") if isinstance(body, bytes) else (body or "")


class FakeGemini:
    """Scripted server. `script` has one entry per HTTP request, in order:
    None -> 200 with a good answer built from the markers found in the request body,
    int -> that status with an error body, ("raw", text) -> 200 whose answer text is `text`,
    dict -> 429/other error body given (status 429). Beyond the script every request gets a good 200.
    `markers` are the unique ids of the payload items, used to count items per request and to build answers."""

    def __init__(self, markers, dict_answer=False, script=()):
        self.markers = list(markers)
        self.dict_answer = dict_answer
        self.script = list(script)
        self.requests: list[dict] = []

    def items_in(self, req) -> list[str]:
        text = request_text(req)
        return [m for m in self.markers if m in text]

    def good(self, req):
        found = self.items_in(req)
        answer = {m: 4 for m in found} if self.dict_answer else [{"key": m, "answer": f"ok:{m}"} for m in found]
        return {"candidates": [{"content": {"parts": [{"text": json.dumps(answer)}]}}]}

    def respond(self, req):
        n = len(self.requests) - 1
        step = self.script[n] if n < len(self.script) else None
        if step is None:
            return FakeResponse(200, self.good(req))
        if isinstance(step, tuple) and step[0] == "raw":
            return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": step[1]}]}}]})
        if isinstance(step, tuple) and step[0] == "error":
            return FakeResponse(step[1], step[2])
        if isinstance(step, dict):
            return FakeResponse(429, step)
        return FakeResponse(step, {"error": {"code": step, "message": f"upstream said key {API_KEY}"}})


def install(monkeypatch, server: FakeGemini) -> list[dict]:
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


def make_steps(batch_size=10, model=None, sleeps=None):
    from lau_meme_pipeline.gemini import GeminiSteps

    sleeps = sleeps if sleeps is not None else []
    if model is None:
        return GeminiSteps(API_KEY, sleep=sleeps.append, batch_size=batch_size), sleeps
    return GeminiSteps(API_KEY, model, sleep=sleeps.append, batch_size=batch_size), sleeps


def concepts(n):
    return [{"key": f"item{i:02d}", "name": f"Meme {i:02d}"} for i in range(n)]


def keys(n):
    return [f"item{i:02d}" for i in range(n)]


def answered_keys(results):
    return [r["key"] for r in results]


# ================================================================ shape of the call


def test_ac_pipe_12_gemini_goi_rest_dung_duong_dan_header_va_json_mime(monkeypatch):
    """AC-PIPE-12: POST /v1beta/models/<model>:generateContent tới generativelanguage.googleapis.com, khóa ở header
    x-goog-api-key, body có contents và generationConfig.responseMimeType = application/json; có đủ 7 bước."""
    server = FakeGemini(keys(3))
    seen = install(monkeypatch, server)
    steps, _ = make_steps()
    assert set(steps) == STEPS

    out = steps["classify"](concepts(3))

    assert answered_keys(out) == keys(3)
    assert len(seen) == 1
    req = seen[0]
    assert req["host"].startswith(HOST)
    assert req["method"] == "POST"
    assert req["path"] == "/v1beta/models/gemini-3.8-flash:generateContent"
    headers = {k.lower(): v for k, v in req["headers"].items()}
    assert headers["x-goog-api-key"] == API_KEY
    body = json.loads(request_text(req))
    assert "contents" in body
    assert body["generationConfig"]["responseMimeType"] == "application/json"


def test_ac_pipe_12_model_la_tham_so(monkeypatch):
    """AC-PIPE-12: đổi model (GEMINI_MODEL) thì đường dẫn đổi theo, không cần sửa code."""
    server = FakeGemini(keys(1))
    seen = install(monkeypatch, server)
    steps, _ = make_steps(model="gemini-2.0-flash")
    steps["describe"](concepts(1))
    assert seen[0]["path"] == "/v1beta/models/gemini-2.0-flash:generateContent"


# ================================================================ AC-PIPE-12


def test_ac_pipe_12_vi_du_25_khai_niem_429_hai_lan_roi_het_quota_o_lo_3(monkeypatch):
    """AC-PIPE-12: 25 khái niệm, lô 10: lô 1 gặp 429 (theo phút) hai lần rồi thành công, lô 3 hết quota theo ngày.
    Có 5 lời gọi (10, 10, 10, 10, 5), chờ 2.0 rồi 4.0, trả 20 kết quả, quota_hit; lời gọi sau không gửi thêm gì."""
    from lau_meme_pipeline.llm import PartialAnswer, QuotaExhausted

    server = FakeGemini(keys(25), script=[QUOTA_PER_MINUTE, QUOTA_PER_MINUTE, None, None, QUOTA_PER_DAY])
    seen = install(monkeypatch, server)
    steps, sleeps = make_steps(batch_size=10)

    with pytest.raises(PartialAnswer) as info:
        steps["classify"](concepts(25))

    assert [len(server.items_in(r)) for r in seen] == [10, 10, 10, 10, 5]
    assert server.items_in(seen[0]) == server.items_in(seen[1]) == server.items_in(seen[2]) == keys(10)
    assert steps.calls == 5
    assert sleeps == [2.0, 4.0]
    assert answered_keys(info.value.answer) == keys(20)
    assert info.value.quota is True
    assert steps.quota_hit is True

    before = len(seen)
    for step in ("classify", "describe", "same"):
        with pytest.raises(QuotaExhausted):
            steps[step](concepts(2))
    assert len(seen) == before


def test_ac_pipe_12_het_quota_ngay_o_lo_dau_thi_nem_quota_exhausted(monkeypatch):
    """AC-PIPE-12: hết quota ngay lô đầu (chưa có gì để trả) thì bước ném QuotaExhausted."""
    from lau_meme_pipeline.llm import QuotaExhausted

    server = FakeGemini(keys(25), script=[QUOTA_PER_DAY])
    seen = install(monkeypatch, server)
    steps, sleeps = make_steps(batch_size=10)

    with pytest.raises(QuotaExhausted):
        steps["classify"](concepts(25))

    assert len(seen) == 1
    assert sleeps == []
    assert steps.quota_hit is True


def test_ac_pipe_12_429_theo_phut_retry_toi_da_3_lan_roi_lo_do_that_bai(monkeypatch):
    """AC-PIPE-12: 429 không phải theo ngày (và 5xx) được retry với backoff 2.0, 4.0, 8.0 (tối đa 3 lần); hết lượt
    thì lô đó bị bỏ, lô sau vẫn chạy và không bị coi là hết quota."""
    from lau_meme_pipeline.llm import PartialAnswer

    server = FakeGemini(keys(15), script=[QUOTA_PER_MINUTE, 503, QUOTA_PER_MINUTE, 500])
    seen = install(monkeypatch, server)
    steps, sleeps = make_steps(batch_size=10)

    with pytest.raises(PartialAnswer) as info:
        steps["classify"](concepts(15))

    assert sleeps == [2.0, 4.0, 8.0]
    assert len(seen) == 5  # chunk 1: 1 + 3 retries, chunk 2: 1
    assert steps.calls == 5
    assert answered_keys(info.value.answer) == keys(15)[10:]
    assert info.value.quota is False
    assert steps.quota_hit is False


def test_ac_pipe_12_lo_loi_http_400_bi_bo_qua_cac_lo_khac_van_tra_ve(monkeypatch):
    """AC-PIPE-12: lô trả HTTP 400 không retry, bị bỏ; kết quả các lô còn lại vẫn được trả theo thứ tự."""
    from lau_meme_pipeline.llm import PartialAnswer

    server = FakeGemini(keys(25), script=[None, 400, None])
    seen = install(monkeypatch, server)
    steps, sleeps = make_steps(batch_size=10)

    with pytest.raises(PartialAnswer) as info:
        steps["classify"](concepts(25))

    assert len(seen) == 3
    assert sleeps == []
    assert answered_keys(info.value.answer) == keys(10) + keys(25)[20:]
    assert info.value.quota is False
    assert steps.quota_hit is False


def test_ac_pipe_12_lo_tra_loi_khong_phai_json_bi_bo_qua(monkeypatch):
    """AC-PIPE-12: lô có câu trả lời không phải JSON bị bỏ qua (không retry); lô khác vẫn trả."""
    from lau_meme_pipeline.llm import PartialAnswer

    server = FakeGemini(keys(20), script=[("raw", "đây không phải JSON {"), None])
    seen = install(monkeypatch, server)
    steps, sleeps = make_steps(batch_size=10)

    with pytest.raises(PartialAnswer) as info:
        steps["describe"](concepts(20))

    assert len(seen) == 2
    assert sleeps == []
    assert answered_keys(info.value.answer) == keys(20)[10:]
    assert info.value.quota is False


@pytest.mark.parametrize(
    "script",
    [[400, 400], [("raw", "not json"), ("raw", "also not json")]],
    ids=["http400", "not_json"],
)
def test_ac_pipe_12_moi_lo_deu_hong_thi_nem_llm_error(monkeypatch, script):
    """AC-PIPE-12: mọi lô đều hỏng thì bước ném LlmError (không im lặng trả danh sách rỗng)."""
    from lau_meme_pipeline.llm import LlmError

    server = FakeGemini(keys(20), script=script)
    install(monkeypatch, server)
    steps, _ = make_steps(batch_size=10)

    with pytest.raises(LlmError):
        steps["classify"](concepts(20))


@pytest.mark.parametrize(
    ("script", "cause"),
    [
        ([400], "HTTP 400"),
        ([("error", 403, {"error": {"message": API_KEY}})], "HTTP 403"),
        ([("raw", "not json")], "không phải JSON"),
        ([("raw", '{"same": [true]}')], "sai dạng"),
    ],
    ids=["http400", "http403", "not_json", "wrong_shape"],
)
def test_ac_pipe_12_moi_lo_deu_hong_thi_loi_ghi_nguyen_nhan(monkeypatch, script, cause):
    """AC-PIPE-12: mọi lô đều hỏng thì LlmError ghi nguyên nhân của lô (loại lỗi, mã HTTP), không chỉ "đều lỗi",
    để báo cáo đợt chỉ ra được sửa gì; vẫn không chứa khóa API (AC-PIPE-13)."""
    from lau_meme_pipeline.llm import LlmError

    server = FakeGemini(keys(3), script=script)
    install(monkeypatch, server)
    steps, _ = make_steps()

    with pytest.raises(LlmError) as info:
        steps["same"](concepts(3))

    message = str(info.value)
    assert cause in message
    assert API_KEY not in message + repr(info.value)


# ================================================================ AC-PIPE-09


def test_ac_pipe_09_buoc_judge_gop_cac_lo_thanh_mot_dict(monkeypatch):
    """AC-PIPE-09: bước judge trả {id công thức: điểm}; câu trả lời của nhiều lô được gộp thành MỘT dict."""
    ids = ["r01", "r02", "r03", "r04", "r05"]
    items = [{"id": i, "a": "Cay", "b": "Cười", "result": f"KQ {i}"} for i in ids]
    server = FakeGemini(ids, dict_answer=True)
    seen = install(monkeypatch, server)
    steps, _ = make_steps(batch_size=2)

    out = steps["judge"](items)

    assert len(seen) == 3  # 2 + 2 + 1
    assert isinstance(out, dict)
    assert out == {i: 4 for i in ids}


# ================================================================ AC-PIPE-13


def test_ac_pipe_13_body_chua_nguyen_van_payload_khoa_chi_o_header(monkeypatch):
    """AC-PIPE-13: body chứa nguyên văn tên/câu nói/ngữ cảnh của meme; khóa API chỉ nằm ở header x-goog-api-key,
    không có trong đường dẫn hay body."""
    items = [
        {
            "key": "k1",
            "name": "Còn Cái Nịt",
            "quote": "còn cái nịt thôi",
            "context": "bình luận trên mạng",
            "source_name": "Reddit",
        }
    ]
    server = FakeGemini(["k1"])
    seen = install(monkeypatch, server)
    steps, _ = make_steps()

    steps["classify"](items)

    req = seen[0]
    body_text = json.dumps(json.loads(request_text(req)), ensure_ascii=False)
    for value in ("Còn Cái Nịt", "còn cái nịt thôi", "bình luận trên mạng", "Reddit"):
        assert value in body_text
    assert API_KEY not in request_text(req)
    assert API_KEY not in req["path"]
    assert "player" not in body_text.lower()
    assert [k.lower() for k, v in req["headers"].items() if v == API_KEY] == ["x-goog-api-key"]


@pytest.mark.parametrize(
    "script",
    [[400], [500, 500, 500, 500], [("error", 403, {"error": {"message": API_KEY}})]],
    ids=["400", "5xx", "403"],
)
def test_ac_pipe_13_thong_bao_loi_khong_chua_khoa_api(monkeypatch, script):
    """AC-PIPE-13: lỗi HTTP chỉ ghi loại lỗi và mã HTTP; thông báo không bao giờ chứa khóa API (kể cả khi máy chủ
    phản hồi lại khóa) hay đường dẫn có khóa."""
    from lau_meme_pipeline.llm import LlmError

    server = FakeGemini(keys(1), script=script)
    install(monkeypatch, server)
    steps, _ = make_steps()

    with pytest.raises(LlmError) as info:
        steps["classify"](concepts(1))

    message = str(info.value) + repr(info.value)
    assert API_KEY not in message
    assert "key=" not in message


@pytest.mark.parametrize("field", ["player_id", "uuid", "nickname", "ip", "steps", "url"])
def test_ac_pipe_13_truong_ngoai_danh_sach_cho_phep_bi_tu_choi_truoc_khi_gui(monkeypatch, field):
    """AC-PIPE-13: item có trường ngoài ALLOWED_LLM_FIELDS bị ValueError trước khi gửi bất kỳ lời gọi nào."""
    server = FakeGemini(keys(2))
    seen = install(monkeypatch, server)
    steps, _ = make_steps()
    items = [{"key": "item00", "name": "Meme 00"}, {"key": "item01", "name": "Meme 01", field: "x"}]

    with pytest.raises(ValueError):
        steps["classify"](items)

    assert seen == []
    assert steps.calls == 0


def test_ac_pipe_10_lo_hong_va_lo_tot_thi_nem_partial_answer_de_khong_bi_cache(monkeypatch):
    """AC-PIPE-10: một lô HTTP 400 và một lô tốt: bước ném PartialAnswer mang câu trả lời của lô tốt (không trả về
    như câu trả lời đầy đủ, để lớp cache không lưu)."""
    from lau_meme_pipeline.llm import PartialAnswer

    server = FakeGemini(keys(20), script=[None, 400])
    install(monkeypatch, server)
    steps, _ = make_steps(batch_size=10)

    with pytest.raises(PartialAnswer) as info:
        steps["classify"](concepts(20))

    assert answered_keys(info.value.answer) == keys(10)
    assert info.value.quota is False


def test_ac_pipe_10_het_quota_sau_mot_lo_tot_cung_nem_partial_answer(monkeypatch):
    """AC-PIPE-10: hết quota sau một lô tốt: PartialAnswer với phần đã xong, quota True, quota_hit True."""
    from lau_meme_pipeline.llm import PartialAnswer

    server = FakeGemini(keys(20), script=[None, QUOTA_PER_DAY])
    install(monkeypatch, server)
    steps, _ = make_steps(batch_size=10)

    with pytest.raises(PartialAnswer) as info:
        steps["classify"](concepts(20))

    assert answered_keys(info.value.answer) == keys(10)
    assert info.value.quota is True
    assert steps.quota_hit is True


@pytest.mark.parametrize("payload", ["Còn Cái Nịt", {"key": "item00", "name": "Meme 00"}], ids=["str", "dict"])
def test_ac_pipe_13_payload_khong_phai_danh_sach_bi_tu_choi_truoc_khi_gui(monkeypatch, payload):
    """AC-PIPE-13: payload không phải danh sách (chuỗi hoặc dict) bị ValueError, không có lời gọi nào."""
    server = FakeGemini(keys(1))
    seen = install(monkeypatch, server)
    steps, _ = make_steps()

    with pytest.raises(ValueError):
        steps["classify"](payload)

    assert seen == []
    assert steps.calls == 0


@pytest.mark.parametrize(
    "candidates",
    [[{"player_id": 1}], "Cay", [1, 2], {"a": "b"}],
    ids=["dict_items", "str", "ints", "dict"],
)
def test_ac_pipe_13_candidates_phai_la_danh_sach_chuoi(monkeypatch, candidates):
    """AC-PIPE-13: trường candidates không phải danh sách chuỗi (có thể giấu dữ liệu lạ) bị ValueError trước khi gửi."""
    server = FakeGemini(["item00"])
    seen = install(monkeypatch, server)
    steps, _ = make_steps()
    items = [{"key": "item00", "name": "Meme 00", "candidates": candidates}]

    with pytest.raises(ValueError):
        steps["link"](items)

    assert seen == []
    assert steps.calls == 0
