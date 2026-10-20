"""Text helpers shared by every pipeline step. Pure functions: no network, no clock, no randomness."""

import unicodedata


def fold(text: str) -> str:
    """Lowercase, strip Vietnamese diacritics and collapse spaces - the key used for search and de-duplication.

    'Đơn Nghỉ  Việc' -> 'don nghi viec'
    """
    text = text.replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return " ".join(stripped.lower().split())
