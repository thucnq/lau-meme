"""Network adapter: Gemini `generateContent` over REST with the standard library (ADR 0011).

`GeminiSteps` is the `llm` mapping of `full.run_full`: one callable per batch step. A list payload goes out in
chunks of `batch_size` through `llm.call_in_batches` (backoff, quota stop - AC-PIPE-12); every item passes the
AC-PIPE-13 allow-list first. Errors carry only their type and HTTP status, never the key or the URL.
"""

import base64
import http.client
import json
import time
from collections.abc import Callable, Iterator, Mapping

from lau_meme_pipeline.art import REJECT_REASONS
from lau_meme_pipeline.batch import TIMEOUT_SECONDS, build_llm_payload
from lau_meme_pipeline.llm import LlmError, PartialAnswer, QuotaExhausted, RateLimited, call_in_batches
from lau_meme_pipeline.moderation import CATEGORIES

HOST = "generativelanguage.googleapis.com"
DEFAULT_MODEL = "gemini-2.5-flash"

_COMMON = (
    "Bạn hỗ trợ game ghép meme tiếng Việt 'Lẩu Meme'. Dữ liệu vào là JSON ở cuối. "
    "Chỉ trả về JSON đúng mẫu, không giải thích, giữ nguyên các giá trị `key`, `id`, `name`, `a`, `b` đã nhận.\n"
)
PROMPTS = {
    "same": "Mỗi phần tử có `name` (meme mới) và `existing` (meme đã có). Trả một mảng boolean cùng thứ tự: true khi "
    "hai cái là cùng một meme (chỉ khác cách viết, thêm bớt chữ), false khi khác.",
    "describe": "Mỗi phần tử là một meme đang lan truyền. Trả mảng cùng thứ tự, mỗi phần tử "
    '{"key", "emoji": một emoji hợp nhất, "description": mô tả trung tính dưới 120 ký tự, '
    '"daily_hint": gợi ý đoán món dưới 80 ký tự và không chứa tên meme, "image_hint": mô tả ảnh minh họa '
    "không có người thật}.",
    "classify": "Kiểm duyệt từng meme, không chắc thì xếp unsure. Trả mảng, mỗi phần tử "
    '{"key", "category": "safe" | "unsure" | một trong ' + ", ".join(CATEGORIES) + ", "
    '"confidence": số 0..1, "person": {"targets": true nếu nhắm vào một người thật cụ thể, "name": tên người '
    'hoặc null, "aliases": [các cách gọi khác]}, "accusation": true nếu cáo buộc người thật, '
    '"hot_person": true nếu là chuyện nóng về một người, "flagged_fields": [tên trường có nội dung xấu]}.',
    "link": "Mỗi phần tử có `name` (meme mới) và `candidates` (tên phần tử đã có). Đề xuất 2-3 cặp phần tử trong "
    "`candidates` mà ghép lại ra meme mới một cách hài hước, dễ hiểu. Trả mảng "
    '{"key", "pairs": [[tên A, tên B], ...]}.',
    "judge": "Mỗi phần tử là công thức A + B = result. Chấm độ hài và hợp lý từ 1 (vô nghĩa) đến 5 (rất hay). "
    'Trả object {"<id>": điểm nguyên}.',
    "supplement_element": "Mỗi phần tử có `name` cần thêm `need` công thức mà nó là đầu vào. Chọn bạn ghép trong "
    "`candidates` và kết quả cũng là một tên trong `candidates`. Trả mảng "
    '{"name", "recipes": [{"with": tên bạn ghép, "result": tên kết quả}]}.',
    "supplement_pair": "Mỗi phần tử là cặp `a`, `b`. Nếu ghép hai cái ra được một phần tử đã có trong game một cách "
    'hợp lý thì cho tên đó, không thì null. Trả mảng {"a", "b", "result": tên hoặc null}.',
}


class _Http:
    """One `generateContent` request; maps the HTTP outcome onto the `llm` exceptions (ADR 0011)."""

    def __init__(self, api_key: str, model: str) -> None:
        self._headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
        self._path = f"/v1beta/models/{model}:generateContent"

    def ask(self, prompt: str, items: list) -> object:
        return self.send([{"text": _COMMON + prompt}, {"text": _json(items)}])

    def send(self, parts: list[dict]) -> object:
        body = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
        }
        conn = http.client.HTTPSConnection(HOST, timeout=TIMEOUT_SECONDS)
        try:
            conn.request("POST", self._path, body=json.dumps(body, ensure_ascii=False).encode(), headers=self._headers)
            res = conn.getresponse()
            raw = res.read()
        finally:
            conn.close()
        if res.status == 429:
            raise QuotaExhausted() if _per_day(raw) else RateLimited()
        if res.status >= 500:
            raise RateLimited()
        if res.status != 200:
            raise LlmError(f"Gemini HTTP {res.status}")
        try:
            text = json.loads(raw)["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except (ValueError, KeyError, IndexError, TypeError):
            raise _Unreadable("Gemini trả lời không phải JSON") from None


class _Unreadable(LlmError):
    """HTTP 200 but no JSON answer: a step decides whether that fails open or closed."""


def _json(items: list) -> str:
    return json.dumps(items, ensure_ascii=False)


def _per_day(raw: bytes) -> bool:
    """Daily quota: a QuotaFailure violation whose quotaId names a per-day limit; per-minute ones are retried."""
    try:
        details = json.loads(raw)["error"].get("details", [])
    except (ValueError, KeyError, AttributeError, TypeError):
        return False
    return any(
        "PerDay" in str(v.get("quotaId", ""))
        for d in details
        if isinstance(d, Mapping)
        for v in d.get("violations", [])
        if isinstance(v, Mapping)
    )


class GeminiSteps(Mapping[str, Callable[[object], object]]):
    """`steps[step](payload)`: chunks, retries and merges; `calls` counts HTTP requests (the batch report's quota)."""

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        *,
        sleep: Callable[[float], None] = time.sleep,
        batch_size: int = 10,
    ) -> None:
        self._http = _Http(api_key, model or DEFAULT_MODEL)
        self._sleep = sleep
        self._size = batch_size
        self.calls = 0
        self.quota_hit = False

    def __getitem__(self, step: str) -> Callable[[object], object]:
        if step not in PROMPTS:
            raise KeyError(step)
        return lambda payload: self._run(step, payload)

    def __iter__(self) -> Iterator[str]:
        return iter(PROMPTS)

    def __len__(self) -> int:
        return len(PROMPTS)

    def _run(self, step: str, payload: object) -> object:
        if not isinstance(payload, list):
            raise ValueError("payload gửi LLM phải là danh sách")
        items = build_llm_payload(payload)
        if self.quota_hit:
            raise QuotaExhausted()
        merged_dict = step == "judge"

        def call(chunk: list) -> list:
            self.calls += 1
            answer = self._http.ask(PROMPTS[step], chunk)
            if merged_dict:
                if not isinstance(answer, Mapping):
                    raise LlmError("Gemini trả lời sai dạng")
                return [answer]
            if not isinstance(answer, list):
                raise LlmError("Gemini trả lời sai dạng")
            return answer

        out = call_in_batches(items, self._size, call, sleep=self._sleep)
        if out.quota_hit:
            self.quota_hit = True
            if not out.results:
                raise QuotaExhausted()
        elif items and not out.results:
            raise LlmError(f"Gemini: cả {len(items)} mục của bước {step} đều lỗi")
        if merged_dict:
            answer: object = {k: v for part in out.results for k, v in part.items()}
        elif step == "same" and out.failed:
            answer = []  # answers are positional: a missing middle chunk would shift them, so trust none
        else:
            answer = out.results
        if out.failed or out.pending:
            raise PartialAnswer(answer, quota=out.quota_hit)  # usable now, never cached (AC-PIPE-10)
        return answer


IMAGE_PROMPT = (
    "Kiểm duyệt ảnh minh họa cho game ghép meme. Ảnh vi phạm nếu có: mặt người giống thật (real_face), "
    "logo hoặc thương hiệu (logo), nhân vật có bản quyền (copyright), chữ trong ảnh (text), nội dung tình dục, "
    'bạo lực, ma túy, chính trị, tôn giáo hoặc phân biệt (banned_category). Trả JSON {"ok": true} nếu đạt, '
    '{"ok": false, "reason": "<một trong real_face, logo, copyright, text, banned_category>"} nếu vi phạm.'
)
_SIGNATURES = ((b"\x89PNG", "image/png"), (b"\xff\xd8", "image/jpeg"), (b"RIFF", "image/webp"))


class GeminiImageCheck:
    """`check(image) -> None | reason` of `art.ArtAdapters` (AC-ART-02, ADR 0012). Fails closed: an answer it cannot
    read is a violation. Per-minute limits are retried; the daily quota raises QuotaExhausted."""

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        *,
        sleep: Callable[[float], None] = time.sleep,
        max_retries: int = 3,
    ) -> None:
        self._http = _Http(api_key, model or DEFAULT_MODEL)
        self._sleep = sleep
        self._retries = max_retries
        self.calls = 0

    def __call__(self, image: bytes) -> str | None:
        mime = next((m for sig, m in _SIGNATURES if image.startswith(sig)), "image/png")
        parts = [
            {"text": IMAGE_PROMPT},
            {"inline_data": {"mime_type": mime, "data": base64.b64encode(image).decode("ascii")}},
        ]
        for attempt in range(self._retries + 1):
            self.calls += 1
            try:
                answer = self._http.send(parts)
                break
            except RateLimited:
                if attempt == self._retries:
                    raise LlmError("Gemini kiểm ảnh: quá giới hạn tần suất") from None
                self._sleep(2.0 * 2**attempt)
            except _Unreadable:
                return "banned_category"
        if not isinstance(answer, Mapping) or not isinstance(answer.get("ok"), bool):
            return "banned_category"
        if answer["ok"]:
            return None
        reason = answer.get("reason")
        return reason if reason in REJECT_REASONS else "banned_category"
