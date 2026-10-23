"""Acceptance tests for docs/acceptance/metric.md, pipeline part: AC-METRIC-06.

Expected additions to `lau_meme_pipeline.batch`
(contract: GET /metrics/summary?day=YYYY-MM-DD in docs/api/openapi.yaml):

    BatchClient.get_metrics_summary(day: str) -> dict  # MetricsSummary, aggregate numbers only
    HttpBatchClient.get_metrics_summary(day)  # GET <base>/api/metrics/summary?day=<day>, bearer token
    run_batch(...) calls client.get_metrics_summary(day) in the report step and puts the numbers in report_body
    (the GitHub Issue of AC-PIPE-14, which already has the label "METRIC").

No network, no clock: the batch time is passed in and the HTTP layer is replaced at the http.client level.
Reuses the fakes of test_batch.py (FakeClient, FakeReporter, run).
"""

import http.client
import json
import re
from datetime import UTC, datetime

from test_batch import FakeClient, FakeReporter, run

FAKE_BEARER = "test-token-not-a-secret"
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

SUMMARY = {
    "day": "2026-10-20",
    "daily_players": 1234,
    "daily_completions": 987,
    "d1_retention": 0.41,
    "d7_retention": None,
    "shares": {"daily": 321, "discovery": 45},
    "miss_rate": 0.27,
    "nhat_rate": 0.13,
    "reports": 17,
}


class MetricsClient(FakeClient):
    def __init__(self, summary=SUMMARY, fail=False, **kw):
        super().__init__(**kw)
        self.summary = summary
        self.fail = fail
        self.metric_days: list[str] = []

    def get_metrics_summary(self, day):
        self.calls.append("get_metrics_summary")
        self.metric_days.append(day)
        if self.fail:
            raise RuntimeError("metrics unavailable")
        return dict(self.summary)


def test_ac_metric_06_buoc_bao_cao_goi_endpoint_tong_hop_voi_ngay_hop_le():
    """AC-METRIC-06: bước báo cáo đợt gọi get_metrics_summary đúng một lần với ngày YYYY-MM-DD hợp lệ,
    ngày đó là ngày GMT+7 của đợt hoặc ngày liền trước."""
    client, reporter = MetricsClient(), FakeReporter()
    outcome = run(client, reporter)
    assert outcome.ok is True
    assert client.calls.count("get_metrics_summary") == 1
    (day,) = client.metric_days
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)
    assert day in {"2026-10-21", "2026-10-20"}  # T = 2026-10-21 00:00 GMT+7 = 2026-10-20 17:00 UTC


def test_ac_metric_06_so_lieu_duoc_ghi_vao_noi_dung_github_issue():
    """AC-METRIC-06: số liệu đã tổng hợp xuất hiện trong nội dung báo cáo đợt (GitHub Issue, AC-PIPE-14)."""
    client, reporter = MetricsClient(), FakeReporter()
    outcome = run(client, reporter)
    text = outcome.report_body
    assert text == reporter.issues[0][1]
    assert "METRIC" in text
    for value in ("1234", "987", "321", "45", "17"):
        assert re.search(rf"(?<!\d){value}(?!\d)", text), value


def test_ac_metric_06_noi_dung_bao_cao_khong_co_uuid_hay_su_kien_tho():
    """AC-METRIC-06: nội dung Issue và nhật ký không chứa UUID người chơi hay sự kiện thô."""
    logs: list[str] = []
    client, reporter = MetricsClient(), FakeReporter()
    outcome = run(client, reporter, log=logs.append)
    assert not UUID_RE.search(outcome.report_body)
    assert "player_id" not in outcome.report_body
    assert "props_json" not in outcome.report_body
    assert not any(UUID_RE.search(m) for m in logs)


def test_ac_metric_06_chi_goi_them_get_metrics_summary():
    """AC-METRIC-06: ngoài get_state / post_batch / patch_batch, client chỉ được gọi thêm get_metrics_summary."""
    client = MetricsClient()
    run(client)
    assert set(client.calls) <= {"get_state", "post_batch", "patch_batch", "get_metrics_summary"}


def test_ac_metric_06_http_client_goi_get_voi_bearer_token_pipeline(monkeypatch):
    """AC-METRIC-06: HttpBatchClient.get_metrics_summary gửi GET /lau-meme/api/metrics/summary?day=... kèm
    Authorization: Bearer <token pipeline> và trả đúng JSON số liệu."""
    from lau_meme_pipeline.batch import HttpBatchClient

    seen: list[dict] = []

    class FakeConnection:
        def __init__(self, host, port=None, *args, **kwargs):
            self.host = host

        def request(self, method, url, body=None, headers=None, **kwargs):
            seen.append({"method": method, "path": url, "headers": {k.lower(): v for k, v in (headers or {}).items()}})

        def getresponse(self):
            class Res:
                status = 200

                def read(self, *args):
                    return json.dumps(SUMMARY).encode()

            return Res()

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", FakeConnection)
    monkeypatch.setattr(http.client, "HTTPConnection", FakeConnection)
    result = HttpBatchClient("https://dinoduct.fun/lau-meme", FAKE_BEARER).get_metrics_summary("2026-10-20")
    assert result == SUMMARY
    (req,) = seen
    assert req["method"] == "GET"
    assert req["path"] == "/lau-meme/api/metrics/summary?day=2026-10-20"
    assert req["headers"]["authorization"] == f"Bearer {FAKE_BEARER}"


def test_ac_metric_06_http_client_401_bao_loi_khong_tra_so_lieu_gia(monkeypatch):
    """AC-METRIC-06: endpoint trả 401 (thiếu/sai token) thì client báo lỗi, không trả số liệu giả."""
    from lau_meme_pipeline.batch import HttpBatchClient

    class FakeConnection:
        def __init__(self, host, port=None, *args, **kwargs):
            pass

        def request(self, *args, **kwargs):
            pass

        def getresponse(self):
            class Res:
                status = 401
                reason = "Unauthorized"

                def read(self, *args):
                    return b'{"type":"about:blank","title":"Unauthorized","status":401}'

            return Res()

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", FakeConnection)
    client = HttpBatchClient("https://dinoduct.fun/lau-meme", FAKE_BEARER)
    get_summary = client.get_metrics_summary  # a missing method must fail the test, not count as the 401 error
    raised = False
    result = None
    try:
        result = get_summary("2026-10-20")
    except Exception:
        raised = True
    assert raised, f"expected an error on 401, got {result!r}"


def test_ac_metric_06_loi_lay_so_lieu_khong_lam_dot_that_bai_va_van_tao_issue():
    """AC-METRIC-06: lấy số liệu lỗi thì chỉ ghi log; mẻ vẫn thành công và Issue vẫn được tạo (như AC-PIPE-14)."""
    client, reporter = MetricsClient(fail=True), FakeReporter()
    logs: list[str] = []
    outcome = run(client, reporter, log=logs.append)
    assert outcome.ok is True
    assert outcome.status == "success"
    assert len(client.success_posts) == 1
    assert len(reporter.issues) == 1
    assert any("metric" in m.lower() for m in logs)


def test_ac_metric_06_ngay_tong_hop_theo_gmt7_khong_theo_utc():
    """AC-METRIC-06: đợt 2026-10-20 18:00 UTC (= 2026-10-21 01:00 GMT+7) hỏi ngày 2026-10-21 hoặc 2026-10-20,
    không bao giờ 2026-10-19 (nghĩa là không tính theo UTC lệch một ngày)."""
    client = MetricsClient()
    run(client, FakeReporter(), batch_at=datetime(2026, 10, 20, 18, 0, 0, tzinfo=UTC))
    (day,) = client.metric_days
    assert day in {"2026-10-21", "2026-10-20"}
