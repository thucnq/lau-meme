"""Crawl step of the full batch (AC-PIPE-03/04): one adapter per source, concepts only.

An adapter returns names, quotes and source passages - never images or videos - and goes through `Http`, which
reads robots.txt before any page and refuses media. One failing source never fails the batch. There is no
Facebook or TikTok adapter (BRD 6).
"""

import http.client
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from html import unescape
from urllib.parse import quote, urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as ET  # crawled XML is untrusted (entity expansion)

USER_AGENT = "lau-meme-pipeline"
MAX_CONTEXT = 500
MEDIA = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov")
TEXT_TYPES = ("text/", "application/json", "application/rss+xml", "application/atom+xml", "application/xml")
GET_TIMEOUT_SECONDS = 20
MAX_BODY_BYTES = 2 * 1024 * 1024  # a feed or API page; anything bigger is cut, never a media file


@dataclass(frozen=True)
class RawConcept:
    name: str
    quote: str
    context: str
    source_url: str
    source_name: str


class RobotsDenied(Exception):
    """robots.txt of the host forbids this path for our user agent."""


class NotText(Exception):
    """The URL or the response is media (image/video) or not a text format."""


class Redirect(Exception):
    """A 3xx answer: `Http` follows it itself, so robots.txt is checked on every hop."""

    def __init__(self, location: str) -> None:
        super().__init__("redirect")
        self.location = location


class HttpStatus(Exception):
    """Non-2xx answer; the network `get` raises it so robots.txt can tell "absent" from "failing"."""

    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


ROBOTS_ABSENT = (404, 410)  # RFC 9309 §2.3.1.3: only an unavailable robots.txt allows everything
MAX_REDIRECTS = 3


class Http:
    """Polite text-only fetching: `get(url) -> (content_type, body)` is the network adapter (a fake in tests)."""

    def __init__(self, get: Callable[[str], tuple[str, str]]) -> None:
        self._get = get
        self._robots: dict[str, RobotFileParser] = {}

    def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        base = f"{parts.scheme}://{parts.netloc}"
        parser = self._robots.get(base)
        if parser is None:
            parser = RobotFileParser()
            try:
                _, body = self._follow(base + "/robots.txt", check_robots=False)
                parser.parse(body.splitlines())
            except HttpStatus as exc:
                parser.parse([] if exc.status in ROBOTS_ABSENT else ["User-agent: *", "Disallow: /"])
            except Exception:  # unreachable (5xx, timeout…): RFC 9309 says assume complete disallow
                parser.parse(["User-agent: *", "Disallow: /"])
            self._robots[base] = parser
        return parser.can_fetch(USER_AGENT, url)

    def _follow(self, url: str, *, check_robots: bool) -> tuple[str, str]:
        """GET with up to MAX_REDIRECTS https hops; every hop is checked like the first (media path, robots.txt).
        Exceptions carry no URL: a query may hold an API key (crawl errors are reported by type only anyway)."""
        for _ in range(MAX_REDIRECTS + 1):
            if urlsplit(url).scheme != "https":
                raise NotText()
            if urlsplit(url).path.lower().endswith(MEDIA):
                raise NotText()
            if check_robots and not self._allowed(url):
                raise RobotsDenied()
            try:
                return self._get(url)
            except Redirect as hop:
                url = urljoin(url, hop.location)
        raise HttpStatus(310)  # too many redirects

    def text(self, url: str) -> str:
        content_type, body = self._follow(url, check_robots=True)
        if not content_type.lower().startswith(TEXT_TYPES):
            raise NotText()
        return body


def _clip(text: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text or ""))).strip()[:MAX_CONTEXT]


def _child(item: Element, *names: str) -> str:
    for c in item:
        if c.tag.rsplit("}", 1)[-1] in names:
            return c.text or c.get("href") or ""
    return ""


def _rss(body: str, source_name: str) -> list[RawConcept]:
    """RSS 2.0 items or Atom entries: title, description/summary, link. Enclosures and media are ignored."""
    root = ET.fromstring(body)
    out: list[RawConcept] = []
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1] not in ("item", "entry"):
            continue
        name = _clip(_child(item, "title"))
        if name:
            context = _clip(_child(item, "description", "summary", "content"))
            out.append(RawConcept(name, "", context, _child(item, "link"), source_name))
    return out


class RssAdapter:
    name = "RSS"

    def __init__(self, feeds: Sequence[str]) -> None:
        self.feeds = list(feeds)

    def fetch(self, http: Http) -> list[RawConcept]:
        return [c for url in self.feeds for c in _rss(http.text(url), self.name)]


class KnowYourMemeAdapter:
    name = "Know Your Meme"
    url = "https://knowyourmeme.com/memes.rss"

    def fetch(self, http: Http) -> list[RawConcept]:
        return _rss(http.text(self.url), self.name)


class GoogleTrendsVnAdapter:
    name = "Google Trends VN"
    url = "https://trends.google.com/trending/rss?geo=VN"

    def fetch(self, http: Http) -> list[RawConcept]:
        return _rss(http.text(self.url), self.name)


class RedditAdapter:
    name = "Reddit"

    def __init__(self, subreddits: Sequence[str]) -> None:
        self.subreddits = list(subreddits)

    def fetch(self, http: Http) -> list[RawConcept]:
        out: list[RawConcept] = []
        for sub in self.subreddits:
            data = json.loads(http.text(f"https://www.reddit.com/r/{quote(sub)}/top.json?t=day&limit=25"))
            for child in data.get("data", {}).get("children", []):
                post = child.get("data", {})
                title = _clip(post.get("title", ""))
                if title:
                    link = "https://www.reddit.com" + post.get("permalink", "")
                    out.append(RawConcept(title, "", _clip(post.get("selftext", "")), link, self.name))
        return out


class YoutubeTrendingAdapter:
    name = "YouTube"

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    def fetch(self, http: Http) -> list[RawConcept]:
        url = (
            "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=VN"
            f"&maxResults=25&key={quote(self.api_key)}"
        )
        data = json.loads(http.text(url))
        out: list[RawConcept] = []
        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            title = _clip(snippet.get("title", ""))
            if title:
                link = f"https://www.youtube.com/watch?v={item.get('id', '')}"
                out.append(RawConcept(title, "", _clip(snippet.get("description", "")), link, self.name))
        return out


def default_adapters(env: Mapping[str, str]) -> list:
    """The five sources of BRD 6. Subreddits and RSS feeds come from configuration (open question #25)."""
    subs = [s for s in env.get("REDDIT_SUBREDDITS", "").split(",") if s.strip()]
    feeds = [f for f in env.get("RSS_FEEDS", "").split(",") if f.strip()]
    return [
        RedditAdapter(subs),
        KnowYourMemeAdapter(),
        GoogleTrendsVnAdapter(),
        YoutubeTrendingAdapter(env.get("YOUTUBE_API_KEY", "")),
        RssAdapter(feeds),
    ]


def http_get(url: str) -> tuple[str, str]:
    """Network adapter of `Http`, one hop: https GET with a timeout. The body is read only for a 2xx text answer and
    only up to MAX_BODY_BYTES, so no media file is ever downloaded (AC-PIPE-04); 3xx raises Redirect, other non-2xx
    HttpStatus (robots.txt tells "absent" from "failing" by it)."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("chỉ crawl qua https")
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    conn = http.client.HTTPSConnection(parts.hostname, parts.port, timeout=GET_TIMEOUT_SECONDS)
    try:
        conn.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": "text/*, application/*"})
        res = conn.getresponse()
        if res.status in (301, 302, 303, 307, 308):
            location = res.getheader("Location")
            if not location:
                raise HttpStatus(res.status)
            raise Redirect(urljoin(url, location))
        if not 200 <= res.status < 300:
            raise HttpStatus(res.status)
        content_type = res.getheader("Content-Type", "") or ""
        if not content_type.lower().startswith(TEXT_TYPES):
            raise NotText()
        raw = res.read(MAX_BODY_BYTES)
    finally:
        conn.close()
    match = re.search(r"charset=([\w-]+)", content_type)
    charset = match.group(1) if match else "utf-8"
    try:
        return content_type, raw.decode(charset, errors="replace")
    except LookupError:  # unknown charset name in the header
        return content_type, raw.decode("utf-8", errors="replace")


@dataclass
class CrawlResult:
    concepts: list[RawConcept] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)


def crawl(adapters: Sequence, http: Http) -> CrawlResult:
    """Every adapter runs; a failing one is reported by error type only (its message may hold a URL or key)."""
    result = CrawlResult()
    for adapter in adapters:
        try:
            result.concepts.extend(adapter.fetch(http))
        except Exception as exc:
            result.errors.append({"source": adapter.name, "error": type(exc).__name__})
    return result


def crawl_report_line(result: CrawlResult) -> str:
    if not result.errors:
        return "Lỗi nguồn: không có"
    return ", ".join(f"{e['source']}: lỗi {e['error']}" for e in result.errors)
