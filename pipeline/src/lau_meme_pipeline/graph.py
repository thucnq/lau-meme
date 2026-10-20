"""Export the encrypted public graph and the manifest of a version (ADR 0002, AC-GRAPH).

Pure functions: the batch time and version are passed in; the output is byte-identical for the same input.
"""

import base64
import binascii
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from lau_meme_pipeline.ids import recipe_id
from lau_meme_pipeline.seed import ACTIVE, CLASSIC, ContentStore, StoredElement
from lau_meme_pipeline.text import fold

GRAPH_FORMAT = 1


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _canonical(data: object) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@lru_cache(maxsize=1 << 16)  # the INV-04/12 checks open the same pairs many times; pure, so caching is safe
def _cipher(a_fold: str, b_fold: str, version: int) -> tuple[AESGCM, bytes]:
    x, y = sorted((a_fold, b_fold), key=lambda s: s.encode("utf-8"))
    okm = HKDF(
        algorithm=hashes.SHA256(),
        length=44,
        salt=f"lm1|graph|v{version}".encode(),
        info=b"lm1|aes-gcm",
    ).derive((x + "\0" + y).encode("utf-8"))
    return AESGCM(okm[:32]), okm[32:]


def _added_version(batch: str) -> int:
    return 0 if batch == CLASSIC else int(batch)


def _plaintext(element: StoredElement) -> dict:
    return {
        "id": element.id,
        "name": element.name,
        "emoji": element.emoji,
        "depth": element.depth,
        "added_version": _added_version(element.batch),
        "image_key": None,
    }


def export_graph(store: ContentStore, version: int) -> dict:
    """Graph of every active recipe whose inputs and result are active."""
    entries: dict[str, str] = {}
    for rid in sorted(store.recipes):
        recipe = store.recipes[rid]
        a, b, result = store.elements[recipe.a], store.elements[recipe.b], store.elements[recipe.result]
        if recipe.status != ACTIVE or any(e.status != ACTIVE for e in (a, b, result)):
            continue
        aes, iv = _cipher(a.fold, b.fold, version)
        entries[rid] = _b64u(aes.encrypt(iv, _canonical(_plaintext(result)), rid.encode("ascii")))
    return {"format": GRAPH_FORMAT, "version": version, "entries": entries}


def graph_to_bytes(graph: Mapping) -> bytes:
    return _canonical(graph)


def decrypt_entry(graph: Mapping, a: str, b: str) -> dict | None:
    """Plaintext of the entry for (a, b), or None when there is none or the names do not open it."""
    key = recipe_id(a, b)
    raw = open_entry(graph, key, fold(a), fold(b))
    if raw is None:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        return None


def open_entry(graph: Mapping, key: str, a_fold: str, b_fold: str) -> bytes | None:
    """Raw plaintext of the entry stored under `key`, opened with the key of (a_fold, b_fold) - None if it fails."""
    value = graph.get("entries", {}).get(key)
    if not isinstance(value, str):
        return None
    aes, iv = _cipher(a_fold, b_fold, int(graph["version"]))
    try:
        return aes.decrypt(iv, _unb64u(value), key.encode("ascii"))
    except (InvalidTag, binascii.Error, ValueError):
        return None


def build_manifest(
    store: ContentStore,
    *,
    version: int,
    batch_at: datetime,
    daily: Mapping,
    previous_version: int | None,
) -> dict:
    """Manifest without `policy_version` (the Worker adds it)."""
    if previous_version is not None and version <= previous_version:
        raise ValueError(f"version {version} phải lớn hơn version trước {previous_version}")
    if batch_at.tzinfo is None:
        raise ValueError("batch_at phải có múi giờ")
    starters = [store.elements[sid] for sid in store.starters]
    return {
        "version": version,
        "batch_at": batch_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "graph_url": f"/api/graph/{version}",
        "starters": [{"id": e.id, "name": e.name, "emoji": e.emoji} for e in starters],
        "miss_lines": list(store.miss_lines),
        "daily": dict(daily),
    }
