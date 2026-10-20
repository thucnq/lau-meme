"""Acceptance tests for docs/acceptance/mod.md: AC-MOD-01..10 (pipeline part).

Expected modules (pure, no network/clock/randomness; LLM answers are injected fakes):

    lau_meme_pipeline.llm         QuotaExhausted, LlmError
    lau_meme_pipeline.moderation  Concept, ModLists, CATEGORIES, layer1, moderate, ModerationResult, Passed,
                                  is_held, daily_candidate_flags, show_new_label
    lau_meme_pipeline.daily       select_daily (existing)

AC-MOD-06: the nickname half is covered by the worker DISC tests; here only the pipeline half (layer 1 rejects).
Imports happen inside the tests so a missing module fails at runtime, not at collection.
"""

from datetime import date

import pytest

D = date(2026, 10, 20)
D_PLUS_29 = date(2026, 11, 18)
D_PLUS_30 = date(2026, 11, 19)


# ---------------------------------------------------------------- helpers


def concept(key="k1", name="Cây Khế", **over):
    from lau_meme_pipeline.moderation import Concept

    return Concept(key=key, name=name, **over)


def lists(**over):
    from lau_meme_pipeline.moderation import ModLists

    return ModLists(**{k: frozenset(v) for k, v in over.items()})


def verdict(key, category="safe", confidence=0.95, targets=False, name=None, aliases=(), accusation=False,
            hot_person=False, flagged_fields=()):
    return {
        "key": key,
        "category": category,
        "confidence": confidence,
        "person": {"targets": targets, "name": name, "aliases": list(aliases)},
        "accusation": accusation,
        "hot_person": hot_person,
        "flagged_fields": list(flagged_fields),
    }


class FakeLlm:
    """classify(items) -> responses. `answers` maps key -> verdict dict (or overrides for verdict())."""

    def __init__(self, answers=None, default=None, raises=None):
        self.answers = answers or {}
        self.default = default
        self.raises = raises or {}  # call index (0-based) -> exception instance
        self.calls = []

    def __call__(self, items):
        index = len(self.calls)
        self.calls.append([dict(i) for i in items])
        if index in self.raises:
            raise self.raises[index]
        out = []
        for item in items:
            answer = self.answers.get(item["key"], self.default)
            if answer is None:
                answer = verdict(item["key"])
            out.append(answer)
        return out

    @property
    def sent_keys(self):
        return [i["key"] for call in self.calls for i in call]


def run(concepts, classify, mod_lists=None, batch_date=D, **kw):
    from lau_meme_pipeline.moderation import ModLists, moderate

    return moderate(concepts, mod_lists or ModLists(), classify, batch_date, **kw)


def passed_keys(result):
    return [p.concept.key for p in result.passed]


# ---------------------------------------------------------------- AC-MOD-01


def test_ac_mod_01_tu_cam_bi_loai_o_lop_1_khong_gui_llm():
    """AC-MOD-01: khái niệm chứa từ cấm bị loại ở lớp 1, không gửi LLM, đếm vào "từ cấm"."""
    from lau_meme_pipeline.moderation import layer1

    ml = lists(banned_words={"Từ Cấm"})
    bad = concept("bad", "Meme Từ Cấm Siêu Bự")
    ok = concept("ok", "Cây Khế")
    assert layer1(bad, ml) == "banned_word"
    assert layer1(ok, ml) is None

    llm = FakeLlm()
    result = run([bad, ok], llm, ml)
    assert result.rejected == {"bad": "banned_word"}
    assert passed_keys(result) == ["ok"]
    assert llm.sent_keys == ["ok"]
    assert result.counts["từ cấm"] == 1


@pytest.mark.parametrize(
    "text",
    [
        "tu cam",  # không dấu
        "TỪ CẤM",  # hoa
        "t.ừ  c-ấm",  # dấu chấm, khoảng trắng, gạch giữa các chữ
        "T Ư   C A M",  # khoảng trắng giữa từng chữ, không dấu
        "xxTừCấmyy",  # dính liền trong từ dài
    ],
)
def test_ac_mod_01_khop_khong_dau_hoa_thuong_chen_dau_cach(text):
    """AC-MOD-01: so khớp không dấu, không phân biệt hoa thường, bỏ qua dấu chấm/khoảng trắng chèn giữa."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name=text), lists(banned_words={"Từ Cấm"})) == "banned_word"


def test_ac_mod_01_tu_cam_duoc_viet_co_dau_cach_van_khop():
    """AC-MOD-01: từ cấm khai báo có dấu chấm/khoảng trắng vẫn khớp tên viết liền."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name="tucam"), lists(banned_words={"t.ừ  c-ấm"})) == "banned_word"


def test_ac_mod_01_khai_niem_sach_khong_bi_loai_nham():
    """AC-MOD-01: tên không chứa từ cấm thì lớp 1 trả None (không khớp nhầm khi chỉ có chữ rời)."""
    from lau_meme_pipeline.moderation import layer1

    ml = lists(banned_words={"Từ Cấm"}, aliases={"abc xyz"}, admin_blocked={"X"})
    assert layer1(concept(name="Từ Này Cấm"), ml) is None  # đảo thứ tự -> "tunaycam"
    assert layer1(concept(name="Cây Khế"), ml) is None


@pytest.mark.parametrize("field", ["description", "daily_hint", "image_hint", "emoji"])
def test_ac_mod_01_lop_1_kiem_ca_van_ban_phu(field):
    """AC-MOD-01: (cũng AC-MOD-04) lớp 1 áp cho tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh."""
    from lau_meme_pipeline.moderation import layer1

    c = concept(**{field: "có chữ T.ừ Cấm ở đây"})
    assert layer1(c, lists(banned_words={"Từ Cấm"})) == "banned_word"


# ---------------------------------------------------------------- AC-MOD-02


def test_ac_mod_02_danh_muc_chinh_tri_bi_loai_an_toan_di_tiep():
    """AC-MOD-02: LLM gắn "chính trị" thì bị loại, đếm theo danh mục; "an toàn" thì đi tiếp."""
    llm = FakeLlm(answers={"pol": verdict("pol", category="politics", confidence=0.97)})
    result = run([concept("pol", "A"), concept("fine", "B")], llm)
    assert result.rejected == {"pol": "politics"}
    assert passed_keys(result) == ["fine"]
    assert result.counts["chính trị"] == 1


def test_ac_mod_02_moi_danh_muc_bi_loai_va_dem_dung_nhan():
    """AC-MOD-02: từng danh mục cấm đều bị loại và đếm đúng nhãn báo cáo."""
    from lau_meme_pipeline.moderation import CATEGORIES

    assert set(CATEGORIES) == {
        "real_person", "politics", "religion", "sexual", "discrimination",
        "body_shaming", "violence", "drugs", "self_harm", "harassment",
    }  # fmt: skip
    labels = {
        "politics": "chính trị",
        "religion": "tôn giáo",
        "sexual": "tình dục",
        "discrimination": "phân biệt",
        "body_shaming": "body shaming",
        "violence": "bạo lực",
        "drugs": "ma túy",
        "self_harm": "tự hại",
        "harassment": "quấy rối",
        "real_person": "người thật",
    }
    for category, label in labels.items():
        llm = FakeLlm(answers={"c": verdict("c", category=category, confidence=0.9)})
        result = run([concept("c", "Tên")], llm)
        assert result.rejected == {"c": category}, category
        assert result.counts.get(label) == 1, category
        assert result.passed == []


def test_ac_mod_02_dem_nhieu_khai_niem_cung_danh_muc():
    """AC-MOD-02: báo cáo đếm cộng dồn theo danh mục."""
    llm = FakeLlm(
        answers={
            "a": verdict("a", category="drugs"),
            "b": verdict("b", category="drugs"),
            "c": verdict("c", category="violence"),
        }
    )
    result = run([concept("a", "A"), concept("b", "B"), concept("c", "C"), concept("d", "D")], llm)
    assert result.counts["ma túy"] == 2
    assert result.counts["bạo lực"] == 1
    assert passed_keys(result) == ["d"]


def test_ac_mod_02_khai_niem_gui_theo_lo_10_nguyen_thu_tu():
    """AC-MOD-02: 25 khái niệm, batch_size 10 -> 3 lời gọi cỡ 10, 10, 5 theo đúng thứ tự đầu vào."""
    concepts = [concept(f"k{i:02d}", f"Meme {chr(97 + i)}") for i in range(25)]
    llm = FakeLlm()
    result = run(concepts, llm)
    assert [len(c) for c in llm.calls] == [10, 10, 5]
    assert llm.sent_keys == [c.key for c in concepts]
    assert passed_keys(result) == [c.key for c in concepts]
    assert result.rejected == {}


def test_ac_mod_02_batch_size_tuy_chinh():
    """AC-MOD-02: batch_size tùy chỉnh được tôn trọng."""
    concepts = [concept(f"k{i}", f"M{i}") for i in range(7)]
    llm = FakeLlm()
    run(concepts, llm, batch_size=3)
    assert [len(c) for c in llm.calls] == [3, 3, 1]


# ---------------------------------------------------------------- AC-MOD-03


def test_ac_mod_03_khong_chac_bi_loai():
    """AC-MOD-03: LLM trả "không chắc" thì bị loại và đếm vào "không chắc", không bao giờ an toàn."""
    llm = FakeLlm(answers={"u": verdict("u", category="unsure", confidence=0.99)})
    result = run([concept("u", "A")], llm)
    assert result.rejected == {"u": "unsure"}
    assert result.passed == []
    assert result.counts["không chắc"] == 1


def test_ac_mod_03_diem_tin_cay_duoi_nguong():
    """AC-MOD-03: 0.79 < 0.8 bị loại; đúng 0.8 thì đi tiếp."""
    llm = FakeLlm(
        answers={
            "low": verdict("low", confidence=0.79),
            "edge": verdict("edge", confidence=0.8),
        }
    )
    result = run([concept("low", "A"), concept("edge", "B")], llm)
    assert result.rejected == {"low": "unsure"}
    assert passed_keys(result) == ["edge"]
    assert result.counts["không chắc"] == 1


def test_ac_mod_03_nguong_tuy_chinh():
    """AC-MOD-03: min_confidence tùy chỉnh được áp dụng."""
    llm = FakeLlm(answers={"m": verdict("m", confidence=0.85)})
    assert run([concept("m", "A")], llm, min_confidence=0.9).rejected == {"m": "unsure"}
    assert passed_keys(run([concept("m", "A")], llm, min_confidence=0.8)) == ["m"]


def _bad_responses(key):
    base = verdict(key)
    missing_person = {k: v for k, v in base.items() if k != "person"}
    return {
        "unknown category": {**base, "category": "meme-lord"},
        "category not str": {**base, "category": 3},
        "confidence str": {**base, "confidence": "high"},
        "confidence > 1": {**base, "confidence": 1.5},
        "confidence < 0": {**base, "confidence": -0.1},
        "accusation not bool": {**base, "accusation": "no"},
        "flagged_fields not list": {**base, "flagged_fields": "name"},
        "missing person": missing_person,
        "wrong key": {**base, "key": "other"},
        "not a dict": "safe",
    }


def test_ac_mod_03_khong_dung_schema_bi_loai():
    """AC-MOD-03: phản hồi sai schema (kiểu sai, danh mục lạ, thiếu trường, sai key) bị loại "invalid_response"."""
    for label, bad in _bad_responses("c").items():
        llm = FakeLlm(answers={"c": bad})
        result = run([concept("c", "A")], llm)
        assert result.rejected == {"c": "invalid_response"}, label
        assert result.passed == [], label
        assert result.counts["không chắc"] == 1, label


def test_ac_mod_03_thieu_phan_hoi_cho_khai_niem_bi_loai():
    """AC-MOD-03: LLM trả thiếu một khái niệm (hoặc danh sách rỗng) thì khái niệm đó bị loại, không coi là an toàn."""
    concepts = [concept("a", "A"), concept("b", "B")]
    result = run(concepts, lambda items: [verdict("a")])
    assert passed_keys(result) == ["a"]
    assert result.rejected == {"b": "invalid_response"}
    assert run(concepts, lambda items: []).passed == []


def test_ac_mod_03_loi_goi_sau_retry_loai_ca_lo():
    """AC-MOD-03: LlmError thì mọi khái niệm của lô đó bị loại "llm_error"; lô khác vẫn được xét."""
    from lau_meme_pipeline.llm import LlmError

    concepts = [concept(f"k{i}", f"M{i}") for i in range(15)]
    llm = FakeLlm(raises={0: LlmError("hết retry")})
    result = run(concepts, llm)
    assert [len(c) for c in llm.calls] == [10, 5]
    assert result.rejected == {f"k{i}": "llm_error" for i in range(10)}
    assert passed_keys(result) == [f"k{i}" for i in range(10, 15)]
    assert result.counts["không chắc"] == 10


def test_ac_mod_03_het_quota_giua_chung_vao_hang_cho_khong_loai_khong_duyet():
    """AC-MOD-03: hết quota ở lô 2 (AC-PIPE-12) -> lô 2 trở đi vào queued đúng thứ tự, không gọi nữa."""
    from lau_meme_pipeline.llm import QuotaExhausted

    concepts = [concept(f"k{i:02d}", f"M{i}") for i in range(25)]
    llm = FakeLlm(raises={1: QuotaExhausted("hết")})
    result = run(concepts, llm)
    assert len(llm.calls) == 2  # lô 3 không được gọi
    assert passed_keys(result) == [f"k{i:02d}" for i in range(10)]
    assert [c.key for c in result.queued] == [f"k{i:02d}" for i in range(10, 25)]
    assert result.rejected == {}
    assert result.counts["hết quota"] == 15
    decided = set(passed_keys(result)) | set(result.rejected) | {c.key for c in result.queued}
    assert decided == {c.key for c in concepts}


def test_ac_mod_03_het_quota_ngay_lo_dau():
    """AC-MOD-03: hết quota ngay lô đầu -> tất cả vào queued, không có khái niệm nào được coi là an toàn."""
    from lau_meme_pipeline.llm import QuotaExhausted

    concepts = [concept(f"k{i}", f"M{i}") for i in range(4)]
    llm = FakeLlm(raises={0: QuotaExhausted("hết")})
    result = run(concepts, llm)
    assert result.passed == []
    assert [c.key for c in result.queued] == ["k0", "k1", "k2", "k3"]
    assert result.rejected == {}


def test_ac_mod_03_khong_co_quota_thi_queued_rong():
    """AC-MOD-03: chạy bình thường thì queued rỗng."""
    result = run([concept("a", "A")], FakeLlm())
    assert result.queued == []
    assert "hết quota" not in result.counts


def test_ac_mod_03_khai_niem_bi_loai_lop_1_khong_vao_hang_cho_khi_het_quota():
    """AC-MOD-03: hết quota thì khái niệm đã bị lớp 1 loại vẫn bị loại, không vào queued."""
    from lau_meme_pipeline.llm import QuotaExhausted

    ml = lists(banned_words={"cấm"})
    concepts = [concept("bad", "Cấm Chơi"), concept("ok", "Cây Khế")]
    llm = FakeLlm(raises={0: QuotaExhausted("hết")})
    result = run(concepts, llm, ml)
    assert result.rejected == {"bad": "banned_word"}
    assert [c.key for c in result.queued] == ["ok"]


# ---------------------------------------------------------------- AC-MOD-04


def test_ac_mod_04_ten_ket_qua_cong_thuc_vi_pham_bi_loai():
    """AC-MOD-04: công thức mới (kind="recipe") có tên kết quả vi phạm bị loại ở lớp 2 và ở lớp 1."""
    from lau_meme_pipeline.moderation import layer1

    llm = FakeLlm(answers={"r1": verdict("r1", category="sexual", confidence=0.95)})
    recipe = concept("r1", "Kết Quả Xấu", kind="recipe")
    result = run([recipe, concept("e1", "Cây Khế")], llm)
    assert result.rejected == {"r1": "sexual"}
    assert passed_keys(result) == ["e1"]
    sent = {i["key"]: i for call in llm.calls for i in call}
    assert sent["r1"]["kind"] == "recipe"
    assert sent["r1"]["name"] == "Kết Quả Xấu"
    assert sent["e1"]["kind"] == "element"  # mặc định

    banned_recipe = concept("r2", "Kết Quả Từ Cấm", kind="recipe")
    assert layer1(banned_recipe, lists(banned_words={"từ cấm"})) == "banned_word"


def test_ac_mod_04_goi_y_daily_vi_pham_phan_tu_di_tiep_nhung_khong_du_dieu_kien_mon_dac_biet():
    """AC-MOD-04: gợi ý Daily bị gắn cờ -> phần tử vẫn đi tiếp nhưng hint_ok=False, không làm Món đặc biệt."""
    from lau_meme_pipeline.moderation import daily_candidate_flags

    from lau_meme_pipeline.daily import select_daily

    llm = FakeLlm(answers={"e": verdict("e", flagged_fields=["daily_hint"])})
    result = run([concept("e", "Phần Tử Lành", daily_hint="nhắc vụ việc nóng")], llm)
    assert passed_keys(result) == ["e"]
    p = result.passed[0]
    assert p.hint_ok is False
    assert p.image_hint_ok is True
    assert daily_candidate_flags(p, D) == {"held": False, "hint_ok": False}

    bad = _daily_cand("bad", **daily_candidate_flags(p, D))
    good = _daily_cand("good", hint_ok=True, held=False)
    assert select_daily([bad, good], [], 5)["element_id"] == "good"


def test_ac_mod_04_goi_y_anh_vi_pham_danh_dau_image_hint_ok_false():
    """AC-MOD-04: gợi ý ảnh bị gắn cờ -> image_hint_ok=False, hint_ok vẫn True, phần tử đi tiếp."""
    llm = FakeLlm(answers={"e": verdict("e", flagged_fields=["image_hint"])})
    result = run([concept("e", "Phần Tử Lành", image_hint="vẽ người đang bị nhắc")], llm)
    p = result.passed[0]
    assert p.image_hint_ok is False
    assert p.hint_ok is True


def test_ac_mod_04_goi_y_sach_thi_ca_hai_deu_ok():
    """AC-MOD-04: không gắn cờ trường nào -> hint_ok và image_hint_ok đều True."""
    result = run([concept("e", "A", daily_hint="gợi ý", image_hint="ảnh")], FakeLlm())
    assert (result.passed[0].hint_ok, result.passed[0].image_hint_ok) == (True, True)


@pytest.mark.parametrize("field", ["name", "emoji", "description"])
def test_ac_mod_04_truong_chinh_bi_gan_co_thi_loai(field):
    """AC-MOD-04: tên, emoji hoặc mô tả bị gắn cờ thì khái niệm bị loại "flagged_field" (đếm "không chắc")."""
    llm = FakeLlm(answers={"e": verdict("e", flagged_fields=[field])})
    result = run([concept("e", "A")], llm)
    assert result.rejected == {"e": "flagged_field"}
    assert result.counts["không chắc"] == 1


def test_ac_mod_04_gui_llm_du_cac_truong_can_kiem():
    """AC-MOD-04: payload gửi LLM có đủ tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh (đúng bộ khóa quy định)."""
    c = concept(
        "e", "Tên", kind="element", emoji="🍲", description="mô tả", daily_hint="gợi ý d", image_hint="gợi ý ảnh",
        context="đoạn nguồn", source_name="rss-x",
    )  # fmt: skip
    llm = FakeLlm()
    run([c], llm)
    assert llm.calls[0] == [
        {
            "key": "e", "kind": "element", "name": "Tên", "emoji": "🍲", "description": "mô tả",
            "daily_hint": "gợi ý d", "image_hint": "gợi ý ảnh", "context": "đoạn nguồn", "source_name": "rss-x",
        }
    ]  # fmt: skip


# ---------------------------------------------------------------- AC-MOD-05


def test_ac_mod_05_tg_kem_ngu_canh_nguon_bi_loai_va_them_ten_bi_danh():
    """AC-MOD-05: payload có đoạn ngữ cảnh nguồn; LLM chỉ ra người -> loại, tên + bí danh (fold) vào chặn."""
    passage = "Vụ việc ồn ào của ca sĩ Nguyễn Văn A (biệt danh Ông A, viết tắt NVA) lan truyền."
    tg = concept("tg", "TG", context=passage, source_name="reddit")
    llm = FakeLlm(
        answers={
            "tg": verdict(
                "tg", category="safe", confidence=0.9, targets=True, name="Nguyễn Văn A", aliases=["Ông A", "NVA"]
            )
        }
    )
    result = run([tg, concept("ok", "Cây Khế")], llm)

    sent = {i["key"]: i for call in llm.calls for i in call}
    assert sent["tg"]["context"] == passage
    assert sent["tg"]["source_name"] == "reddit"
    assert result.rejected == {"tg": "real_person"}
    assert result.new_aliases == frozenset({"nguyen van a", "ong a", "nva"})
    assert result.counts["người thật"] == 1
    assert passed_keys(result) == ["ok"]


def test_ac_mod_05_tro_toi_nguoi_that_loai_du_confidence_cao_va_category_an_toan():
    """AC-MOD-05: person.targets=true là đủ để loại, kể cả khi category "safe" và confidence 1.0."""
    llm = FakeLlm(answers={"p": verdict("p", confidence=1.0, targets=True, name="Ai Đó", aliases=[])})
    result = run([concept("p", "P")], llm)
    assert result.rejected == {"p": "real_person"}
    assert result.new_aliases == frozenset({"ai do"})


def test_ac_mod_05_bi_danh_la_none_khong_gay_loi():
    """AC-MOD-05: person.name là None vẫn loại, chỉ thêm các bí danh có thật (không thêm chuỗi rỗng/None)."""
    llm = FakeLlm(answers={"p": verdict("p", targets=True, name=None, aliases=["Biệt Danh"])})
    result = run([concept("p", "P")], llm)
    assert result.rejected == {"p": "real_person"}
    assert result.new_aliases == frozenset({"biet danh"})


def test_ac_mod_05_khong_tro_toi_nguoi_thi_khong_them_bi_danh():
    """AC-MOD-05: không trỏ tới người cụ thể thì new_aliases rỗng."""
    result = run([concept("a", "A")], FakeLlm())
    assert result.new_aliases == frozenset()


# ---------------------------------------------------------------- AC-MOD-06 (pipeline half)


def test_ac_mod_06_bi_danh_bi_chan_loai_o_lop_1():
    """AC-MOD-06: danh sách chặn có "abc xyz"; khái niệm chứa "ABC Xyz" bị loại ở lớp 1, không gửi LLM."""
    from lau_meme_pipeline.moderation import layer1

    ml = lists(aliases={"abc xyz"})
    hit = concept("hit", "ABC Xyz")
    assert layer1(hit, ml) == "blocked_alias"
    llm = FakeLlm()
    result = run([hit, concept("ok", "Cây Khế")], llm, ml)
    assert result.rejected == {"hit": "blocked_alias"}
    assert llm.sent_keys == ["ok"]
    assert result.counts["bí danh bị chặn"] == 1


@pytest.mark.parametrize("text", ["abcxyz", "a.b.c xyz", "Ông ABC  Xyz Ơi", "ábc xỹz"])
def test_ac_mod_06_bi_danh_khop_moi_dang_viet(text):
    """AC-MOD-06: bí danh khớp dạng liền, chèn dấu chấm/khoảng trắng, nằm trong chuỗi dài, không dấu."""
    from lau_meme_pipeline.moderation import layer1

    assert layer1(concept(name=text), lists(aliases={"abc xyz"})) == "blocked_alias"


def test_ac_mod_06_bi_danh_hoc_duoc_o_lo_nay_chan_o_lo_sau():
    """AC-MOD-06: bí danh mới (new_aliases) đưa vào ModLists thì đợt sau loại khái niệm đó ở lớp 1."""
    from lau_meme_pipeline.moderation import ModLists

    first = run(
        [concept("tg", "TG")],
        FakeLlm(answers={"tg": verdict("tg", targets=True, name="Nguyễn Văn A", aliases=["NVA"])}),
    )
    next_lists = ModLists(aliases=first.new_aliases)
    llm = FakeLlm()
    second = run([concept("later", "N.V.A fan club")], llm, next_lists)
    assert second.rejected == {"later": "blocked_alias"}
    assert llm.calls == []


def test_ac_mod_06_bi_danh_kiem_ca_van_ban_phu():
    """AC-MOD-06: bí danh cũng được kiểm trong mô tả và gợi ý."""
    from lau_meme_pipeline.moderation import layer1

    ml = lists(aliases={"abc xyz"})
    assert layer1(concept(description="nhắc tới abc xyz đó"), ml) == "blocked_alias"
    assert layer1(concept(daily_hint="A B C X Y Z"), ml) == "blocked_alias"


# ---------------------------------------------------------------- AC-MOD-07


def test_ac_mod_07_con_cai_nit_tieng_long_chung_di_tiep():
    """AC-MOD-07: "Còn Cái Nịt" với LLM trả "không trỏ tới người cụ thể" thì đi tiếp."""
    c = concept("nit", "Còn Cái Nịt", context="câu cửa miệng đã thành tiếng lóng chung")
    llm = FakeLlm(answers={"nit": verdict("nit", category="safe", confidence=0.93, targets=False)})
    result = run([c], llm)
    assert passed_keys(result) == ["nit"]
    assert result.rejected == {}
    assert result.new_aliases == frozenset()
    assert result.passed[0].held_until is None
    assert result.counts.get("người thật", 0) == 0


# ---------------------------------------------------------------- AC-MOD-08


def _daily_cand(eid, **over):
    base = {
        "element_id": eid,
        "name": f"Món {eid}",
        "emoji": "🍲",
        "depth": 5,
        "source": "trend",
        "added_version": 1,
        "active": True,
        "reachable": True,
        "held": False,
        "hint": f"Gợi ý {eid}",
        "hint_ok": True,
    }
    base.update(over)
    return base


def _hot_passed():
    llm = FakeLlm(answers={"hot": verdict("hot", hot_person=True)})
    result = run([concept("hot", "Hiện Tượng Nóng")], llm, batch_date=D)
    assert passed_keys(result) == ["hot"]
    return result.passed[0]


def test_ac_mod_08_noi_dung_nong_vi_mot_nguoi_bi_hoan_30_ngay():
    """AC-MOD-08: hot_person=true -> vẫn đi tiếp nhưng held_until = D + 30 ngày."""
    p = _hot_passed()
    assert p.held_until == D_PLUS_30
    assert date(2026, 11, 19) == D_PLUS_30


def test_ac_mod_08_khong_nong_thi_khong_hoan():
    """AC-MOD-08: hot_person=false -> held_until None."""
    result = run([concept("a", "A")], FakeLlm())
    assert result.passed[0].held_until is None


def test_ac_mod_08_bien_d_cong_29_con_hoan_d_cong_30_het_hoan():
    """AC-MOD-08: ngày D+29 còn hoãn, D+30 xét bình thường; so với batch_date, không dùng đồng hồ hệ thống."""
    from lau_meme_pipeline.moderation import is_held

    until = D_PLUS_30
    assert is_held(until, D) is True
    assert is_held(until, D_PLUS_29) is True
    assert is_held(until, D_PLUS_30) is False
    assert is_held(until, date(2026, 12, 31)) is False
    assert is_held(None, D) is False
    assert is_held(None, date(1999, 1, 1)) is False


def test_ac_mod_08_khong_duoc_chon_mon_dac_biet_truoc_d_cong_30():
    """AC-MOD-08: phần tử hoãn không bao giờ được select_daily chọn trước D+30, sau đó được xét bình thường."""
    from lau_meme_pipeline.moderation import daily_candidate_flags

    from lau_meme_pipeline.daily import select_daily

    p = _hot_passed()
    assert daily_candidate_flags(p, D) == {"held": True, "hint_ok": True}
    assert daily_candidate_flags(p, D_PLUS_29) == {"held": True, "hint_ok": True}
    assert daily_candidate_flags(p, D_PLUS_30) == {"held": False, "hint_ok": True}

    other = _daily_cand("other", source="classic", added_version=0)
    for version in range(1, 12):
        hot = _daily_cand("hot", added_version=99, **daily_candidate_flags(p, D_PLUS_29))
        assert select_daily([hot, other], [], version)["element_id"] == "other"
    # sau D+30: trend mới nhất thắng classic
    hot_free = _daily_cand("hot", added_version=99, **daily_candidate_flags(p, D_PLUS_30))
    assert select_daily([hot_free, other], [], 3)["element_id"] == "hot"


def test_ac_mod_08_khong_co_nhan_moi_truoc_d_cong_30():
    """AC-MOD-08: không gắn nhãn "MỚI" khi còn hoãn; từ D+30 thì có."""
    from lau_meme_pipeline.moderation import show_new_label

    p = _hot_passed()
    assert show_new_label(p, D) is False
    assert show_new_label(p, D_PLUS_29) is False
    assert show_new_label(p, D_PLUS_30) is True

    normal = run([concept("n", "N")], FakeLlm()).passed[0]
    assert show_new_label(normal, D) is True


def test_ac_mod_08_ngay_hoan_tinh_theo_batch_date_khong_theo_dong_ho():
    """AC-MOD-08: held_until phụ thuộc batch_date truyền vào (qua ranh giới tháng/năm), không phụ thuộc ngày hôm nay."""
    llm = FakeLlm(answers={"h": verdict("h", hot_person=True)})
    result = run([concept("h", "H")], llm, batch_date=date(2026, 12, 20))
    assert result.passed[0].held_until == date(2027, 1, 19)
    result = run([concept("h", "H")], llm, batch_date=date(2020, 2, 10))
    assert result.passed[0].held_until == date(2020, 3, 11)  # 2020 là năm nhuận


def test_ac_mod_08_hot_person_ma_bi_loai_thi_khong_vao_passed():
    """AC-MOD-08: nội dung nóng nhưng đã vi phạm (danh mục cấm) vẫn bị loại, không được "hoãn" thay vì loại."""
    llm = FakeLlm(answers={"x": verdict("x", category="sexual", hot_person=True)})
    result = run([concept("x", "X")], llm)
    assert result.rejected == {"x": "sexual"}
    assert result.passed == []


# ---------------------------------------------------------------- AC-MOD-09


def test_ac_mod_09_cao_buoc_bi_loai_du_an_toan_va_confidence_cao():
    """AC-MOD-09: accusation=true bị loại kể cả category "safe" và confidence 1.0; tên/bí danh vào new_aliases."""
    llm = FakeLlm(
        answers={
            "acc": verdict(
                "acc", category="safe", confidence=1.0, accusation=True, name="Trần Thị B", aliases=["Cô B", "TTB"]
            )
        }
    )
    result = run([concept("acc", "Vụ Việc B")], llm)
    assert result.rejected == {"acc": "accusation"}
    assert result.passed == []
    assert result.new_aliases == frozenset({"tran thi b", "co b", "ttb"})
    assert result.counts["người thật"] == 1


def test_ac_mod_09_cao_buoc_uu_tien_hon_hai_huoc_hot_person():
    """AC-MOD-09: accusation thắng hot_person — không được chỉ "hoãn" mà phải loại."""
    llm = FakeLlm(answers={"acc": verdict("acc", accusation=True, hot_person=True)})
    result = run([concept("acc", "A")], llm)
    assert result.rejected == {"acc": "accusation"}
    assert result.passed == []


def test_ac_mod_09_dua_ve_quay_roi_dang_chung_chung_bi_loai():
    """AC-MOD-09: đùa về quấy rối/xâm hại dạng chung chung (category harassment) bị loại, đếm "quấy rối"."""
    llm = FakeLlm(answers={"h": verdict("h", category="harassment", confidence=0.99)})
    result = run([concept("h", "H")], llm)
    assert result.rejected == {"h": "harassment"}
    assert result.counts["quấy rối"] == 1


def test_ac_mod_09_cao_buoc_khong_lam_loi_khi_khong_co_ten():
    """AC-MOD-09: accusation=true với person.name None vẫn loại, không ném lỗi."""
    llm = FakeLlm(answers={"acc": verdict("acc", accusation=True, name=None, aliases=[])})
    result = run([concept("acc", "A")], llm)
    assert result.rejected == {"acc": "accusation"}
    assert result.new_aliases == frozenset()


# ---------------------------------------------------------------- AC-MOD-10


def test_ac_mod_10_ten_bi_quan_tri_chan_khong_quay_lai():
    """AC-MOD-10: fold trùng tên bị quản trị chặn -> loại ở lớp 1, không gửi LLM, đếm "đã bị chặn"."""
    from lau_meme_pipeline.moderation import layer1

    ml = lists(admin_blocked={"Phần Tử X"})
    again = concept("again", "PHAN TU x")
    assert layer1(again, ml) == "admin_blocked"
    llm = FakeLlm()
    result = run([again, concept("ok", "Cây Khế")], llm, ml)
    assert result.rejected == {"again": "admin_blocked"}
    assert llm.sent_keys == ["ok"]
    assert result.counts["đã bị chặn"] == 1


def test_ac_mod_10_chi_khop_ten_chinh_xac_sau_fold_khong_khop_chuoi_con():
    """AC-MOD-10: admin_blocked so khớp đúng tên (fold), tên dài hơn chứa tên bị chặn thì không bị loại ở lớp này."""
    from lau_meme_pipeline.moderation import layer1

    ml = lists(admin_blocked={"X"})
    assert layer1(concept(name="x"), ml) == "admin_blocked"
    assert layer1(concept(name="Xe Máy"), ml) is None
    assert layer1(concept(name="Super X"), ml) is None
    assert layer1(concept(name="Cây Khế", description="X"), ml) is None


def test_ac_mod_10_thu_tu_uu_tien_admin_roi_bi_danh_roi_tu_cam():
    """AC-MOD-10: một khái niệm trúng nhiều lớp 1 -> admin_blocked, rồi blocked_alias, rồi banned_word."""
    from lau_meme_pipeline.moderation import layer1

    c = concept(name="abc")
    assert layer1(c, lists(admin_blocked={"abc"}, aliases={"abc"}, banned_words={"abc"})) == "admin_blocked"
    assert layer1(c, lists(aliases={"abc"}, banned_words={"abc"})) == "blocked_alias"
    assert layer1(c, lists(banned_words={"abc"})) == "banned_word"
    assert layer1(c, lists()) is None


def test_ac_mod_10_dem_nhieu_nhan_trong_mot_dot():
    """AC-MOD-10: (cũng AC-MOD-01) báo cáo đợt đếm riêng từng loại lớp 1."""
    ml = lists(banned_words={"tục"}, aliases={"abc xyz"}, admin_blocked={"X"})
    concepts = [
        concept("a", "Tục Tĩu"),
        concept("b", "ABC Xyz"),
        concept("c", "x"),
        concept("d", "Cây Khế"),
    ]
    result = run(concepts, FakeLlm(), ml)
    assert result.counts["từ cấm"] == 1
    assert result.counts["bí danh bị chặn"] == 1
    assert result.counts["đã bị chặn"] == 1
    assert passed_keys(result) == ["d"]


# ---------------------------------------------------------------- general


def test_ac_mod_03_khong_coi_an_toan_khi_dau_vao_rong_hoac_khong_co_llm_loi():
    """AC-MOD-03: đầu vào rỗng không gọi LLM và trả kết quả rỗng."""
    llm = FakeLlm()
    result = run([], llm)
    assert llm.calls == []
    assert result.passed == [] and result.rejected == {} and result.queued == []
    assert result.new_aliases == frozenset()
