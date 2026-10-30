"""Tests cho AC-ART-15: job tìm ảnh trên web cho meme chưa có ảnh (ADR 0024).

Thuần: API quản trị, API tìm ảnh và tải ảnh đều là fake, không mở socket.
"""

import io

import pytest
from PIL import Image

from lau_meme_pipeline.art_search import (
    SearchRefused,
    main,
    parse_brave_images,
    pick_elements,
    run_art_search,
)
from lau_meme_pipeline.links import LinkRefused


class Boom(Exception):
    pass


def _png(color=(200, 30, 30), size=(40, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg(color=(30, 30, 200), size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


def _el(eid, name, *, depth=0, state="active", image_key=None, image_state="none", image_source=None):
    return {
        "id": eid,
        "name": name,
        "emoji": "🙂",
        "depth": depth,
        "state": state,
        "image_key": image_key,
        "image_state": image_state,
        "image_source": image_source,
    }


class FakeAdmin:
    def __init__(self, items, page_size=100):
        self.items = list(items)
        self.page_size = page_size
        self.list_calls = []
        self.puts = []

    def list_elements(self, page, size):
        self.list_calls.append((page, size))
        start = (page - 1) * self.page_size
        return {
            "items": self.items[start : start + self.page_size],
            "page": page,
            "size": size,
            "total": len(self.items),
        }

    def put_image(self, element_id, webp):
        self.puts.append((element_id, webp))
        return {"id": element_id}


class FakeSearch:
    def __init__(self, mapping=None, default=None, refuse_on=None):
        self.mapping = mapping or {}
        self.default = default if default is not None else []
        self.refuse_on = refuse_on
        self.queries = []

    def __call__(self, *args, **kwargs):
        assert not kwargs
        assert len(args) == 1 and isinstance(args[0], str)
        query = args[0]
        self.queries.append(query)
        if self.refuse_on is not None and self.refuse_on in query:
            raise SearchRefused("quota")
        for name, urls in self.mapping.items():
            if name in query:
                return list(urls)
        return list(self.default)


class FakeFetch:
    def __init__(self, table=None, default=None):
        self.table = table or {}
        self.default = default
        self.calls = []

    def __call__(self, url):
        self.calls.append(url)
        value = self.table.get(url, self.default)
        if isinstance(value, Exception):
            raise value
        if value is None:
            raise LinkRefused("không có")
        return value


def _assert_webp_256(data: bytes):
    img = Image.open(io.BytesIO(data))
    assert img.format == "WEBP"
    assert img.size == (256, 256)


def test_ac_art_15_pick_only_active_without_image():
    """AC-ART-15: chỉ chọn phần tử đang hoạt động có image_key rỗng (bỏ C, D, E, F)."""
    items = [
        _el("a", "A"),
        _el("b", "B"),
        _el("c", "C", image_key="img/c.webp", image_state="active", image_source="ai"),
        _el("d", "D", image_key="img/d.webp", image_state="active", image_source="admin"),
        _el("e", "E", image_key="img/e.webp", image_state="hidden", image_source="ai"),
        _el("f", "F", state="hidden"),
        _el("g", "G", state="blocked"),
    ]
    picked = pick_elements(items, 50)
    assert sorted(p["id"] for p in picked) == ["a", "b"]


def test_ac_art_15_pick_orders_depth_desc_then_folded_name():
    """AC-ART-15: xếp độ sâu giảm dần rồi tên đã fold (bỏ dấu, không phân biệt hoa thường)."""
    items = [
        _el("1", "Em", depth=1),
        _el("2", "Đa", depth=1),
        _el("3", "Cá", depth=1),
        _el("4", "Zed", depth=5),
        _el("5", "Alpha", depth=0),
    ]
    picked = pick_elements(items, 50)
    assert [p["id"] for p in picked] == ["4", "3", "2", "1", "5"]


def test_ac_art_15_pick_respects_limit():
    """AC-ART-15: lấy tối đa số phần tử đã chọn (limit)."""
    items = [_el(str(i), f"N{i:02d}", depth=i) for i in range(10)]
    picked = pick_elements(items, 3)
    assert [p["id"] for p in picked] == ["9", "8", "7"]
    assert pick_elements(items, 0) == []


def test_ac_art_15_attaches_webp_256_for_found_image():
    """AC-ART-15: A có link ảnh hợp lệ thì put_image với WebP 256x256 (từ PNG hoặc JPEG)."""
    admin = FakeAdmin([_el("a", "Cá sấu"), _el("b", "Mèo")])
    search = FakeSearch({"Cá sấu": ["https://x.test/a.png"], "Mèo": ["https://x.test/b.jpg"]})
    fetch = FakeFetch({"https://x.test/a.png": _png(), "https://x.test/b.jpg": _jpeg()})
    result = run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert sorted(result["attached"]) == ["a", "b"]
    assert result["not_found"] == []
    assert result["considered"] == 2
    assert result["planned"] == []
    assert sorted(eid for eid, _ in admin.puts) == ["a", "b"]
    for _, webp in admin.puts:
        _assert_webp_256(webp)


def test_ac_art_15_query_contains_name_and_meme():
    """AC-ART-15: truy vấn tìm ảnh theo tên phần tử, có chữ meme, và chỉ là một chuỗi."""
    admin = FakeAdmin([_el("a", "Cá sấu")])
    search = FakeSearch()
    run_art_search(admin, search=search, fetch=FakeFetch(), log=lambda *_: None)
    assert search.queries == ["Cá sấu meme"]


def test_ac_art_15_not_found_keeps_emoji_and_never_puts():
    """AC-ART-15: B mọi kết quả đều lỗi (rỗng, bị từ chối, không phải ảnh) thì không put, vào not_found."""
    admin = FakeAdmin([_el("b1", "Không kết quả"), _el("b2", "Bị chặn"), _el("b3", "Không ảnh")])
    search = FakeSearch(
        {
            "Bị chặn": ["https://x.test/blocked"],
            "Không ảnh": ["https://x.test/notimg"],
        }
    )
    fetch = FakeFetch(
        {
            "https://x.test/blocked": LinkRefused("nội bộ"),
            "https://x.test/notimg": b"<html>not an image</html>",
        }
    )
    result = run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert admin.puts == []
    assert result["attached"] == []
    assert sorted(result["not_found"]) == ["b1", "b2", "b3"]
    assert result["considered"] == 3


def test_ac_art_15_tries_first_three_candidates_in_order():
    """AC-ART-15: thử lần lượt tối đa 3 kết quả đầu; ảnh đầu tiên dùng được thắng; kết quả thứ 4 không tải."""
    urls = [f"https://x.test/{i}" for i in range(1, 6)]
    admin = FakeAdmin([_el("a", "Gấu")])
    search = FakeSearch({"Gấu": urls})
    fetch = FakeFetch(
        {
            urls[0]: LinkRefused("x"),
            urls[1]: b"garbage",
            urls[2]: _png(),
            urls[3]: _png(),
        }
    )
    result = run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert fetch.calls == urls[:3]
    assert result["attached"] == ["a"]
    assert len(admin.puts) == 1
    _assert_webp_256(admin.puts[0][1])


def test_ac_art_15_fourth_candidate_never_fetched_when_first_three_fail():
    """AC-ART-15: cả 3 kết quả đầu lỗi thì vào not_found, không thử kết quả thứ 4 dù nó hợp lệ."""
    urls = [f"https://x.test/{i}" for i in range(1, 5)]
    admin = FakeAdmin([_el("a", "Gấu")])
    search = FakeSearch({"Gấu": urls})
    fetch = FakeFetch({urls[0]: Boom(), urls[1]: Boom(), urls[2]: Boom(), urls[3]: _png()})
    result = run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert fetch.calls == urls[:3]
    assert urls[3] not in fetch.calls
    assert result["not_found"] == ["a"]
    assert admin.puts == []


def test_ac_art_15_stops_at_first_working_candidate():
    """AC-ART-15: ảnh đầu dùng được thì không tải các kết quả sau."""
    urls = ["https://x.test/1", "https://x.test/2"]
    admin = FakeAdmin([_el("a", "Gấu")])
    fetch = FakeFetch({urls[0]: _png(), urls[1]: _png()})
    run_art_search(admin, search=FakeSearch({"Gấu": urls}), fetch=fetch, log=lambda *_: None)
    assert fetch.calls == [urls[0]]


def test_ac_art_15_run_skips_non_candidates_and_never_searches_them():
    """AC-ART-15: C, D, E, F không bao giờ được tìm ảnh hay tải."""
    items = [
        _el("a", "Alpha"),
        _el("c", "Cee", image_key="k", image_state="active", image_source="ai"),
        _el("d", "Dee", image_key="k", image_state="active", image_source="admin"),
        _el("e", "Eee", image_key="k", image_state="hidden", image_source="ai"),
        _el("f", "Eff", state="hidden"),
    ]
    admin = FakeAdmin(items)
    search = FakeSearch(default=["https://x.test/p"])
    fetch = FakeFetch(default=_png())
    result = run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert len(search.queries) == 1
    assert "Alpha" in search.queries[0]
    assert result["considered"] == 1
    assert [eid for eid, _ in admin.puts] == ["a"]


def test_ac_art_15_run_processes_in_order_and_respects_limit():
    """AC-ART-15: xử lý theo độ sâu giảm dần, tên fold, và dừng ở limit."""
    items = [
        _el("1", "Em", depth=1),
        _el("2", "Đa", depth=1),
        _el("3", "Cá", depth=1),
        _el("4", "Zed", depth=5),
    ]
    admin = FakeAdmin(items)
    search = FakeSearch(default=["https://x.test/p"])
    fetch = FakeFetch(default=_png())
    result = run_art_search(admin, search=search, fetch=fetch, limit=3, log=lambda *_: None)
    assert [eid for eid, _ in admin.puts] == ["4", "3", "2"]
    assert result["considered"] == 3
    assert len(search.queries) == 3
    assert "Zed" in search.queries[0]
    assert "Cá" in search.queries[1]
    assert "Đa" in search.queries[2]


def test_ac_art_15_dry_run_puts_nothing_and_plans_name_and_url():
    """AC-ART-15: chạy thử chỉ in tên phần tử và link sẽ dùng, không gắn ảnh."""
    admin = FakeAdmin([_el("a", "Cá sấu"), _el("b", "Hết cách")])
    search = FakeSearch({"Cá sấu": ["https://x.test/a.png"]})
    fetch = FakeFetch({"https://x.test/a.png": _png()})
    logged = []
    result = run_art_search(
        admin, search=search, fetch=fetch, dry_run=True, log=lambda *a: logged.append(" ".join(map(str, a)))
    )
    assert admin.puts == []
    assert result["attached"] == []
    assert result["planned"] == [("Cá sấu", "https://x.test/a.png")]
    assert result["not_found"] == ["b"]
    text = "\n".join(logged)
    assert "Cá sấu" in text
    assert "https://x.test/a.png" in text


def test_ac_art_15_errors_counted_by_class_name():
    """AC-ART-15: bản tóm tắt ghi lỗi tải theo tên loại lỗi, mỗi ứng viên lỗi tính một."""
    admin = FakeAdmin([_el("a", "Một"), _el("b", "Hai")])
    search = FakeSearch(default=["https://x.test/1", "https://x.test/2"])
    fetch = FakeFetch(
        {
            "https://x.test/1": Boom("x"),
            "https://x.test/2": LinkRefused("y"),
        }
    )
    result = run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert result["errors"] == {"Boom": 2, "LinkRefused": 2}
    assert sorted(result["not_found"]) == ["a", "b"]


def test_ac_art_15_search_refused_stops_job_and_keeps_earlier_attachments():
    """AC-ART-15: API tìm ảnh 401/403/hết hạn mức thì job dừng, ảnh đã gắn trước đó giữ nguyên."""
    items = [_el("1", "Alpha", depth=3), _el("2", "Boom", depth=2), _el("3", "Gamma", depth=1)]
    admin = FakeAdmin(items)
    search = FakeSearch(default=["https://x.test/p"], refuse_on="Boom")
    fetch = FakeFetch(default=_png())
    with pytest.raises(SearchRefused):
        run_art_search(admin, search=search, fetch=fetch, log=lambda *_: None)
    assert [eid for eid, _ in admin.puts] == ["1"]
    assert len(search.queries) == 2


def test_ac_art_15_reads_every_page_of_catalog():
    """AC-ART-15: đọc hết mọi trang GET /admin/elements (trang bắt đầu từ 1, size 100)."""
    items = [_el(f"e{i:03d}", f"Tên {i:03d}", depth=i) for i in range(250)]
    admin = FakeAdmin(items, page_size=100)
    search = FakeSearch(default=["https://x.test/p"])
    fetch = FakeFetch(default=_png())
    result = run_art_search(admin, search=search, fetch=fetch, limit=250, log=lambda *_: None)
    pages = [p for p, _ in admin.list_calls]
    assert pages[0] == 1
    assert set(pages) >= {1, 2, 3}
    assert all(size == 100 for _, size in admin.list_calls)
    assert result["considered"] == 250
    assert len(admin.puts) == 250
    assert admin.puts[0][0] == "e249"


def test_ac_art_15_search_receives_only_query_string():
    """AC-ART-15: API tìm ảnh chỉ nhận chuỗi truy vấn là tên phần tử, không có dữ liệu khác."""
    admin = FakeAdmin([_el("secret-id-1", "Alpha")])
    search = FakeSearch()
    run_art_search(admin, search=search, fetch=FakeFetch(), log=lambda *_: None)
    assert search.queries == ["Alpha meme"]


def test_ac_art_15_parse_brave_images_https_only_in_order():
    """AC-ART-15: parse_brave_images lấy properties.url theo thứ tự, chỉ https, bỏ mục thiếu."""
    payload = {
        "results": [
            {"properties": {"url": "https://a.test/1.png"}, "thumbnail": {"src": "https://t/1"}},
            {"properties": {"url": "http://a.test/2.png"}},
            {"thumbnail": {"src": "https://t/3"}},
            {"properties": {}},
            {"properties": {"url": "https://a.test/5.jpg"}},
        ]
    }
    assert parse_brave_images(payload) == ["https://a.test/1.png", "https://a.test/5.jpg"]
    assert parse_brave_images({"results": []}) == []
    assert parse_brave_images({}) == []


def test_ac_art_15_main_missing_env_returns_2_without_network(monkeypatch):
    """AC-ART-15: thiếu cấu hình (ADMIN_API_BASE_URL, ADMIN_TOKEN, IMAGE_SEARCH_API_KEY) thì trả 2."""
    names = ["ADMIN_API_BASE_URL", "ADMIN_TOKEN", "IMAGE_SEARCH_API_KEY"]
    for n in names:
        monkeypatch.delenv(n, raising=False)
    assert main([]) == 2
    for missing in names:
        for n in names:
            monkeypatch.setenv(n, "https://admin.test" if n == "ADMIN_API_BASE_URL" else "tok")
        monkeypatch.delenv(missing)
        assert main(["--dry-run"]) == 2


def test_ac_art_15_main_returns_0_and_passes_limit(monkeypatch):
    """AC-ART-15: chạy bình thường trả 0, cờ --limit được áp dụng."""
    for n in ("ADMIN_API_BASE_URL", "ADMIN_TOKEN", "IMAGE_SEARCH_API_KEY"):
        monkeypatch.delenv(n, raising=False)
    admin = FakeAdmin([_el(str(i), f"N{i}", depth=i) for i in range(5)])
    rc = main(
        ["--limit", "2"],
        admin=admin,
        search=FakeSearch(default=["https://x.test/p"]),
        fetch=FakeFetch(default=_png()),
    )
    assert rc == 0
    assert [eid for eid, _ in admin.puts] == ["4", "3"]


def test_ac_art_15_main_dry_run_puts_nothing():
    """AC-ART-15: --dry-run không gắn ảnh nào và trả 0."""
    admin = FakeAdmin([_el("a", "Alpha")])
    rc = main(
        ["--dry-run"],
        admin=admin,
        search=FakeSearch(default=["https://x.test/p"]),
        fetch=FakeFetch(default=_png()),
    )
    assert rc == 0
    assert admin.puts == []


def test_ac_art_15_main_default_limit_is_50():
    """AC-ART-15: số phần tử tối đa mặc định là 50."""
    admin = FakeAdmin([_el(f"e{i:03d}", f"N{i:03d}", depth=i) for i in range(60)])
    rc = main(
        [],
        admin=admin,
        search=FakeSearch(default=["https://x.test/p"]),
        fetch=FakeFetch(default=_png()),
    )
    assert rc == 0
    assert len(admin.puts) == 50


def test_ac_art_15_main_search_refused_returns_1():
    """AC-ART-15: API tìm ảnh từ chối thì main trả 1 (job đỏ), ảnh đã gắn giữ nguyên."""
    admin = FakeAdmin([_el("1", "Alpha", depth=2), _el("2", "Boom", depth=1)])
    rc = main(
        [],
        admin=admin,
        search=FakeSearch(default=["https://x.test/p"], refuse_on="Boom"),
        fetch=FakeFetch(default=_png()),
    )
    assert rc == 1
    assert [eid for eid, _ in admin.puts] == ["1"]
