"""Network adapter: Workers AI text-to-image over the Cloudflare REST API (ADR 0012).

`WorkersAiImages(prompt) -> bytes` is the `generate` of `art.ArtAdapters`. 429 means the free allocation is used up
(the rest waits, AC-ART-03); 5xx is retried with backoff; another 4xx is DrawRejected (the prompt itself is refused).
The seed comes from the prompt and how many times this run asked it, so a rerun draws the same pictures
(AC-PIPE-10) while a redraw is a new one. Only the Flux response shape `{"result": {"image": base64}}` is read.
Errors carry only their type and HTTP status, never the token or the account URL.
"""

import base64
import binascii
import hashlib
import http.client
import json
import time
from collections.abc import Callable

from lau_meme_pipeline.batch import TIMEOUT_SECONDS
from lau_meme_pipeline.llm import DrawRejected, LlmError, QuotaExhausted

HOST = "api.cloudflare.com"
DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell"
MAX_RETRIES = 3
BASE_DELAY = 2.0


class WorkersAiImages:
    def __init__(
        self,
        account_id: str,
        token: str,
        model: str = DEFAULT_MODEL,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._path = f"/client/v4/accounts/{account_id}/ai/run/{model or DEFAULT_MODEL}"
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self._sleep = sleep
        self.calls = 0
        self._asked: dict[str, int] = {}

    def __call__(self, prompt: str) -> bytes:
        n = self._asked.get(prompt, 0)
        self._asked[prompt] = n + 1
        seed = int(hashlib.sha256(f"{prompt}|{n}".encode()).hexdigest()[:8], 16)
        for attempt in range(MAX_RETRIES + 1):
            self.calls += 1
            status, raw = self._post({"prompt": prompt, "seed": seed})
            if status == 429:
                raise QuotaExhausted()
            if status >= 500:
                if attempt == MAX_RETRIES:
                    raise LlmError(f"Workers AI HTTP {status}")
                self._sleep(BASE_DELAY * 2**attempt)
                continue
            if status != 200:
                raise DrawRejected(f"Workers AI HTTP {status}")
            try:
                answer = json.loads(raw)
                if answer.get("success") is not True:
                    raise ValueError
                return base64.b64decode(answer["result"]["image"], validate=True)
            except (ValueError, KeyError, TypeError, AttributeError, binascii.Error):
                raise LlmError("Workers AI trả lời không đọc được") from None
        raise LlmError("Workers AI không trả lời")  # unreachable: the loop returns or raises

    def _post(self, body: dict) -> tuple[int, bytes]:
        conn = http.client.HTTPSConnection(HOST, timeout=TIMEOUT_SECONDS * 4)  # an image takes longer than text
        try:
            conn.request("POST", self._path, body=json.dumps(body, ensure_ascii=False).encode(), headers=self._headers)
            res = conn.getresponse()
            return res.status, res.read()
        finally:
            conn.close()
