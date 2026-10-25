"""Fetching the image link an admin chose as an element's picture (AC-ART-14, ADR 0018).

The url comes from a player's proposal, so every hop is checked before it is requested: https only, and the host must
resolve to global unicast addresses (no loopback, private, link-local, metadata or reserved targets). `fetch_link` is
pure given its `http` and `resolve`; `https_get` and `resolve_host` are the network side, isolated here and mocked in
tests. The url is never sent to an LLM, logged, or written to the batch report.
"""

import http.client
import ipaddress
import socket
import ssl
import time
from collections.abc import Callable, Sequence
from urllib.parse import urljoin, urlsplit

MAX_LINK_BYTES = 1_048_576
MAX_REDIRECTS = 3
TIMEOUT_SECONDS = 15  # for the whole fetch, every hop and every body chunk included
CHUNK_BYTES = 65_536
# IPv6 prefixes that embed an IPv4 address (NAT64, 6to4): Python calls them global, the IPv4 inside may not be
EMBEDDED_V4 = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
    ipaddress.ip_network("2002::/16"),
)
REDIRECTS = frozenset({301, 302, 303, 307, 308})


class LinkRefused(Exception):
    """The link was not fetched or gave no usable body; the element keeps its emoji and the next batch retries."""


def _public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if any(ip in net for net in EMBEDDED_V4):
            return False
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def check_target(url: str, addresses: Sequence[str]) -> None:
    """Raise LinkRefused unless `url` is https on port 443 with a host and every address it resolves to is public."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise LinkRefused("link không phải https")
    try:
        port = parts.port
    except ValueError:
        port = -1
    if port not in (None, 443):  # no probing other services on a public host
        raise LinkRefused("link không dùng cổng 443")
    if not addresses or not all(_public(a) for a in addresses):
        raise LinkRefused("link trỏ vào địa chỉ không công khai")


def fetch_link(
    url: str,
    *,
    http: Callable[[str], tuple[int, str | None, bytes]],
    resolve: Callable[[str], Sequence[str]],
) -> bytes:
    """GET `url`, following at most MAX_REDIRECTS redirects, each hop checked before it is requested."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        host = urlsplit(current).hostname
        check_target(current, resolve(host) if host else ())
        status, location, body = http(current)
        if status == 200:
            if len(body) > MAX_LINK_BYTES:
                raise LinkRefused("ảnh quá 1 MB")
            return body
        if status not in REDIRECTS:
            raise LinkRefused(f"trạng thái {status}")
        if not location:
            raise LinkRefused("chuyển hướng không có Location")
        current = urljoin(current, location)
    raise LinkRefused("chuyển hướng quá nhiều lần")


def read_body(read: Callable[[int], bytes], *, deadline: float, clock: Callable[[], float]) -> bytes:
    """Read in chunks up to MAX_LINK_BYTES + 1 bytes; a server that trickles past `deadline` is refused."""
    body = b""
    while len(body) <= MAX_LINK_BYTES:
        if clock() > deadline:
            raise LinkRefused("hết giờ")
        chunk = read(min(CHUNK_BYTES, MAX_LINK_BYTES + 1 - len(body)))
        if not chunk:
            break
        body += chunk
    return body


def resolve_host(host: str) -> list[str]:
    """Every address `host` resolves to (all must be public, so a mixed answer is refused)."""
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        return []
    return sorted({str(info[4][0]) for info in infos})


class _PinnedHttps(http.client.HTTPSConnection):
    """Connects to the address that was checked, not a fresh lookup (no DNS rebinding); TLS still verifies `host`."""

    def __init__(self, host: str, port: int, address: str, context: ssl.SSLContext, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout, context=context)
        self.address = address
        self.tls = context

    def connect(self) -> None:
        sock = socket.create_connection((self.address, self.port), self.timeout)
        self.sock = self.tls.wrap_socket(sock, server_hostname=self.host)


def https_get(url: str, *, deadline: float) -> tuple[int, str | None, bytes]:
    """One request, no redirect following, body read up to MAX_LINK_BYTES + 1 bytes before `deadline` (monotonic)."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise LinkRefused("hết giờ")
    parts = urlsplit(url)
    host = parts.hostname or ""
    addresses = resolve_host(host)
    check_target(url, addresses)
    conn = _PinnedHttps(host, 443, addresses[0], ssl.create_default_context(), timeout=left)
    try:
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        conn.request("GET", path, headers={"User-Agent": "lau-meme-pipeline", "Accept": "image/*"})
        response = conn.getresponse()
        body = read_body(response.read, deadline=deadline, clock=time.monotonic)
        return response.status, response.getheader("Location"), body
    except (OSError, http.client.HTTPException) as exc:
        raise LinkRefused(type(exc).__name__) from None
    finally:
        conn.close()
