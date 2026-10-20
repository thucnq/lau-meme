"""Queue of memes that could not be linked yet (AC-PIPE-07): retried first next batch, dropped after 6 tries."""

from collections.abc import Sequence
from dataclasses import dataclass, field

MAX_ATTEMPTS = 6  # open question #14 - 6 batches (3 days)


@dataclass
class QueueResult:
    queue: list[dict] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)


def next_queue(queue: Sequence[dict], unlinked: Sequence[dict], linked_keys: set[str]) -> QueueResult:
    """`unlinked` items failed this batch: queued ones count one more try, new ones enter with 1."""
    result = QueueResult()
    failed = {u["key"]: u for u in unlinked}
    for item in queue:
        if item["key"] in linked_keys:
            continue
        if item["key"] in failed:
            item = {**item, "attempts": item["attempts"] + 1}
            failed.pop(item["key"])
        if item["attempts"] >= MAX_ATTEMPTS and item["key"] not in linked_keys:
            result.dropped.append(item["key"])
        else:
            result.queue.append(item)
    for key, u in failed.items():
        if key not in linked_keys:
            result.queue.append({"reason": "unlinked", **u, "attempts": 1})
    return result


def batch_order(queue: Sequence[dict], new_concepts: Sequence[dict]) -> list[dict]:
    """Queued concepts first (oldest first), then this batch's new ones; one entry per key."""
    out: list[dict] = []
    seen: set[str] = set()
    for item in [*queue, *new_concepts]:
        if item["key"] not in seen:
            seen.add(item["key"])
            out.append(item)
    return out
