"""Acceptance tests for docs/acceptance/pipe.md, phase 2: AC-PIPE-04 (crawl transport).

Expected public surface of lau_meme_pipeline.crawl:

    http_get(url) -> (content_type, body)      single hop, https only
    Redirect(location)                         on 301/302/303/307/308 with a Location header; `.location` absolute
    NotText, HttpStatus(status) (`.status`), RobotsDenied
    Http(get).text(url)                        follows at most 3 https redirects, robots.txt checked on EVERY host

The network is mocked at the connection layer (http.client.HTTPSConnection); nothing real is contacted.
Imports happen inside the tests so a missing name fails at runtime, not at collection.
"""

import http.client

import pytest

MAX_BYTES = 2 * 1024 * 1024


class FakeResponse:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.reason = "X"
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._body = body
        self.read_calls: list = []
        self.closed = False

    def getheader(self, name, default=None):
        return self.headers.get(name.lower(), default)

    def getheaders(self):
        return list(self.headers.items())

    def read(self, n=None):
        self.read_calls.append(n)
        return self._body if n is None else self._body[:n]

    def close(self):
        self.closed = True


def install(monkeypatch, response):
    """Replace HTTPSConnection; return the list of (host, method, path) requests."""
    seen: list[tuple] = []

    class FakeConn:
        def __init__(self, host, *args, **kwargs):
            self.host = host

        def request(self, method, url, body=None, headers=None, **kwargs):
            seen.append((self.host, method, url))

        def getresponse(self):
            return response

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", FakeConn)
    return seen


# ================================================================ http_get


def test_ac_pipe_04_http_get_tu_choi_url_http_khong_mo_ket_noi(monkeypatch):
    """AC-PIPE-04: URL http:// bị ValueError và không mở kết nối nào."""
    from lau_meme_pipeline.crawl import http_get

    opened: list = []

    def boom(*args, **kwargs):
        opened.append(args)
        raise AssertionError("no connection allowed")

    monkeypatch.setattr(http.client, "HTTPSConnection", boom)
    monkeypatch.setattr(http.client, "HTTPConnection", boom)
    with pytest.raises(ValueError):
        http_get("http://ex.com/a")
    assert opened == []


@pytest.mark.parametrize(
    ("status", "location", "expected"),
    [
        (301, "https://other.example.org/b", "https://other.example.org/b"),
        (302, "/moved", "https://ex.com/moved"),
        (302, "next", "https://ex.com/dir/next"),
    ],
    ids=["301_absolute", "302_root_relative", "302_relative"],
)
def test_ac_pipe_04_chuyen_huong_nem_redirect_voi_dia_chi_tuyet_doi_va_khong_doc_body(
    monkeypatch, status, location, expected
):
    """AC-PIPE-04: 301/302 có Location ném Redirect với .location tuyệt đối; thân trang KHÔNG được đọc."""
    from lau_meme_pipeline.crawl import Redirect, http_get

    response = FakeResponse(status, {"Location": location, "Content-Type": "text/html"}, b"<html>moved</html>")
    install(monkeypatch, response)

    with pytest.raises(Redirect) as info:
        http_get("https://ex.com/dir/a")

    assert info.value.location == expected
    assert response.read_calls == []


def test_ac_pipe_04_content_type_anh_nem_not_text_va_khong_doc_body(monkeypatch):
    """AC-PIPE-04: Content-Type image/png ném NotText và không gọi read()."""
    from lau_meme_pipeline.crawl import NotText, http_get

    response = FakeResponse(200, {"Content-Type": "image/png"}, b"\x89PNG")
    install(monkeypatch, response)

    with pytest.raises(NotText):
        http_get("https://ex.com/a")

    assert response.read_calls == []


def test_ac_pipe_04_than_trang_qua_2mb_bi_cat_o_muc_tran(monkeypatch):
    """AC-PIPE-04: trang text/html lớn hơn 2 MB: body trả về không quá 2 MiB (read nhận giới hạn kích thước)."""
    from lau_meme_pipeline.crawl import http_get

    response = FakeResponse(200, {"Content-Type": "text/html; charset=utf-8"}, b"a" * (3 * 1024 * 1024))
    install(monkeypatch, response)

    content_type, body = http_get("https://ex.com/big")

    assert content_type.startswith("text/html")
    assert 0 < len(body) <= MAX_BYTES
    assert None not in response.read_calls
    assert all(isinstance(n, int) and n <= MAX_BYTES + 1 for n in response.read_calls)


def test_ac_pipe_04_charset_la_van_giai_ma_utf8_khong_loi(monkeypatch):
    """AC-PIPE-04: charset=x-unknown giải mã bằng utf-8, không ném lỗi."""
    from lau_meme_pipeline.crawl import http_get

    text = "Còn Cái Nịt"
    response = FakeResponse(200, {"Content-Type": "text/html; charset=x-unknown"}, text.encode("utf-8"))
    install(monkeypatch, response)

    _, body = http_get("https://ex.com/a")

    assert body == text


def test_ac_pipe_04_http_404_nem_http_status(monkeypatch):
    """AC-PIPE-04: HTTP 404 ném HttpStatus với .status == 404."""
    from lau_meme_pipeline.crawl import HttpStatus, http_get

    install(monkeypatch, FakeResponse(404, {"Content-Type": "text/html"}, b"nope"))

    with pytest.raises(HttpStatus) as info:
        http_get("https://ex.com/missing")

    assert info.value.status == 404


# ================================================================ Http.text redirects


class FakeGet:
    """get(url) -> (content_type, body) | raises. `pages` maps a full URL to a tuple or an exception instance.
    A robots.txt URL that is not in `pages` is an empty (allow all) file."""

    def __init__(self, pages=None):
        self.pages = dict(pages or {})
        self.requested: list[str] = []

    def __call__(self, url):
        self.requested.append(url)
        if url in self.pages:
            page = self.pages[url]
            if isinstance(page, Exception):
                raise page
            return page
        if url.endswith("/robots.txt"):
            return ("text/plain", "")
        raise AssertionError(f"unexpected fetch {url}")


def make_http(pages):
    from lau_meme_pipeline.crawl import Http

    get = FakeGet(pages)
    return Http(get), get


def redirect(location):
    from lau_meme_pipeline.crawl import Redirect

    return Redirect(location)


def page_requests(get):
    return [u for u in get.requested if not u.endswith("/robots.txt")]


def test_ac_pipe_04_theo_chuyen_huong_https_va_kiem_robots_tung_host():
    """AC-PIPE-04: chuyển hướng https sang host khác được theo; robots.txt của CẢ HAI host được kiểm."""
    http, get = make_http(
        {
            "https://a.example/x": redirect("https://b.example/y"),
            "https://b.example/y": ("text/html", "nội dung đích"),
        }
    )

    assert http.text("https://a.example/x") == "nội dung đích"

    assert "https://a.example/robots.txt" in get.requested
    assert "https://b.example/robots.txt" in get.requested
    assert page_requests(get) == ["https://a.example/x", "https://b.example/y"]


def test_ac_pipe_04_robots_cua_host_dich_cam_thi_khong_tai_url_dich():
    """AC-PIPE-04: robots.txt của host đích cấm đường dẫn thì RobotsDenied và URL đích không bao giờ được tải."""
    from lau_meme_pipeline.crawl import RobotsDenied

    http, get = make_http(
        {
            "https://a.example/x": redirect("https://b.example/private/y"),
            "https://b.example/robots.txt": ("text/plain", "User-agent: *\nDisallow: /private"),
            "https://b.example/private/y": ("text/html", "bí mật"),
        }
    )

    with pytest.raises(RobotsDenied):
        http.text("https://a.example/x")

    assert "https://b.example/private/y" not in get.requested


def test_ac_pipe_04_chuyen_huong_sang_http_bi_loi_va_khong_tai():
    """AC-PIPE-04: chuyển hướng sang http:// là lỗi (ValueError hoặc NotText) và URL đó không bao giờ được tải."""
    from lau_meme_pipeline.crawl import NotText

    http, get = make_http({"https://a.example/x": redirect("http://a.example/plain")})

    with pytest.raises((ValueError, NotText)):
        http.text("https://a.example/x")

    assert "http://a.example/plain" not in get.requested
    assert not [u for u in get.requested if u.startswith("http://")]


def test_ac_pipe_04_toi_da_3_lan_chuyen_huong():
    """AC-PIPE-04: 3 lần chuyển hướng vẫn được theo; lần thứ 4 là lỗi và trang cuối không được tải."""
    chain = {
        "https://h0.example/p": redirect("https://h1.example/p"),
        "https://h1.example/p": redirect("https://h2.example/p"),
        "https://h2.example/p": redirect("https://h3.example/p"),
        "https://h3.example/p": ("text/html", "đích 3"),
    }
    http, _ = make_http(chain)
    assert http.text("https://h0.example/p") == "đích 3"

    too_long = {
        **chain,
        "https://h3.example/p": redirect("https://h4.example/p"),
        "https://h4.example/p": ("text/html", "quá xa"),
    }
    http, get = make_http(too_long)
    with pytest.raises(Exception) as info:
        http.text("https://h0.example/p")
    assert not isinstance(info.value, AssertionError)
    assert "https://h4.example/p" not in get.requested


def test_ac_pipe_04_robots_txt_chuyen_huong_mot_lan_sang_https_cung_host_duoc_theo():
    """AC-PIPE-04: robots.txt chuyển hướng một lần (https, cùng host) vẫn được đọc: đường dẫn cho phép được tải,
    đường dẫn bị cấm trong file đích thì RobotsDenied."""
    from lau_meme_pipeline.crawl import RobotsDenied

    pages = {
        "https://ex.com/robots.txt": redirect("https://ex.com/real-robots.txt"),
        "https://ex.com/real-robots.txt": ("text/plain", "User-agent: *\nDisallow: /private"),
        "https://ex.com/public/a": ("text/html", "công khai"),
        "https://ex.com/private/a": ("text/html", "bí mật"),
    }
    http, get = make_http(pages)

    assert http.text("https://ex.com/public/a") == "công khai"
    assert "https://ex.com/real-robots.txt" in get.requested
    with pytest.raises(RobotsDenied):
        http.text("https://ex.com/private/a")
    assert "https://ex.com/private/a" not in get.requested


def test_ac_pipe_04_thong_bao_loi_khong_chua_url():
    """AC-PIPE-04: thông báo của NotText và RobotsDenied không chứa URL (có thể rỗng)."""
    from lau_meme_pipeline.crawl import NotText, RobotsDenied

    private_url = "https://ex.com/private/token-abc123.jpg"
    http, _ = make_http({})
    with pytest.raises(NotText) as not_text:
        http.text(private_url)
    assert "token-abc123" not in str(not_text.value) + repr(not_text.value)

    url = "https://ex.com/private/token-xyz789"
    http, _ = make_http({"https://ex.com/robots.txt": ("text/plain", "User-agent: *\nDisallow: /private")})
    with pytest.raises(RobotsDenied) as denied:
        http.text(url)
    assert "token-xyz789" not in str(denied.value) + repr(denied.value)
