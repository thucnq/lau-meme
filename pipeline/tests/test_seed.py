import copy
import json
from pathlib import Path

import pytest

from lau_meme_pipeline.ids import element_id, recipe_id
from lau_meme_pipeline.seed import ContentStore, SeedError, load_core, main

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
STARTERS = ["Cay", "Cười", "Toang", "Deadline"]
SUMMARY_PARTS = ("139 phần tử", "363 công thức", "40 câu Nồi trào", "4 phần tử khởi đầu")
ORPHAN = {"name": "Lạc Trôi Mất Tiêu", "emoji": "🛸", "origin": "V", "depth": 3, "image_hint": "x"}


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def used_pairs(core: dict) -> set:
    return {frozenset((r["a"], r["b"])) for r in core["recipes"]}


def add_reachable(core: dict, name: str, emoji: str) -> None:
    """Thêm phần tử mới có công thức từ cặp chưa dùng (tới được từ khởi đầu)."""
    names = [e["name"] for e in core["elements"]]
    taken = used_pairs(core)
    for a in STARTERS:
        for b in names:
            if frozenset((a, b)) not in taken:
                core["elements"].append(
                    {"name": name, "emoji": emoji, "origin": "V", "depth": 9, "image_hint": "x"}
                )
                core["recipes"].append({"a": a, "b": b, "result": name, "best": False})
                return
    raise AssertionError("no free pair")


def bfs_depths(core: dict) -> dict:
    """Độ sâu = số vòng mở rộng từ 4 phần tử khởi đầu (cài độc lập trong test)."""
    depth = {s: 0 for s in core["starters"]}
    level = 0
    while True:
        level += 1
        new = {}
        for r in core["recipes"]:
            if r["a"] in depth and r["b"] in depth and r["result"] not in depth:
                new.setdefault(r["result"], level)
        if not new:
            return depth
        depth.update(new)


def assert_fails(core: dict, needles: list[str]) -> None:
    store = ContentStore.empty()
    with pytest.raises(SeedError) as exc:
        load_core(core, store)
    text = "\n".join(exc.value.problems)
    for n in needles:
        assert n in text
    assert store == ContentStore.empty()


def test_ids_formula_and_order_independence():
    """AC-SEED-01: id phần tử 43 ký tự, id công thức không phụ thuộc thứ tự."""
    assert len(element_id("Cay")) == 43
    assert element_id("Cà Khịa") == element_id("ca khia")
    assert recipe_id("Cay", "Cười") == recipe_id("Cười", "Cay")
    assert recipe_id("Cay", "Cười") != recipe_id("Cay", "Toang")


def test_ac_seed_01_nap_loi_hop_le():
    """AC-SEED-01: nạp lõi hợp lệ vào kho rỗng."""
    core = real_core()
    result = load_core(core, ContentStore.empty())
    store = result.store
    assert len(store.elements) == 139
    assert len(store.recipes) == 363
    assert len(store.miss_lines) == 40
    assert len(store.starters) == 4
    assert store.starters == tuple(element_id(s) for s in STARTERS)
    assert all(e.status == "active" and e.batch == "classic" for e in store.elements.values())
    assert all(r.batch == "classic" and r.status == "active" for r in store.recipes.values())
    for r in core["recipes"]:
        rec = store.recipes[recipe_id(r["a"], r["b"])]
        assert rec.result == element_id(r["result"])
    assert result.changed is True
    for frag in SUMMARY_PARTS:
        assert frag in result.summary


def test_ac_seed_01_cli_in_tom_tat(tmp_path, capsys):
    """AC-SEED-01: lệnh in tóm tắt, ghi file kho, trả 0."""
    store_path = tmp_path / "store.json"
    code = main([str(CORE_PATH), "--store", str(store_path)])
    out = capsys.readouterr().out
    assert code == 0
    for frag in SUMMARY_PARTS:
        assert frag in out
    loaded = ContentStore.from_json(store_path.read_text(encoding="utf-8"))
    assert len(loaded.elements) == 139 and len(loaded.recipes) == 363


def test_ac_seed_02_phan_tu_khong_toi_duoc():
    """AC-SEED-02: phần tử mồ côi bị liệt kê, kho không đổi."""
    core = real_core()
    core["elements"].append(dict(ORPHAN))
    assert_fails(core, [ORPHAN["name"]])


def test_ac_seed_02_chi_toi_duoc_qua_vong_kin():
    """AC-SEED-02: hai phần tử chỉ sinh ra từ nhau vẫn không tới được."""
    core = real_core()
    core["elements"] += [
        {"name": "Vòng Một", "emoji": "🅰️", "origin": "V", "depth": 3, "image_hint": "x"},
        {"name": "Vòng Hai", "emoji": "🅱️", "origin": "V", "depth": 3, "image_hint": "x"},
    ]
    core["recipes"] += [
        {"a": "Vòng Một", "b": "Vòng Một", "result": "Vòng Hai", "best": False},
        {"a": "Vòng Hai", "b": "Vòng Hai", "result": "Vòng Một", "best": False},
    ]
    assert_fails(core, ["Vòng Một", "Vòng Hai"])


def test_ac_seed_02_cli_that_bai_khong_ghi_kho(tmp_path, capsys):
    """AC-SEED-02: lệnh thất bại trả 1, in phần tử lỗi, không ghi file kho."""
    core = real_core()
    core["elements"].append(dict(ORPHAN))
    core_path = tmp_path / "core.json"
    core_path.write_text(json.dumps(core, ensure_ascii=False), encoding="utf-8")
    store_path = tmp_path / "store.json"
    code = main([str(core_path), "--store", str(store_path)])
    out = capsys.readouterr().out
    assert code == 1
    assert ORPHAN["name"] in out
    assert not store_path.exists()


def test_ac_seed_02_that_bai_khong_doi_kho_da_co():
    """AC-SEED-02: kho đã có dữ liệu không đổi khi nạp lỗi."""
    good = load_core(real_core(), ContentStore.empty()).store
    snapshot = good.to_json()
    bad = copy.deepcopy(real_core())
    bad["elements"].append(dict(ORPHAN))
    with pytest.raises(SeedError):
        load_core(bad, good)
    assert good.to_json() == snapshot


def test_ac_seed_03_trung_cap_dao_thu_tu():
    """AC-SEED-03: (A,B) và (B,A) bị coi là trùng cặp."""
    core = real_core()
    r = next(x for x in core["recipes"] if x["a"] != x["b"])
    core["recipes"].append({"a": r["b"], "b": r["a"], "result": r["result"], "best": False})
    assert_fails(core, [r["a"], r["b"]])


def test_ac_seed_03_trung_cap_khac_ket_qua():
    """AC-SEED-03: cùng cặp nhưng khác kết quả cũng thất bại."""
    core = real_core()
    r = core["recipes"][0]
    other = next(e["name"] for e in core["elements"] if e["name"] not in (r["result"], r["a"], r["b"]))
    core["recipes"].append({"a": r["a"], "b": r["b"], "result": other, "best": False})
    assert_fails(core, [r["a"]])


def test_ac_seed_04_trung_ten_sau_chuan_hoa():
    """AC-SEED-04: "Cà Khịa" và "ca khia" trùng sau chuẩn hóa."""
    core = real_core()
    add_reachable(core, "Cà Khịa Test", "🧪")
    add_reachable(core, "ca khia test", "🧫")
    assert_fails(core, ["Cà Khịa Test", "ca khia test"])


def test_ac_seed_04_trung_emoji():
    """AC-SEED-04: hai phần tử cùng emoji bị từ chối."""
    core = real_core()
    first = core["elements"][0]
    add_reachable(core, "Trùng Emoji Một", first["emoji"])
    assert_fails(core, ["Trùng Emoji Một", first["name"]])


def test_ac_seed_05_tham_chieu_dau_vao_khong_ton_tai():
    """AC-SEED-05: đầu vào không có trong elements."""
    core = real_core()
    core["recipes"].append({"a": "Cay", "b": "Ma Không Tồn Tại", "result": "Cười", "best": False})
    assert_fails(core, ["Ma Không Tồn Tại"])


def test_ac_seed_05_tham_chieu_ket_qua_khong_ton_tai():
    """AC-SEED-05: kết quả không có trong elements."""
    core = real_core()
    core["recipes"].append({"a": "Cay", "b": "Toang", "result": "Kết Quả Ma", "best": False})
    assert_fails(core, ["Kết Quả Ma"])


def test_ac_seed_05_tu_tham_chieu():
    """AC-SEED-05: kết quả trùng một trong hai đầu vào."""
    core = real_core()
    taken = used_pairs(core)
    b = next(e["name"] for e in core["elements"] if frozenset(("Cay", e["name"])) not in taken)
    core["recipes"].append({"a": "Cay", "b": b, "result": b, "best": False})
    assert_fails(core, [b])


def test_ac_seed_06_depth_tinh_lai_bfs():
    """AC-SEED-06: depth lưu là BFS, cảnh báo phần tử lệch, khởi đầu depth 0."""
    core = real_core()
    expected = bfs_depths(core)
    victim = next(e for e in core["elements"] if e["name"] not in STARTERS)
    victim["depth"] = expected[victim["name"]] + 7
    starter = next(e for e in core["elements"] if e["name"] == "Cay")
    starter["depth"] = 5
    result = load_core(core, ContentStore.empty())
    for name, d in expected.items():
        assert result.store.elements[element_id(name)].depth == d
    for s in STARTERS:
        assert result.store.elements[element_id(s)].depth == 0
    warned = "\n".join(result.warnings)
    assert victim["name"] in warned
    assert "Cay" in warned


def test_ac_seed_07_ten_rong():
    """AC-SEED-07: tên rỗng bị từ chối."""
    core = real_core()
    core["elements"].append({"name": "", "emoji": "🈳", "origin": "V", "depth": 1, "image_hint": "x"})
    store = ContentStore.empty()
    with pytest.raises(SeedError) as exc:
        load_core(core, store)
    assert exc.value.problems
    assert store == ContentStore.empty()


def test_ac_seed_07_ten_qua_4_tu():
    """AC-SEED-07: tên dài hơn 4 từ bị từ chối."""
    core = real_core()
    add_reachable(core, "Một Hai Ba Bốn Năm", "5️⃣")
    assert_fails(core, ["Một Hai Ba Bốn Năm"])


def test_ac_seed_07_emoji_rong():
    """AC-SEED-07: emoji rỗng bị từ chối."""
    core = real_core()
    add_reachable(core, "Thiếu Emoji", "")
    assert_fails(core, ["Thiếu Emoji"])


def test_ac_seed_08_nap_lai_idempotent():
    """AC-SEED-08: nạp lại cùng file thì kho không đổi."""
    core = real_core()
    first = load_core(core, ContentStore.empty())
    snapshot = first.store.to_json()
    second = load_core(core, first.store)
    assert second.changed is False
    assert "không có thay đổi" in second.summary
    assert second.store == first.store
    assert second.store.to_json() == snapshot
    assert len(second.store.elements) == 139
    assert {k: v.depth for k, v in second.store.elements.items()} == {
        k: v.depth for k, v in first.store.elements.items()
    }
    assert first.store == ContentStore.from_json(snapshot)


def test_ac_seed_08_cli_idempotent(tmp_path, capsys):
    """AC-SEED-08: chạy lệnh lần hai báo không có thay đổi, file kho giữ nguyên."""
    store_path = tmp_path / "store.json"
    assert main([str(CORE_PATH), "--store", str(store_path)]) == 0
    before = store_path.read_text(encoding="utf-8")
    capsys.readouterr()
    assert main([str(CORE_PATH), "--store", str(store_path)]) == 0
    out = capsys.readouterr().out
    assert "không có thay đổi" in out
    assert store_path.read_text(encoding="utf-8") == before
