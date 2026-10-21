"""Illustrations for new elements (AC-ART-01..04): prompt, draw + moderate with one redraw, quota carry-over, WebP.

Pure logic: Workers AI (`generate`), the Gemini image check (`check`) and R2 (`store`) are passed in - network
adapters in production, fakes in tests. Only Pillow re-encodes bytes, which is deterministic for the same input.
"""

import hashlib
import io
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Protocol

from PIL import Image, ImageOps

from lau_meme_pipeline.llm import QuotaExhausted
from lau_meme_pipeline.moderation import ModLists
from lau_meme_pipeline.seed import ContentStore

# The shared style paragraph (AC-ART-01, updated 2026-10-20: hand-drawn replaces the sticker style). One place only.
STYLE_PROMPT = (
    "Hand-drawn illustration in ink pen and watercolor, slightly shaky sketch lines, plain background, "
    "a hotpot when it fits the idea, no text, no letters, no real people, no logo."
)
REJECT_REASONS = ("real_face", "logo", "copyright", "text", "banned_category")
MAX_DRAWS = 2  # one draw + one redraw, then the emoji (AC-ART-02)
MAX_PER_BATCH = 20  # chosen 2026-10-21 (ADR 0012): the rest waits for the next batch
SIZE = 256
R2_PREFIX = "img/"
# Untrusted bytes from the model (ADR 0012): bounded before and while decoding.
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 4096 * 4096
INPUT_FORMATS = ("PNG", "JPEG", "WEBP")


class UploadFailed(Exception):
    """Saving a passed image failed for a reason outside the image (network, R2): retry the element next batch."""


@dataclass(frozen=True)
class ArtAdapters:
    """The network side of drawing (ADR 0012): Workers AI `generate(prompt) -> bytes`, the Gemini image `check`."""

    generate: Callable[[str], bytes]
    check: Callable[[bytes], str | None]


@dataclass(frozen=True)
class ArtItem:
    id: str
    name: str
    image_hint: str


@dataclass
class ArtResult:
    images: dict[str, str] = field(default_factory=dict)
    fallback: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    rejections: dict[str, int] = field(default_factory=dict)
    errors: dict[str, int] = field(default_factory=dict)
    draws: int = 0


@dataclass(frozen=True)
class SavedImage:
    key: str
    uploaded: bool


class BlobStore(Protocol):
    def exists(self, r2_key: str) -> bool: ...

    def put(self, r2_key: str, data: bytes) -> None: ...


def build_prompt(image_hint: str, name: str, mod_lists: ModLists | None = None) -> str:
    """Image hint + the shared style (AC-ART-01).

    The element name is never sent: it may be an alias on the block list or a proper noun, and there is no
    reliable way to tell a proper noun apart, so the concept hint alone describes the picture.
    """
    return f"{image_hint.strip().rstrip('.')}. {STYLE_PROMPT}"


def draw_images(
    items: Sequence[ArtItem],
    generate: Callable[[str], bytes],
    check: Callable[[bytes], str | None],
    save: Callable[[bytes], str],
    *,
    limit: int = MAX_PER_BATCH,
) -> ArtResult:
    """Draw, redraw once on a violation, else fall back to the emoji (AC-ART-02). Quota, the per-batch limit and
    errors outside the image (network, upload) leave the element waiting for the next batch (AC-ART-03); an image
    that cannot be decoded counts as a failed draw. Never raises for one element."""
    result = ArtResult()
    rejections: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    drawn_items = 0
    for index, art in enumerate(items):
        if not art.image_hint.strip():
            result.fallback.append(art.id)  # no approved hint: a generic picture would mislead (AC-ART-01)
            continue
        if drawn_items >= limit:
            result.pending.append(art.id)
            continue
        drawn_items += 1
        prompt = build_prompt(art.image_hint, art.name)
        try:
            for _ in range(MAX_DRAWS):
                image = generate(prompt)
                result.draws += 1
                reason = check(image)
                if reason is not None:
                    rejections[reason if reason in REJECT_REASONS else "banned_category"] += 1
                    continue
                try:
                    result.images[art.id] = save(image)
                    break
                except UploadFailed:
                    raise
                except Exception:  # corrupt or oversized model output (Pillow): a failed draw
                    errors["decode_error"] += 1
            else:
                result.fallback.append(art.id)
        except QuotaExhausted:
            result.pending.extend(i.id for i in items[index:] if i.image_hint.strip())
            result.fallback.extend(i.id for i in items[index + 1 :] if not i.image_hint.strip())
            break
        except Exception:  # Workers AI / check / upload error for this element: try again next batch
            result.pending.append(art.id)
    result.rejections = dict(rejections)
    result.errors = dict(errors)
    return result


def order_for_drawing(pending: Iterable[ArtItem], new: Iterable[ArtItem]) -> list[ArtItem]:
    """Items waiting from earlier batches first, then the new ones, each id once (AC-ART-03)."""
    seen: set[str] = set()
    ordered: list[ArtItem] = []
    for art in (*pending, *new):
        if art.id not in seen:
            seen.add(art.id)
            ordered.append(art)
    return ordered


def to_webp_256(data: bytes) -> bytes:
    """Center-crop to a square and encode as a 256x256 WebP (AC-ART-04). The input is untrusted: size, format and
    pixel count are bounded (Pillow raises DecompressionBombError above MAX_PIXELS)."""
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("ảnh đầu vào quá lớn")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with Image.open(io.BytesIO(data), formats=INPUT_FORMATS) as source:
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("ảnh quá nhiều điểm ảnh")
        image = ImageOps.fit(source.convert("RGBA"), (SIZE, SIZE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=85, method=6)
    return out.getvalue()


def image_key(webp: bytes) -> str:
    """`<first 12 hex of sha256(content)>.webp` - the key D1, the graph, the block list and `/img/{key}` use."""
    return hashlib.sha256(webp).hexdigest()[:12] + ".webp"


def save_image(data: bytes, store: BlobStore) -> SavedImage:
    """Store a passed image under `img/<key>`; same content, same key, no second upload (AC-ART-04)."""
    webp = to_webp_256(data)
    key = image_key(webp)
    r2_key = R2_PREFIX + key
    if store.exists(r2_key):
        return SavedImage(key, uploaded=False)
    store.put(r2_key, webp)
    return SavedImage(key, uploaded=True)


def apply_images(store: ContentStore, images: Mapping[str, str]) -> ContentStore:
    """Record each element's image key; the graph export then carries it in the encrypted result."""
    elements = dict(store.elements)
    for element_id, key in images.items():
        elements[element_id] = replace(elements[element_id], image_key=key)
    return replace(store, elements=elements)
