"""Acceptance tests for docs/acceptance/art.md, AC-ART-14 phía pipeline (ADR 0018).

Giao diện dự kiến (chưa có code production, viết đúng theo đây):

    lau_meme_pipeline.links
        LinkRefused(Exception), MAX_LINK_BYTES = 1_048_576, MAX_REDIRECTS = 3
        check_target(url, addresses) -> None
            raise LinkRefused nếu không phải https hoặc có địa chỉ không công khai
        fetch_link(url, *, http, resolve) -> bytes
            http(url) -> (status, location | None, body <= MAX_LINK_BYTES + 1 byte), một yêu cầu, không tự theo
            chuyển hướng; resolve(host) -> các IP
    run_batch(mode="full", ..., art=..., link_image=callable(url) -> "<12 hex>.webp" | raise)
        đọc state["image_links"] = [{element_id, url}] của GET /pipeline/state; phần tử có trong image_links không
        bao giờ được đưa cho adapter vẽ; link_image thành công thì image_key của phần tử là khóa trả về (coi là có
        ảnh khi tính tier), thất bại thì phần tử giữ emoji; báo cáo đợt ghi "- Link ảnh lỗi: N" khi N > 0
        (không ghi link).
    FullOutcome.report["link_images_failed"] chỉ kiểm qua dòng báo cáo (test đi qua run_batch).

Không có mạng, không có DNS, không có đồng hồ thật: http/resolve/link_image đều là hàm giả.
"""

import ipaddress
import json
import re
from datetime import timedelta

import pytest

from test_art_full_batch import ArtClient, Check, Draw, art_adapters, content_element
from test_contrib import HINT, HINT2, NAME, NAME2, decrypted, deep_pair, free_pairs, leaf_name, row, with_blocked
from test_pipe_full_batch import (
    MEME,
    FakeAdapter,
    FakeReporter,
    Recording,
    T,
    _classify,
    _describe,
    _judge,
    _link,
    _same,
    _supplement_element,
    _supplement_pair,
    make_llm,
)
from test_tier import graph_tiers, make_state, real_core, table

URL = "https://example.com/a.png"
URL2 = "https://example.org/b.webp"
LINK_IMG = "0a1b2c3d4e5f.webp"
LINK_IMG2 = "f5e4d3c2b1a0.webp"
FAILED_LINE = re.compile(r"^- Link ảnh lỗi: (\d+)$", re.MULTILINE)
PUBLIC_V4 = "93.184.216.34"
PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946"
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 64


# ---------------------------------------------------------------- helpers


def link_state(*links: tuple[str, str], contributions=()) -> dict:
    """State với đề xuất đã duyệt và image_links [(tên phần tử, url)]."""
    from test_tier import eid

    state = make_state(contributions=contributions)
    state["image_links"] = [{"element_id": eid(name), "url": url} for name, url in links]
    return state


class LinkImage:
    """link_image giả: ghi lại url được gọi; trả khóa theo url, hoặc ném `exc` (mọi url, hoặc chỉ url `failing`)."""

    def __init__(self, keys=None, exc=None, failing=None):
        self.keys = keys or {URL: LINK_IMG, URL2: LINK_IMG2}
        self.exc = exc
        self.failing = failing
        self.urls: list[str] = []

    def __call__(self, url):
        self.urls.append(url)
        if self.exc is not None and (self.failing is None or url in self.failing):
            raise self.exc
        return self.keys[url]


def run_links(state, link_image, *, draw=None, llm=None, names=(), client=None, reporter=None, batch_at=T):
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    client = client if client is not None else ArtClient()
    reporter = reporter if reporter is not None else FakeReporter()
    draw = draw if draw is not None else Draw()
    client.state = state
    outcome = run_batch(
        mode="full",
        batch_at=batch_at,
        core=real_core(),
        client=client,
        reporter=reporter,
        adapters=[FakeAdapter("RSS", list(names))],
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=llm if llm is not None else make_llm(),
        log=lambda m: None,
        banned_words=[],
        art=art_adapters(draw, Check()),
        link_image=link_image,
    )
    return outcome, client, reporter, draw


def failed_count(reporter) -> int | None:
    found = FAILED_LINE.findall(reporter.issues[0][1])
    return int(found[0]) if found else None


# ================================================================ links.check_target


def test_ac_art_14_check_target_chap_nhan_https_voi_dia_chi_cong_khai():
    """AC-ART-14: https với mọi địa chỉ là unicast công khai (IPv4 và IPv6) thì không bị từ chối."""
    from lau_meme_pipeline.links import check_target

    check_target(URL, [PUBLIC_V4])
    check_target(URL, [PUBLIC_V6])
    check_target(URL, [PUBLIC_V4, PUBLIC_V6])
    check_target("https://example.com:443/a.png", [PUBLIC_V4])


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.8.8.8",
        "::1",
        "10.0.0.5",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.1.1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        str(ipaddress.IPv4Address(0)),  # 0.0.0.0
        "::",
        "224.0.0.1",
        "ff02::1",
        "240.0.0.1",
        "255.255.255.255",
        "100.64.0.1",
        "100.127.255.254",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",  # NAT64 of 127.0.0.1
        "2002:7f00:1::1",  # 6to4 of 127.0.0.1
    ],
)
def test_ac_art_14_check_target_tu_choi_dia_chi_noi_bo_loopback_mang_rieng(address):
    """AC-ART-14: loopback, mạng riêng, link-local (cả 169.254.169.254), CGNAT, multicast, dành riêng bị từ chối,
    kể cả khi chỉ một trong các địa chỉ phân giải là địa chỉ như vậy."""
    from lau_meme_pipeline.links import LinkRefused, check_target

    with pytest.raises(LinkRefused):
        check_target(URL, [address])
    with pytest.raises(LinkRefused):
        check_target(URL, [PUBLIC_V4, address])


def test_ac_art_14_check_target_tu_choi_danh_sach_dia_chi_rong():
    """AC-ART-14: tên miền không phân giải ra địa chỉ nào thì bị từ chối."""
    from lau_meme_pipeline.links import LinkRefused, check_target

    with pytest.raises(LinkRefused):
        check_target(URL, [])


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a.png",
        "ftp://example.com/a.png",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "//example.com/a.png",
        "example.com/a.png",
        "https:///a.png",
        "https://",
        "",
        "https://example.com:6379/a.png",
        "https://example.com:8443/a.png",
        "https://example.com:99999/a.png",
    ],
)
def test_ac_art_14_check_target_chi_nhan_https_co_may_chu(url):
    """AC-ART-14: chỉ https:// có tên máy chủ; http, ftp, file, javascript, thiếu scheme hoặc host đều bị từ chối."""
    from lau_meme_pipeline.links import LinkRefused, check_target

    with pytest.raises(LinkRefused):
        check_target(url, [PUBLIC_V4])


def test_ac_art_14_gioi_han_hang_so():
    """AC-ART-14: tối đa 1 MB và 3 lần chuyển hướng."""
    from lau_meme_pipeline.links import MAX_LINK_BYTES, MAX_REDIRECTS

    assert MAX_LINK_BYTES == 1_048_576
    assert MAX_REDIRECTS == 3


# ================================================================ links.fetch_link


class FakeHttp:
    """http(url) -> phản hồi kế tiếp (status, location, body) của kịch bản; ghi lại url đã gọi."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.urls: list[str] = []

    def __call__(self, url):
        self.urls.append(url)
        return self.responses.pop(0) if self.responses else (200, None, PNG)


class FakeResolve:
    """resolve(host) -> IP theo bảng `table` (mặc định công khai); ghi lại host đã phân giải."""

    def __init__(self, table_=None):
        self.table = table_ or {}
        self.hosts: list[str] = []

    def __call__(self, host):
        self.hosts.append(host)
        return self.table.get(host, [PUBLIC_V4])


def fetch(url, http, resolve=None):
    from lau_meme_pipeline.links import fetch_link

    return fetch_link(url, http=http, resolve=resolve if resolve is not None else FakeResolve())


def test_ac_art_14_fetch_link_tra_ve_noi_dung_khi_200():
    """AC-ART-14: link https công khai trả 200: trả đúng các byte, kiểm đích trước khi gọi, đúng một yêu cầu."""
    http, resolve = FakeHttp((200, None, PNG)), FakeResolve()
    assert fetch(URL, http, resolve) == PNG
    assert http.urls == [URL]
    assert resolve.hosts == ["example.com"]


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_ac_art_14_fetch_link_theo_chuyen_huong_va_giai_quyet_location_tuong_doi(status):
    """AC-ART-14: mã 301/302/303/307/308 có Location thì được theo; Location tương đối hiểu theo url hiện tại; mỗi
    bước đều phân giải và kiểm lại máy chủ."""
    http = FakeHttp((status, "/b/c.png", b""), (status, "https://cdn.example.org/d.png", b""), (200, None, PNG))
    resolve = FakeResolve()
    assert fetch(URL, http, resolve) == PNG
    assert http.urls == [URL, "https://example.com/b/c.png", "https://cdn.example.org/d.png"]
    assert resolve.hosts == ["example.com", "example.com", "cdn.example.org"]


def test_ac_art_14_fetch_link_toi_da_ba_lan_chuyen_huong():
    """AC-ART-14: đúng 3 lần chuyển hướng rồi 200 thì được; lần chuyển hướng thứ 4 thì bị từ chối."""
    from lau_meme_pipeline.links import LinkRefused

    hop = (302, "/next", b"")
    assert fetch(URL, FakeHttp(hop, hop, hop, (200, None, PNG))) == PNG

    http = FakeHttp(hop, hop, hop, hop, (200, None, PNG))
    with pytest.raises(LinkRefused):
        fetch(URL, http)
    assert len(http.urls) <= 4, "không được gọi thêm sau khi vượt số lần chuyển hướng"


def test_ac_art_14_fetch_link_vong_chuyen_huong_bi_tu_choi():
    """AC-ART-14: chuyển hướng vô hạn về chính nó thì bị từ chối sau vài yêu cầu, không lặp mãi."""
    from lau_meme_pipeline.links import LinkRefused

    http = FakeHttp(*[(302, URL, b"")] * 50)
    with pytest.raises(LinkRefused):
        fetch(URL, http)
    assert len(http.urls) <= 4


def test_ac_art_14_fetch_link_chuyen_huong_sang_http_bi_tu_choi_va_khong_goi_http():
    """AC-ART-14: chuyển hướng sang http:// thì bị từ chối; yêu cầu http:// không bao giờ được gửi."""
    from lau_meme_pipeline.links import LinkRefused

    http = FakeHttp((302, "http://example.com/a.png", b""), (200, None, PNG))
    with pytest.raises(LinkRefused):
        fetch(URL, http)
    assert http.urls == [URL]


@pytest.mark.parametrize("bad_ip", ["127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "::1", "fd00::5"])
def test_ac_art_14_fetch_link_chuyen_huong_vao_dia_chi_noi_bo_bi_tu_choi_truoc_khi_goi(bad_ip):
    """AC-ART-14: link công khai chuyển hướng sang máy chủ phân giải ra địa chỉ nội bộ: bị từ chối, yêu cầu thứ hai
    không bao giờ được gửi."""
    from lau_meme_pipeline.links import LinkRefused

    http = FakeHttp((302, "https://internal.example.net/x.png", b""), (200, None, PNG))
    resolve = FakeResolve({"internal.example.net": [bad_ip]})
    with pytest.raises(LinkRefused):
        fetch(URL, http, resolve)
    assert http.urls == [URL]


@pytest.mark.parametrize("bad_ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"])
def test_ac_art_14_fetch_link_dia_chi_dau_noi_bo_thi_khong_goi_http_lan_nao(bad_ip):
    """AC-ART-14: link đầu đã phân giải ra địa chỉ nội bộ (hoặc lẫn một địa chỉ nội bộ trong số công khai): từ chối,
    http không bao giờ được gọi."""
    from lau_meme_pipeline.links import LinkRefused

    for addresses in ([bad_ip], [PUBLIC_V4, bad_ip]):
        http = FakeHttp((200, None, PNG))
        with pytest.raises(LinkRefused):
            fetch(URL, http, FakeResolve({"example.com": addresses}))
        assert http.urls == []


@pytest.mark.parametrize("url", ["http://example.com/a.png", "ftp://example.com/a.png", "file:///etc/passwd"])
def test_ac_art_14_fetch_link_khong_phai_https_thi_khong_goi_http(url):
    """AC-ART-14: link đầu không phải https:// thì bị từ chối trước khi gửi bất kỳ yêu cầu nào."""
    from lau_meme_pipeline.links import LinkRefused

    http = FakeHttp((200, None, PNG))
    with pytest.raises(LinkRefused):
        fetch(url, http)
    assert http.urls == []


@pytest.mark.parametrize("status", [204, 400, 403, 404, 410, 500, 503])
def test_ac_art_14_fetch_link_trang_thai_khac_200_va_khac_chuyen_huong_bi_tu_choi(status):
    """AC-ART-14: link không tải được (4xx, 5xx, 204) thì bị từ chối."""
    from lau_meme_pipeline.links import LinkRefused

    with pytest.raises(LinkRefused):
        fetch(URL, FakeHttp((status, None, b"")))


def test_ac_art_14_fetch_link_chuyen_huong_khong_co_location_bi_tu_choi():
    """AC-ART-14: 302 không có Location thì bị từ chối."""
    from lau_meme_pipeline.links import LinkRefused

    with pytest.raises(LinkRefused):
        fetch(URL, FakeHttp((302, None, b"")))


def test_ac_art_14_fetch_link_toi_da_1_mb():
    """AC-ART-14: nội dung đúng 1 MB (1_048_576 byte) được nhận; dài hơn một byte thì bị từ chối."""
    from lau_meme_pipeline.links import MAX_LINK_BYTES, LinkRefused

    exact = b"y" * MAX_LINK_BYTES
    assert fetch(URL, FakeHttp((200, None, exact))) == exact
    with pytest.raises(LinkRefused):
        fetch(URL, FakeHttp((200, None, b"y" * (MAX_LINK_BYTES + 1))))


# ================================================================ run_batch: link_image


def test_ac_art_14_link_tai_thanh_cong_phan_tu_nhan_khoa_anh_va_khong_bao_gio_bi_ve():
    """AC-ART-14: đề xuất có trong image_links, link_image trả khóa K: gọi đúng 1 lần với url; content và graph mang
    image_key K; adapter vẽ không bao giờ nhận gợi ý ảnh của phần tử; không có dòng "Link ảnh lỗi"."""
    (p1,) = free_pairs(1)
    link_image = LinkImage()
    state = link_state((NAME, URL), contributions=[row(NAME, *p1, hint=HINT2)])
    outcome, client, reporter, draw = run_links(state, link_image)

    assert outcome.ok is True
    assert link_image.urls == [URL]
    assert not any(HINT2 in p for p in draw.prompts)
    (body,) = client.success_posts
    assert content_element(body, NAME)["image_key"] == LINK_IMG
    assert decrypted(body, *p1)["image_key"] == LINK_IMG
    assert failed_count(reporter) is None


def test_ac_art_14_doi_chung_khong_co_link_thi_phan_tu_dong_gop_duoc_ve():
    """AC-ART-14: đối chứng: cùng đề xuất nhưng không có image_links thì adapter vẽ nhận gợi ý ảnh của nó, và
    link_image không được gọi."""
    (p1,) = free_pairs(1)
    link_image = LinkImage()
    outcome, _client, _reporter, draw = run_links(make_state(contributions=[row(NAME, *p1, hint=HINT2)]), link_image)

    assert outcome.ok is True
    assert any(HINT2 in p for p in draw.prompts)
    assert link_image.urls == []


def test_ac_art_14_anh_tu_link_duoc_coi_la_co_anh_khi_tinh_tier_va_loi_thi_khong():
    """AC-ART-14: phần tử đóng góp ở độ sâu 6: link tải được thì auto_tier theo bảng với ảnh (>= 4), graph mang tier
    đó; link lỗi thì không có ảnh nên bị giữ ở Xanh dương (3)."""
    a, b, depth = deep_pair()
    assert table(depth, True) >= 4 and table(depth, False) == 3
    rows = [row(NAME, a, b, hint=HINT2)]

    _, client, _, _ = run_links(link_state((NAME, URL), contributions=rows), LinkImage())
    (body,) = client.success_posts
    assert content_element(body, NAME)["auto_tier"] == table(depth, True)
    assert graph_tiers(body)[content_element(body, NAME)["id"]] == table(depth, True)

    _, client, _, _ = run_links(link_state((NAME, URL), contributions=rows), LinkImage(exc=RuntimeError("down")))
    (body,) = client.success_posts
    assert content_element(body, NAME).get("image_key") is None
    assert content_element(body, NAME)["auto_tier"] == 3


@pytest.mark.parametrize(
    "exc", [RuntimeError("không tải được"), ValueError("không phải ảnh"), OSError("hết giờ"), Exception("lỗi bất kỳ")]
)
def test_ac_art_14_link_loi_thi_giu_emoji_khong_ve_va_bao_cao_dem_khong_ghi_link(exc):
    """AC-ART-14: link_image ném lỗi bất kỳ: mẻ vẫn success, phần tử không có image_key, adapter vẽ không nhận gợi ý
    của nó, báo cáo đợt có đúng dòng "- Link ảnh lỗi: 1" và không chứa link."""
    (p1,) = free_pairs(1)
    state = link_state((NAME, URL), contributions=[row(NAME, *p1, hint=HINT2)])
    outcome, client, reporter, draw = run_links(state, LinkImage(exc=exc))

    assert outcome.ok is True and outcome.status == "success"
    assert not any(HINT2 in p for p in draw.prompts)
    (body,) = client.success_posts
    assert content_element(body, NAME).get("image_key") is None
    assert failed_count(reporter) == 1
    text = reporter.issues[0][1]
    assert URL not in text and "example.com" not in text
    assert f"- Lỗi link ảnh theo loại: {type(exc).__name__} 1" in text
    assert client.puts == []


def test_ac_art_14_read_body_doc_theo_khuc_toi_da_1_mb_va_het_gio_tong():
    """AC-ART-14: thân đọc theo khúc, dừng ở MAX_LINK_BYTES + 1 byte; máy chủ trả nhỏ giọt quá hạn chót tổng
    (15 giây cho cả lần tải) thì bị từ chối."""
    from lau_meme_pipeline.links import MAX_LINK_BYTES, LinkRefused, read_body

    data = b"x" * (MAX_LINK_BYTES + 100)
    sent = []

    def read(n):
        chunk = data[sum(sent) : sum(sent) + n]
        sent.append(len(chunk))
        return chunk

    assert len(read_body(read, deadline=10.0, clock=lambda: 0.0)) == MAX_LINK_BYTES + 1
    chunks = iter([b"ab", b"c", b""])
    assert read_body(lambda n: next(chunks), deadline=10.0, clock=lambda: 0.0) == b"abc"
    ticks = iter([0.0, 5.0, 16.0])
    with pytest.raises(LinkRefused):
        read_body(lambda n: b"a", deadline=15.0, clock=lambda: next(ticks))


def test_ac_art_14_khong_co_ham_tai_link_van_khong_ve_phan_tu_va_me_thanh_cong():
    """AC-ART-14: image_links có phần tử nhưng link_image là None (thiếu cấu hình): mẻ success, phần tử không bị vẽ bằng
    Workers AI, không có image_key."""
    (p1,) = free_pairs(1)
    state = link_state((NAME, URL), contributions=[row(NAME, *p1, hint=HINT2)])
    outcome, client, reporter, draw = run_links(state, None)

    assert outcome.ok is True
    assert not any(HINT2 in p for p in draw.prompts)
    (body,) = client.success_posts
    assert content_element(body, NAME).get("image_key") is None
    assert URL not in reporter.issues[0][1]


def test_ac_art_14_hai_link_mot_loi_mot_duoc_dem_dung_va_phan_tu_con_lai_van_co_anh():
    """AC-ART-14: hai phần tử dùng link, link thứ hai lỗi: phần tử thứ nhất có khóa, phần tử thứ hai giữ emoji, báo cáo
    "Link ảnh lỗi: 1", mỗi link_image được gọi đúng một lần."""
    p1, p2 = free_pairs(2)
    rows = [row(NAME, *p1, hint=HINT2), row(NAME2, *p2, hint=HINT)]
    state = link_state((NAME, URL), (NAME2, URL2), contributions=rows)
    link_image = LinkImage(exc=RuntimeError("404"), failing={URL2})
    outcome, client, reporter, draw = run_links(state, link_image)

    assert outcome.ok is True
    assert sorted(link_image.urls) == sorted([URL, URL2])
    assert not any(HINT in p or HINT2 in p for p in draw.prompts)
    (body,) = client.success_posts
    assert content_element(body, NAME)["image_key"] == LINK_IMG
    assert content_element(body, NAME2).get("image_key") is None
    assert failed_count(reporter) == 1


def test_ac_art_14_me_sau_thu_lai_link_da_loi():
    """AC-ART-14: mẻ 1 link lỗi (emoji, không bị vẽ); mẻ 2 (kho của mẻ 1, state vẫn có image_links) thử lại và thành
    công: phần tử có khóa, không bị vẽ, báo cáo mẻ 2 không có dòng lỗi."""
    (p1,) = free_pairs(1)
    rows = [row(NAME, *p1, hint=HINT2)]
    first = LinkImage(exc=RuntimeError("tạm lỗi"))
    _, client1, reporter1, draw1 = run_links(link_state((NAME, URL), contributions=rows), first)
    (body1,) = client1.success_posts
    assert failed_count(reporter1) == 1 and content_element(body1, NAME).get("image_key") is None

    second = LinkImage()
    client2 = ArtClient(store=body1["store"])
    outcome, client2, reporter2, draw2 = run_links(
        link_state((NAME, URL), contributions=rows), second, client=client2, batch_at=T + timedelta(hours=12)
    )
    assert outcome.ok is True
    assert second.urls == [URL]
    (body2,) = client2.success_posts
    assert content_element(body2, NAME)["image_key"] == LINK_IMG
    assert not any(HINT2 in p for p in draw1.prompts + draw2.prompts)
    assert failed_count(reporter2) is None


def test_ac_art_14_phan_tu_chua_vao_graph_thi_khong_tai_link():
    """AC-ART-14: phần tử trong image_links mà cha bị chặn nên chưa vào content: link_image không được gọi, không
    vẽ, không tính link lỗi."""
    parent = leaf_name()
    state = with_blocked(
        link_state((NAME, URL), contributions=[row(NAME, parent, "Cay", hint=HINT2)]),
        parent,
    )
    link_image = LinkImage()
    outcome, _client, reporter, draw = run_links(state, link_image)

    assert outcome.ok is True
    assert link_image.urls == []
    assert not any(HINT2 in p for p in draw.prompts)
    assert failed_count(reporter) is None


def test_ac_art_14_link_khong_bao_gio_toi_llm_adapter_ve_bao_cao_hay_noi_dung_dang():
    """AC-ART-14: mẻ có meme crawl (LLM được gọi), một đề xuất dùng link (lỗi), một đề xuất không dùng link (được vẽ):
    url không nằm trong payload LLM, prompt vẽ, báo cáo đợt hay body đăng mẻ."""
    p1, p2 = free_pairs(2)
    rows = [row(NAME, *p1, hint=HINT2), row(NAME2, *p2, hint=HINT)]
    steps = {
        "same": _same,
        "classify": _classify,
        "describe": _describe,
        "link": _link,
        "judge": _judge,
        "supplement_element": _supplement_element,
        "supplement_pair": _supplement_pair,
    }
    llm = make_llm(**{k: Recording(v) for k, v in steps.items()})
    state = link_state((NAME, URL), contributions=rows)
    outcome, client, reporter, draw = run_links(state, LinkImage(exc=RuntimeError("x")), llm=llm, names=[MEME])

    assert outcome.ok is True
    assert sum(step.calls for step in llm.values()) > 0, "phải có gọi LLM thì kiểm tra mới có nghĩa"
    assert any(HINT in p for p in draw.prompts), "đề xuất không dùng link vẫn được vẽ"
    assert not any(HINT2 in p for p in draw.prompts)
    llm_dump = json.dumps([p for step in llm.values() for p in step.payloads], ensure_ascii=False)
    for blob in (llm_dump, "\n".join(draw.prompts), reporter.issues[0][0] + reporter.issues[0][1]):
        assert URL not in blob and "example.com" not in blob
    assert "example.com/a.png" not in json.dumps(client.posted, ensure_ascii=False)
