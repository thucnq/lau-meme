"""Acceptance tests for docs/acceptance/daily.md, AC-DAILY-19 phía pipeline (ADR 0019, contract 0.7.0).

`GET /pipeline/state` trả thêm `daily_pin: {id, element_id, hint} | null` (state thiếu khóa = không có chỉ định).
Nếu phần tử còn trong kho, đang hoạt động và không bị chặn thì mẻ dùng nó làm Món đặc biệt với gợi ý của admin
(emoji và depth của chính phần tử), bỏ qua luật chọn tự động (không cần daily_hint lõi, depth 4-8, hay luật 30 mẻ);
không thì bỏ chỉ định và chọn như thường. Mẻ success mang `daily_pin_id` (id đã đọc) và `stats.daily_pin`
("used" | "dropped"); mẻ không có chỉ định thì không có hai khóa đó; mẻ lỗi không mang `daily_pin_id`.
"""

import json

from test_batch import (
    T_ISO,
    FakeClient,
    FakeReporter,
    daily_name_of,
    eid,
    hinted_core_names,
    hist,
    make_state,
    real_core,
    run,
)

PIN_ID = "0190b1c2-0000-7000-8000-00000000d019"
HINT = "Thứ làm lưỡi bốc hỏa rồi nước mắt rơi"
DROPPED_NOTE = "Chỉ định Món đặc biệt bị bỏ"


def core_element(name: str) -> dict:
    return next(e for e in real_core()["elements"] if e["name"] == name)


def pinned_state(name_or_id: str, hint: str = HINT, *, is_id: bool = False, **kw) -> dict:
    state = make_state(**kw)
    state["daily_pin"] = {"id": PIN_ID, "element_id": name_or_id if is_id else eid(name_or_id), "hint": hint}
    return state


def not_hinted_name() -> str:
    """A core element that the automatic rule can never pick (no hand-written hint or depth outside 4-8)."""
    hinted = set(hinted_core_names())
    return next(e["name"] for e in real_core()["elements"] if e["name"] not in hinted)


def assert_used(body: dict, name: str):
    element = core_element(name)
    assert body["content"]["daily_element_id"] == eid(name)
    assert body["manifest"]["daily"] == {
        "element_id": eid(name),
        "emoji": element["emoji"],
        "hint": HINT,
        "depth": element["depth"],
    }
    assert body["daily_pin_id"] == PIN_ID
    assert body["stats"]["daily_pin"] == "used"


def test_ac_daily_19_chi_dinh_phan_tu_khong_co_daily_hint_duoc_dung_lam_mon_dac_biet_o_core():
    """AC-DAILY-19: chỉ định một phần tử không đủ điều kiện chọn tự động (không daily_hint hoặc depth ngoài 4-8, vd.
    món khởi đầu Cay): mẻ core dùng nó, manifest.daily mang gợi ý admin cùng emoji/depth của phần tử,
    content.daily_element_id đúng, body có daily_pin_id, stats.daily_pin 'used', báo cáo không ghi bị bỏ."""
    for name in ("Cay", not_hinted_name()):
        assert name not in hinted_core_names()
        client, reporter = FakeClient(pinned_state(name)), FakeReporter()
        outcome = run(client, reporter)
        assert outcome.ok is True and outcome.status == "success"
        (body,) = client.success_posts
        assert_used(body, name)
        assert DROPPED_NOTE not in outcome.report_body
        assert DROPPED_NOTE not in reporter.issues[0][1]


def test_ac_daily_19_chi_dinh_ca_mon_vua_lam_mon_dac_biet_trong_30_me_gan_nhat():
    """AC-DAILY-19: chỉ định một món nằm trong lịch sử 30 mẻ gần nhất vẫn được dùng (admin vượt luật 30 mẻ), không
    báo pool cạn."""
    name = hinted_core_names()[0]
    history = [hist(name, 1)]
    client, reporter = FakeClient(pinned_state(name, history=history)), FakeReporter()
    outcome = run(client, reporter)
    assert outcome.ok is True
    (body,) = client.success_posts
    assert_used(body, name)
    assert not body["stats"].get("daily_pool_exhausted")
    assert "Pool thử thách cạn" not in outcome.report_body


def test_ac_daily_19_phan_tu_bi_chan_hoac_khong_con_trong_kho_thi_bo_chi_dinh_va_chon_nhu_thuong():
    """AC-DAILY-19: phần tử trong blocklist.elements, hoặc id không có trong kho ⇒ bỏ chỉ định: Món đặc biệt giống
    hệt mẻ không chỉ định, stats.daily_pin 'dropped', body vẫn mang daily_pin_id (để Worker xóa chỉ định hỏng),
    Issue ghi "Chỉ định Món đặc biệt bị bỏ"; gợi ý admin không lọt vào manifest."""
    control = FakeClient()
    run(control)
    (control_body,) = control.success_posts

    cases = [
        (pinned_state("Cay", blocked_elements=[eid("Cay")]), None),
        (pinned_state(eid("Món Không Có Trong Kho Này"), is_id=True), control_body),
    ]
    for state, same_as in cases:
        client, reporter = FakeClient(state), FakeReporter()
        outcome = run(client, reporter)
        assert outcome.ok is True and outcome.status == "success"
        (body,) = client.success_posts
        assert body["stats"]["daily_pin"] == "dropped"
        assert body["daily_pin_id"] == PIN_ID
        assert daily_name_of(body) in hinted_core_names()
        assert body["manifest"]["daily"]["hint"] != HINT
        assert HINT not in json.dumps(body, ensure_ascii=False)
        assert DROPPED_NOTE in outcome.report_body
        assert DROPPED_NOTE in reporter.issues[0][1]
        if same_as is not None:
            assert body["content"]["daily_element_id"] == same_as["content"]["daily_element_id"]
            assert body["manifest"]["daily"] == same_as["manifest"]["daily"]


def test_ac_daily_19_pin_bi_chan_chon_giong_me_khong_chi_dinh_cung_blocklist():
    """AC-DAILY-19: món chỉ định bị chặn ⇒ kết quả (manifest, content, graph) bằng đúng mẻ cùng blocklist không có
    chỉ định, chỉ khác daily_pin_id và stats.daily_pin."""
    top = FakeClient()
    run(top)
    top_name = daily_name_of(top.success_posts[0])
    blocked = [eid(top_name)]

    plain = FakeClient(make_state(blocked_elements=blocked))
    run(plain)
    pinned = FakeClient(pinned_state(top_name, blocked_elements=blocked))
    run(pinned)
    (a,), (b,) = plain.success_posts, pinned.success_posts
    assert b["stats"]["daily_pin"] == "dropped"
    assert b["daily_pin_id"] == PIN_ID
    for key in ("manifest", "graph", "content"):
        assert json.dumps(a[key], sort_keys=True) == json.dumps(b[key], sort_keys=True), key
    assert b["content"]["daily_element_id"] != eid(top_name)


def test_ac_daily_19_khong_co_chi_dinh_thi_body_va_stats_khong_co_khoa_moi():
    """AC-DAILY-19: state không có khóa daily_pin hoặc daily_pin null ⇒ body không có daily_pin_id, stats không có
    daily_pin, báo cáo không nhắc chỉ định; kết quả giống nhau giữa hai dạng."""
    absent = FakeClient(make_state())
    assert "daily_pin" not in absent.state
    null_state = make_state()
    null_state["daily_pin"] = None
    null = FakeClient(null_state)
    outcomes = [run(absent, FakeReporter()), run(null, FakeReporter())]
    for outcome, client in zip(outcomes, (absent, null), strict=True):
        assert outcome.ok is True
        (body,) = client.success_posts
        assert "daily_pin_id" not in body
        assert "daily_pin" not in body["stats"]
        assert "Chỉ định Món đặc biệt" not in outcome.report_body
    assert json.dumps(absent.success_posts[0], sort_keys=True) == json.dumps(null.success_posts[0], sort_keys=True)


def test_ac_daily_19_cung_state_cung_batch_at_cho_body_giong_het_byte():
    """AC-DAILY-19: chỉ định đi vào như một phần của state ⇒ cùng state + batch_at cho body giống hệt từng byte."""
    bodies = []
    for _ in range(2):
        client = FakeClient(pinned_state("Cay", history=[hist(hinted_core_names()[0], 1)]))
        run(client)
        bodies.append(json.dumps(client.success_posts[0], sort_keys=True, ensure_ascii=False))
    assert bodies[0] == bodies[1]
    assert json.loads(bodies[0])["daily_pin_id"] == PIN_ID


def test_ac_daily_19_me_that_bai_sau_do_dang_me_loi_khong_mang_daily_pin_id():
    """AC-DAILY-19: mẻ có chỉ định mà lỗi ở bước publish ⇒ chỉ đăng đợt error, không có daily_pin_id (chỉ định còn
    nguyên cho mẻ sau), không có bản success."""
    client, reporter = FakeClient(pinned_state("Cay"), fail_success=True), FakeReporter()
    outcome = run(client, reporter)
    assert outcome.ok is False and outcome.failed_step == "publish"
    assert client.success_posts == []
    (error,) = client.error_posts
    assert "daily_pin_id" not in error
    assert set(error) == {"status", "batch_at", "mode", "failed_step", "stats"}
    assert error["batch_at"] == T_ISO
    assert "daily_pin" not in error["stats"]


def test_ac_daily_19_daily_pin_sai_dinh_dang_thi_me_that_bai_o_buoc_state():
    """AC-DAILY-19: state.daily_pin sai dạng (thiếu hint, element_id không phải chuỗi, thiếu id, không phải object)
    ⇒ mẻ lỗi ở bước 'state': đăng đúng một đợt error, không có bản success nào."""
    malformed = [
        {"id": PIN_ID, "element_id": eid("Cay")},
        {"id": PIN_ID, "element_id": 123, "hint": HINT},
        {"element_id": eid("Cay"), "hint": HINT},
        "Cay",
    ]
    for pin in malformed:
        state = make_state()
        state["daily_pin"] = pin
        client, reporter = FakeClient(state), FakeReporter()
        outcome = run(client, reporter)
        assert outcome.ok is False, pin
        assert outcome.failed_step == "state", pin
        assert client.success_posts == [], pin
        (error,) = client.error_posts
        assert error["failed_step"] == "state"
        assert "daily_pin_id" not in error


def test_ac_daily_19_che_do_full_cung_dung_chi_dinh_va_gui_daily_pin_id():
    """AC-DAILY-19: mode=full (kho đọc từ Worker, không có adapter) cũng dùng phần tử chỉ định kể cả khi nó không đủ
    điều kiện chọn tự động: manifest.daily, content.daily_element_id, daily_pin_id, stats.daily_pin 'used'."""
    import test_pipe_full_batch as full

    name = "Cay"
    assert name not in hinted_core_names()
    client, reporter = full.FakeClient(), full.FakeReporter()
    state = full.make_state()
    state["daily_pin"] = {"id": PIN_ID, "element_id": eid(name), "hint": HINT}
    client.state = state
    outcome = full.run_full_batch(client, reporter, [], full.make_llm())
    assert outcome.ok is True and outcome.status == "success"
    (body,) = client.success_posts
    assert body["mode"] == "full"
    assert_used(body, name)
    assert DROPPED_NOTE not in outcome.report_body
