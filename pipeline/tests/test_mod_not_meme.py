"""Acceptance tests (thêm 2026-10-30, câu hỏi mở 102) cho phần pipeline của:

  AC-MOD-12  lớp 1 "không phải meme": dấu hiệu trong TÊN (🔴, "trực tiếp"/"livestream"/"live stream", từ 2 dấu "|",
             ngày đủ ngày-tháng-năm, cụm giải đấu, hơn 10 từ); loại ở lớp 1, không gửi LLM, mã lý do `not_meme`
             (nhãn "Không phải meme"), bước layer1 trong `rejected` của mẻ, báo cáo đợt đếm "không phải meme";
             admin Bỏ chặn thì mẻ sau bỏ qua lớp 1 và lớp 2 (AC-PIPE-21).
  AC-MOD-13  lớp 2: yêu cầu phân loại gửi LLM có danh mục `not_meme` kèm định nghĩa; phản hồi `not_meme` bị loại,
             bước layer2; "Còn Cái Nịt" đi tiếp; luật người thật (AC-MOD-05) vẫn thêm tên và bí danh.

Giả định về hợp đồng nội bộ (suy ra từ AC và các test AC-MOD-01..11 đã có):
  - moderation.layer1(concept, mod_lists) trả mã lý do `"not_meme"` khi tên có dấu hiệu, `None` khi không.
  - moderation.CATEGORIES có thêm "not_meme"; ModerationResult.counts dùng khóa "không phải meme".
  - `rejected` của mẻ success:
    {"reasons": [{"code": "not_meme", "label": "Không phải meme"}], "step": "layer1"|"layer2"}.
  - GeminiSteps["classify"] nhét danh sách danh mục (mã + định nghĩa) vào lời gọi; test chỉ tìm mã và các cụm khóa
    của định nghĩa trong AC (so khớp không phân biệt hoa thường), không ép đúng từng chữ của prompt.
Helper dùng lại từ test_mod.py, test_mod_rejected.py, test_pipe_gemini.py. Không mạng, không đồng hồ thật.
"""

import json

import pytest

from test_mod import FakeLlm, concept, lists, passed_keys, verdict
from test_mod import run as mod_run
from test_mod_rejected import (
    K_ID,
    Adapter,
    classify_by_name,
    content_names,
    fold_of,
    k_row,
    names_in,
    state,
    unblocked_run,
)
from test_mod_rejected import run as batch_run
from test_pipe_full_batch import MEME, Recording, _classify, make_llm
from test_pipe_gemini import FakeGemini, install, make_steps, request_text
from test_tier import eid

# ---------------------------------------------------------------- dữ liệu của AC

POSITIVES = [
    "🔴 TRỰC TIẾP: BOX GAMING vs BOOM ESPORTS | GIAI ĐOẠN PLAYOFFS | ĐTDV MÙA ĐÔNG 2026",
    "🔴 TRỰC TIẾP: FPT POLYTECHNIC vs SAIGON PHANTOM | GIAI ĐOẠN PLAYOFFS | ĐTDV MÙA ĐÔNG 2026",
    "Ngày 1 | CKTG 2026 - Vòng Swiss Ngày 24.10.2026",
]
CONTROLS = ["Còn Cái Nịt", "Mèo vs Dưa Leo", "Live Laugh Love", "Mùa Đông Không Lạnh"]
LAYER2_NOT_MEME = [
    "đội tuyển bóng đá quốc gia bồ đào nha",
    "thủy tiên",
    'AI Rumpelstiltskin "Tip Toein\' In My Jordans"',
]
NOT_MEME_LABEL = "Không phải meme"


def reasons_of(row) -> list:
    return [r["code"] for r in row["reasons"]]


def rows_by_fold(body) -> dict:
    return {r["fold"]: r for r in body.get("rejected", [])}


# ================================================================ AC-MOD-12 (lớp 1)


@pytest.mark.parametrize("name", POSITIVES)
def test_ac_mod_12_ba_vi_du_cua_ac_bi_loai_o_lop_1_ma_not_meme(name):
    """AC-MOD-12: ba khái niệm ví dụ (hai livestream ĐTDV, một lịch CKTG) bị lớp 1 trả mã `not_meme`."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name=name), lists()) == "not_meme"


@pytest.mark.parametrize("name", CONTROLS)
def test_ac_mod_12_bon_khai_niem_doi_chung_di_tiep_sang_lop_2(name):
    """AC-MOD-12: "Còn Cái Nịt", "Mèo vs Dưa Leo", "Live Laugh Love", "Mùa Đông Không Lạnh" không bị lớp 1 loại."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name=name), lists()) is None


@pytest.mark.parametrize(
    "name",
    [
        "🔴 Cái Này",  # ký tự 🔴
        "Meme 🔴",
        "Trực Tiếp Gáy Luôn",  # "trực tiếp"
        "TRUC TIEP luôn",  # không dấu, hoa thường
        "trực  tiếp",
        "Livestream Của Bạn",
        "LIVESTREAM",
        "Live Stream Meme",
        "live stream",
        "Cái A | Cái B | Cái C",  # từ 2 dấu "|"
        "A||B",
        "Ngày 24.10.2026 là gì",  # ngày đủ ngày-tháng-năm
        "meme 24/10/2026",
        "meme 24-10-2026",
        "Vòng Bảng Của Nhà Meme",
        "vòng loại thứ nhất",
        "Vòng Swiss Cuối",
        "Vòng 3 Của Meme",
        "vòng 12 nè",
        "Giai Đoạn Hai",
        "giai doan cuoi",
        "Playoff Meme",
        "PLAYOFFS meme",
        "Mùa Giải Này",
        "Mùa Xuân 2026",
        "mùa hạ 2027",
        "Mùa Hè 2026",
        "mua thu 2025",
        "MÙA ĐÔNG 2026",
        "một hai ba bốn năm sáu bảy tám chín mười mười_một",  # 11 từ
    ],
)
def test_ac_mod_12_moi_dau_hieu_trong_ten_deu_bi_loai_o_lop_1(name):
    """AC-MOD-12: mỗi dấu hiệu liệt kê trong AC (kể cả không dấu, hoa thường) đủ để lớp 1 trả `not_meme`."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name=name), lists()) == "not_meme", name


@pytest.mark.parametrize(
    "name",
    [
        "Mèo vs Dưa Leo",  # " vs " không phải dấu hiệu
        "Live",  # "live" đứng riêng không phải dấu hiệu
        "Live Laugh Love",
        "Vòng Tay Mèo",  # "vòng" đứng riêng
        "Mùa Đông Không Lạnh",  # "mùa" không kèm năm 4 chữ số
        "Mùa Đông 26",  # năm chỉ 2 chữ số
        "Cái A | Cái B",  # chỉ 1 dấu "|"
        "Ngày 24.10",  # thiếu năm
        "24/10 nè",
        "Còn Cái Nịt",
        "một hai ba bốn năm sáu bảy tám chín mười",  # đúng 10 từ, chưa "hơn 10"
    ],
)
def test_ac_mod_12_ten_khong_du_dau_hieu_khong_bi_loai_nham(name):
    """AC-MOD-12: các tên gần giống nhưng chưa đủ dấu hiệu (câu hỏi mở 102) đi tiếp, không bị chặn nhầm."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name=name), lists()) is None, name


@pytest.mark.parametrize("field", ["description", "context", "daily_hint", "image_hint"])
def test_ac_mod_12_chi_xet_ten_khong_xet_mo_ta_hay_ngu_canh(field):
    """AC-MOD-12: dấu hiệu nằm ở mô tả / ngữ cảnh nguồn / gợi ý (🔴, "trực tiếp", 3 dấu "|", ngày đầy đủ) không làm
    khái niệm có tên sạch bị loại."""
    from lau_meme_pipeline.moderation import layer1

    text = "🔴 TRỰC TIẾP | GIAI ĐOẠN PLAYOFFS | ngày 24.10.2026, livestream vòng bảng mùa đông 2026"
    assert layer1(concept(name="Còn Cái Nịt", **{field: text}), lists()) is None


def test_ac_mod_12_bi_loai_o_lop_1_khong_gui_llm_va_dem_khong_phai_meme():
    """AC-MOD-12: moderate: 3 khái niệm ví dụ bị loại với lý do `not_meme`, KHÔNG gửi LLM; 4 khái niệm đối chứng
    được gửi LLM đúng thứ tự; báo cáo đợt đếm "không phải meme" = 3."""
    pos = [concept(f"p{i}", n) for i, n in enumerate(POSITIVES)]
    ctl = [concept(f"c{i}", n) for i, n in enumerate(CONTROLS)]
    llm = FakeLlm()
    result = mod_run(pos + ctl, llm)

    assert result.rejected == {"p0": "not_meme", "p1": "not_meme", "p2": "not_meme"}
    assert llm.sent_keys == ["c0", "c1", "c2", "c3"]
    assert passed_keys(result) == ["c0", "c1", "c2", "c3"]
    assert result.counts["không phải meme"] == 3


def test_ac_mod_12_lop_1_khong_goi_llm_khi_chi_co_khai_niem_khong_phai_meme():
    """AC-MOD-12: toàn khái niệm bị lớp 1 loại thì không có lời gọi LLM nào."""
    llm = FakeLlm()
    result = mod_run([concept(f"p{i}", n) for i, n in enumerate(POSITIVES)], llm)
    assert llm.calls == []
    assert result.passed == []


def test_ac_mod_12_ghi_vao_bi_chan_voi_ma_not_meme_nhan_va_buoc_lop_1():
    """AC-MOD-12: mẻ full: 3 khái niệm ví dụ vào `rejected` với mã `not_meme`, nhãn "Không phải meme", bước layer1,
    nguồn + ngữ cảnh đi kèm (AC-MOD-11); không vào graph; không gửi bước phân loại LLM; stats.blocked đếm 3."""
    items = [(n, f"ngữ cảnh {i}", f"https://ex.com/p{i}") for i, n in enumerate(POSITIVES)]
    # "Còn Cái Nịt" là phần tử lõi đã có trong graph nền (khử trùng, không vào kiểm duyệt)
    # nên mẻ này chỉ dùng ba đối chứng mới
    new_controls = [n for n in CONTROLS if n != "Còn Cái Nịt"]
    items += [(n, f"ngữ cảnh c{i}", f"https://ex.com/c{i}") for i, n in enumerate(new_controls)]
    classify = Recording(_classify)
    outcome, client, _ = batch_run(state(), [Adapter("RSS", items)], make_llm(classify=classify))

    assert outcome.ok is True
    (body,) = client.success_posts
    by_fold = rows_by_fold(body)
    for name in POSITIVES:
        row = by_fold[fold_of(name)]
        assert row["step"] == "layer1"
        assert reasons_of(row) == ["not_meme"]
        assert row["reasons"] == [{"code": "not_meme", "label": NOT_MEME_LABEL}]
        assert row["source_name"] == "RSS"
        assert row["source_url"].startswith("https://ex.com/p")
        assert name not in names_in(classify.payloads)
    assert content_names(body).isdisjoint(set(POSITIVES))
    for name in new_controls:
        assert fold_of(name) not in by_fold
        assert name in names_in(classify.payloads)
    assert body["stats"]["blocked"]["không phải meme"] == 3


def test_ac_mod_12_khong_phai_meme_trong_bao_cao_dot_khong_lo_ten():
    """AC-MOD-12: báo cáo đợt chỉ đếm "không phải meme" (AC-ADMIN-11), không chứa tên khái niệm bị loại."""
    outcome, client, reporter = batch_run(
        state(),
        [Adapter("RSS", [(POSITIVES[2], "x", "https://ex.com/1"), (MEME, "y", "https://ex.com/2")])],
        make_llm(),
    )
    assert outcome.ok is True
    (body,) = client.success_posts
    assert body["stats"]["blocked"]["không phải meme"] == 1
    assert POSITIVES[2] not in json.dumps(body["stats"], ensure_ascii=False)
    assert all(POSITIVES[2] not in text and POSITIVES[2] not in title for title, text in reporter.issues)


def test_ac_mod_12_admin_bo_chan_thi_me_sau_bo_qua_lop_1_va_lop_2():
    """AC-MOD-12 (qua AC-PIPE-21): admin Bỏ chặn một khái niệm có tên livestream thì mẻ sau không gửi nó vào bước
    phân loại (bỏ qua cả lớp 1 lẫn lớp 2), nó vào graph và `rejected_added` báo nó, không nằm lại trong `rejected`."""
    name = POSITIVES[0]
    link_calls = Recording(
        lambda items: [
            {"key": i["key"], "pairs": [["AFK", "Aura"] if i.get("name") == name else ["AFK", "Bom Hàng"]]}
            for i in items
        ]
    )
    classify = Recording(_classify)
    row = k_row(name=name, fold=fold_of(name), emoji="📺", description="Mô tả admin điền")
    outcome, client, _ = unblocked_run([row], llm=make_llm(link=link_calls, classify=classify))

    assert outcome.ok is True
    (body,) = client.success_posts
    assert name not in names_in(classify.payloads)
    assert name in content_names(body)
    assert body["rejected_added"] == [{"id": K_ID, "element_id": eid(name)}]
    assert name not in {r["name"] for r in body.get("rejected", [])}


# ================================================================ AC-MOD-13 (lớp 2)


def test_ac_mod_13_danh_muc_not_meme_co_trong_danh_sach():
    """AC-MOD-13: `not_meme` là một danh mục phân loại hợp lệ của lớp 2 (cộng với mười danh mục cũ)."""
    from lau_meme_pipeline.moderation import CATEGORIES

    assert "not_meme" in set(CATEGORIES)


def test_ac_mod_13_yeu_cau_phan_loai_gui_llm_co_danh_muc_not_meme_kem_dinh_nghia(monkeypatch):
    """AC-MOD-13: lời gọi `classify` thật tới Gemini (HTTP giả) chứa mã `not_meme` và các cụm khóa của định nghĩa:
    tên người/đội/câu lạc bộ/nhóm nhạc/tổ chức đứng một mình; tên bài hát/phim/chương trình; tiêu đề trận đấu,
    livestream, tin tức, sự kiện."""
    server = FakeGemini(["k1"])
    seen = install(monkeypatch, server)
    steps, _ = make_steps()

    steps["classify"]([{"key": "k1", "name": "thủy tiên"}])

    text = request_text(seen[0])
    decoded = json.dumps(json.loads(text), ensure_ascii=False).lower()
    assert "not_meme" in decoded
    phrases = (
        "câu lạc bộ", "nhóm nhạc", "tổ chức", "bài hát", "phim", "chương trình",
        "trận đấu", "livestream", "tin tức", "sự kiện",
    )  # fmt: skip
    for phrase in phrases:
        assert phrase in decoded, phrase


def test_ac_mod_13_ba_khai_niem_not_meme_bi_loai_o_lop_2_con_cai_nit_di_tiep():
    """AC-MOD-13: moderate: ba khái niệm LLM gắn `not_meme` bị loại (đếm "không phải meme" = 3), "Còn Cái Nịt" với
    phản hồi "an toàn" đi tiếp; cả bốn đều được gửi LLM (đã qua lớp 1)."""
    from lau_meme_pipeline.moderation import layer1

    for n in [*LAYER2_NOT_MEME, "Còn Cái Nịt"]:
        assert layer1(concept(name=n), lists()) is None, n  # tiền đề: qua lớp 1

    concepts = [concept(f"n{i}", n) for i, n in enumerate(LAYER2_NOT_MEME)] + [concept("nit", "Còn Cái Nịt")]
    answers = {f"n{i}": verdict(f"n{i}", category="not_meme", confidence=0.95) for i in range(3)}
    answers["nit"] = verdict("nit", category="safe", confidence=0.93, targets=False)
    llm = FakeLlm(answers=answers)
    result = mod_run(concepts, llm)

    assert llm.sent_keys == ["n0", "n1", "n2", "nit"]
    assert result.rejected == {"n0": "not_meme", "n1": "not_meme", "n2": "not_meme"}
    assert passed_keys(result) == ["nit"]
    assert result.counts["không phải meme"] == 3
    assert result.new_aliases == frozenset()


def test_ac_mod_13_ghi_vao_bi_chan_voi_buoc_lop_2_nhan_khong_phai_meme():
    """AC-MOD-13: mẻ full: 3 khái niệm LLM gắn `not_meme` vào `rejected` với bước layer2, mã `not_meme`, nhãn
    "Không phải meme"; "Còn Cái Nịt" không có trong `rejected`; stats.blocked đếm 3."""
    items = [(n, f"ngữ cảnh {i}", f"https://ex.com/n{i}") for i, n in enumerate(LAYER2_NOT_MEME)]
    items.append(("Còn Cái Nịt", "tiếng lóng chung", "https://ex.com/nit"))
    llm = make_llm(classify=classify_by_name({n: "not_meme" for n in LAYER2_NOT_MEME}))
    outcome, client, _ = batch_run(state(), [Adapter("RSS", items)], llm)

    assert outcome.ok is True
    (body,) = client.success_posts
    by_fold = rows_by_fold(body)
    assert len(by_fold) == 3
    for name in LAYER2_NOT_MEME:
        row = by_fold[fold_of(name)]
        assert row["step"] == "layer2"
        assert row["reasons"] == [{"code": "not_meme", "label": NOT_MEME_LABEL}]
        assert row["source_name"] == "RSS"
    assert fold_of("Còn Cái Nịt") not in by_fold
    assert content_names(body).isdisjoint(set(LAYER2_NOT_MEME))
    assert body["stats"]["blocked"]["không phải meme"] == 3


def test_ac_mod_13_luat_nguoi_that_van_ap_not_meme_tro_toi_nguoi_them_ten_va_bi_danh():
    """AC-MOD-13 (+ AC-MOD-05): "thủy tiên" vừa `not_meme` vừa trỏ tới người cụ thể: vẫn bị loại, tên và mọi bí danh
    (dạng fold) vào danh sách chặn bí danh; "đội tuyển ..." chỉ `not_meme` (không trỏ tới người) thì không thêm gì."""
    person = verdict(
        "tt",
        category="not_meme",
        confidence=0.95,
        targets=True,
        name="Thủy Tiên",
        aliases=["Thuỷ Tiên Công Vinh", "TT"],
    )
    team = verdict("team", category="not_meme", confidence=0.95, targets=False)
    llm = FakeLlm(answers={"tt": person, "team": team})
    result = mod_run(
        [concept("tt", "thủy tiên", context="ca sĩ Thủy Tiên làm từ thiện"), concept("team", LAYER2_NOT_MEME[0])], llm
    )

    assert set(result.rejected) == {"tt", "team"}
    assert result.rejected["team"] == "not_meme"
    assert result.rejected["tt"] in ("not_meme", "real_person")
    assert result.new_aliases == frozenset({"thuy tien", "thuy tien cong vinh"})  # "TT" < 3 ký tự bị bỏ (AC-MOD-05)
    assert result.passed == []


def test_ac_mod_13_not_meme_ket_hop_nguong_tin_cay_van_theo_ac_mod_03():
    """AC-MOD-13: phản hồi `not_meme` kèm tin cậy dưới ngưỡng vẫn bị loại (không bao giờ thành an toàn)."""
    llm = FakeLlm(answers={"n": verdict("n", category="not_meme", confidence=0.5)})
    result = mod_run([concept("n", "thủy tiên")], llm)
    assert "n" in result.rejected
    assert result.passed == []
