"""Tiers (TIER, ADR 0013, 0016): an admin-assigned tier (kept by the Worker, read from `/pipeline/state`) wins;
every other element takes the depth-based auto tier of this batch (AC-TIER-04/05). Pure.
"""

from collections.abc import Iterable, Mapping
from dataclasses import replace

from lau_meme_pipeline.seed import ACTIVE, ContentStore, StoredElement
from lau_meme_pipeline.text import fold

TIERS = range(1, 6)
TIER_NAMES = ("Xám", "Xanh lá", "Xanh dương", "Vàng", "Đỏ")
NO_IMAGE_CAP = 3  # Vàng/Đỏ need a usable image (open question 69)


def _by_depth(depth: int) -> int:
    if depth <= 2:
        return 1
    if depth <= 4:
        return depth - 1
    return 4 if depth <= 6 else 5


def auto_tier(depth: int, has_image: bool) -> int:
    """AC-TIER-04: depth 0-2 -> 1, 3 -> 2, 4 -> 3, 5-6 -> 4, >= 7 -> 5; 4 or 5 without a usable image -> 3."""
    tier = _by_depth(depth)
    return tier if has_image else min(tier, NO_IMAGE_CAP)


def auto_tiers(store: ContentStore, blocked_images: Iterable[str] = ()) -> dict[str, int]:
    """Auto tier of every element; a usable image has an `image_key` and is not blocked/hidden."""
    hidden = frozenset(blocked_images)
    return {k: auto_tier(e.depth, _usable(e, hidden)) for k, e in store.elements.items()}


def valid_tier(value: object) -> bool:
    return type(value) is int and value in TIERS


def needs_rare_image(depth: int, admin_tier: object = None) -> bool:
    """AC-ART-12: Vàng/Đỏ once it has a usable image - admin-assigned 4/5, otherwise auto tier 4/5 by depth."""
    return (admin_tier if valid_tier(admin_tier) else _by_depth(depth)) > NO_IMAGE_CAP


def apply_tiers(store: ContentStore, tiers: Iterable[Mapping], blocked_images: Iterable[str] = ()) -> ContentStore:
    """Elements listed in `tiers` take that tier as given; the others take their auto tier. Admin values are checked
    later on the exported graph (`invalid_tiers`), so a bad value fails the batch at the check step (AC-PIPE-11)."""
    by_id = {t.get("element_id"): t.get("tier") for t in tiers}
    auto = auto_tiers(store, blocked_images)
    elements = {k: replace(e, tier=by_id[k] if k in by_id else auto[k]) for k, e in store.elements.items()}
    return replace(store, elements=elements)


def tier_report(store: ContentStore, tiers: Iterable[Mapping], blocked_images: Iterable[str] = ()) -> list[str]:
    """Report lines (AC-TIER-04): effective tier counts of the active elements, and the auto-tiered ones held at
    Xanh dương only for lack of an image; admin Vàng/Đỏ elements left without a usable image (AC-ART-12)."""
    admin = {t.get("element_id"): t.get("tier") for t in tiers}
    hidden = frozenset(blocked_images)
    auto = auto_tiers(store, hidden)
    active = [e for e in store.elements.values() if e.status == ACTIVE]
    counts = [sum(1 for e in active if e.tier == t) for t in TIERS]
    waiting = sum(1 for e in active if e.id not in admin and auto[e.id] < _by_depth(e.depth))
    missing = sorted(
        (e.name for e in active if e.id in admin and needs_rare_image(e.depth, admin[e.id]) and not _usable(e, hidden)),
        key=fold,
    )
    return [
        "Tier: " + " · ".join(f"{name} {n}" for name, n in zip(TIER_NAMES, counts, strict=True)),
        f"Chờ ảnh để lên Vàng/Đỏ: {waiting}",
        *([f"Vàng/Đỏ thiếu ảnh: {', '.join(missing)}"] if missing else []),
    ]


def _usable(element: StoredElement, hidden: frozenset[str]) -> bool:
    return bool(element.image_key) and element.id not in hidden


def invalid_tiers(entries: Iterable[Mapping]) -> list[str]:
    """Ids of decrypted graph entries whose tier is missing or not an integer 1-5."""
    return [e.get("id", "?") for e in entries if not valid_tier(e.get("tier"))]
