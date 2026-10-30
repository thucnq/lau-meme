"""Web image search for memes without a picture (AC-ART-15, ADR 0024): `python -m lau_meme_pipeline.art_search`.

A manual job, not a batch step: it lists the catalog through the admin API, searches the web for each active element
without an image, and attaches the first usable result through `PUT /admin/elements/{id}/image`, so the picture is an
admin image (never drawn over, audited, in the graph from the next batch). No LLM moderation and no filter on real
faces or copyright: the project owner's decision (2026-10-30). `pick_elements` and `run_art_search` are pure given
their adapters; the admin API, the search API and the image fetch are the network side, isolated here and mocked in
tests. Only the element name reaches the search API.
"""

import argparse
import json
import os
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Protocol
from urllib.parse import urlencode

from lau_meme_pipeline.art import to_webp_256
from lau_meme_pipeline.batch import open_connection, parse_api_url
from lau_meme_pipeline.links import TIMEOUT_SECONDS as LINK_TIMEOUT_SECONDS
from lau_meme_pipeline.links import fetch_link, https_get, resolve_host
from lau_meme_pipeline.text import fold

DEFAULT_LIMIT = 50
MAX_CANDIDATES = 3
PAGE_SIZE = 100  # the admin API's maximum `size`
QUERY_SUFFIX = "meme"
BRAVE_IMAGES = "https://api.search.brave.com/res/v1/images/search"
BRAVE_COUNT = 10  # a few spare results: non-https ones are dropped before the first MAX_CANDIDATES are tried
REFUSED_STATUSES = frozenset({401, 403, 429})


class SearchRefused(Exception):
    """The search API refused the key or ran out of quota: the job stops, images attached so far stay."""


class AdminClient(Protocol):
    def list_elements(self, page: int, size: int) -> dict: ...

    def put_image(self, element_id: str, webp: bytes) -> dict: ...


def pick_elements(items: Sequence[Mapping], limit: int) -> list[Mapping]:
    """Active elements without an image, deepest first (they hold Vàng/Đỏ back - AC-TIER-04), then folded name."""
    picked = [e for e in items if e.get("state") == "active" and not e.get("image_key")]
    picked.sort(key=lambda e: (-int(e.get("depth") or 0), fold(str(e.get("name") or ""))))
    return picked[: max(limit, 0)]


def _catalog(admin: AdminClient) -> list[Mapping]:
    items: list[Mapping] = []
    page = 1
    while True:
        body = admin.list_elements(page, PAGE_SIZE)
        chunk = body.get("items") or []
        items.extend(chunk)
        if not chunk or len(items) >= int(body.get("total") or 0):
            return items
        page += 1


def run_art_search(
    admin: AdminClient,
    *,
    search: Callable[[str], list[str]],
    fetch: Callable[[str], bytes],
    limit: int = DEFAULT_LIMIT,
    dry_run: bool = False,
    log: Callable[..., None] = print,
) -> dict:
    picked = pick_elements(_catalog(admin), limit)
    attached: list[str] = []
    not_found: list[str] = []
    errors: dict[str, int] = {}
    planned: list[tuple[str, str]] = []
    for element in picked:
        eid, name = str(element["id"]), str(element["name"])
        try:
            urls = search(f"{name} {QUERY_SUFFIX}")
        except SearchRefused:
            raise
        except Exception as exc:  # the search adapter's boundary: one bad answer does not stop the job
            errors[type(exc).__name__] = errors.get(type(exc).__name__, 0) + 1
            urls = []
        webp = url = None
        for url in urls[:MAX_CANDIDATES]:
            try:
                webp = to_webp_256(fetch(url))
                break
            except Exception as exc:  # LinkRefused, not an image, decode limits: try the next result
                errors[type(exc).__name__] = errors.get(type(exc).__name__, 0) + 1
        if webp is None or url is None:  # url narrows the type; it is set whenever webp is
            not_found.append(eid)
            log(f"Không tìm được ảnh: {name}")
            continue
        if dry_run:
            planned.append((name, url))
            log(f"Sẽ gắn: {name} <- {url}")
            continue
        admin.put_image(eid, webp)
        attached.append(eid)
        log(f"Đã gắn ảnh: {name}")
    return {
        "considered": len(picked),
        "attached": attached,
        "not_found": not_found,
        "errors": errors,
        "planned": planned,
    }


def parse_brave_images(payload: Mapping) -> list[str]:
    """`properties.url` of each result in rank order, https only (fetch_link refuses anything else anyway)."""
    urls = []
    for result in payload.get("results") or []:
        url = ((result or {}).get("properties") or {}).get("url") if isinstance(result, Mapping) else None
        if isinstance(url, str) and url.startswith("https://"):
            urls.append(url)
    return urls


class BraveImageSearch:
    """Network adapter: Brave Search image API (open question 104), key from the GitHub Secret IMAGE_SEARCH_API_KEY.
    safesearch=strict drops explicit images; nothing filters real faces or copyright (ADR 0024)."""

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.tls, self.host, self.port, self.path = parse_api_url(BRAVE_IMAGES)

    def __call__(self, query: str) -> list[str]:
        params = urlencode({"q": query, "count": BRAVE_COUNT, "safesearch": "strict"})
        conn = open_connection(self.tls, self.host, self.port)
        try:
            conn.request(
                "GET",
                f"{self.path}?{params}",
                headers={
                    "Accept": "application/json",
                    "X-Subscription-Token": self.api_key,
                    "User-Agent": "lau-meme-pipeline",
                },
            )
            res = conn.getresponse()
            raw = res.read()
        finally:
            conn.close()
        if res.status in REFUSED_STATUSES:
            raise SearchRefused(f"API tìm ảnh trả HTTP {res.status}")
        if res.status != 200:
            raise RuntimeError(f"API tìm ảnh trả HTTP {res.status}")
        return parse_brave_images(json.loads(raw or b"{}"))


class HttpAdminClient:
    """Network adapter: the admin host's `/api/admin/*` (ADR 0008) with ADMIN_TOKEN (GitHub Secret)."""

    def __init__(self, base_url: str, token: str) -> None:
        self.tls, self.host, self.port, self.prefix = parse_api_url(base_url)
        self.headers = {"Authorization": f"Bearer {token}", "User-Agent": "lau-meme-pipeline"}

    def _send(self, method: str, path: str, body: bytes | None, headers: Mapping[str, str]) -> dict:
        conn = open_connection(self.tls, self.host, self.port)
        try:
            conn.request(method, self.prefix + path, body=body, headers={**self.headers, **headers})
            res = conn.getresponse()
            raw = res.read()
        finally:
            conn.close()
        if not 200 <= res.status < 300:
            raise RuntimeError(f"{method} {path.split('?')[0]}: HTTP {res.status}")
        return json.loads(raw or b"{}")

    def list_elements(self, page: int, size: int) -> dict:
        return self._send("GET", f"/api/admin/elements?state=active&page={int(page)}&size={int(size)}", None, {})

    def put_image(self, element_id: str, webp: bytes) -> dict:
        return self._send("PUT", f"/api/admin/elements/{element_id}/image", bytes(webp), {"Content-Type": "image/webp"})


def fetch_image(url: str) -> bytes:
    """Same safe fetch as AC-ART-14: https only, public addresses, 1 MB, one 15 s budget for every hop."""
    deadline = time.monotonic() + LINK_TIMEOUT_SECONDS
    return fetch_link(url, http=lambda u: https_get(u, deadline=deadline), resolve=resolve_host)


def summary_lines(result: Mapping, *, dry_run: bool) -> list[str]:
    lines = [
        f"## Tìm ảnh cho meme{' (chạy thử)' if dry_run else ''}",
        f"- Xét: {result['considered']}",
        f"- {'Sẽ gắn' if dry_run else 'Gắn được'}: {len(result['planned'] if dry_run else result['attached'])}",
        f"- Không tìm được: {len(result['not_found'])}",
    ]
    lines += [f"- Lỗi tải `{kind}`: {count}" for kind, count in sorted(result["errors"].items())]
    return lines


def main(argv: list[str], *, admin: AdminClient | None = None, search=None, fetch=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m lau_meme_pipeline.art_search", description="Tìm ảnh cho meme")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="số meme tối đa")
    parser.add_argument("--dry-run", action="store_true", help="chỉ in tên và link, không gắn ảnh")
    args = parser.parse_args(argv)
    if admin is None or search is None:
        names = ("ADMIN_API_BASE_URL", "ADMIN_TOKEN", "IMAGE_SEARCH_API_KEY")
        missing = [n for n in names if not os.environ.get(n)]
        if missing:
            print(f"Thiếu cấu hình: {', '.join(missing)}", file=sys.stderr)
            return 2
        admin = admin or HttpAdminClient(os.environ["ADMIN_API_BASE_URL"], os.environ["ADMIN_TOKEN"])
        search = search or BraveImageSearch(os.environ["IMAGE_SEARCH_API_KEY"])
    try:
        result = run_art_search(
            admin, search=search, fetch=fetch or fetch_image, limit=args.limit, dry_run=args.dry_run
        )
    except SearchRefused as exc:
        print(f"Dừng: {exc}. Ảnh đã gắn trước đó giữ nguyên.", file=sys.stderr)
        return 1
    print("\n".join(summary_lines(result, dry_run=args.dry_run)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
