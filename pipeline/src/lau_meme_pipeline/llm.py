"""LLM call errors shared by the batch steps (moderation, linking, judge — AC-MOD-03, AC-PIPE-12)."""


class QuotaExhausted(Exception):
    """The provider's quota is used up: stop calling, the unprocessed items wait for the next batch."""


class LlmError(Exception):
    """A call still failed after its retries: the items of that call are treated as not safe."""
