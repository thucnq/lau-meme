"""Acceptance tests for docs/acceptance/pipe.md, phase 2: AC-PIPE-03, 04, 05, 06, 07, 08, 09, 10, 12.

Expected modules (pure; no network, clock, randomness or sleeping; HTTP and LLM steps are injected fakes):

    lau_meme_pipeline.crawl      RawConcept, RobotsDenied, NotText, Http, RedditAdapter, KnowYourMemeAdapter,
                                 GoogleTrendsVnAdapter, YoutubeTrendingAdapter, RssAdapter, default_adapters,
                                 crawl, CrawlResult, crawl_report_line
    lau_meme_pipeline.dedupe     dedupe_key, dedupe, DedupeResult
    lau_meme_pipeline.linking    Graph, validate_links, LinkResult, bfs_depths, needs_supplement
    lau_meme_pipeline.judge      judge, JudgeResult
    lau_meme_pipeline.linkqueue  MAX_ATTEMPTS, next_queue, QueueResult, batch_order
    lau_meme_pipeline.llm        RateLimited, QuotaExhausted, LlmError, call_in_batches, BatchCalls, CachedLlm
    lau_meme_pipeline.full       run_full, FullOutcome   (store shape: ADR 0009 `store_json`)

AC-PIPE-06 depth: the coordinator ruled that bfs_depths uses the core's BFS rounds (AC-SEED-06): a result is at
level max(depth A, depth B) + 1, NOT min + 1 as the AC text says (reported as an ambiguity).
Imports happen inside the tests so a missing module fails at runtime, not at collection.
"""

import dataclasses
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
BATCH_AT = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def raw(name="Meme Thử", quote="", context="", url="https://example.com/a", source="Fake"):
    from lau_meme_pipeline.crawl import RawConcept

    return RawConcept(name=name, quote=quote, context=context, source_url=url, source_name=source)


# ================================================================ crawl helpers


class FakeGet:
    """get(url) -> (content_type, body). `pages` maps url -> (content_type, body) or an exception instance.
    robots.txt of a host defaults to an empty (allow all) file; an exception instance is raised instead."""

    def __init__(self, pages=None, robots=None):
        self.pages = dict(pages or {})
        self.robots = robots or {}  # host -> robots text
        self.requested: list[str] = []

    def __call__(self, url):
        self.requested.append(url)
        if url.endswith("/robots.txt"):
            host = url.split("/")[2]
            robots = self.robots.get(host, "")
            if isinstance(robots, Exception):
                raise robots
            return ("text/plain", robots)
        page = self.pages[url]
        if isinstance(page, Exception):
            raise page
        return page


def make_http(pages=None, robots=None):
    from lau_meme_pipeline.crawl import Http

    get = FakeGet(pages, robots)
    return Http(get), get


MEDIA_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov")


def requested_media(get: FakeGet) -> list[str]:
    return [u for u in get.requested if u.lower().split("?")[0].endswith(MEDIA_EXT)]


REDDIT_URL = "https://www.reddit.com/r/vietnam/top.json?t=day&limit=25"
KYM_URL = "https://knowyourmeme.com/memes.rss"
GT_URL = "https://trends.google.com/trending/rss?geo=VN"
YT_URL = (
    "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=VN&maxResults=25&key=KEY123"
)
RSS_URL = "https://blog.example.com/feed.xml"
ATOM_URL = "https://news.example.com/atom.xml"

REDDIT_BODY = json.dumps(
    {
        "data": {
            "children": [
                {
                    "data": {
                        "title": "Còn Cái Nịt",
                        "selftext": "Z" * 800,
                        "url": "https://i.redd.it/abc.jpg",
                        "thumbnail": "https://b.thumbs.redditmedia.com/t1.jpg",
                        "permalink": "/r/vietnam/comments/1/con_cai_nit/",
                        "is_video": False,
                    }
                },
                {
                    "data": {
                        "title": "Clip Hot",
                        "selftext": "ngắn",
                        "url": "https://v.redd.it/clip.mp4",
                        "thumbnail": "https://b.thumbs.redditmedia.com/t2.png",
                        "permalink": "/r/vietnam/comments/2/clip_hot/",
                        "is_video": True,
                    }
                },
            ]
        }
    }
)

KYM_BODY = """<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>KYM</title>
<item><title>Distracted Boyfriend</title><link>https://knowyourmeme.com/memes/distracted-boyfriend</link>
<description>Stock photo meme</description>
<enclosure url="https://i.kym-cdn.com/photos/images/original/1.jpg" type="image/jpeg" length="1"/>
<media:thumbnail url="https://i.kym-cdn.com/photos/images/thumb/2.png"/></item>
<item><title>Rickroll</title><link>https://knowyourmeme.com/memes/rickroll</link>
<description>Bait and switch</description>
<enclosure url="https://i.kym-cdn.com/videos/3.mp4" type="video/mp4" length="1"/></item>
</channel></rss>"""

GT_BODY = """<?xml version="1.0"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel>
<item><title>giá vàng</title><ht:approx_traffic>200+</ht:approx_traffic>
<ht:picture>https://t0.gstatic.com/images?q=1.jpg</ht:picture>
<link>https://trends.google.com/trending/rss?geo=VN&amp;id=1</link></item>
</channel></rss>"""

YT_BODY = json.dumps(
    {
        "items": [
            {
                "id": "vid123",
                "snippet": {
                    "title": "Video Trend",
                    "description": "D" * 800,
                    "thumbnails": {"default": {"url": "https://i.ytimg.com/vi/vid123/default.jpg"}},
                },
            }
        ]
    }
)

RSS_BODY = """<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title>
<item><title>Meme Blog</title><link>https://blog.example.com/p/1</link><description>Mô tả</description>
<enclosure url="https://blog.example.com/img/1.webp" type="image/webp" length="1"/></item>
</channel></rss>"""

ATOM_BODY = """<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title>
<entry><title>Meme Atom</title><link href="https://news.example.com/p/9"/><summary>Tóm tắt</summary></entry>
</feed>"""

ALL_PAGES = {
    REDDIT_URL: ("application/json", REDDIT_BODY),
    KYM_URL: ("application/rss+xml", KYM_BODY),
    GT_URL: ("application/xml", GT_BODY),
    YT_URL: ("application/json; charset=utf-8", YT_BODY),
    RSS_URL: ("text/xml", RSS_BODY),
    ATOM_URL: ("application/atom+xml", ATOM_BODY),
}


class FakeAdapter:
    def __init__(self, name, concepts=(), error=None):
        self.name = name
        self._concepts = list(concepts)
        self._error = error
        self.calls = 0

    def fetch(self, http):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return list(self._concepts)


# ================================================================ AC-PIPE-03


def test_ac_pipe_03_mot_nguon_loi_khong_lam_hong_ca_dot():
    """AC-PIPE-03: Reddit hết thời gian; 4 adapter còn lại vẫn cho khái niệm, báo cáo ghi "Reddit: lỗi <loại>"."""
    from lau_meme_pipeline.crawl import crawl, crawl_report_line

    http, _ = make_http()
    reddit = FakeAdapter("Reddit", error=TimeoutError("timed out"))
    kym = FakeAdapter("Know Your Meme", [raw("K1", source="Know Your Meme")])
    gt = FakeAdapter(
        "Google Trends VN",
        [raw("G1", source="Google Trends VN"), raw("G2", source="Google Trends VN")],
    )
    yt = FakeAdapter("YouTube", [raw("Y1", source="YouTube")])
    rss = FakeAdapter("RSS", [raw("R1", source="RSS")])

    result = crawl([reddit, kym, gt, yt, rss], http)

    assert [c.name for c in result.concepts] == ["K1", "G1", "G2", "Y1", "R1"]
    assert result.errors == [{"source": "Reddit", "error": "TimeoutError"}]
    assert all(a.calls == 1 for a in (reddit, kym, gt, yt, rss))
    assert "Reddit: lỗi TimeoutError" in crawl_report_line(result)


def test_ac_pipe_03_khong_loi_bao_cao_khong_co_loi_nguon():
    """AC-PIPE-03: không nguồn nào lỗi thì dòng báo cáo là "Lỗi nguồn: không có"."""
    from lau_meme_pipeline.crawl import crawl, crawl_report_line

    http, _ = make_http()
    result = crawl([FakeAdapter("RSS", [raw("R1")])], http)
    assert result.errors == []
    assert crawl_report_line(result) == "Lỗi nguồn: không có"


def test_ac_pipe_03_nhieu_nguon_loi_deu_duoc_ghi():
    """AC-PIPE-03: nhiều nguồn lỗi cùng lúc, mỗi nguồn một mục lỗi theo loại ngoại lệ, nguồn tốt vẫn chạy."""
    from lau_meme_pipeline.crawl import crawl, crawl_report_line

    http, _ = make_http()
    result = crawl(
        [
            FakeAdapter("Reddit", error=TimeoutError()),
            FakeAdapter("YouTube", error=ValueError("bad json")),
            FakeAdapter("RSS", [raw("R1")]),
        ],
        http,
    )
    assert [c.name for c in result.concepts] == ["R1"]
    assert result.errors == [
        {"source": "Reddit", "error": "TimeoutError"},
        {"source": "YouTube", "error": "ValueError"},
    ]
    line = crawl_report_line(result)
    assert "Reddit: lỗi TimeoutError" in line
    assert "YouTube: lỗi ValueError" in line


def test_ac_pipe_03_robots_cam_la_loi_nguon_khong_lam_hong_dot():
    """AC-PIPE-03: adapter bị robots.txt cấm được ghi là lỗi RobotsDenied của nguồn đó, nguồn khác vẫn chạy."""
    from lau_meme_pipeline.crawl import KnowYourMemeAdapter, RedditAdapter, crawl

    http, get = make_http(ALL_PAGES, robots={"www.reddit.com": "User-agent: *\nDisallow: /r/"})
    result = crawl([RedditAdapter(["vietnam"]), KnowYourMemeAdapter()], http)
    assert result.errors == [{"source": "Reddit", "error": "RobotsDenied"}]
    assert [c.name for c in result.concepts] == ["Distracted Boyfriend", "Rickroll"]
    assert REDDIT_URL not in get.requested


@pytest.mark.parametrize(
    ("failure", "allowed"),
    [(404, True), (410, True), (500, False), (503, False), (401, False), (TimeoutError("hết giờ"), False)],
    ids=["404", "410", "500", "503", "401", "timeout"],
)
def test_ac_pipe_03_robots_khong_co_thi_cho_phep_loi_thi_cam(failure, allowed):
    """AC-PIPE-03: robots.txt 404/410 ⇒ không cấm gì; lỗi máy chủ, cấm truy cập hay hết giờ ⇒ coi như cấm hết
    (RFC 9309), nguồn đó báo RobotsDenied và trang không bị tải."""
    from lau_meme_pipeline.crawl import HttpStatus, RedditAdapter, crawl

    error = HttpStatus(failure) if isinstance(failure, int) else failure
    http, get = make_http(ALL_PAGES, robots={"www.reddit.com": error})
    result = crawl([RedditAdapter(["vietnam"])], http)
    if allowed:
        assert result.errors == []
        assert REDDIT_URL in get.requested
    else:
        assert result.errors == [{"source": "Reddit", "error": "RobotsDenied"}]
        assert REDDIT_URL not in get.requested


# ================================================================ AC-PIPE-04


def test_ac_pipe_04_khai_niem_chi_gom_nam_truong():
    """AC-PIPE-04: RawConcept chỉ có tên, câu nói, ngữ cảnh, link nguồn, tên nguồn."""
    from lau_meme_pipeline.crawl import RawConcept

    assert [f.name for f in dataclasses.fields(RawConcept)] == [
        "name",
        "quote",
        "context",
        "source_url",
        "source_name",
    ]
    assert RawConcept.__dataclass_params__.frozen


def test_ac_pipe_04_reddit_bo_anh_video_va_cat_ngu_canh_500():
    """AC-PIPE-04: Reddit lấy tên = tiêu đề, ngữ cảnh ≤ 500 ký tự, không tải ảnh/video."""
    from lau_meme_pipeline.crawl import RedditAdapter

    http, get = make_http(ALL_PAGES)
    adapter = RedditAdapter(["vietnam"])
    assert adapter.name == "Reddit"
    concepts = adapter.fetch(http)

    assert [c.name for c in concepts] == ["Còn Cái Nịt", "Clip Hot"]
    assert 0 < len(concepts[0].context) <= 500
    assert concepts[1].context == "ngắn"
    assert all(c.source_name == "Reddit" for c in concepts)
    assert all(c.source_url and not c.source_url.lower().endswith(MEDIA_EXT) for c in concepts)
    assert requested_media(get) == []
    assert get.requested.count(REDDIT_URL) == 1


@pytest.mark.parametrize(
    ("adapter_factory", "url", "expected_names", "source"),
    [
        (lambda m: m.KnowYourMemeAdapter(), KYM_URL, ["Distracted Boyfriend", "Rickroll"], "Know Your Meme"),
        (lambda m: m.GoogleTrendsVnAdapter(), GT_URL, ["giá vàng"], "Google Trends VN"),
        (lambda m: m.YoutubeTrendingAdapter("KEY123"), YT_URL, ["Video Trend"], "YouTube"),
        (lambda m: m.RssAdapter([RSS_URL]), RSS_URL, ["Meme Blog"], "RSS"),
        (lambda m: m.RssAdapter([ATOM_URL]), ATOM_URL, ["Meme Atom"], "RSS"),
    ],
)
def test_ac_pipe_04_adapter_rss_json_khong_tai_anh_video(adapter_factory, url, expected_names, source):
    """AC-PIPE-04: mỗi adapter đọc đúng URL, chỉ thu khái niệm, không tải URL ảnh/video trong enclosure."""
    import lau_meme_pipeline.crawl as m

    http, get = make_http(ALL_PAGES)
    adapter = adapter_factory(m)
    assert adapter.name == source
    concepts = adapter.fetch(http)

    assert [c.name for c in concepts] == expected_names
    assert all(isinstance(c, m.RawConcept) for c in concepts)
    assert all(c.source_name == source for c in concepts)
    assert all(c.source_url and not c.source_url.lower().endswith(MEDIA_EXT) for c in concepts)
    assert requested_media(get) == []
    assert [u for u in get.requested if not u.endswith("/robots.txt")] == [url]


def test_ac_pipe_04_youtube_ngu_canh_toi_da_500():
    """AC-PIPE-04: YouTube lấy mô tả làm ngữ cảnh, tối đa 500 ký tự."""
    from lau_meme_pipeline.crawl import YoutubeTrendingAdapter

    http, _ = make_http(ALL_PAGES)
    (concept,) = YoutubeTrendingAdapter("KEY123").fetch(http)
    assert concept.name == "Video Trend"
    assert 0 < len(concept.context) <= 500
    assert "vid123" in concept.source_url


def test_ac_pipe_04_robots_cam_duong_dan_khong_duoc_truy_cap():
    """AC-PIPE-04: đường dẫn bị robots.txt cấm ném RobotsDenied, không được tải; robots tải một lần mỗi host."""
    from lau_meme_pipeline.crawl import RobotsDenied

    http, get = make_http(
        {"https://ex.com/public/a": ("text/html", "ok"), "https://ex.com/private/a": ("text/html", "no")},
        robots={"ex.com": "User-agent: *\nDisallow: /private"},
    )
    assert http.text("https://ex.com/public/a") == "ok"
    with pytest.raises(RobotsDenied):
        http.text("https://ex.com/private/a")
    assert "https://ex.com/private/a" not in get.requested
    assert get.requested.count("https://ex.com/robots.txt") == 1


def test_ac_pipe_04_robots_theo_user_agent_cua_pipeline():
    """AC-PIPE-04: luật robots riêng cho user-agent `lau-meme-pipeline` được áp dụng."""
    from lau_meme_pipeline.crawl import RobotsDenied

    robots = "User-agent: *\nAllow: /\n\nUser-agent: lau-meme-pipeline\nDisallow: /x\n"
    pages = {"https://ex.com/x/1": ("text/html", "no"), "https://ex.com/y": ("text/html", "ok")}
    http, get = make_http(pages, {"ex.com": robots})
    assert http.text("https://ex.com/y") == "ok"
    with pytest.raises(RobotsDenied):
        http.text("https://ex.com/x/1")
    assert "https://ex.com/x/1" not in get.requested


@pytest.mark.parametrize("ext", ["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm", "mov"])
def test_ac_pipe_04_duoi_anh_video_khong_duoc_tai(ext):
    """AC-PIPE-04: URL có đuôi ảnh/video ném NotText mà không tải."""
    from lau_meme_pipeline.crawl import NotText

    url = f"https://ex.com/media/file.{ext}"
    http, get = make_http({url: ("text/html", "x")})
    with pytest.raises(NotText):
        http.text(url)
    assert url not in get.requested


@pytest.mark.parametrize("content_type", ["image/png", "video/mp4", "application/octet-stream", "application/pdf"])
def test_ac_pipe_04_content_type_khong_phai_van_ban_bi_loai(content_type):
    """AC-PIPE-04: phản hồi có content-type không phải văn bản ném NotText."""
    from lau_meme_pipeline.crawl import NotText

    http, _ = make_http({"https://ex.com/a": (content_type, "\x89PNG")})
    with pytest.raises(NotText):
        http.text("https://ex.com/a")


@pytest.mark.parametrize(
    "content_type",
    [
        "text/html; charset=utf-8",
        "text/plain",
        "application/json",
        "application/rss+xml",
        "application/atom+xml",
        "application/xml",
    ],
)
def test_ac_pipe_04_content_type_van_ban_duoc_chap_nhan(content_type):
    """AC-PIPE-04: text/*, json, rss, atom, xml được đọc."""
    http, _ = make_http({"https://ex.com/a": (content_type, "nội dung")})
    assert http.text("https://ex.com/a") == "nội dung"


def test_ac_pipe_04_khong_co_adapter_facebook_tiktok():
    """AC-PIPE-04: default_adapters đúng 5 loại, không có Facebook hoặc TikTok."""
    from lau_meme_pipeline.crawl import (
        GoogleTrendsVnAdapter,
        KnowYourMemeAdapter,
        RedditAdapter,
        RssAdapter,
        YoutubeTrendingAdapter,
        default_adapters,
    )

    adapters = default_adapters({"YOUTUBE_API_KEY": "KEY123"})
    assert {type(a) for a in adapters} == {
        RedditAdapter,
        KnowYourMemeAdapter,
        GoogleTrendsVnAdapter,
        YoutubeTrendingAdapter,
        RssAdapter,
    }
    assert len(adapters) == 5
    for a in adapters:
        label = f"{a.name} {type(a).__name__}".lower()
        assert "facebook" not in label
        assert "tiktok" not in label


# ================================================================ AC-PIPE-05


def test_ac_pipe_05_dedupe_key_fold_bo_dau_cau():
    """AC-PIPE-05: dedupe_key bỏ dấu, chữ thường, bỏ dấu câu, gộp khoảng trắng."""
    from lau_meme_pipeline.dedupe import dedupe_key

    assert dedupe_key("CÒN CÁI NỊT!!") == "con cai nit"
    assert dedupe_key("con cai nit") == "con cai nit"
    assert dedupe_key("  Còn   Cái, Nịt?  ") == "con cai nit"


def test_ac_pipe_05_hai_khai_niem_dau_loai_khong_goi_llm_chi_gan_giong_gui_llm():
    """AC-PIPE-05: 2 khái niệm trùng chuỗi fold bị loại không LLM; chỉ "Còn mỗi cái nịt" gửi LLM, trùng thì loại."""
    from lau_meme_pipeline.dedupe import dedupe

    calls = []

    def ask_same(items):
        calls.append(items)
        return [True for _ in items]

    concepts = [raw("con cai nit"), raw("CÒN CÁI NỊT!!"), raw("Còn mỗi cái nịt")]
    result = dedupe(concepts, ["Còn Cái Nịt"], ask_same)

    assert calls == [[{"name": "Còn mỗi cái nịt", "existing": "Còn Cái Nịt"}]]
    assert result.kept == []
    assert result.dropped == {"con cai nit": "exact", "CÒN CÁI NỊT!!": "exact", "Còn mỗi cái nịt": "llm_same"}


def test_ac_pipe_05_llm_noi_khac_thi_giu():
    """AC-PIPE-05: LLM trả không trùng thì khái niệm gần giống được giữ."""
    from lau_meme_pipeline.dedupe import dedupe

    concepts = [raw("con cai nit"), raw("Còn mỗi cái nịt")]
    result = dedupe(concepts, ["Còn Cái Nịt"], lambda items: [False for _ in items])
    assert [c.name for c in result.kept] == ["Còn mỗi cái nịt"]
    assert result.dropped == {"con cai nit": "exact"}


def test_ac_pipe_05_khong_gan_giong_thi_khong_goi_llm():
    """AC-PIPE-05: khái niệm hoàn toàn khác không gửi LLM; không có gì để hỏi thì không gọi ask_same."""
    from lau_meme_pipeline.dedupe import dedupe

    def boom(items):
        raise AssertionError("ask_same must not be called")

    result = dedupe([raw("Stonks"), raw("Xyz Qwv")], ["Còn Cái Nịt"], boom)
    assert [c.name for c in result.kept] == ["Stonks", "Xyz Qwv"]
    assert result.dropped == {}


def test_ac_pipe_05_trung_trong_cung_danh_sach_giu_ban_dau():
    """AC-PIPE-05: trùng chuỗi fold với khái niệm đứng trước trong cùng lô thì loại, giữ bản đầu."""
    from lau_meme_pipeline.dedupe import dedupe

    first = raw("Aura Farming", url="https://a")
    second = raw("aura farming!!", url="https://b")
    result = dedupe([first, second], [], lambda items: [False for _ in items])
    assert result.kept == [first]
    assert result.dropped == {"aura farming!!": "exact"}


def test_ac_pipe_05_nhieu_gan_giong_gui_dung_mot_lan_goi_voi_ten_gan_nhat():
    """AC-PIPE-05: các khái niệm gần giống gửi trong ĐÚNG MỘT lời gọi, kèm tên đã có gần nhất."""
    from lau_meme_pipeline.dedupe import dedupe

    calls = []

    def ask_same(items):
        calls.append(items)
        return [i["name"] == "Còn mỗi cái nịt" for i in items]

    existing = ["Hết Nước Chấm", "Còn Cái Nịt", "Thả Thính"]
    result = dedupe([raw("Còn mỗi cái nịt"), raw("Thả thính nè"), raw("Hết nước chấm rồi")], existing, ask_same)

    assert len(calls) == 1
    assert {(i["name"], i["existing"]) for i in calls[0]} == {
        ("Còn mỗi cái nịt", "Còn Cái Nịt"),
        ("Thả thính nè", "Thả Thính"),
        ("Hết nước chấm rồi", "Hết Nước Chấm"),
    }
    assert sorted(c.name for c in result.kept) == ["Hết nước chấm rồi", "Thả thính nè"]
    assert result.dropped == {"Còn mỗi cái nịt": "llm_same"}


# ================================================================ AC-PIPE-06 / 08 (linking)


def graph(**over):
    """starters s,a ; b = (a,s) depth 1 ; c = (s,s) depth 1 ; x = (a,c) so (a,c) already has a recipe."""
    from lau_meme_pipeline.linking import Graph

    base = {
        "starters": ("a", "s"),
        "elements": {"a": "A", "s": "S", "b": "B", "c": "C", "x": "X", "m": "M"},
        "recipes": {("a", "s"): "b", ("s", "s"): "c", ("a", "c"): "x"},
    }
    base.update(over)
    return Graph(**base)


def test_ac_pipe_06_chi_cap_hop_le_duoc_them_hai_cap_kia_bi_loai_kem_ly_do():
    """AC-PIPE-06: đề xuất (A,B) hợp lệ, (A,C) đã có công thức, (M,A) tự tham chiếu; chỉ (A,B) được nhận."""
    from lau_meme_pipeline.linking import validate_links

    result = validate_links("m", [("a", "b"), ("a", "c"), ("m", "a")], graph())
    assert result.accepted == [("a", "b")]
    assert result.rejected == {("a", "c"): "exists", ("a", "m"): "self"}


def test_ac_pipe_06_cap_duoc_sap_xep_va_trung_lap_bi_loai():
    """AC-PIPE-06: cặp luôn được sắp xếp; cùng một cặp đề xuất hai lần thì lần sau là "duplicate"."""
    from lau_meme_pipeline.linking import validate_links

    result = validate_links("m", [("b", "a"), ("a", "b")], graph())
    assert result.accepted == [("a", "b")]
    assert result.rejected == {("a", "b"): "duplicate"}


def test_ac_pipe_06_phan_tu_khong_ton_tai_hoac_dang_an_bi_loai():
    """AC-PIPE-06: đầu vào không tồn tại hoặc đang ẩn/chặn bị loại."""
    from lau_meme_pipeline.linking import validate_links

    g = graph(inactive=frozenset({"b"}))
    result = validate_links("m", [("a", "ghost"), ("a", "b"), ("s", "c")], g)
    assert result.rejected == {("a", "ghost"): "unknown", ("a", "b"): "inactive"}
    assert result.accepted == [("c", "s")]


def test_ac_pipe_06_depth_theo_bfs_lai_toan_graph():
    """AC-PIPE-06: depth tính bằng BFS lại toàn graph theo vòng (max(A,B)+1 như AC-SEED-06)."""
    from lau_meme_pipeline.linking import bfs_depths, validate_links

    g = graph()
    assert bfs_depths(g) == {"a": 0, "s": 0, "b": 1, "c": 1, "x": 2}

    # M = (A, X): A depth 0, X depth 2 -> M at round 3 (max+1); min+1 would wrongly give 1.
    result = validate_links("m", [("a", "x")], g)
    assert result.accepted == [("a", "x")]
    recipes = {**g.recipes, ("a", "x"): "m"}
    depths = bfs_depths(graph(recipes=recipes))
    assert depths["m"] == 3


def test_ac_pipe_06_nhieu_cong_thuc_lay_duong_ngan_nhat_va_bo_phan_tu_an():
    """AC-PIPE-06: nhiều công thức cùng kết quả thì lấy vòng sớm nhất; công thức qua phần tử ẩn không tính."""
    from lau_meme_pipeline.linking import bfs_depths

    recipes = {("a", "s"): "b", ("s", "s"): "c", ("a", "c"): "x", ("b", "x"): "m", ("a", "b"): "m"}
    assert bfs_depths(graph(recipes=recipes))["m"] == 2  # via (a,b): max(0,1)+1

    hidden = bfs_depths(graph(recipes=recipes, inactive=frozenset({"b"})))
    assert "b" not in hidden
    assert "m" not in hidden  # both of m's recipes need b


def test_ac_pipe_08_phan_tu_duoi_3_cong_thuc_can_bo_sung():
    """AC-PIPE-08: phần tử đang hoạt động có ít hơn 3 công thức làm đầu vào cần bổ sung (sắp xếp)."""
    from lau_meme_pipeline.linking import Graph, needs_supplement

    recipes = {("s", "t"): "u", ("s", "u"): "v", ("s", "v"): "w", ("t", "u"): "w"}
    g = Graph(starters=("s", "t"), elements={k: k.upper() for k in "stuvw"}, recipes=recipes)
    # counts as input: s=3, t=2, u=2, v=1, w=0
    assert needs_supplement(g) == ["t", "u", "v", "w"]
    assert needs_supplement(g, min_out=2) == ["v", "w"]
    assert needs_supplement(g, min_out=1) == ["w"]


def test_ac_pipe_08_phan_tu_an_khong_can_bo_sung():
    """AC-PIPE-08: phần tử đang ẩn/chặn không nằm trong danh sách cần bổ sung."""
    from lau_meme_pipeline.linking import Graph, needs_supplement

    recipes = {("s", "t"): "u", ("s", "u"): "v", ("s", "v"): "w", ("t", "u"): "w"}
    g = Graph(
        starters=("s", "t"),
        elements={k: k.upper() for k in "stuvw"},
        recipes=recipes,
        inactive=frozenset({"v"}),
    )
    assert needs_supplement(g) == ["t", "u", "w"]


def test_ac_pipe_08_cong_thuc_bo_sung_qua_cung_luat_hop_le():
    """AC-PIPE-08: công thức bổ sung đi qua validate_links: cặp đã có, tự tham chiếu, ẩn đều bị loại."""
    from lau_meme_pipeline.linking import validate_links

    g = graph(inactive=frozenset({"x"}))
    result = validate_links("c", [("a", "s"), ("c", "b"), ("a", "x"), ("s", "b")], g)
    assert result.accepted == [("b", "s")]
    assert result.rejected == {("a", "s"): "exists", ("b", "c"): "self", ("a", "x"): "inactive"}


# ---- AC-PIPE-08 (cập nhật 2026-10-20): mô phỏng Đĩa, chọn cặp, bước bổ sung trong run_full


def test_ac_pipe_08_mo_phong_dia_khong_cong_thuc_thi_luot_nao_cung_truot():
    """AC-PIPE-08: graph không có công thức: mọi lượt trượt, mỗi phần tử khởi đầu có mặt games*turns lượt."""
    from lau_meme_pipeline.linking import Graph, Simulation, simulate_plate

    g = Graph(starters=("a", "b"), elements={"a": "A", "b": "B"}, recipes={})
    sim = simulate_plate(g, games=3, turns=10, seed=7)
    assert isinstance(sim, Simulation)
    assert Simulation.__dataclass_params__.frozen
    assert sim.presence == {"a": 30, "b": 30}
    assert sim.first20 == 1.0
    assert sim.overall == 1.0


def test_ac_pipe_08_mo_phong_dia_xac_dinh_theo_seed_va_phan_tu_khoi_dau_luon_co_mat():
    """AC-PIPE-08: cùng graph + seed cho kết quả y hệt; phần tử khởi đầu luôn trên Đĩa, phần tử chưa ra thì không."""
    from lau_meme_pipeline.linking import simulate_plate

    g = graph()
    first = simulate_plate(g, games=20, turns=30, seed=3)
    second = simulate_plate(g, games=20, turns=30, seed=3)
    assert first == second
    assert first.presence["a"] == 20 * 30
    assert first.presence["s"] == 20 * 30
    assert all(0 < n <= 20 * 30 for n in first.presence.values())
    assert set(first.presence) <= set(g.elements)
    assert "m" not in first.presence  # no recipe makes M, so it never reaches the plate
    assert 0.0 <= first.first20 <= 1.0
    assert 0.0 <= first.overall < 1.0  # (a, s) -> b is hit sometimes


def test_ac_pipe_08_mo_phong_dia_phan_tu_an_khong_len_dia_va_ket_qua_an_la_truot():
    """AC-PIPE-08: phần tử khởi đầu đang ẩn không có trên Đĩa; công thức có đầu vào hoặc kết quả ẩn là trượt."""
    from lau_meme_pipeline.linking import simulate_plate

    only_a = simulate_plate(graph(inactive=frozenset({"s"})), games=5, turns=8)
    assert only_a.presence == {"a": 40}
    assert only_a.first20 == 1.0 and only_a.overall == 1.0

    hidden_result = simulate_plate(graph(inactive=frozenset({"b"})), games=10, turns=30)
    assert "b" not in hidden_result.presence


def test_ac_pipe_08_mo_phong_dia_dia_rong_hoac_khong_van_tra_ty_le_0():
    """AC-PIPE-08: Đĩa rỗng, games=0 hoặc turns=0 thì tỉ lệ 0.0 và presence rỗng."""
    from lau_meme_pipeline.linking import Graph, simulate_plate

    empty = simulate_plate(Graph(starters=(), elements={}, recipes={}))
    assert (empty.presence, empty.first20, empty.overall) == ({}, 0.0, 0.0)
    no_games = simulate_plate(graph(), games=0)
    assert (no_games.presence, no_games.first20, no_games.overall) == ({}, 0.0, 0.0)
    no_turns = simulate_plate(graph(), turns=0)
    assert (no_turns.presence, no_turns.first20, no_turns.overall) == ({}, 0.0, 0.0)


def test_ac_pipe_08_chon_cap_xep_theo_tich_so_dem_gom_cap_cung_phan_tu():
    """AC-PIPE-08: cặp xếp theo tích hai số đếm giảm dần, bằng nhau thì theo tên fold; có cặp (a, a); bỏ cặp đã có."""
    from lau_meme_pipeline.linking import Graph, supplement_pairs

    g = Graph(
        starters=("a", "b"),
        elements={"a": "Alpha", "b": "Beta", "c": "Cam", "d": "Dưa"},
        recipes={("a", "b"): "c"},
    )
    presence = {"a": 10, "b": 5, "c": 2, "d": 1}
    assert supplement_pairs(g, presence) == [
        ("a", "a"),  # 100
        ("b", "b"),  # 25
        ("a", "c"),  # 20
        ("a", "d"),  # 10, ("alpha", "dua") before ("beta", "cam")
        ("b", "c"),  # 10
        ("b", "d"),  # 5
        ("c", "c"),  # 4
        ("c", "d"),  # 2
        ("d", "d"),  # 1
    ]


def test_ac_pipe_08_chon_cap_hoa_bang_nhau_theo_ten_da_fold_khong_theo_id():
    """AC-PIPE-08: tích bằng nhau thì xếp theo tên đã fold (bỏ dấu, chữ thường), hai tên trong cặp xếp tăng dần."""
    from lau_meme_pipeline.linking import Graph, supplement_pairs

    g = Graph(starters=("x", "y"), elements={"x": "Zeta", "y": "Alpha", "z": "Beta"}, recipes={})
    assert supplement_pairs(g, {"x": 1, "y": 1, "z": 1}) == [
        ("y", "y"),  # (alpha, alpha)
        ("y", "z"),  # (alpha, beta)
        ("x", "y"),  # (alpha, zeta)
        ("z", "z"),  # (beta, beta)
        ("x", "z"),  # (beta, zeta)
        ("x", "x"),  # (zeta, zeta)
    ]

    accents = Graph(starters=("p", "q"), elements={"p": "Ếch", "q": "Eo"}, recipes={})
    assert supplement_pairs(accents, {"p": 1, "q": 1}) == [("p", "p"), ("p", "q"), ("q", "q")]


def test_ac_pipe_08_chon_cap_bo_cap_an_cap_da_hoi_cap_co_mat_0_va_cap_da_co_cong_thuc():
    """AC-PIPE-08: bỏ phần tử ẩn, phần tử có mặt 0 hoặc thiếu, cặp đã hỏi (bị loại) và cặp đã có công thức."""
    from lau_meme_pipeline.linking import Graph, supplement_pairs

    g = Graph(
        starters=("a", "b"),
        elements={k: k.upper() for k in "abcdef"},
        recipes={("a", "c"): "b"},
        inactive=frozenset({"d"}),
    )
    presence = {"a": 3, "b": 2, "c": 1, "d": 9, "e": 0}  # f is missing
    result = supplement_pairs(g, presence, asked={("a", "b")})
    assert result == [("a", "a"), ("b", "b"), ("b", "c"), ("c", "c")]


def test_ac_pipe_08_chon_cap_toi_da_150_theo_mac_dinh_va_ton_trong_limit():
    """AC-PIPE-08: tối đa 150 cặp mỗi đợt (SUPPLEMENT_LIMIT), limit nhỏ hơn cắt đúng phần đầu danh sách."""
    from lau_meme_pipeline.linking import SUPPLEMENT_LIMIT, Graph, supplement_pairs

    ids = [f"e{i:02d}" for i in range(20)]
    g = Graph(starters=tuple(ids[:2]), elements={i: i.upper() for i in ids}, recipes={})
    presence = dict.fromkeys(ids, 1)
    full = supplement_pairs(g, presence, limit=1000)
    assert SUPPLEMENT_LIMIT == 150
    assert len(full) == 210  # 20 * 21 / 2 pairs including (a, a)
    assert supplement_pairs(g, presence) == full[:150]
    assert supplement_pairs(g, presence, limit=5) == full[:5]
    assert supplement_pairs(g, presence, limit=0) == []


def _none_pairs(items):
    return [{"a": i["a"], "b": i["b"], "result": None} for i in items]


class _Ids(dict):
    """name -> element id for ANY name (the store only keeps trend elements; ids are deterministic)."""

    def __missing__(self, name):
        from lau_meme_pipeline.ids import element_id

        return element_id(name)


def _id_by_name(outcome):
    return _Ids()


def test_ac_pipe_08_buoc_bo_sung_cap_hop_le_duoc_them_cap_khong_hop_vao_danh_sach_da_hoi():
    """AC-PIPE-08: cặp LLM trả kết quả hợp lệ qua giám khảo được thêm (supplement, có điểm); cặp "không hợp" được
    ghi "đã hỏi"; báo cáo ghi số cặp hỏi/thêm và tỉ lệ trượt trước/sau."""
    from lau_meme_pipeline.full import run_full

    state: dict = {}

    def pair_fake(payload):
        first = payload[0]
        result = next(n for p in payload for n in (p["a"], p["b"]) if n not in (first["a"], first["b"]))
        state.update(pair=(first["a"], first["b"]), result=result)
        return [{"a": p["a"], "b": p["b"], "result": result if k == 0 else None} for k, p in enumerate(payload)]

    pair_llm = Recording(pair_fake)
    outcome = run_full(
        real_core(), {}, crawl_of("Meme Thử Một"), make_llm(supplement_pair=pair_llm), BATCH_AT, mod_lists()
    )

    assert pair_llm.calls == 1
    payload = pair_llm.payloads[0]
    ids = _id_by_name(outcome)
    a_id, b_id = (ids[n] for n in state["pair"])
    added = [r for r in outcome.store["recipes"] if r.get("supplement")]
    assert len(added) == 1
    assert sorted((added[0]["a"], added[0]["b"])) == sorted((a_id, b_id))
    assert added[0]["result"] == ids[state["result"]]
    assert added[0]["score"] == 4 and added[0]["supplement"] is True

    asked = outcome.store["asked_pairs"]
    assert asked == sorted(sorted((ids[p["a"]], ids[p["b"]])) for p in payload[1:])
    assert sorted((a_id, b_id)) not in asked

    sup = outcome.report["supplement"]
    assert sup["asked"] == len(payload) <= 150
    assert sup["added"] == 1
    assert outcome.report["supplement_needed"] == sup["needed"]
    assert len(sup["miss_before"]) == 2 and len(sup["miss_after"]) == 2
    assert sup["miss_after"] == outcome.report["miss_rate"]
    assert sup["miss_after"][0] <= sup["miss_before"][0]


def test_ac_pipe_08_cap_da_hoi_bi_loai_khong_bi_hoi_lai_o_dot_sau():
    """AC-PIPE-08: cặp trong danh sách "đã hỏi, bị loại" của kho không được gửi lại ở đợt sau và được giữ nguyên."""
    from lau_meme_pipeline.full import run_full

    pair1 = Recording(_none_pairs)
    first = run_full(real_core(), {}, crawl_of("Meme Thử Một"), make_llm(supplement_pair=pair1), BATCH_AT, mod_lists())
    asked1 = first.store["asked_pairs"]
    assert asked1
    assert len(asked1) == len(pair1.payloads[0])

    ids1 = _id_by_name(first)
    name_of = {ids1[n]: n for p in pair1.payloads[0] for n in (p["a"], p["b"])}
    asked_names = {frozenset((name_of[a], name_of[b])) for a, b in asked1}

    pair2 = Recording(_none_pairs)
    second = run_full(
        real_core(),
        {"asked_pairs": asked1},
        crawl_of("Meme Thử Một"),
        make_llm(supplement_pair=pair2),
        BATCH_AT,
        mod_lists(),
    )
    assert pair2.calls == 1
    payload2 = pair2.payloads[0]
    assert payload2
    assert not [p for p in payload2 if frozenset((p["a"], p["b"])) in asked_names]
    assert all(pair in second.store["asked_pairs"] for pair in asked1)
    assert second.store["asked_pairs"] == sorted(second.store["asked_pairs"])


def test_ac_pipe_08_phan_tu_duoi_3_cong_thuc_xin_llm_bo_sung_de_xuat_sai_bi_loai_vao_da_hoi():
    """AC-PIPE-08: LLM đề xuất công thức cho phần tử thiếu: hợp lệ được thêm, kết quả không tồn tại bị loại và ghi
    vào danh sách đã hỏi."""
    from lau_meme_pipeline.full import run_full

    state: dict = {}

    def element_fake(payload):
        item = payload[0]
        name, cands = item["name"], item["candidates"]
        result = next(c for c in reversed(cands) if c != name)
        partners = [c for c in cands if c not in (name, result)]
        state.update(name=name, result=result, bad_partner=partners[0])
        recipes = [{"with": partners[0], "result": "Phần Tử Không Tồn Tại"}]
        recipes += [{"with": w, "result": result} for w in partners[1:6]]
        return [{"name": name, "recipes": recipes}]

    element_llm = Recording(element_fake)
    outcome = run_full(
        real_core(), {}, crawl_of("Meme Thử Một"), make_llm(supplement_element=element_llm), BATCH_AT, mod_lists()
    )

    assert element_llm.calls == 1
    assert all(set(i) == {"name", "need", "candidates"} for i in element_llm.payloads[0])
    ids = _id_by_name(outcome)
    p_id, r_id, bad_id = ids[state["name"]], ids[state["result"]], ids[state["bad_partner"]]
    assert not [r for r in outcome.store["recipes"] if r["result"] == ids["Phần Tử Không Tồn Tại"]]

    added = [r for r in outcome.store["recipes"] if r.get("supplement")]
    assert added
    assert all(p_id in (r["a"], r["b"]) and r["result"] == r_id and r["score"] >= 3 for r in added)
    bad_pair = sorted((p_id, bad_id))
    assert bad_pair in outcome.store["asked_pairs"]
    assert not [r for r in added if sorted((r["a"], r["b"])) == bad_pair]
    assert outcome.report["supplement"]["added"] == len(added)


def test_ac_pipe_08_giam_khao_cham_2_thi_khong_them_va_cap_vao_danh_sach_da_hoi():
    """AC-PIPE-08: công thức bổ sung bị giám khảo chấm 2 thì không được thêm và cặp được ghi "đã hỏi"."""
    from lau_meme_pipeline.full import run_full

    state: dict = {}

    def pair_fake(payload):
        first = payload[0]
        result = next(n for p in payload for n in (p["a"], p["b"]) if n not in (first["a"], first["b"]))
        state["pair"] = (first["a"], first["b"])
        return [{"a": p["a"], "b": p["b"], "result": result if k == 0 else None} for k, p in enumerate(payload)]

    def judge_fake(items):
        # the supplement judge call comes after the pair step has been asked; earlier judge calls score 4
        return {i["id"]: (2 if state else 4) for i in items}

    llm = make_llm(supplement_pair=Recording(pair_fake), judge=judge_fake)
    outcome = run_full(real_core(), {}, crawl_of("Meme Thử Một"), llm, BATCH_AT, mod_lists())

    ids = _id_by_name(outcome)
    pair_ids = sorted(ids[n] for n in state["pair"])
    assert not [r for r in outcome.store["recipes"] if r.get("supplement")]
    assert not [r for r in outcome.store["recipes"] if sorted((r["a"], r["b"])) == pair_ids]
    assert pair_ids in outcome.store["asked_pairs"]
    assert outcome.report["supplement"]["added"] == 0


def test_ac_pipe_08_payload_chi_gom_ten_va_tra_loi_khong_phai_danh_sach_thi_khong_sap():
    """AC-PIPE-08: payload gửi LLM chỉ có tên; phản hồi không phải danh sách coi như không đề xuất gì, không sập."""
    from lau_meme_pipeline.full import run_full

    element_llm = Recording(lambda items: "không hiểu")
    pair_llm = Recording(lambda items: None)
    outcome = run_full(
        real_core(),
        {},
        crawl_of("Meme Thử Một"),
        make_llm(supplement_element=element_llm, supplement_pair=pair_llm),
        BATCH_AT,
        mod_lists(),
    )

    assert element_llm.calls == 1 and pair_llm.calls == 1
    for item in element_llm.payloads[0]:
        assert set(item) == {"name", "need", "candidates"}
        assert isinstance(item["name"], str) and item["need"] in (1, 2, 3)
        assert all(isinstance(c, str) for c in item["candidates"])
    payload = pair_llm.payloads[0]
    assert payload
    assert all(set(p) == {"a", "b"} and isinstance(p["a"], str) and isinstance(p["b"], str) for p in payload)

    assert not [r for r in outcome.store["recipes"] if r.get("supplement")]
    assert outcome.store["asked_pairs"] == []  # no answer is not "không hợp": the pairs stay askable
    assert outcome.report["supplement"]["added"] == 0
    assert outcome.report["supplement"]["asked"] == 0


def test_ac_pipe_08_cap_chua_duoc_tra_loi_khong_vao_danh_sach_da_hoi():
    """AC-PIPE-08: danh sách rỗng hoặc bị cắt cụt: cặp không có câu trả lời không bị ghi "đã hỏi", cặp đã trả
    "không hợp" thì có."""
    from lau_meme_pipeline.full import run_full

    empty = Recording(lambda items: [])
    outcome = run_full(
        real_core(), {}, crawl_of("Meme Thử Một"), make_llm(supplement_pair=empty), BATCH_AT, mod_lists()
    )
    assert empty.calls == 1 and empty.payloads[0]
    assert outcome.store["asked_pairs"] == []
    assert outcome.report["supplement"]["asked"] == 0

    half = Recording(lambda items: _none_pairs(items[: len(items) // 2]))
    outcome = run_full(real_core(), {}, crawl_of("Meme Thử Một"), make_llm(supplement_pair=half), BATCH_AT, mod_lists())
    payload = half.payloads[0]
    ids = _id_by_name(outcome)
    answered = payload[: len(payload) // 2]
    assert answered and len(answered) < len(payload)
    assert outcome.store["asked_pairs"] == sorted(sorted((ids[p["a"]], ids[p["b"]])) for p in answered)
    assert outcome.report["supplement"]["asked"] == len(answered)


# ================================================================ AC-PIPE-09


def recs(*ids):
    return [{"id": i, "a": "x", "b": "y", "result": "z"} for i in ids]


def test_ac_pipe_09_chi_giu_diem_tu_3_tro_len_va_luu_diem_kem_cong_thuc():
    """AC-PIPE-09: điểm 2, 3, 5 và một phản hồi không đọc được; giữ ≥ 3, điểm lưu kèm công thức."""
    from lau_meme_pipeline.judge import judge

    result = judge(recs("r2", "r3", "r5", "rx"), {"r2": 2, "r3": 3, "r5": 5, "rx": "khó đọc"})
    assert [r["id"] for r in result.kept] == ["r3", "r5"]
    assert [r["score"] for r in result.kept] == [3, 5]
    assert result.rejected == {"r2": "low_score", "rx": "unreadable"}


@pytest.mark.parametrize("bad", [None, True, False, 0, 6, -1, 4.0, "4", "năm", [4], {"score": 4}])
def test_ac_pipe_09_diem_khong_hop_le_la_khong_doc_duoc(bad):
    """AC-PIPE-09: điểm không phải số nguyên 1..5 (bool, chuỗi, ngoài khoảng...) bị loại là "unreadable"."""
    from lau_meme_pipeline.judge import judge

    result = judge(recs("r1"), {"r1": bad})
    assert result.kept == []
    assert result.rejected == {"r1": "unreadable"}


def test_ac_pipe_09_thieu_diem_la_khong_doc_duoc_va_giu_thu_tu():
    """AC-PIPE-09: công thức thiếu điểm bị loại; công thức giữ lại theo thứ tự đầu vào."""
    from lau_meme_pipeline.judge import judge

    result = judge(recs("r1", "r2", "r3"), {"r3": 4, "r1": 1 + 3})
    assert [r["id"] for r in result.kept] == ["r1", "r3"]
    assert result.rejected == {"r2": "unreadable"}


def test_ac_pipe_09_diem_1_va_2_la_low_score():
    """AC-PIPE-09: điểm hợp lệ nhưng dưới 3 là "low_score"."""
    from lau_meme_pipeline.judge import judge

    result = judge(recs("a", "b"), {"a": 1, "b": 2})
    assert result.kept == []
    assert result.rejected == {"a": "low_score", "b": "low_score"}


# ================================================================ AC-PIPE-07


def concept_dict(key):
    return {"key": key, "name": f"Meme {key}"}


def unlinked_item(key):
    return {"key": key, "concept": concept_dict(key), "reason": "unlinked"}


def test_ac_pipe_07_meme_chua_noi_duoc_vao_hang_cho_voi_so_lan_thu_1():
    """AC-PIPE-07: meme không nối được vào hàng chờ với số lần thử = 1."""
    from lau_meme_pipeline.linkqueue import next_queue

    result = next_queue([], [unlinked_item("m")], set())
    assert [(i["key"], i["attempts"], i["reason"]) for i in result.queue] == [("m", 1, "unlinked")]
    assert result.queue[0]["concept"] == concept_dict("m")
    assert result.dropped == []


def test_ac_pipe_07_dot_sau_thu_lai_truoc_meme_moi():
    """AC-PIPE-07: đợt sau meme trong hàng chờ được thử lại trước meme mới, không trùng theo key."""
    from lau_meme_pipeline.linkqueue import batch_order

    queue = [
        {"key": "q1", "concept": concept_dict("q1"), "attempts": 2, "reason": "unlinked"},
        {"key": "q2", "concept": concept_dict("q2"), "attempts": 1, "reason": "quota"},
    ]
    order = batch_order(queue, [concept_dict("n1"), concept_dict("q2"), concept_dict("n2")])
    assert [c["key"] for c in order] == ["q1", "q2", "n1", "n2"]


def test_ac_pipe_07_noi_duoc_thi_roi_hang_cho_van_chua_noi_tang_so_lan_thu():
    """AC-PIPE-07: meme nối được rời hàng chờ; meme vẫn chưa nối được tăng số lần thử."""
    from lau_meme_pipeline.linkqueue import next_queue

    queue = [
        {"key": "ok", "concept": concept_dict("ok"), "attempts": 2, "reason": "unlinked"},
        {"key": "still", "concept": concept_dict("still"), "attempts": 2, "reason": "unlinked"},
    ]
    result = next_queue(queue, [unlinked_item("still"), unlinked_item("fresh")], {"ok"})
    assert {i["key"]: i["attempts"] for i in result.queue} == {"still": 3, "fresh": 1}
    assert result.dropped == []


def test_ac_pipe_07_sau_6_lan_thu_khong_noi_duoc_thi_bo_va_bao_cao():
    """AC-PIPE-07: sau 6 lần thử không nối được thì bỏ khỏi hàng chờ và báo cáo; lần thứ 7 không xảy ra."""
    from lau_meme_pipeline.linkqueue import MAX_ATTEMPTS, next_queue

    assert MAX_ATTEMPTS == 6
    queue: list[dict] = []
    for attempt in range(1, 6):
        result = next_queue(queue, [unlinked_item("m")], set())
        queue = result.queue
        assert [i["attempts"] for i in queue] == [attempt]
        assert result.dropped == []

    result = next_queue(queue, [unlinked_item("m")], set())  # the 6th failed try
    assert result.queue == []
    assert result.dropped == ["m"]


def test_ac_pipe_07_hang_cho_het_quota_giu_nguyen_khong_bi_phat():
    """AC-PIPE-07: khái niệm chờ vì hết quota (không nằm trong unlinked) không bị tăng số lần thử hay bị bỏ."""
    from lau_meme_pipeline.linkqueue import next_queue

    queue = [{"key": "q", "concept": concept_dict("q"), "attempts": 1, "reason": "quota"}]
    result = next_queue(queue, [], set())
    assert [(i["key"], i["attempts"]) for i in result.queue] == [("q", 1)]
    assert result.dropped == []


# ================================================================ AC-PIPE-12


class ScriptedCall:
    """call(chunk) -> answers; `script` has one entry per call: an exception to raise, or None."""

    def __init__(self, script):
        self.script = list(script)
        self.chunks: list[list] = []

    def __call__(self, chunk):
        self.chunks.append(list(chunk))
        step = self.script[len(self.chunks) - 1] if len(self.chunks) <= len(self.script) else None
        if step is not None:
            raise step
        return [f"ok:{x}" for x in chunk]


def test_ac_pipe_12_vi_du_25_khai_niem_429_hai_lan_roi_het_quota_o_lo_3():
    """AC-PIPE-12: 25 khái niệm, lô 10; 429 hai lần ở lô 1 rồi thành công, hết quota ở lô 3."""
    from lau_meme_pipeline.llm import QuotaExhausted, RateLimited, call_in_batches

    items = list(range(25))
    call = ScriptedCall([RateLimited(), RateLimited(), None, None, QuotaExhausted()])
    sleeps: list[float] = []

    out = call_in_batches(items, 10, call, sleep=sleeps.append)

    assert [len(c) for c in call.chunks] == [10, 10, 10, 10, 5]
    assert call.chunks[0] == call.chunks[1] == call.chunks[2] == items[:10]
    assert out.calls == 5
    assert sleeps == [2.0, 4.0]
    assert out.results == [f"ok:{x}" for x in items[:20]]
    assert out.pending == items[20:]
    assert out.quota_hit is True
    assert out.failed == []


def test_ac_pipe_12_khong_loi_thi_dung_3_loi_goi_lo():
    """AC-PIPE-12: không lỗi thì đúng 3 lời gọi (10, 10, 5), không ngủ, không quota."""
    from lau_meme_pipeline.llm import call_in_batches

    items = list(range(25))
    call = ScriptedCall([])
    sleeps: list[float] = []
    out = call_in_batches(items, 10, call, sleep=sleeps.append)
    assert [len(c) for c in call.chunks] == [10, 10, 5]
    assert out.calls == 3
    assert sleeps == []
    assert out.results == [f"ok:{x}" for x in items]
    assert out.failed == [] and out.pending == [] and out.quota_hit is False


def test_ac_pipe_12_backoff_luy_thua_het_luot_retry_thi_lo_vao_failed():
    """AC-PIPE-12: backoff 2, 4, 8 giây; hết max_retries thì lô vào failed và các lô sau vẫn chạy."""
    from lau_meme_pipeline.llm import RateLimited, call_in_batches

    items = list(range(15))
    call = ScriptedCall([RateLimited(), RateLimited(), RateLimited(), RateLimited()])
    sleeps: list[float] = []
    out = call_in_batches(items, 10, call, sleep=sleeps.append, max_retries=3, base_delay=2.0)

    assert sleeps == [2.0, 4.0, 8.0]
    assert out.calls == 5  # chunk 1: 1 + 3 retries, chunk 2: 1
    assert out.failed == items[:10]
    assert out.results == [f"ok:{x}" for x in items[10:]]
    assert out.pending == [] and out.quota_hit is False


def test_ac_pipe_12_base_delay_la_tham_so():
    """AC-PIPE-12: thời gian chờ là tham số, test không ngủ thật."""
    from lau_meme_pipeline.llm import RateLimited, call_in_batches

    sleeps: list[float] = []
    call_in_batches([1], 10, ScriptedCall([RateLimited(), RateLimited()]), sleep=sleeps.append, base_delay=0.5)
    assert sleeps == [0.5, 1.0]


def test_ac_pipe_12_loi_khac_thi_lo_vao_failed_khong_dung_batch():
    """AC-PIPE-12: lỗi bất kỳ khác thì lô đó vào failed, không retry, các lô sau vẫn chạy."""
    from lau_meme_pipeline.llm import LlmError, call_in_batches

    items = list(range(25))
    call = ScriptedCall([None, LlmError("hỏng"), None])
    sleeps: list[float] = []
    out = call_in_batches(items, 10, call, sleep=sleeps.append)
    assert out.calls == 3
    assert sleeps == []
    assert out.failed == items[10:20]
    assert out.results == [f"ok:{x}" for x in items[:10] + items[20:]]


def test_ac_pipe_12_het_quota_giua_chung_dua_lo_do_va_phan_con_lai_vao_pending():
    """AC-PIPE-12: hết quota ở lô 2 thì lô 2 và lô 3 vào pending, phần đã xử lý vẫn giữ."""
    from lau_meme_pipeline.llm import QuotaExhausted, call_in_batches

    items = list(range(25))
    call = ScriptedCall([None, QuotaExhausted()])
    out = call_in_batches(items, 10, call, sleep=lambda s: None)
    assert out.calls == 2
    assert out.results == [f"ok:{x}" for x in items[:10]]
    assert out.pending == items[10:]
    assert out.quota_hit is True


def test_ac_pipe_12_het_quota_o_pipeline_dua_vao_hang_cho_va_bao_cao():
    """AC-PIPE-12: classify hết quota thì khái niệm vào hàng chờ (quota), báo cáo ghi "hết quota", không đăng."""
    from lau_meme_pipeline.full import run_full
    from lau_meme_pipeline.llm import QuotaExhausted

    llm = make_llm(classify=_raise(QuotaExhausted()))
    outcome = run_full(real_core(), {}, crawl_of("Meme Thử Một", "Meme Thử Hai"), llm, BATCH_AT, mod_lists())

    assert "hết quota" in json.dumps(outcome.report, ensure_ascii=False)
    queued = outcome.store["queue"]
    assert {i["concept"]["name"] for i in queued} == {"Meme Thử Một", "Meme Thử Hai"}
    assert all(i["reason"] == "quota" for i in queued)
    names = {e["name"] for e in outcome.store["elements"]}
    assert "Meme Thử Một" not in names and "Meme Thử Hai" not in names


# ================================================================ AC-PIPE-10


def test_ac_pipe_10_cached_llm_khoa_la_sha256_va_khong_goi_lai():
    """AC-PIPE-10: CachedLlm khóa bằng sha256(bước + payload JSON sắp xếp); khóa đã có không gọi lại."""
    from lau_meme_pipeline.llm import CachedLlm

    calls = []

    def call(*args):
        calls.append(args)
        return {"answer": len(calls)}

    payload = {"b": "Còn Cái Nịt", "a": [1, 2]}
    cache: dict = {}
    llm = CachedLlm(call, cache)
    first = llm.ask("same", payload)

    body = "same" + json.dumps(payload, sort_keys=True, ensure_ascii=False)
    key = hashlib.sha256(body.encode("utf-8")).hexdigest()
    assert key in cache
    assert cache[key] == first

    before = len(calls)
    assert llm.ask("same", {"a": [1, 2], "b": "Còn Cái Nịt"}) == first
    assert len(calls) == before


def test_ac_pipe_10_cached_llm_buoc_khac_nhau_khong_dung_chung_cache():
    """AC-PIPE-10: cùng payload nhưng khác bước thì là hai khóa khác nhau."""
    from lau_meme_pipeline.llm import CachedLlm

    seen = []

    def call(*args):
        seen.append(args)
        return len(seen)

    cache: dict = {}
    llm = CachedLlm(call, cache)
    a = llm.ask("same", {"x": 1})
    b = llm.ask("judge", {"x": 1})
    assert a != b
    assert len(cache) == 2
    assert llm.ask("same", {"x": 1}) == a
    assert len(seen) == 2


# ---- end-to-end idempotency with fakes


def mod_lists():
    from lau_meme_pipeline.moderation import ModLists

    return ModLists()


def crawl_of(*names):
    from lau_meme_pipeline.crawl import CrawlResult

    concepts = [
        raw(n, quote=f"câu nói {n}", context=f"ngữ cảnh {n}", url=f"https://ex.com/{i}", source="RSS")
        for i, n in enumerate(names)
    ]
    return CrawlResult(concepts=concepts, errors=[])


def _raise(exc):
    def f(items):
        raise exc

    return f


class Counting:
    def __init__(self, fn):
        self.fn = fn
        self.calls = 0

    def __call__(self, payload):
        self.calls += 1
        return self.fn(payload)


class Recording(Counting):
    """Counting fake that also keeps every payload it was called with."""

    def __init__(self, fn):
        super().__init__(fn)
        self.payloads: list = []

    def __call__(self, payload):
        self.payloads.append(payload)
        return super().__call__(payload)


def _same(items):
    return [False for _ in items]


def _classify(items):
    return [
        {
            "key": i["key"],
            "category": "safe",
            "confidence": 0.95,
            "person": {"targets": False, "name": None, "aliases": []},
            "accusation": False,
            "hot_person": False,
            "flagged_fields": [],
        }
        for i in items
    ]


def _describe(items):
    return [
        {
            "key": i.get("key", i["name"]),
            "emoji": "🔥",
            "description": f"Mô tả {i['name']}",
            "daily_hint": f"Gợi ý {i['name']}",
            "image_hint": f"Ảnh {i['name']}",
        }
        for i in items
    ]


def _link(items):
    fallback = [["AFK", "Aura"], ["AFK", "Bom Hàng"], ["AFK", "Brainrot"]]
    out = []
    for n, i in enumerate(items):
        cands = i.get("candidates") or []
        pairs = [[cands[0], cands[1]]] if len(cands) >= 2 else fallback[n % 3 : n % 3 + 1]
        out.append({"key": i["key"], "pairs": pairs})
    return out


def _judge(items):
    return {i["id"]: 4 for i in items}


def _supplement_element(items):
    return [{"name": i["name"], "recipes": []} for i in items]


def _supplement_pair(items):
    return [{"a": i["a"], "b": i["b"], "result": None} for i in items]


def make_llm(**over):
    fns = {
        "same": _same,
        "classify": _classify,
        "describe": _describe,
        "link": _link,
        "judge": _judge,
        "supplement_element": _supplement_element,
        "supplement_pair": _supplement_pair,
    }
    fns.update(over)
    return {k: Counting(v) if not isinstance(v, Counting) else v for k, v in fns.items()}


def forbidden(step):
    def f(payload):
        raise AssertionError(f"LLM step {step!r} must not be called again")

    return Counting(f)


def test_ac_pipe_10_chay_lai_cung_dau_vao_cho_byte_giong_nhau_khong_goi_llm_lai():
    """AC-PIPE-10: cùng kho, crawl, llm_cache, batch_at -> graph/manifest giống từng byte, 0 lời gọi LLM lần 2."""
    from lau_meme_pipeline.full import run_full

    core = real_core()
    crawl_result = crawl_of("Meme Thử Một", "Meme Thử Hai", "Meme Thử Ba")
    store_in: dict = {}

    first_llm = make_llm()
    first = run_full(core, store_in, crawl_result, first_llm, BATCH_AT, mod_lists())
    assert sum(f.calls for f in first_llm.values()) > 0
    assert first.store["llm_cache"]

    second_llm = {
        step: forbidden(step)
        for step in ("same", "classify", "describe", "link", "judge", "supplement_element", "supplement_pair")
    }
    second_store = {**store_in, "llm_cache": first.store["llm_cache"]}
    second = run_full(core, second_store, crawl_result, second_llm, BATCH_AT, mod_lists())

    assert sum(f.calls for f in second_llm.values()) == 0
    assert json.dumps(second.graph, sort_keys=True) == json.dumps(first.graph, sort_keys=True)
    assert json.dumps(second.manifest, sort_keys=True) == json.dumps(first.manifest, sort_keys=True)
    assert json.dumps(second.store, sort_keys=True, ensure_ascii=False) == json.dumps(
        first.store, sort_keys=True, ensure_ascii=False
    )


def test_ac_pipe_10_khong_tao_phan_tu_hoac_cong_thuc_trung():
    """AC-PIPE-10: kho xuất ra không có id phần tử/công thức trùng, không có cặp (a,b) trùng."""
    from lau_meme_pipeline.full import run_full

    outcome = run_full(
        real_core(), {}, crawl_of("Meme Thử Một", "Meme Thử Hai", "Meme Thử Ba"), make_llm(), BATCH_AT, mod_lists()
    )
    elements = outcome.store["elements"]
    recipes = outcome.store["recipes"]
    assert len({e["id"] for e in elements}) == len(elements)
    assert len({r["id"] for r in recipes}) == len(recipes)
    pairs = [tuple(sorted((r["a"], r["b"]))) for r in recipes]
    assert len(set(pairs)) == len(pairs)
    assert all(r["score"] >= 3 for r in recipes)
