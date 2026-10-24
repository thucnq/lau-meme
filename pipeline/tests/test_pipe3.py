"""Acceptance tests for docs/acceptance/pipe.md (added 2026-10-23): AC-PIPE-15 (Tuổi Trẻ), AC-PIPE-16 (trend_peak),
AC-PIPE-17 (Threads via the official API); plus the pipeline half of AC-ADMIN-11 (stats sent with the batch log).

Expected public surface (new names are marked NEW):

    lau_meme_pipeline.crawl
        TuoiTreAdapter()                      NEW  .name == "Tuổi Trẻ", .fetch(http) -> list[RawConcept]
        ThreadsAdapter(access_token, keywords)   NEW  .name == "Threads", .fetch(http) -> list[RawConcept]
                                              (keywords: list[str]; missing token or no keyword -> fetch returns [] and
                                              touches no URL; at most 50 concepts per fetch)
        default_adapters(env)                 now also returns a TuoiTreAdapter and a ThreadsAdapter (reads env keys
                                              THREADS_ACCESS_TOKEN and THREADS_KEYWORDS, comma separated)
        Http(get), http_get, HttpStatus(status), RawConcept, crawl(adapters, http), crawl_report_line(result)
    lau_meme_pipeline.batch.run_batch(mode, batch_at, core, client, reporter, adapters, crawl_http, llm, log,
                                      banned_words) as in test_pipe_full_batch.py
        success body: content.elements[].trend_peak (int >= 0, optional; absent = keep the stored value),
                      stats.sources = [{"source", "concepts": int | None, "error": str | None}] (mode full only),
                      stats.queue_size
        state (GET /pipeline/state): catalog = [{"id", "first_version", "trend_peak"}]

No network, no sleeping, no real clock. Imports happen inside the tests so a missing name fails at runtime.
"""

import copy
import dataclasses
import http.client
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)
T2 = T + timedelta(hours=12)
MEDIA_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov")


# ---------------------------------------------------------------- shared fakes (self-contained)


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def eid(name: str) -> str:
    from lau_meme_pipeline.ids import element_id

    return element_id(name)


class FakeGet:
    """get(url) -> (content_type, body) | raises. `pages` maps a full URL to a tuple or an exception instance.
    `robots` maps host -> robots text (default: empty file = allow all)."""

    def __init__(self, pages=None, robots=None):
        self.pages = dict(pages or {})
        self.robots = dict(robots or {})
        self.requested: list[str] = []

    def __call__(self, url):
        self.requested.append(url)
        if url.endswith("/robots.txt"):
            return ("text/plain", self.robots.get(url.split("/")[2], ""))
        page = self.pages[url]
        if isinstance(page, Exception):
            raise page
        return page

    @property
    def pages_requested(self) -> list[str]:
        return [u for u in self.requested if not u.endswith("/robots.txt")]


def make_http(get):
    from lau_meme_pipeline.crawl import Http

    return Http(get)


class FakeAdapter:
    def __init__(self, name, names=(), error=None):
        self.name = name
        self._names = list(names)
        self._error = error

    def fetch(self, http):
        if self._error is not None:
            raise self._error
        from lau_meme_pipeline.crawl import RawConcept

        return [
            RawConcept(
                name=n,
                quote=f"câu nói {n}",
                context=f"ngữ cảnh {n}",
                source_url=f"https://ex.com/{self.name}/{i}",
                source_name=self.name,
            )
            for i, n in enumerate(self._names)
        ]


def make_state(catalog=None) -> dict:
    return {
        "catalog": list(catalog or []),
        "current_version": None,
        "blocklist": {"elements": [], "recipes": [], "images": []},
        "banned_aliases": [],
        "admin_blocked": [],
        "daily_history": [],
        "feedback": [],
        "tiers": [],
        "contributions": [],
    }


class FakeClient:
    def __init__(self, store=None, catalog=None, fail_success=False):
        self.state = make_state(catalog)
        self.store = store if store is not None else {}
        self.fail_success = fail_success
        self.posted: list[dict] = []
        self._n = 0

    def get_state(self):
        return copy.deepcopy(self.state)

    def get_store(self, version=None):
        return copy.deepcopy(self.store)

    def put_banned_terms(self, source, terms):
        pass

    def post_batch(self, body):
        if self.fail_success and body.get("status") == "success":
            raise RuntimeError("deploy failed")
        self._n += 1
        self.posted.append(copy.deepcopy(body))
        return {
            "id": f"00000000-0000-4000-8000-{self._n:012d}",
            "version": body.get("version"),
            "batch_at": body["batch_at"],
            "mode": body["mode"],
            "status": body["status"],
            "failed_step": body.get("failed_step"),
            "stats": body["stats"],
            "issue_url": None,
            "created_at": body["batch_at"],
        }

    def patch_batch(self, run_id, issue_url):
        return {"id": run_id, "issue_url": issue_url}

    @property
    def success_posts(self):
        return [b for b in self.posted if b["status"] == "success"]

    @property
    def error_posts(self):
        return [b for b in self.posted if b["status"] == "error"]


class FakeReporter:
    def __init__(self):
        self.issues: list[tuple[str, str]] = []

    def create_issue(self, title, body):
        self.issues.append((title, body))
        return f"https://github.com/o/r/issues/{len(self.issues)}"


class Counting:
    def __init__(self, fn):
        self.fn = fn
        self.calls = 0
        self.payloads: list = []

    def __call__(self, payload):
        self.calls += 1
        self.payloads.append(payload)
        return self.fn(payload)


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


def make_llm(**over):
    fns = {
        "same": lambda items: [False for _ in items],
        "classify": _classify,
        "describe": _describe,
        "link": _link,
        "judge": lambda items: {i["id"]: 4 for i in items},
        "supplement_element": lambda items: [{"name": i["name"], "recipes": []} for i in items],
        "supplement_pair": lambda items: [{"a": i["a"], "b": i["b"], "result": None} for i in items],
    }
    fns.update(over)
    return {k: Counting(v) for k, v in fns.items()}


def run_full(client, reporter, adapters, llm=None, crawl_get=None, batch_at=T, mode="full"):
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    return run_batch(
        mode=mode,
        batch_at=batch_at,
        core=real_core(),
        client=client,
        reporter=reporter,
        adapters=adapters,
        crawl_http=Http(crawl_get if crawl_get is not None else (lambda url: ("text/plain", ""))),
        llm=llm if llm is not None else make_llm(),
        log=lambda msg: None,
        banned_words=[],
    )


# ================================================================ AC-PIPE-15: Tuổi Trẻ

TT_URL = "https://tuoitre.vn/meme.html"
TT_ROBOTS = "User-agent: *\nDisallow: /tim-kiem.htm\nDisallow: /print/\n"
LONG_SAPO = "Tóm tắt dài " + "x" * 788  # 800 characters


def tt_title(i: int) -> str:
    return "Bố & Con đu trend số 5" if i == 5 else f"Tiêu đề meme số {i}"


def tt_sapo(i: int) -> str:
    return LONG_SAPO if i == 1 else f"Tóm tắt của bài số {i}: câu chuyện hài hước."


def tt_href(i: int) -> str:
    return f"https://tuoitre.vn/meme-so-{i}-2026102300{i:02d}.htm" if i == 7 else f"/meme-so-{i}-2026102300{i:02d}.htm"


def tt_expected_url(i: int) -> str:
    return f"https://tuoitre.vn/meme-so-{i}-2026102300{i:02d}.htm"


def tuoitre_html(count: int = 20) -> str:
    items = []
    for i in range(1, count + 1):
        title = tt_title(i).replace("&", "&amp;")
        items.append(
            f'<div class="box-category-item" data-id="{i}">'
            f'<a class="box-category-link-with-avatar" href="{tt_href(i)}" title="{title}">'
            f'<img class="box-category-avatar" src="https://cdn.tuoitre.vn/thumb/{i}.jpg" alt=""></a>'
            f'<h3 class="box-title-text"><a class="box-category-link-title" href="{tt_href(i)}" title="{title}">'
            f"{title}</a></h3>"
            f'<p class="box-category-sapo">{tt_sapo(i)}</p>'
            f'<a class="print-link" href="/print/meme-so-{i}.htm">In bài</a></div>'
        )
    return (
        "<!DOCTYPE html><html lang='vi'><head><title>Meme - Tuổi Trẻ Online</title></head><body>"
        '<form action="/tim-kiem.htm"><input name="keywords"></form>'
        f"<main>{''.join(items)}</main>"
        '<nav class="pagination"><a href="/meme/trang-2.htm">Trang 2</a></nav>'
        "</body></html>"
    )


BROKEN_HTML = "<!DOCTYPE html><html><body><div class='moi'>Giao diện mới, không còn danh sách bài</div></body></html>"


def tt_get(html: str | None = None, robots: str = TT_ROBOTS) -> FakeGet:
    page = html if html is not None else tuoitre_html()
    return FakeGet({TT_URL: ("text/html; charset=utf-8", page)}, {"tuoitre.vn": robots})


def test_ac_pipe_15_tuoi_tre_tra_20_khai_niem_dung_truong():
    """AC-PIPE-15: 20 bài: tên = tiêu đề, ngữ cảnh = tóm tắt (tối đa 500 ký tự), link tuyệt đối, nguồn "Tuổi Trẻ"."""
    from lau_meme_pipeline.crawl import RawConcept, TuoiTreAdapter

    get = tt_get()
    adapter = TuoiTreAdapter()
    assert adapter.name == "Tuổi Trẻ"
    concepts = adapter.fetch(make_http(get))

    assert len(concepts) == 20
    assert all(isinstance(c, RawConcept) for c in concepts)
    assert [c.name for c in concepts] == [tt_title(i) for i in range(1, 21)]
    assert [c.source_url for c in concepts] == [tt_expected_url(i) for i in range(1, 21)]
    assert all(c.source_name == "Tuổi Trẻ" for c in concepts)
    assert 0 < len(concepts[0].context) <= 500
    assert concepts[0].context.startswith("Tóm tắt dài")
    assert [c.context for c in concepts[1:]] == [tt_sapo(i) for i in range(2, 21)]


def test_ac_pipe_15_tuoi_tre_chi_doc_trang_1_cua_chuyen_muc_khong_tai_anh_khong_theo_link():
    """AC-PIPE-15: chỉ trang chuyên mục meme.html được tải (không trang 2, không bài, không /print/, không tìm kiếm),
    không tải ảnh đại diện."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter

    get = tt_get()
    TuoiTreAdapter().fetch(make_http(get))

    assert get.pages_requested == [TT_URL]
    assert [u for u in get.requested if u.lower().split("?")[0].endswith(MEDIA_EXT)] == []
    assert not [u for u in get.requested if "/print/" in u or "tim-kiem" in u or "trang-2" in u]
    assert get.requested.count("https://tuoitre.vn/robots.txt") == 1


def test_ac_pipe_15_tuoi_tre_khai_niem_chi_gom_nam_truong_khong_lo_anh():
    """AC-PIPE-04/15: khái niệm không chứa URL ảnh đại diện hay link in bài (chỉ 5 trường của RawConcept)."""
    from lau_meme_pipeline.crawl import RawConcept, TuoiTreAdapter

    assert [f.name for f in dataclasses.fields(RawConcept)] == ["name", "quote", "context", "source_url", "source_name"]
    concepts = TuoiTreAdapter().fetch(make_http(tt_get()))
    dump = json.dumps([dataclasses.asdict(c) for c in concepts], ensure_ascii=False)
    assert "cdn.tuoitre.vn" not in dump
    assert "/print/" not in dump


def test_ac_pipe_15_tuoi_tre_robots_chi_cam_tim_kiem_va_print_thi_van_doc_duoc():
    """AC-PIPE-15: robots.txt mẫu cấm /tim-kiem.htm và /print/ không chặn trang chuyên mục: 20 khái niệm, không lỗi."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter, crawl

    result = crawl([TuoiTreAdapter()], make_http(tt_get()))
    assert result.errors == []
    assert len(result.concepts) == 20


def test_ac_pipe_15_tuoi_tre_robots_cam_chuyen_muc_thi_loi_nguon_robots_denied_khong_tai_trang():
    """AC-PIPE-15: nếu robots.txt cấm chính trang chuyên mục thì nguồn báo RobotsDenied và trang không bị tải."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter, crawl

    get = tt_get(robots="User-agent: *\nDisallow: /meme.html\n")
    result = crawl([TuoiTreAdapter()], make_http(get))

    assert result.errors == [{"source": "Tuổi Trẻ", "error": "RobotsDenied"}]
    assert result.concepts == []
    assert TT_URL not in get.requested


def test_ac_pipe_15_tuoi_tre_html_doi_cau_truc_bao_loi_nguon_khong_doc_duoc_trang():
    """AC-PIPE-15: HTML không còn bài nào đọc được: lỗi nguồn "Tuổi Trẻ" nêu "không đọc được trang", nguồn khác vẫn
    chạy (AC-PIPE-03)."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter, crawl, crawl_report_line

    http = make_http(tt_get(BROKEN_HTML))
    result = crawl([TuoiTreAdapter(), FakeAdapter("RSS", ["R1"])], http)

    assert [c.name for c in result.concepts] == ["R1"]
    assert len(result.errors) == 1
    assert result.errors[0]["source"] == "Tuổi Trẻ"
    assert "không đọc được trang" in result.errors[0]["error"]
    line = crawl_report_line(result)
    assert "Tuổi Trẻ: " in line and "không đọc được trang" in line


def test_ac_pipe_15_tuoi_tre_html_doi_cau_truc_dot_full_khong_that_bai():
    """AC-PIPE-15: HTML đổi cấu trúc ở mẻ full: mẻ vẫn success, stats.source_errors có "Tuổi Trẻ",
    Issue ghi dòng lỗi."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter

    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full(
        client,
        reporter,
        [TuoiTreAdapter(), FakeAdapter("RSS", ["Meme Thử Một"])],
        crawl_get=tt_get(BROKEN_HTML),
    )

    assert outcome.ok is True and outcome.status == "success"
    assert client.error_posts == []
    (body,) = client.success_posts
    assert [e["source"] for e in body["stats"]["source_errors"]] == ["Tuổi Trẻ"]
    assert "không đọc được trang" in body["stats"]["source_errors"][0]["error"]
    assert "Tuổi Trẻ: " in reporter.issues[0][1] and "không đọc được trang" in reporter.issues[0][1]


def test_ac_pipe_15_tuoi_tre_dot_full_thu_20_khai_niem():
    """AC-PIPE-15: mẻ full chạy adapter Tuổi Trẻ thật với HTML mẫu: stats.crawled = 20, không lỗi nguồn."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter

    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full(client, reporter, [TuoiTreAdapter()], crawl_get=tt_get())

    assert outcome.ok is True
    (body,) = client.success_posts
    assert body["stats"]["crawled"] == 20
    assert body["stats"]["source_errors"] == []


def test_ac_pipe_15_tuoi_tre_user_agent_neu_ten_du_an(monkeypatch):
    """AC-PIPE-15: mọi yêu cầu (robots.txt và trang) gửi User-Agent có tên dự án "lau-meme"."""
    from lau_meme_pipeline.crawl import Http, TuoiTreAdapter, http_get

    headers_seen: list[dict] = []
    html = tuoitre_html()

    class Resp:
        status = 200
        reason = "OK"

        def __init__(self, path):
            ctype = "text/plain" if path.endswith("/robots.txt") else "text/html; charset=utf-8"
            self._h = {"content-type": ctype}
            self._body = b"" if path.endswith("/robots.txt") else html.encode("utf-8")

        def getheader(self, name, default=None):
            return self._h.get(name.lower(), default)

        def getheaders(self):
            return list(self._h.items())

        def read(self, n=None):
            return self._body if n is None else self._body[:n]

        def close(self):
            pass

    class Conn:
        def __init__(self, host, *args, **kwargs):
            self.path = ""

        def request(self, method, url, body=None, headers=None, **kwargs):
            self.path = url
            headers_seen.append({k.lower(): v for k, v in (headers or {}).items()})

        def getresponse(self):
            return Resp(self.path)

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Conn)
    concepts = TuoiTreAdapter().fetch(Http(http_get))

    assert len(concepts) == 20
    assert len(headers_seen) >= 2
    assert all("lau-meme" in h.get("user-agent", "").lower() for h in headers_seen)


def test_ac_pipe_15_default_adapters_co_tuoi_tre():
    """AC-PIPE-15: default_adapters (mẻ full) có adapter Tuổi Trẻ."""
    from lau_meme_pipeline.crawl import TuoiTreAdapter, default_adapters

    adapters = default_adapters({"YOUTUBE_API_KEY": "KEY123"})
    assert [a.name for a in adapters if isinstance(a, TuoiTreAdapter)] == ["Tuổi Trẻ"]


# ================================================================ AC-PIPE-17: Threads

THREADS_HOST = "graph.threads.net"
THREADS_ACCESS = "THREADSTOKENSECRET123"
SCRAPE_HOSTS = {"threads.net", "www.threads.net", "threads.com", "www.threads.com"}


def threads_post(q: str, i: int) -> dict:
    media = ["TEXT_POST", "IMAGE", "VIDEO"][i % 3]
    post = {
        "id": f"{q}{i:02d}",
        "text": f"Meme {q} số {i}: câu nói hot",
        "permalink": f"https://www.threads.net/t/{q}{i:02d}",
        "username": f"nguoi_dung_{i:02d}",
        "media_type": media,
        "timestamp": "2026-10-23T03:00:00+0000",
        "is_quote_post": False,
    }
    if media == "IMAGE":
        post["media_url"] = f"https://scontent.cdninstagram.com/v/t51/{q}{i:02d}.jpg"
    if media == "VIDEO":
        post["media_url"] = f"https://scontent.cdninstagram.com/v/t50/{q}{i:02d}.mp4"
        post["thumbnail_url"] = f"https://scontent.cdninstagram.com/v/t50/{q}{i:02d}-thumb.jpg"
    return post


class ThreadsGet:
    """Serves the official keyword-search endpoint (host graph.threads.net, path ending /keyword_search). Any other
    non-robots URL fails the test. `fail` (an exception instance) is raised for the search call instead."""

    def __init__(self, per_keyword=15, fail=None):
        self.per_keyword = per_keyword
        self.fail = fail
        self.requested: list[str] = []

    def __call__(self, url):
        self.requested.append(url)
        parts = urlsplit(url)
        if parts.path.endswith("/robots.txt"):
            return ("text/plain", "")
        assert parts.hostname == THREADS_HOST and parts.path.endswith("/keyword_search"), f"unexpected fetch {url}"
        if self.fail is not None:
            raise self.fail
        q = parse_qs(parts.query).get("q", [""])[0]
        data = [threads_post(q, i) for i in range(1, self.per_keyword + 1)]
        return ("application/json; charset=utf-8", json.dumps({"data": data}))

    @property
    def pages_requested(self) -> list[str]:
        return [u for u in self.requested if not urlsplit(u).path.endswith("/robots.txt")]

    @property
    def queries(self) -> list[str]:
        return [parse_qs(urlsplit(u).query).get("q", [""])[0] for u in self.pages_requested]


def test_ac_pipe_17_threads_tra_15_khai_niem_tu_noi_dung_bai():
    """AC-PIPE-17: 15 bài công khai: tên/câu nói lấy từ nội dung chữ, link nguồn = permalink, tên nguồn "Threads"."""
    from lau_meme_pipeline.crawl import RawConcept, ThreadsAdapter

    get = ThreadsGet()
    adapter = ThreadsAdapter(THREADS_ACCESS, ["meme"])
    assert adapter.name == "Threads"
    concepts = adapter.fetch(make_http(get))

    assert len(concepts) == 15
    assert all(isinstance(c, RawConcept) for c in concepts)
    assert all(c.source_name == "Threads" for c in concepts)
    posts = [threads_post("meme", i) for i in range(1, 16)]
    assert [c.source_url for c in concepts] == [p["permalink"] for p in posts]
    for concept, post in zip(concepts, posts, strict=True):
        assert 0 < len(concept.name) <= 100
        assert concept.name in post["text"]
        assert concept.quote and concept.quote in post["text"]


def test_ac_pipe_17_threads_khong_luu_ten_nguoi_dang_anh_dai_dien_link_ho_so():
    """AC-PIPE-17: khái niệm không chứa tên người đăng, link hồ sơ, URL ảnh/video."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    concepts = ThreadsAdapter(THREADS_ACCESS, ["meme"]).fetch(make_http(ThreadsGet()))
    dump = json.dumps([dataclasses.asdict(c) for c in concepts], ensure_ascii=False)
    assert "nguoi_dung" not in dump
    assert "threads.net/@" not in dump
    assert "cdninstagram" not in dump
    assert THREADS_ACCESS not in dump


def test_ac_pipe_17_threads_chi_goi_api_chinh_thuc_khong_tai_anh_video():
    """AC-PIPE-17: chỉ gọi host API chính thức của Meta (graph.threads.net), không scrape threads.net, không tải
    ảnh/video trong phản hồi."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    get = ThreadsGet()
    ThreadsAdapter(THREADS_ACCESS, ["meme", "trend"]).fetch(make_http(get))

    hosts = {urlsplit(u).hostname for u in get.requested}
    assert hosts == {THREADS_HOST}
    assert not hosts & SCRAPE_HOSTS
    assert [u for u in get.requested if urlsplit(u).path.lower().endswith(MEDIA_EXT)] == []
    assert sorted(get.queries) == ["meme", "trend"]


@pytest.mark.parametrize(
    ("token", "keywords"),
    [(None, ["meme"]), ("", ["meme"]), (THREADS_ACCESS, []), (THREADS_ACCESS, [""])],
    ids=["thieu_token", "token_rong", "khong_tu_khoa", "tu_khoa_rong"],
)
def test_ac_pipe_17_threads_thieu_cau_hinh_khong_thu_gi_va_khong_goi_mang(token, keywords):
    """AC-PIPE-17: thiếu THREADS_ACCESS_TOKEN hoặc THREADS_KEYWORDS rỗng: adapter trả [] và không gọi URL nào."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    get = ThreadsGet()
    assert ThreadsAdapter(token, keywords).fetch(make_http(get)) == []
    assert get.requested == []


def test_ac_pipe_17_threads_thieu_cau_hinh_dot_full_khong_that_bai_bao_cao_canh_bao():
    """AC-PIPE-17: thiếu cấu hình ở mẻ full: mẻ vẫn success, các nguồn khác vẫn chạy, Issue cảnh báo thiếu cấu hình
    Threads."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    client, reporter = FakeClient(), FakeReporter()
    get = ThreadsGet()
    outcome = run_full(
        client,
        reporter,
        [ThreadsAdapter(None, []), FakeAdapter("RSS", ["Meme Thử Một"])],
        crawl_get=get,
    )

    assert outcome.ok is True and outcome.status == "success"
    assert client.error_posts == []
    assert get.requested == []
    (body,) = client.success_posts
    assert body["stats"]["crawled"] == 1
    text = reporter.issues[0][1]
    assert "threads" in text.lower()
    assert "cấu hình" in text.lower()


def test_ac_pipe_17_default_adapters_doc_token_va_tu_khoa_tu_env():
    """AC-PIPE-17: default_adapters có adapter Threads đọc THREADS_ACCESS_TOKEN và THREADS_KEYWORDS (phân tách dấu
    phẩy); thiếu env thì adapter không thu gì."""
    from lau_meme_pipeline.crawl import ThreadsAdapter, default_adapters

    configured = default_adapters(
        {"YOUTUBE_API_KEY": "KEY123", "THREADS_ACCESS_TOKEN": THREADS_ACCESS, "THREADS_KEYWORDS": "meme, trend"}
    )
    (adapter,) = [a for a in configured if isinstance(a, ThreadsAdapter)]
    get = ThreadsGet()
    assert len(adapter.fetch(make_http(get))) == 30
    assert sorted(get.queries) == ["meme", "trend"]

    unconfigured = default_adapters({"YOUTUBE_API_KEY": "KEY123"})
    (idle,) = [a for a in unconfigured if isinstance(a, ThreadsAdapter)]
    get = ThreadsGet()
    assert idle.fetch(make_http(get)) == []
    assert get.requested == []


@pytest.mark.parametrize("status", [401, 403, 429])
def test_ac_pipe_17_threads_api_tu_choi_ghi_loi_nguon_threads_khong_lo_token(status):
    """AC-PIPE-17: API trả 401/403/429: lỗi nguồn "Threads: lỗi ..." theo AC-PIPE-03, nguồn khác vẫn chạy, token
    không lọt vào thông báo lỗi."""
    from lau_meme_pipeline.crawl import HttpStatus, ThreadsAdapter, crawl, crawl_report_line

    get = ThreadsGet(fail=HttpStatus(status))
    result = crawl([ThreadsAdapter(THREADS_ACCESS, ["meme"]), FakeAdapter("RSS", ["R1"])], make_http(get))

    assert [c.name for c in result.concepts] == ["R1"]
    assert len(result.errors) == 1
    assert result.errors[0]["source"] == "Threads"
    assert result.errors[0]["error"].startswith("HttpStatus")
    line = crawl_report_line(result)
    assert "Threads: lỗi" in line
    assert THREADS_ACCESS not in line + json.dumps(result.errors)


def test_ac_pipe_17_threads_toi_da_50_bai_moi_dot():
    """AC-PIPE-17: 4 từ khóa x 15 bài = 60 bài, adapter chỉ trả tối đa 50 khái niệm."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    concepts = ThreadsAdapter(THREADS_ACCESS, ["meme", "trend", "hot", "cười"]).fetch(make_http(ThreadsGet()))
    assert len(concepts) == 50
    assert len({c.source_url for c in concepts}) == 50


def test_ac_pipe_17_threads_ten_nguoi_dang_khong_toi_llm_khong_vao_noi_dung_dang():
    """AC-PIPE-17: mẻ full với adapter Threads: payload gửi mọi bước LLM, content và store đã đăng không có tên người
    đăng, link hồ sơ hay URL ảnh/video."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    client, reporter, llm = FakeClient(), FakeReporter(), make_llm()
    outcome = run_full(client, reporter, [ThreadsAdapter(THREADS_ACCESS, ["meme"])], llm, crawl_get=ThreadsGet())

    assert outcome.ok is True
    (body,) = client.success_posts
    assert body["stats"]["crawled"] == 15
    sent = json.dumps([p for step in llm.values() for p in step.payloads], ensure_ascii=False, default=str)
    published = json.dumps({"content": body["content"], "store": body["store"]}, ensure_ascii=False)
    for text in (sent, published):
        assert "nguoi_dung" not in text
        assert "threads.net/@" not in text
        assert "cdninstagram" not in text
        assert THREADS_ACCESS not in text
    assert llm["classify"].calls >= 1


# ================================================================ AC-PIPE-16: trend_peak

CCN = "Còn Cái Nịt"
STONKS = "Stonks"
NEW_MEME = "Meme Thử Một"


def round_one_adapters():
    return [
        FakeAdapter("Reddit", ["con cai nit", "CÒN CÁI NỊT!!", "stonks"]),
        FakeAdapter("RSS", ["còn cái nịt", NEW_MEME]),
        FakeAdapter("Google Trends VN", ["Con Cai Nit", "meme thử một!"]),
    ]


def initial_catalog() -> list[dict]:
    return [
        {"id": eid(CCN), "first_version": 1, "trend_peak": 2},
        {"id": eid(STONKS), "first_version": 1, "trend_peak": 0},
    ]


def peaks(body: dict) -> dict[str, int | None]:
    """name -> trend_peak sent in content.elements (None when the field is absent = keep the stored value)."""
    return {e["name"]: e.get("trend_peak") for e in body["content"]["elements"]}


def catalog_from(body: dict) -> list[dict]:
    """What the Worker would report in the next /pipeline/state after publishing `body`."""
    return [
        {"id": e["id"], "first_version": body["version"], "trend_peak": e.get("trend_peak") or 0}
        for e in body["content"]["elements"]
    ]


def effective(body: dict, name: str, previous: int) -> int:
    value = peaks(body)[name]
    return previous if value is None else value


def run_round_one(catalog=None, batch_at=T):
    client, reporter = FakeClient(catalog=catalog if catalog is not None else initial_catalog()), FakeReporter()
    outcome = run_full(client, reporter, round_one_adapters(), batch_at=batch_at)
    assert outcome.ok is True, outcome.failed_step
    (body,) = client.success_posts
    return client, reporter, body


def test_ac_pipe_16_sau_dot_1_con_cai_nit_4_stonks_1_meme_moi_2():
    """AC-PIPE-16: 4 khái niệm (3 nguồn) về "Còn Cái Nịt" nâng trend_peak 2 lên 4; "Stonks" 0 lên 1; meme mới do 2
    khái niệm gộp thành có trend_peak 2; phần tử không được crawl thấy giữ 0."""
    _, _, body = run_round_one()

    assert NEW_MEME in peaks(body)
    assert effective(body, CCN, 2) == 4
    assert effective(body, STONKS, 0) == 1
    assert effective(body, NEW_MEME, 0) == 2
    others = {n: v for n, v in peaks(body).items() if n not in (CCN, STONKS, NEW_MEME)}
    assert others and all((v or 0) == 0 for v in others.values())
    assert all(isinstance(v, int) and v >= 0 for v in peaks(body).values() if v is not None)


def test_ac_pipe_16_dot_2_chi_thay_1_khai_niem_thi_trend_peak_van_4():
    """AC-PIPE-16: đợt sau crawl được 1 khái niệm về "Còn Cái Nịt": trend_peak vẫn 4 (mức cao nhất từng ghi), các
    phần tử khác giữ nguyên."""
    _, _, body1 = run_round_one()
    client2, reporter2 = FakeClient(store=body1["store"], catalog=catalog_from(body1)), FakeReporter()
    outcome = run_full(client2, reporter2, [FakeAdapter("RSS", ["con cai nit"])], batch_at=T2)

    assert outcome.ok is True
    (body2,) = client2.success_posts
    assert effective(body2, CCN, 4) == 4
    assert effective(body2, STONKS, 1) == 1
    assert effective(body2, NEW_MEME, 2) == 2


def test_ac_pipe_16_me_core_khong_doi_trend_peak():
    """AC-PIPE-16: mẻ core không đổi trend_peak: mọi phần tử vắng trường hoặc đúng bằng giá trị trong catalog."""
    catalog = [
        {"id": eid(CCN), "first_version": 1, "trend_peak": 4},
        {"id": eid(STONKS), "first_version": 1, "trend_peak": 1},
    ]
    client, reporter = FakeClient(catalog=catalog), FakeReporter()
    outcome = run_full(client, reporter, [], mode="core")

    assert outcome.ok is True
    (body,) = client.success_posts
    assert effective(body, CCN, 4) == 4
    assert effective(body, STONKS, 1) == 1
    assert all((v or 0) == 0 for n, v in peaks(body).items() if n not in (CCN, STONKS))


def test_ac_pipe_16_dot_loi_khong_gui_trend_peak_va_khong_dang_gi():
    """AC-PIPE-16: đợt lỗi (LLM ném lỗi thường) không đăng success; thân đợt lỗi không mang trend_peak nào."""

    def boom(items):
        raise RuntimeError("boom")

    client, reporter = FakeClient(catalog=initial_catalog()), FakeReporter()
    outcome = run_full(client, reporter, round_one_adapters(), make_llm(describe=boom))

    assert outcome.ok is False
    assert client.success_posts == []
    assert "trend_peak" not in json.dumps(client.error_posts)


def test_ac_pipe_16_chay_lai_cung_dot_khong_cong_don():
    """AC-PIPE-16: chạy lại cùng đợt (cùng crawl, cùng kho đầu vào): trend_peak không cộng dồn, kể cả khi catalog đã
    mang kết quả đợt trước (4 / 1 / 2)."""
    _, _, first = run_round_one()
    _, _, again_same_catalog = run_round_one()
    _, _, again_new_catalog = run_round_one(catalog=catalog_from(first))

    for body in (first, again_same_catalog, again_new_catalog):
        assert (effective(body, CCN, 4), effective(body, STONKS, 1), effective(body, NEW_MEME, 2)) == (4, 1, 2)
    assert peaks(again_same_catalog) == peaks(first)


def test_ac_pipe_16_bao_cao_liet_ke_phan_tu_trending_ten_khong_o_tieu_de():
    """AC-PIPE-16: Issue liệt kê các phần tử trending cao nhất (kèm mức) trong nội dung; tên không có trong tiêu đề."""
    _, reporter, _ = run_round_one()

    title, text = reporter.issues[0]
    for name in (CCN, STONKS, NEW_MEME):
        assert name not in title
        assert name in text
    assert re.search(rf"{CCN}[^\n]{{0,40}}\b4\b", text)
    assert re.search(rf"{NEW_MEME}[^\n]{{0,40}}\b2\b", text)


# ================================================================ AC-ADMIN-11 (pipeline half: stats sent with the log)


class RobotsDenied(Exception):
    """Local stand-in: the batch records the exception TYPE NAME as the source error."""


def test_ac_admin_11_pipeline_gui_thong_ke_nguon_va_hang_cho_cung_nhat_ky_dot():
    """AC-ADMIN-11: mẻ full gửi stats.sources (mỗi nguồn: số khái niệm, nguồn lỗi có loại lỗi và concepts null) và
    stats.queue_size = số meme đang trong hàng chờ; mẻ core không có stats.sources."""
    client, reporter = FakeClient(), FakeReporter()
    adapters = [
        FakeAdapter("Reddit", error=RobotsDenied()),
        FakeAdapter("Know Your Meme", ["Meme Thử Một", "Meme Thử Hai", "Meme Thử Ba"]),
    ]

    def link_only_first(items):
        return [{"key": i["key"], "pairs": [["AFK", "Aura"]] if n == 0 else []} for n, i in enumerate(items)]

    outcome = run_full(client, reporter, adapters, make_llm(link=link_only_first))

    assert outcome.ok is True
    (body,) = client.success_posts
    stats = body["stats"]
    assert stats["sources"] == [
        {"source": "Reddit", "concepts": None, "error": "RobotsDenied"},
        {"source": "Know Your Meme", "concepts": 3, "error": None},
    ]
    assert stats["crawled"] == 3
    assert stats["queue_size"] == len(body["store"]["queue"]) == stats["queued"] == 2
    assert stats["source_errors"] == [{"source": "Reddit", "error": "RobotsDenied"}]

    core_client = FakeClient()
    run_full(core_client, FakeReporter(), [], mode="core")
    assert "sources" not in core_client.success_posts[0]["stats"]
