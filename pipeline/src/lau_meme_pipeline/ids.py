"""Stable ids of elements and recipes (ADR 0002). Pure functions: no network, no clock, no randomness."""

import base64
import hashlib

from lau_meme_pipeline.text import fold


def _b64u_sha256(text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def element_id(name: str) -> str:
    """Id of an element: base64url(SHA-256("lm1|e|" + fold(name))), 43 characters."""
    return _b64u_sha256("lm1|e|" + fold(name))


def recipe_id(a: str, b: str) -> str:
    """Graph lookup key of the unordered pair (a, b) - the same for (a, b) and (b, a)."""
    x, y = sorted((fold(a), fold(b)), key=lambda s: s.encode("utf-8"))
    return _b64u_sha256("lm1|k|" + x + "\0" + y)
