"""Crawl step of the full batch (AC-PIPE-03/04): one adapter per source, concepts only.

An adapter returns names, quotes and source passages - never images or videos - and goes through `Http`, which
reads robots.txt before any page and refuses media. One failing source never fails the batch. There is no
Facebook or TikTok adapter (BRD 6); Threads only through Meta's official API (AC-PIPE-17).
"""

import http.client
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from html import unescape
from html.parser import HTMLParser
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


class PageUnreadable(Exception):
    """The page answered but none of its articles could be read (its HTML changed, AC-PIPE-15)."""

    report = "không đọc được trang"


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


class _TuoiTreList(HTMLParser):
    """Articles of a Tuổi Trẻ category page: `box-category-item` blocks, each with a title link
    (`box-category-link-title`) and a summary (`box-category-sapo`). Thumbnails and other links are never read."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[dict[str, str]] = []
        self._field: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if "box-category-item" in classes:
            self.items.append({"title": "", "href": "", "sapo": ""})
        elif self.items and "box-category-link-title" in classes:
            self.items[-1]["href"] = a.get("href") or ""
            self._field = "title"
        elif self.items and "box-category-sapo" in classes:
            self._field = "sapo"

    def handle_endtag(self, tag: str) -> None:
        if tag in ("a", "p", "h3", "div"):
            self._field = None

    def handle_data(self, data: str) -> None:
        if self._field and self.items:
            self.items[-1][self._field] += data


class TuoiTreAdapter:
    """Category page 1 of tuoitre.vn/meme.html only (AC-PIPE-15): no article page, no next page, no image."""

    name = "Tuổi Trẻ"
    url = "https://tuoitre.vn/meme.html"

    def fetch(self, http: Http) -> list[RawConcept]:
        page = _TuoiTreList()
        page.feed(http.text(self.url))
        out: list[RawConcept] = []
        for item in page.items:
            name, href = _clip(item["title"]), item["href"].strip()
            if name and href:
                out.append(RawConcept(name, "", _clip(item["sapo"]), urljoin(self.url, href), self.name))
        if not out:
            raise PageUnreadable()
        return out


THREADS_API = "https://graph.threads.net/v1.0/keyword_search"
THREADS_MAX_POSTS = 50
MAX_THREADS_NAME = 100
# The permalink names the poster (`/@user/post/<code>`); the short form `/t/<code>` opens the same post without it.
_THREADS_USER_LINK = re.compile(r"^https://(?:www\.)?threads\.(?:net|com)/@[^/]+/post/([\w-]+)")


def _threads_link(permalink: str) -> str:
    match = _THREADS_USER_LINK.match(permalink)
    if match:
        return f"https://www.threads.net/t/{match.group(1)}"
    return "" if "@" in permalink else permalink


def _threads_name(text: str) -> str:
    line = _clip(text.strip().splitlines()[0] if text.strip() else "")
    if len(line) <= MAX_THREADS_NAME:
        return line
    return line[:MAX_THREADS_NAME].rsplit(" ", 1)[0] or line[:MAX_THREADS_NAME]


class ThreadsAdapter:
    """Keyword search of the official Threads API (AC-PIPE-17). Only text and permalink are asked for and kept: no
    username, avatar, profile link or media. Without a token or keywords it collects nothing (a config warning)."""

    name = "Threads"

    def __init__(self, access_token: str | None, keywords: Sequence[str]) -> None:
        self.access_token = access_token or ""
        self.keywords = [k.strip() for k in keywords if k and k.strip()]

    @property
    def missing_config(self) -> bool:
        return not self.access_token or not self.keywords

    def fetch(self, http: Http) -> list[RawConcept]:
        if self.missing_config:
            return []
        out: list[RawConcept] = []
        seen: set[str] = set()
        for keyword in self.keywords:
            if len(out) >= THREADS_MAX_POSTS:
                break
            url = (
                f"{THREADS_API}?q={quote(keyword)}&search_type=TOP&fields=id,text,permalink"
                f"&limit={THREADS_MAX_POSTS}&access_token={quote(self.access_token)}"
            )
            for post in json.loads(http.text(url)).get("data", []):
                text = post.get("text") or ""
                name, link = _threads_name(text), _threads_link(post.get("permalink") or "")
                if not name or post.get("id") in seen:
                    continue
                seen.add(post.get("id"))
                out.append(RawConcept(name, _clip(text), "", link, self.name))
                if len(out) >= THREADS_MAX_POSTS:
                    break
        return out


def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def default_adapters(env: Mapping[str, str]) -> list:
    """The sources of BRD 6 plus Tuổi Trẻ and Threads (AC-PIPE-15/17). Subreddits, RSS feeds and Threads keywords
    come from configuration (open question #25)."""
    return [
        RedditAdapter(_csv(env.get("REDDIT_SUBREDDITS", ""))),
        KnowYourMemeAdapter(),
        GoogleTrendsVnAdapter(),
        YoutubeTrendingAdapter(env.get("YOUTUBE_API_KEY", "")),
        RssAdapter(_csv(env.get("RSS_FEEDS", ""))),
        TuoiTreAdapter(),
        ThreadsAdapter(env.get("THREADS_ACCESS_TOKEN", ""), _csv(env.get("THREADS_KEYWORDS", ""))),
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
    # One entry per adapter, in order (AC-ADMIN-11): concepts collected, or the error and `concepts` None.
    sources: list[dict] = field(default_factory=list)
    unconfigured: list[str] = field(default_factory=list)


def crawl(adapters: Sequence, http: Http) -> CrawlResult:
    """Every adapter runs; a failing one is reported by error type only (its message may hold a URL or key)."""
    result = CrawlResult()
    for adapter in adapters:
        if getattr(adapter, "missing_config", False):
            result.unconfigured.append(adapter.name)
        try:
            found = adapter.fetch(http)
        except Exception as exc:
            error = getattr(exc, "report", None) or type(exc).__name__
            result.errors.append({"source": adapter.name, "error": error})
            result.sources.append({"source": adapter.name, "concepts": None, "error": error})
            continue
        result.concepts.extend(found)
        result.sources.append({"source": adapter.name, "concepts": len(found), "error": None})
    return result


def crawl_report_line(result: CrawlResult) -> str:
    if not result.errors:
        return "Lỗi nguồn: không có"
    return ", ".join(source_error_text(e) for e in result.errors)


def source_error_text(error: Mapping[str, str]) -> str:
    """An exception type reads "Reddit: lỗi RobotsDenied"; a described error as is ("Tuổi Trẻ: không đọc được
    trang", AC-PIPE-15)."""
    text = str(error.get("error", ""))
    return f"{error.get('source')}: {text}" if " " in text else f"{error.get('source')}: lỗi {text}"
