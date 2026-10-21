"""LLM calls of the batch steps (moderation, linking, judge): errors, batching with backoff, per-batch cache.

AC-MOD-03, AC-PIPE-10, AC-PIPE-12. No network here: the provider adapter is passed in.
"""

import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field


class QuotaExhausted(Exception):
    """The provider's quota is used up: stop calling, the unprocessed items wait for the next batch."""


class LlmError(Exception):
    """A call still failed after its retries: the items of that call are treated as not safe."""


class DrawRejected(LlmError):
    """The provider refused this input for good (HTTP 4xx other than 429): retrying the same prompt cannot help."""


class ArtConfigError(LlmError):
    """The provider rejects our credentials, account or model (401/403/404, invalid key): every call would fail the
    same way, so drawing stops and nothing is held against the elements."""


class PartialAnswer(Exception):
    """Some chunks were answered, others failed or hit the quota: usable now, never cached (AC-PIPE-10)."""

    def __init__(self, answer: object, *, quota: bool = False) -> None:
        super().__init__("partial answer")
        self.answer = answer
        self.quota = quota  # the missing part hit the quota (reported as "hết quota")


class RateLimited(Exception):
    """A temporary 429: the same call is retried after an exponential backoff."""


@dataclass
class BatchCalls:
    results: list = field(default_factory=list)
    failed: list = field(default_factory=list)
    pending: list = field(default_factory=list)
    quota_hit: bool = False
    calls: int = 0


def call_in_batches(
    items: Sequence,
    size: int,
    call: Callable[[list], list],
    *,
    sleep: Callable[[float], None],
    max_retries: int = 3,
    base_delay: float = 2.0,
) -> BatchCalls:
    """Batches of `size` (AC-PIPE-12); `sleep` is a parameter so tests never wait."""
    out = BatchCalls()
    chunks = [list(items[i : i + size]) for i in range(0, len(items), size)]
    for n, chunk in enumerate(chunks):
        for attempt in range(max_retries + 1):
            out.calls += 1
            try:
                out.results.extend(call(chunk))
                break
            except RateLimited:
                if attempt == max_retries:
                    out.failed.extend(chunk)
                else:
                    sleep(base_delay * 2**attempt)
            except QuotaExhausted:
                out.quota_hit = True
                out.pending = [x for c in chunks[n:] for x in c]
                return out
            except Exception:
                out.failed.extend(chunk)
                break
    return out


class CachedLlm:
    """Answers stored per batch, so re-running the same batch never calls the LLM again (AC-PIPE-10)."""

    def __init__(self, call: Callable[[str, object], object], cache: dict) -> None:
        self._call = call
        self.cache = cache
        self.quota_hit = False

    @staticmethod
    def key(step: str, payload: object) -> str:
        text = step + json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def ask(self, step: str, payload: object) -> object:
        """A partial answer is returned but not cached: the next batch asks again for what is missing."""
        k = self.key(step, payload)
        if k not in self.cache:
            try:
                self.cache[k] = self._call(step, payload)
            except PartialAnswer as partial:
                self.quota_hit = self.quota_hit or partial.quota
                return partial.answer
        return self.cache[k]
