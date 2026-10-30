"""Acceptance tests (thêm 2026-10-30, ADR 0022, contract 0.11.0) cho phần pipeline của:

  AC-MOD-11    khái niệm bị chặn ở kiểm duyệt được gửi lại trong `rejected` của mẻ success (mọi lý do, bước, nguồn,
               ngữ cảnh <= 500 ký tự); mẻ lỗi không gửi gì; khái niệm hoãn vì hết quota không tính là bị chặn;
               báo cáo đợt vẫn chỉ đếm theo danh mục.
  AC-PIPE-21   /pipeline/state.unblocked: khái niệm đã bỏ chặn vào đầu hàng chờ với trường admin đã sửa, bỏ qua lớp 1
               và lớp 2, trường trống vẫn qua bước mô tả; nối được thì gửi `rejected_added`; hết quota hoặc không nối
               được thì ở lại hàng chờ; đợt lỗi không đăng gì.
  AC-ADMIN-16  (phần pipeline) /pipeline/state.element_edits áp vào kho ở mọi mẻ (core và full) và gửi lại
               `element_edits_applied`; đổi tên giữ id; `element_aliases` khử trùng khái niệm crawl có tên cũ.

Hợp đồng dùng (docs/api/openapi.yaml 0.11.0): PipelineState.unblocked / element_edits / element_aliases,
PublishBatchRequest.rejected / rejected_added / element_edits_applied, BatchStats.unblocked_added. Các khóa mới của thân
mẻ được đọc bằng body.get(khóa, []) nên "vắng" và "rỗng" đều chấp nhận được khi không có gì để gửi.
Helper dùng lại từ test_pipe_full_batch.py và test_tier.py. Không mạng, không đồng hồ thật, import trong hàm test.
"""

import json

import pytest

from test_pipe_full_batch import (
    ERROR_KEYS,
    MEME,
    T2,
    FakeClient,
    FakeReporter,
    Recording,
    T,
    _classify,
    _link_nothing,
    _raise,
    make_llm,
    real_core,
)
from test_tier import eid, make_state, run_core, run_full

ALLOWED_REJECTED_KEYS = {
    "name",
    "fold",
    "emoji",
    "description",
    "source_name",
    "source_url",
    "context",
    "reasons",
    "step",
}
K_NAME = "Khái Niệm Được Mở Chặn"
K_ID = "0190b1c2-0000-7000-8000-00000000a001"
LONG_CONTEXT = ("ngữ cảnh dài " * 100)[:800]


# ---------------------------------------------------------------- helpers


def state(**over) -> dict:
    s = make_state()
    s.update(
        {
            "image_links": [],
            "daily_pin": None,
            "element_edits": [],
            "element_aliases": [],
            "unblocked": [],
            "manual_approvals": [],
        }
    )
    s.update(over)
    return s


def fold_of(text: str) -> str:
    from lau_meme_pipeline.text import fold

    return fold(text)


class Adapter:
    """Adapter giả: mỗi mục là (tên, ngữ cảnh, link nguồn)."""

    def __init__(self, name, items):
        self.name = name
        self._items = list(items)

    def fetch(self, http):
        from lau_meme_pipeline.crawl import RawConcept

        return [
            RawConcept(name=n, quote=f"câu nói {n}", context=c, source_url=u, source_name=self.name)
            for n, c, u in self._items
        ]


def classify_by_name(special: dict):
    """_classify của batch nhưng gắn danh mục riêng cho vài tên: {tên: danh mục}."""

    def f(items):
        out = _classify(items)
        for answer, item in zip(out, items, strict=True):
            if item["name"] in special:
                answer["category"] = special[item["name"]]
        return out

    return f


def run(st, adapters, llm, banned_words=(), batch_at=T, store=None):
    from lau_meme_pipeline.batch import run_batch
    from lau_meme_pipeline.crawl import Http

    client, reporter = FakeClient(store=store), FakeReporter()
    client.state = st
    outcome = run_batch(
        mode="full",
        batch_at=batch_at,
        core=real_core(),
        client=client,
        reporter=reporter,
        adapters=adapters,
        crawl_http=Http(lambda url: ("text/plain", "")),
        llm=llm,
        log=lambda msg: None,
        banned_words=list(banned_words),
    )
    return outcome, client, reporter


def names_in(payloads) -> list:
    return [p.get("name") for payload in payloads for p in payload]


def k_row(**over) -> dict:
    row = {
        "id": K_ID,
        "name": K_NAME,
        "fold": fold_of(K_NAME),
        "emoji": "🧩",
        "description": None,
        "daily_hint": None,
        "image_hint": "một mảnh ghép đang tìm chỗ",
        "source_name": "Reddit",
        "source_url": "https://ex.com/k",
        "context": "ngữ cảnh của K",
    }
    row.update(over)
    return row


def content_names(body: dict) -> set:
    return {e["name"] for e in body["content"]["elements"]}


# ================================================================ AC-MOD-11


def test_ac_mod_11_khai_niem_bi_chan_duoc_gui_lai_trong_rejected_day_du_lop_va_ly_do():
    """AC-MOD-11: mẻ full có 5 khái niệm bị chặn (từ cấm lớp 1, bí danh lớp 1, chính trị lớp 2, không chắc lớp 2, thêm
    một khái niệm chính trị nữa) và 1 khái niệm sạch: thân mẻ có `rejected` với 5 dòng, mỗi dòng có tên, fold, nguồn
    (tên + URL), ngữ cảnh cắt tối đa 500 ký tự, lý do (mã + nhãn) và bước; khái niệm sạch không có trong `rejected`."""
    banned, alias, pol, unsure, again, clean = (
        "Meme Từ Cấm Xyz",
        "Bí Danh Chặn",
        "Meme Chính Trị",
        "Meme Không Chắc",
        "Meme Gặp Lại",
        "Meme Sạch",
    )
    adapter = Adapter(
        "RSS",
        [
            (banned, LONG_CONTEXT, "https://ex.com/ban"),
            (alias, "ngữ cảnh alias", "https://ex.com/alias"),
            (pol, "ngữ cảnh chính trị", "https://ex.com/pol"),
            (unsure, "ngữ cảnh không chắc", "https://ex.com/unsure"),
            (again, "ngữ cảnh gặp lại", "https://ex.com/again"),
            (clean, "ngữ cảnh sạch", "https://ex.com/clean"),
        ],
    )
    llm = make_llm(classify=classify_by_name({pol: "politics", unsure: "unsure", again: "politics"}))
    outcome, client, _ = run(state(banned_aliases=[fold_of(alias)]), [adapter], llm, banned_words=["Từ Cấm Xyz"])

    assert outcome.ok is True
    (body,) = client.success_posts
    rejected = body.get("rejected", [])
    by_fold = {r["fold"]: r for r in rejected}
    assert len(rejected) == 5 and len(by_fold) == 5
    assert set(by_fold) == {fold_of(n) for n in (banned, alias, pol, unsure, again)}
    for r in rejected:
        assert set(r) <= ALLOWED_REJECTED_KEYS  # không có dữ liệu người chơi (AC-PIPE-13)
        assert {"name", "fold", "source_name", "reasons", "step"} <= set(r)
        assert r["source_name"] == "RSS"
        assert r["step"] in ("layer1", "layer2")
        assert len(r["reasons"]) >= 1
        for reason in r["reasons"]:
            assert set(reason) == {"code", "label"}
            assert isinstance(reason["code"], str) and reason["code"]
            assert isinstance(reason["label"], str) and reason["label"]
        assert len(r.get("context", "")) <= 500

    b = by_fold[fold_of(banned)]
    assert b["step"] == "layer1"
    assert b["context"] == LONG_CONTEXT[:500]
    assert b["source_url"] == "https://ex.com/ban"
    assert b["reasons"][0]["code"] in ("banned_word", "banned_term")
    assert by_fold[fold_of(alias)]["step"] == "layer1"
    assert by_fold[fold_of(alias)]["source_url"] == "https://ex.com/alias"
    p = by_fold[fold_of(pol)]
    assert p["step"] == "layer2"
    assert [x["code"] for x in p["reasons"]] == ["politics"]
    assert [x["code"] for x in by_fold[fold_of(unsure)]["reasons"]] == ["unsure"]
    assert by_fold[fold_of(unsure)]["step"] == "layer2"

    # không vào graph (như cũ); khái niệm sạch vào graph và không nằm trong rejected
    assert clean in content_names(body)
    assert content_names(body).isdisjoint({banned, alias, pol, unsure, again})
    assert fold_of(clean) not in by_fold


def test_ac_mod_11_mot_khai_niem_nhieu_ly_do_gui_du_ca_ma_va_nhan_khong_chi_ly_do_dau():
    """AC-MOD-11: khái niệm vừa chứa từ cấm vừa trùng bí danh bị chặn: dòng trong `rejected` có đủ cả hai lý do (mã
    khác nhau, nhãn không rỗng), không chỉ lý do đầu tiên."""
    name = "Từ Cấm Hai"
    adapter = Adapter("RSS", [(name, "ngữ cảnh", "https://ex.com/two")])
    outcome, client, _ = run(state(banned_aliases=[fold_of(name)]), [adapter], make_llm(), banned_words=["Từ Cấm"])
    assert outcome.ok is True
    (body,) = client.success_posts
    (row,) = body.get("rejected", [])
    codes = [r["code"] for r in row["reasons"]]
    assert len(codes) >= 2 and len(set(codes)) == len(codes)
    assert all(r["label"] for r in row["reasons"])
    assert row["step"] == "layer1"


def test_ac_mod_11_bao_cao_dot_van_chi_dem_theo_danh_muc_khong_co_ten():
    """AC-MOD-11: stats của mẻ chỉ đếm theo danh mục (AC-ADMIN-11): "chính trị" 1, "không chắc" 1; không có tên khái
    niệm bị chặn ở bất kỳ đâu trong stats hoặc Issue báo cáo."""
    pol, unsure = "Meme Chính Trị Bí Mật", "Meme Mơ Hồ Bí Mật"
    adapter = Adapter(
        "RSS", [(pol, "x", "https://ex.com/1"), (unsure, "y", "https://ex.com/2"), (MEME, "z", "https://ex.com/3")]
    )
    llm = make_llm(classify=classify_by_name({pol: "politics", unsure: "unsure"}))
    outcome, client, reporter = run(state(), [adapter], llm)
    assert outcome.ok is True
    (body,) = client.success_posts
    assert body["stats"]["blocked"]["chính trị"] == 1
    assert body["stats"]["blocked"]["không chắc"] == 1
    blob = json.dumps(body["stats"], ensure_ascii=False)
    for secret in (pol, unsure):
        assert secret not in blob
        assert all(secret not in issue_body and secret not in title for title, issue_body in reporter.issues)


def test_ac_mod_11_het_quota_khong_tinh_la_bi_chan_ma_vao_hang_cho():
    """AC-MOD-11: Gemini hết quota ở bước kiểm duyệt: khái niệm vào hàng chờ (AC-PIPE-12), `rejected` rỗng hoặc vắng."""
    from lau_meme_pipeline.llm import QuotaExhausted

    adapter = Adapter("RSS", [(MEME, "ngữ cảnh", "https://ex.com/1")])
    llm = make_llm(classify=_raise(QuotaExhausted("hết quota")))
    outcome, client, _ = run(state(), [adapter], llm)
    assert outcome.ok is True
    (body,) = client.success_posts
    assert body.get("rejected", []) == []
    assert MEME in {i["concept"]["name"] for i in body["store"]["queue"]}


def test_ac_mod_11_dot_loi_giua_chung_khong_gui_rejected():
    """AC-MOD-11: đợt lỗi giữa chừng (bước mô tả ném lỗi) chỉ đăng mẻ error đúng khóa, không có `rejected`, không có
    mẻ success nào."""
    pol = "Meme Chính Trị Lỗi"
    adapter = Adapter("RSS", [(pol, "x", "https://ex.com/1"), (MEME, "z", "https://ex.com/3")])
    llm = make_llm(classify=classify_by_name({pol: "politics"}), describe=_raise(RuntimeError("boom")))
    outcome, client, _ = run(state(), [adapter], llm)
    assert outcome.ok is False
    assert client.success_posts == []
    (err,) = client.error_posts
    assert set(err) == ERROR_KEYS
    assert "rejected" not in err


def test_ac_mod_11_khong_co_khai_niem_bi_chan_thi_khong_co_dong_rejected():
    """AC-MOD-11: mẻ sạch không gửi dòng `rejected` nào."""
    outcome, client, _ = run(state(), [Adapter("RSS", [(MEME, "ngữ cảnh", "https://ex.com/1")])], make_llm())
    assert outcome.ok is True
    assert client.success_posts[0].get("rejected", []) == []


# ================================================================ AC-PIPE-21


def unblocked_run(rows, llm=None, adapters=None, banned_words=("Mở Chặn",), batch_at=T):
    """Mẻ full có `rows` đã bỏ chặn; tên K vừa chứa từ cấm vừa nằm trong bí danh bị chặn để chứng minh
    lớp 1 bị bỏ qua."""
    st = state(unblocked=rows, banned_aliases=[fold_of(K_NAME)])
    if adapters is None:
        adapters = [Adapter("RSS", [(MEME, "ngữ cảnh", "https://ex.com/m")])]
    return run(st, adapters, llm or make_llm(), banned_words=banned_words, batch_at=batch_at)


def test_ac_pipe_21_khai_niem_bo_chan_vao_dau_hang_cho_bo_qua_kiem_duyet_va_vao_graph():
    """AC-PIPE-21: K đã bỏ chặn (tên chứa từ cấm và nằm trong bí danh bị chặn, emoji admin đã sửa, mô tả trống): bước
    liên kết nhận K TRƯỚC meme mới; K không bị gửi bước kiểm duyệt; K đi qua bước mô tả; K vào content với tên và emoji
    của admin và mô tả do Gemini viết; `rejected_added` báo K; K không nằm trong `rejected`."""

    def link_distinct(items):
        # mỗi mục một cặp riêng (AC-INV-02: cặp chỉ thuộc về một meme): K -> AFK + Aura, meme mới -> AFK + Bom Hàng
        return [
            {"key": i["key"], "pairs": [["AFK", "Aura"] if i.get("name") == K_NAME else ["AFK", "Bom Hàng"]]}
            for i in items
        ]

    link = Recording(link_distinct)
    classify = Recording(_classify)
    describe_payloads = []

    def describe(items):
        describe_payloads.append(items)
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

    outcome, client, _ = unblocked_run([k_row()], llm=make_llm(link=link, classify=classify, describe=describe))
    assert outcome.ok is True
    (body,) = client.success_posts

    link_names = names_in(link.payloads)
    assert K_NAME in link_names and MEME in link_names
    assert link_names.index(K_NAME) < link_names.index(MEME)  # đầu hàng chờ, trước meme mới
    assert K_NAME not in names_in(classify.payloads)  # bỏ qua lớp 1 (từ cấm, bí danh) và lớp 2
    assert K_NAME in names_in(describe_payloads)  # trường trống vẫn qua bước mô tả của Gemini

    k = next(e for e in body["content"]["elements"] if e["name"] == K_NAME)
    assert k["id"] == eid(K_NAME)
    assert k["emoji"] == "🧩"  # emoji admin thắng, không bị mô tả ghi đè
    assert k.get("description") == f"Mô tả {K_NAME}"
    assert body["rejected_added"] == [{"id": K_ID, "element_id": eid(K_NAME)}]
    assert K_NAME not in {r["name"] for r in body.get("rejected", [])}
    assert MEME in content_names(body)
    assert body["stats"].get("unblocked_added") == 1


def test_ac_pipe_21_truong_admin_da_dien_duoc_giu_nguyen():
    """AC-PIPE-21: admin đã điền mô tả và gợi ý Daily: content giữ nguyên giá trị đó, Gemini không ghi đè."""
    row = k_row(description="Mô tả do admin viết", daily_hint="Gợi ý Daily do admin viết")
    outcome, client, _ = unblocked_run(
        [row], llm=make_llm(link=lambda items: [{"key": i["key"], "pairs": [["AFK", "Aura"]]} for i in items])
    )
    assert outcome.ok is True
    (body,) = client.success_posts
    k = next(e for e in body["content"]["elements"] if e["name"] == K_NAME)
    assert k.get("description") == "Mô tả do admin viết"
    assert k.get("daily_hint") == "Gợi ý Daily do admin viết"
    assert k.get("image_hint") == "một mảnh ghép đang tìm chỗ"
    assert body["rejected_added"] == [{"id": K_ID, "element_id": eid(K_NAME)}]


def test_ac_pipe_21_khong_noi_duoc_thi_o_lai_hang_cho_khong_bao_added():
    """AC-PIPE-21: bước liên kết không trả cặp nào: K ở hàng chờ với attempts 1 như AC-PIPE-07, không có trong content,
    không có trong `rejected_added`."""
    outcome, client, _ = unblocked_run([k_row()], llm=make_llm(link=_link_nothing))
    assert outcome.ok is True
    (body,) = client.success_posts
    assert body.get("rejected_added", []) == []
    assert K_NAME not in content_names(body)
    queued = {i["concept"]["name"]: i for i in body["store"]["queue"]}
    assert K_NAME in queued and queued[K_NAME]["attempts"] == 1
    assert K_NAME not in {r["name"] for r in body.get("rejected", [])}


def test_ac_pipe_21_het_quota_truoc_khi_toi_k_thi_k_o_lai_hang_cho():
    """AC-PIPE-21: Gemini hết quota ở bước mô tả: mẻ vẫn đăng, K ở lại hàng chờ, không có trong content, không có trong
    `rejected_added` (dòng của K vẫn "Đã bỏ chặn" cho mẻ sau)."""
    from lau_meme_pipeline.llm import QuotaExhausted

    outcome, client, _ = unblocked_run(
        [k_row()], llm=make_llm(describe=_raise(QuotaExhausted("hết quota"))), adapters=[Adapter("RSS", [])]
    )
    assert outcome.ok is True
    (body,) = client.success_posts
    assert body.get("rejected_added", []) == []
    assert K_NAME not in content_names(body)
    assert K_NAME in {i["concept"]["name"] for i in body["store"]["queue"]}


def test_ac_pipe_21_dot_loi_thi_khong_dang_gi_k_van_bo_chan_cho_dot_sau():
    """AC-PIPE-21: đợt lỗi giữa chừng (bước liên kết ném lỗi): không có mẻ success, mẻ error đúng khóa và không có
    `rejected_added` - Worker không có gì để chuyển dòng K sang "Đã thêm"."""
    outcome, client, _ = unblocked_run([k_row()], llm=make_llm(link=_raise(RuntimeError("boom"))))
    assert outcome.ok is False
    assert client.success_posts == []
    (err,) = client.error_posts
    assert set(err) == ERROR_KEYS
    assert "rejected_added" not in err


def test_ac_pipe_21_mot_dot_sau_k_da_them_khong_xuat_hien_lai_trong_rejected_added():
    """AC-PIPE-21: sau khi Worker chuyển K sang "Đã thêm" (state.unblocked rỗng) thì mẻ kế tiếp không gửi K nữa: không
    có `rejected_added`, K không bị tạo lại."""
    outcome, client, _ = run(
        state(), [Adapter("RSS", [(MEME, "ngữ cảnh", "https://ex.com/m")])], make_llm(), batch_at=T2
    )
    assert outcome.ok is True
    (body,) = client.success_posts
    assert body.get("rejected_added", []) == []
    assert K_NAME not in content_names(body)


# ================================================================ AC-ADMIN-16 (phần pipeline)

CAY = "Cay"  # phần tử lõi (starter)


def edit_row(**fields) -> dict:
    row = {"element_id": eid(CAY), "rev": 3}
    row.update(fields)
    return row


def content_of(body: dict, element_id: str) -> dict:
    return next(e for e in body["content"]["elements"] if e["id"] == element_id)


@pytest.mark.parametrize("mode", ["core", "full"])
def test_ac_admin_16_ban_sua_cua_admin_ap_vao_noi_dung_o_moi_me_va_gui_lai_rev_da_ap(mode):
    """AC-ADMIN-16: element_edits của phần tử lõi (emoji, mô tả, gợi ý Daily, gợi ý ảnh) được áp vào content ở cả mẻ
    core lẫn full, và mẻ gửi lại `element_edits_applied` với đúng rev đã áp."""
    st = state(
        element_edits=[
            edit_row(
                emoji="🧨", description="Mô tả do admin", daily_hint="Gợi ý Daily admin", image_hint="Ảnh do admin"
            )
        ]
    )
    if mode == "core":
        outcome, client, _ = run_core(st)
    else:
        outcome, client = run_full(st, names=())
    assert outcome.ok is True
    (body,) = client.success_posts
    el = content_of(body, eid(CAY))
    assert el["emoji"] == "🧨"
    assert el.get("description") == "Mô tả do admin"
    assert el.get("daily_hint") == "Gợi ý Daily admin"
    assert el.get("image_hint") == "Ảnh do admin"
    assert body["element_edits_applied"] == [{"element_id": eid(CAY), "rev": 3}]


def test_ac_admin_16_khong_ghi_de_o_cac_me_sau_ke_ca_khi_gemini_viet_gia_tri_khac():
    """AC-ADMIN-16: hai mẻ liên tiếp cùng một element_edits (mẻ full có LLM trả emoji khác): cả hai content đều giữ giá
    trị admin đã sửa; mẻ sau gửi lại cùng rev (bản sửa không biến mất)."""
    st1 = state(element_edits=[edit_row(emoji="🧨", description="Mô tả do admin")])
    st2 = state(element_edits=[edit_row(emoji="🧨", description="Mô tả do admin")])
    _, c1, _ = run_core(st1, batch_at=T)
    _, c2 = run_full(st2, names=(MEME,), batch_at=T2)
    for client in (c1, c2):
        (body,) = client.success_posts
        el = content_of(body, eid(CAY))
        assert el["emoji"] == "🧨"
        assert el.get("description") == "Mô tả do admin"
        assert body["element_edits_applied"] == [{"element_id": eid(CAY), "rev": 3}]


def test_ac_admin_16_doi_ten_giu_nguyen_id_va_ten_cu_la_bi_danh_khu_trung_khi_crawl_lai():
    """AC-ADMIN-16: admin đổi tên "Cay" thành "Cay Đã Đổi Tên": id vẫn là id của "Cay" (không có phần tử mang id băm
    của tên mới), tên mới hiện trong content; đợt crawl lại khái niệm "Cay" (tên cũ, có trong element_aliases) được khử
    trùng vào phần tử đó: không thêm meme mới, không vào hàng chờ."""
    new_name = "Cay Đã Đổi Tên"
    st = state(
        element_edits=[edit_row(name=new_name)],
        element_aliases=[{"fold": fold_of(CAY), "element_id": eid(CAY)}],
    )
    outcome, client = run_full(st, names=(CAY,))
    assert outcome.ok is True
    (body,) = client.success_posts
    ids = {e["id"] for e in body["content"]["elements"]}
    assert eid(CAY) in ids and eid(new_name) not in ids
    assert content_of(body, eid(CAY))["name"] == new_name
    assert body["stats"]["crawled"] == 1
    assert body["stats"]["added"] == 0
    assert body["stats"]["queued"] == 0
    assert body["store"]["queue"] == []
    assert [e["name"] for e in body["content"]["elements"]].count(CAY) == 0
    assert body["element_edits_applied"] == [{"element_id": eid(CAY), "rev": 3}]
