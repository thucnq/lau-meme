"""Admin-assigned tiers (TIER, ADR 0013): the Worker keeps them, every batch copies them into the graph plaintext.

Pure: the tiers come from `/pipeline/state`; the pipeline never picks or changes a tier itself (AC-TIER-01).
"""

from collections.abc import Iterable, Mapping
from dataclasses import replace

from lau_meme_pipeline.seed import ContentStore

TIERS = range(1, 6)


def valid_tier(value: object) -> bool:
    return type(value) is int and value in TIERS


def apply_tiers(store: ContentStore, tiers: Iterable[Mapping]) -> ContentStore:
    """Elements listed in `tiers` take that tier as given; the others keep tier 1. Values are checked later on the
    exported graph (`invalid_tiers`), so a bad value fails the batch at the check step (AC-PIPE-11)."""
    by_id = {t["element_id"]: t["tier"] for t in tiers}
    if not by_id:
        return store
    elements = {k: replace(e, tier=by_id[k]) if k in by_id else e for k, e in store.elements.items()}
    return replace(store, elements=elements)


def invalid_tiers(entries: Iterable[Mapping]) -> list[str]:
    """Ids of decrypted graph entries whose tier is missing or not an integer 1-5."""
    return [e.get("id", "?") for e in entries if not valid_tier(e.get("tier"))]
