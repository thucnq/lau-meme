"""Acceptance tests for docs/acceptance/pipe.md (added 2026-10-24): AC-PIPE-18 (host graph.threads.com),
AC-PIPE-19 (token self-refresh command + workflow), AC-PIPE-20 (warning when Threads returns 0 posts).

Expected public surface (new names are marked NEW):

    lau_meme_pipeline.threads_token                                   NEW
        main(env: Mapping[str, str], http) -> int
            env keys: THREADS_ACCESS_TOKEN, THREADS_TOKEN_OUT. `http` is a lau_meme_pipeline.crawl.Http (the same
            injectable wrapper the crawl adapters take); returns the exit code. Output goes to stdout.
        python -m lau_meme_pipeline.threads_token calls main(os.environ, Http(http_get))
    lau_meme_pipeline.crawl.ThreadsAdapter / crawl / HttpStatus / Http as in test_pipe3.py

No network, no sleeping, no real clock. Imports of production names happen inside the tests so a missing name fails
at runtime.
"""

import json
import re
import stat
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from test_pipe3 import (
    THREADS_HOST,
    FakeAdapter,
    FakeClient,
    FakeReporter,
    ThreadsGet,
    make_http,
    run_full,
)

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / "docs" / "dev" / "workflows" / "threads-token.yml"

OLD_ACCESS = "OLDTHREADSTOKENSECRET111"
NEW_ACCESS = "NEWTHREADSTOKENSECRET222"
OLD_HOST = "graph.threads.net"
SEARCH_PATH = "/v1.0/keyword_search"
REFRESH_PATH = "/refresh_access_token"
ZERO_LINE = (
    "⚠️ Threads: 0 bài cho mọi từ khóa - kiểm tra app đã được Meta duyệt quyền threads_keyword_search (xem runbook)"
)


# ---------------------------------------------------------------- fakes


def ok_refresh(token: str = NEW_ACCESS, expires_in: int = 5183944):
    return ("application/json; charset=utf-8", json.dumps({"access_token": token, "expires_in": expires_in}))


class RefreshGet:
    """Serves GET https://graph.threads.com/refresh_access_token. `result` is a (content_type, body) tuple, or an
    exception instance to raise. Any other non-robots URL fails the test."""

    def __init__(self, result=None):
        self.result = result if result is not None else ok_refresh()
        self.requested: list[str] = []

    def __call__(self, url):
        self.requested.append(url)
        parts = urlsplit(url)
        if parts.path.endswith("/robots.txt"):
            return ("text/plain", "")
        assert parts.scheme == "https", f"non-https fetch {url}"
        assert parts.hostname == THREADS_HOST and parts.path == REFRESH_PATH, f"unexpected fetch {url}"
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    @property
    def pages_requested(self) -> list[str]:
        return [u for u in self.requested if not urlsplit(u).path.endswith("/robots.txt")]


class BothGet:
    """Routes search and refresh URLs; records every URL (robots included)."""

    def __init__(self):
        self.search = ThreadsGet()
        self.refresh = RefreshGet()
        self.requested: list[str] = []

    def __call__(self, url):
        self.requested.append(url)
        if urlsplit(url).path.endswith(REFRESH_PATH):
            return self.refresh(url)
        return self.search(url)


def env_for(out: Path, token=OLD_ACCESS) -> dict:
    env = {"THREADS_TOKEN_OUT": str(out)}
    if token is not None:
        env["THREADS_ACCESS_TOKEN"] = token
    return env


def run_refresh(get, out: Path, token=OLD_ACCESS):
    from lau_meme_pipeline.threads_token import main

    return main(env_for(out, token), make_http(get))


# ================================================================ AC-PIPE-18: host graph.threads.com


def test_ac_pipe_18_tim_kiem_goi_graph_threads_com_duong_dan_keyword_search():
    """AC-PIPE-18: adapter Threads với 2 từ khóa: mọi request có host đúng là graph.threads.com, tìm ở đường dẫn
    /v1.0/keyword_search, không request nào tới graph.threads.net; giữ nguyên tham số q."""
    from lau_meme_pipeline.crawl import ThreadsAdapter

    assert THREADS_HOST == "graph.threads.com"
    get = ThreadsGet()
    concepts = ThreadsAdapter(OLD_ACCESS, ["meme", "trend"]).fetch(make_http(get))

    pages = [urlsplit(u) for u in get.pages_requested]
    assert len(pages) == 2
    assert {p.hostname for p in pages} == {"graph.threads.com"}
    assert {p.path for p in pages} == {SEARCH_PATH}
    assert all(p.scheme == "https" for p in pages)
    assert OLD_HOST not in "".join(get.requested)
    assert sorted(get.queries) == ["meme", "trend"]
    assert len(concepts) == 30


def test_ac_pipe_18_gia_han_goi_graph_threads_com_duong_dan_refresh_access_token(tmp_path):
    """AC-PIPE-18: lệnh gia hạn token: mọi request có host graph.threads.com, đường dẫn /refresh_access_token với
    grant_type=th_refresh_token, không request nào tới graph.threads.net."""
    get = RefreshGet()
    assert run_refresh(get, tmp_path / "token.out") == 0

    (url,) = get.pages_requested
    parts = urlsplit(url)
    assert parts.hostname == "graph.threads.com"
    assert parts.path == REFRESH_PATH
    assert parse_qs(parts.query)["grant_type"] == ["th_refresh_token"]
    assert OLD_HOST not in "".join(get.requested)


def test_ac_pipe_18_ca_hai_luong_khong_cham_host_cu(tmp_path):
    """AC-PIPE-18: chạy cả tìm kiếm lẫn gia hạn qua cùng một getter: tập host duy nhất là graph.threads.com."""
    from lau_meme_pipeline.crawl import ThreadsAdapter
    from lau_meme_pipeline.threads_token import main

    get = BothGet()
    http = make_http(get)
    ThreadsAdapter(OLD_ACCESS, ["meme", "trend"]).fetch(http)
    assert main(env_for(tmp_path / "t.out"), http) == 0

    assert {urlsplit(u).hostname for u in get.requested} == {"graph.threads.com"}
    assert not [u for u in get.requested if OLD_HOST in u]


def test_ac_pipe_18_loi_401_van_xu_ly_nhu_ac_pipe_17():
    """AC-PIPE-18: cách xử lý lỗi giữ nguyên AC-PIPE-17: API trả 401 ở host mới thì lỗi nguồn "Threads: lỗi ...",
    nguồn khác vẫn chạy, token không lộ."""
    from lau_meme_pipeline.crawl import HttpStatus, ThreadsAdapter, crawl, crawl_report_line

    get = ThreadsGet(fail=HttpStatus(401))
    result = crawl([ThreadsAdapter(OLD_ACCESS, ["meme", "trend"]), FakeAdapter("RSS", ["R1"])], make_http(get))

    assert [c.name for c in result.concepts] == ["R1"]
    assert [e["source"] for e in result.errors] == ["Threads"]
    assert "Threads: lỗi" in crawl_report_line(result)
    assert OLD_ACCESS not in crawl_report_line(result) + json.dumps(result.errors)


# ================================================================ AC-PIPE-19: gia han token


def test_ac_pipe_19_200_ghi_token_moi_dung_nguyen_van_quyen_600_in_so_ngay_exit_0(tmp_path, capsys):
    """AC-PIPE-19: phản hồi 200 {access_token, expires_in=5183944}: file THREADS_TOKEN_OUT chứa đúng token mới (không
    xuống dòng), quyền 600, in "Threads token: đã gia hạn, còn 59 ngày", exit 0, không lộ token cũ/mới."""
    out = tmp_path / "token.out"
    code = run_refresh(RefreshGet(), out)
    captured = capsys.readouterr()

    assert code == 0
    assert out.read_bytes() == NEW_ACCESS.encode()
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    assert captured.out.strip() == "Threads token: đã gia hạn, còn 59 ngày"
    for secret in (OLD_ACCESS, NEW_ACCESS):
        assert secret not in captured.out + captured.err


@pytest.mark.parametrize(
    ("expires_in", "days"),
    [(5183944, 59), (5184000, 60), (86399, 0), (172800, 2)],
    ids=["59_ngay_le", "dung_60_ngay", "duoi_1_ngay", "dung_2_ngay"],
)
def test_ac_pipe_19_so_ngay_la_expires_in_chia_86400_lam_tron_xuong(tmp_path, capsys, expires_in, days):
    """AC-PIPE-19: N = expires_in / 86400 làm tròn xuống."""
    assert run_refresh(RefreshGet(ok_refresh(expires_in=expires_in)), tmp_path / "token.out") == 0
    assert capsys.readouterr().out.strip() == f"Threads token: đã gia hạn, còn {days} ngày"


def test_ac_pipe_19_gui_token_hien_tai_qua_tham_so_access_token(tmp_path):
    """AC-PIPE-19: yêu cầu gia hạn mang token hiện tại (tham số access_token) và grant_type=th_refresh_token."""
    get = RefreshGet()
    run_refresh(get, tmp_path / "token.out")

    (url,) = get.pages_requested
    query = parse_qs(urlsplit(url).query)
    assert query["grant_type"] == ["th_refresh_token"]
    assert query["access_token"] == [OLD_ACCESS]


@pytest.mark.parametrize("status", [400, 401, 429])
def test_ac_pipe_19_loi_http_khong_tao_file_in_ma_loi_exit_1(tmp_path, capsys, status):
    """AC-PIPE-19: phản hồi 400/401/429: không tạo file, in "Threads token: gia hạn lỗi <mã HTTP>", exit 1, token
    không lọt vào stdout/stderr."""
    from lau_meme_pipeline.crawl import HttpStatus

    out = tmp_path / "token.out"
    code = run_refresh(RefreshGet(HttpStatus(status)), out)
    captured = capsys.readouterr()

    assert code == 1
    assert not out.exists()
    assert f"Threads token: gia hạn lỗi {status}" in captured.out
    for secret in (OLD_ACCESS, NEW_ACCESS):
        assert secret not in captured.out + captured.err


def test_ac_pipe_19_loi_mang_khong_tao_file_in_loai_loi_khong_lo_url(tmp_path, capsys):
    """AC-PIPE-19: lỗi mạng (ngoại lệ có URL chứa token trong thông điệp): không tạo file, in "Threads token: gia hạn
    lỗi <loại lỗi>", exit 1, thông báo không chép URL hay token."""
    leaky = ConnectionError(f"https://graph.threads.com/refresh_access_token?access_token={OLD_ACCESS} reset")
    out = tmp_path / "token.out"
    code = run_refresh(RefreshGet(leaky), out)
    captured = capsys.readouterr()
    text = captured.out + captured.err

    assert code == 1
    assert not out.exists()
    assert re.search(r"Threads token: gia hạn lỗi \S+", captured.out)
    assert OLD_ACCESS not in text
    assert "access_token=" not in text
    assert "https://" not in text


@pytest.mark.parametrize(
    "body",
    [
        json.dumps({"expires_in": 5183944}),
        json.dumps({"access_token": "", "expires_in": 5183944}),
        json.dumps({}),
        "khong phai json",
    ],
    ids=["thieu_access_token", "access_token_rong", "json_rong", "khong_phai_json"],
)
def test_ac_pipe_19_phan_hoi_200_thieu_access_token_la_loi(tmp_path, capsys, body):
    """AC-PIPE-19: 200 nhưng thiếu access_token (hoặc thân hỏng): không tạo file, in "Threads token: gia hạn lỗi ...",
    exit 1, token cũ và thân phản hồi không lộ."""
    out = tmp_path / "token.out"
    code = run_refresh(RefreshGet(("application/json", body)), out)
    captured = capsys.readouterr()

    assert code == 1
    assert not out.exists()
    assert re.search(r"Threads token: gia hạn lỗi \S+", captured.out)
    assert OLD_ACCESS not in captured.out + captured.err
    assert "khong phai json" not in captured.out + captured.err


@pytest.mark.parametrize("token", [None, ""], ids=["khong_co_bien", "bien_rong"])
def test_ac_pipe_19_thieu_token_khong_goi_mang_in_bo_qua_exit_0(tmp_path, capsys, token):
    """AC-PIPE-19: thiếu THREADS_ACCESS_TOKEN: không gọi mạng, không tạo file, in "Threads token: thiếu cấu hình, bỏ
    qua", exit 0."""
    out = tmp_path / "token.out"
    get = RefreshGet()
    code = run_refresh(get, out, token=token)
    captured = capsys.readouterr()

    assert code == 0
    assert get.requested == []
    assert not out.exists()
    assert captured.out.strip() == "Threads token: thiếu cấu hình, bỏ qua"


def test_ac_pipe_19_loi_khong_de_lai_bat_ky_file_nao(tmp_path):
    """AC-PIPE-19: lỗi 401 thì thư mục đích không có file nào (workflow dựa vào đó để không ghi secret)."""
    from lau_meme_pipeline.crawl import HttpStatus

    assert run_refresh(RefreshGet(HttpStatus(401)), tmp_path / "token.out") == 1
    assert list(tmp_path.iterdir()) == []


def test_ac_pipe_19_workflow_threads_token_lich_thu_hai_ghi_ca_hai_environment_mo_issue_khi_loi():
    """AC-PIPE-19: workflow threads-token.yml: cron '0 2 * * 1' + workflow_dispatch, dùng secrets.GH_SECRETS_TOKEN
    để `gh secret set THREADS_ACCESS_TOKEN` cho cả staging và production-no-approval, xóa file, mở Issue khi lỗi."""
    assert WORKFLOW_PATH.exists(), "thiếu docs/dev/workflows/threads-token.yml"
    text = WORKFLOW_PATH.read_text(encoding="utf-8")

    assert re.search(r"cron:\s*['\"]0 2 \* \* 1['\"]", text)
    assert "workflow_dispatch" in text
    assert "lau_meme_pipeline.threads_token" in text
    assert "THREADS_TOKEN_OUT" in text
    assert "secrets.GH_SECRETS_TOKEN" in text
    assert re.search(r"gh secret set THREADS_ACCESS_TOKEN\b", text)
    assert re.search(r"--env\s+\S*(staging|\$)", text)
    assert "staging" in text and "production-no-approval" in text
    assert re.search(r"\brm\b", text)
    assert "gh issue create" in text
    assert "Threads token: gia hạn lỗi" in text
    assert re.search(r"issues:\s*write", text)
    assert re.search(r"if:\s*(\$\{\{\s*)?failure\(\)", text)


# ================================================================ AC-PIPE-20: canh bao 0 bai


def threads_adapters(token=OLD_ACCESS, keywords=("meme", "trend")):
    from lau_meme_pipeline.crawl import ThreadsAdapter

    return [ThreadsAdapter(token, list(keywords)), FakeAdapter("RSS", ["Meme Thử Một"])]


class OneKeywordHasPosts(ThreadsGet):
    """Keyword `meme` returns 3 posts; every other keyword returns an empty list."""

    def __call__(self, url):
        parts = urlsplit(url)
        if not parts.path.endswith("/robots.txt"):
            self.per_keyword = 3 if parse_qs(parts.query).get("q", [""])[0] == "meme" else 0
        return super().__call__(url)


def test_ac_pipe_20_ca_hai_tu_khoa_rong_co_dong_canh_bao_khong_phai_loi_nguon():
    """AC-PIPE-20: API trả 200 data: [] cho cả 2 từ khóa: báo cáo đợt có đúng dòng cảnh báo; không vào lỗi nguồn
    (AC-PIPE-03); đợt không thất bại; nguồn khác vẫn chạy."""
    client, reporter = FakeClient(), FakeReporter()
    get = ThreadsGet(per_keyword=0)
    outcome = run_full(client, reporter, threads_adapters(), crawl_get=get)

    assert outcome.ok is True and outcome.status == "success"
    assert client.error_posts == []
    assert sorted(get.queries) == ["meme", "trend"]
    (body,) = client.success_posts
    assert body["stats"]["source_errors"] == []
    assert body["stats"]["crawled"] == 1
    text = reporter.issues[0][1]
    assert ZERO_LINE in text
    assert "Threads: lỗi" not in text


def test_ac_pipe_20_dong_canh_bao_khong_chua_token():
    """AC-PIPE-20: dòng cảnh báo, báo cáo, tiêu đề và thân đợt không chứa token."""
    client, reporter = FakeClient(), FakeReporter()
    run_full(client, reporter, threads_adapters(), crawl_get=ThreadsGet(per_keyword=0))

    title, text = reporter.issues[0]
    (line,) = [ln for ln in text.splitlines() if "0 bài cho mọi từ khóa" in ln]
    assert ZERO_LINE in line
    assert OLD_ACCESS not in line + title + text + json.dumps(client.posted, ensure_ascii=False)


def test_ac_pipe_20_co_it_nhat_mot_bai_o_mot_tu_khoa_thi_khong_co_dong_canh_bao():
    """AC-PIPE-20: có ít nhất 1 bài ở một từ khóa (từ khóa kia rỗng) thì không có dòng 0 bài."""
    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full(client, reporter, threads_adapters(), crawl_get=OneKeywordHasPosts())

    assert outcome.ok is True
    (body,) = client.success_posts
    assert body["stats"]["crawled"] == 4
    text = reporter.issues[0][1]
    assert ZERO_LINE not in text
    assert "0 bài cho mọi từ khóa" not in text


def test_ac_pipe_20_du_bai_o_moi_tu_khoa_thi_khong_co_dong_canh_bao():
    """AC-PIPE-20: 15 bài mỗi từ khóa: không có dòng 0 bài."""
    client, reporter = FakeClient(), FakeReporter()
    run_full(client, reporter, threads_adapters(), crawl_get=ThreadsGet())

    assert "0 bài cho mọi từ khóa" not in reporter.issues[0][1]


def test_ac_pipe_20_thieu_cau_hinh_chi_co_canh_bao_thieu_cau_hinh():
    """AC-PIPE-20: thiếu cấu hình: chỉ có cảnh báo thiếu cấu hình (AC-PIPE-17), không có dòng 0 bài, không gọi mạng."""
    client, reporter = FakeClient(), FakeReporter()
    get = ThreadsGet(per_keyword=0)
    outcome = run_full(client, reporter, threads_adapters(token=None, keywords=()), crawl_get=get)

    assert outcome.ok is True
    assert get.requested == []
    text = reporter.issues[0][1]
    assert "cấu hình" in text.lower() and "threads" in text.lower()
    assert "0 bài cho mọi từ khóa" not in text
    assert ZERO_LINE not in text


@pytest.mark.parametrize("status", [401, 403, 429])
def test_ac_pipe_20_moi_tu_khoa_loi_http_chi_co_loi_nguon_khong_co_dong_0_bai(status):
    """AC-PIPE-20: mọi từ khóa đều lỗi 401/403/429: chỉ có lỗi nguồn "Threads: lỗi ...", không có dòng 0 bài, đợt
    không thất bại."""
    from lau_meme_pipeline.crawl import HttpStatus

    client, reporter = FakeClient(), FakeReporter()
    outcome = run_full(client, reporter, threads_adapters(), crawl_get=ThreadsGet(fail=HttpStatus(status)))

    assert outcome.ok is True
    (body,) = client.success_posts
    assert [e["source"] for e in body["stats"]["source_errors"]] == ["Threads"]
    text = reporter.issues[0][1]
    assert "Threads: lỗi" in text
    assert "0 bài cho mọi từ khóa" not in text
    assert OLD_ACCESS not in text


def test_ac_pipe_20_threads_0_khai_niem_khong_loi_trong_stats_sources():
    """AC-PIPE-20: cảnh báo 0 bài không phải lỗi nguồn: stats.sources có Threads 0 khái niệm, error null; RSS 1."""
    client, reporter = FakeClient(), FakeReporter()
    run_full(client, reporter, threads_adapters(), crawl_get=ThreadsGet(per_keyword=0))

    (body,) = client.success_posts
    sources = {s["source"]: s for s in body["stats"]["sources"]}
    assert sources["Threads"]["error"] is None
    assert sources["Threads"]["concepts"] == 0
    assert sources["RSS"]["concepts"] == 1
