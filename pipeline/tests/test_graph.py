import base64
import json
import re
from datetime import UTC, datetime, timezone
from hashlib import sha256
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from lau_meme_pipeline.graph import build_manifest, decrypt_entry, export_graph, graph_to_bytes
from lau_meme_pipeline.ids import element_id, recipe_id
from lau_meme_pipeline.seed import ContentStore, load_core
from lau_meme_pipeline.text import fold

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
ROLLBACK_WORKFLOW = ROOT / ".github" / "workflows" / "rollback.yml"
STARTERS = ["Cay", "Cười", "Toang", "Deadline"]
BATCH_AT = datetime(2026, 10, 20, 5, 30, 0, tzinfo=UTC)


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def build_store() -> ContentStore:
    return load_core(real_core(), ContentStore.empty()).store


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sorted_fold(a: str, b: str) -> tuple[str, str]:
    x, y = sorted((fold(a), fold(b)), key=lambda s: s.encode("utf-8"))
    return x, y


def adr_lookup_key(a: str, b: str) -> str:
    """Cài lại độc lập công thức khóa tra cứu của ADR 0002."""
    x, y = sorted_fold(a, b)
    return b64u(sha256(("lm1|k|" + x + "\0" + y).encode("utf-8")).digest())


def adr_decrypt(graph: dict, a: str, b: str) -> dict:
    """Cài lại độc lập HKDF + AES-GCM của ADR 0002."""
    x, y = sorted_fold(a, b)
    key_id = adr_lookup_key(a, b)
    okm = HKDF(
        algorithm=hashes.SHA256(),
        length=44,
        salt=("lm1|graph|v" + str(graph["version"])).encode("utf-8"),
        info=b"lm1|aes-gcm",
    ).derive((x + "\0" + y).encode("utf-8"))
    key, iv = okm[:32], okm[32:]
    plain = AESGCM(key).decrypt(iv, unb64u(graph["entries"][key_id]), key_id.encode("ascii"))
    return json.loads(plain.decode("utf-8"))


def bfs_depths(core: dict) -> dict:
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


def make_daily(store: ContentStore) -> dict:
    daily_id = next(i for i, e in store.elements.items() if e.depth >= 4)
    return {"element_id": daily_id, "emoji": "🍲", "hint": "Gợi ý hôm nay", "depth": 4}


def make_manifest(store: ContentStore, version: int = 3, previous: int | None = 2) -> dict:
    return build_manifest(store, version=version, batch_at=BATCH_AT, daily=make_daily(store), previous_version=previous)


def hidden_elements(core: dict) -> list[dict]:
    return [e for e in core["elements"] if e["depth"] >= 1 and e["name"] not in STARTERS]


class FakeClient:
    def __init__(self, status: int, body: dict):
        self.status = status
        self.body = body
        self.calls: list = []

    def post_rollback(self, version):
        self.calls.append(version)
        return self.status, self.body


def test_ac_graph_01_khoa_tra_cuu_la_bam_cap_da_sap_xep():
    """AC-GRAPH-01: khóa của (Cay, Cười) trùng (Cười, Cay), là băm 43 ký tự, không chứa tên đọc được."""
    store = build_store()
    graph = export_graph(store, 3)
    key = recipe_id("Cay", "Cười")
    assert key == recipe_id("Cười", "Cay")
    assert key == adr_lookup_key("Cay", "Cười")
    assert len(key) == 43
    assert key in graph["entries"]
    assert graph["format"] == 1 and graph["version"] == 3
    assert set(graph["entries"]) == set(store.recipes)
    assert all(len(k) == 43 and k.replace("-", "").replace("_", "").isalnum() for k in graph["entries"])
    assert key.isascii() and " " not in key


def test_ac_graph_02_giai_ma_dung_ket_qua_hai_chieu():
    """AC-GRAPH-02: mọi công thức của lõi giải mã đúng bằng (a, b) và (b, a)."""
    core = real_core()
    depths = bfs_depths(core)
    emoji = {e["name"]: e["emoji"] for e in core["elements"]}
    graph = export_graph(build_store(), 3)
    assert len(core["recipes"]) == 518
    for r in core["recipes"]:
        for first, second in ((r["a"], r["b"]), (r["b"], r["a"])):
            got = decrypt_entry(graph, first, second)
            assert got is not None, (first, second)
            assert got["name"] == r["result"]
            assert got["id"] == element_id(r["result"])
            assert got["emoji"] == emoji[r["result"]]
            assert got["depth"] == depths[r["result"]]
            assert got["added_version"] == 0
            assert got["image_key"] is None


def test_ac_graph_02_sai_doi_tac_hoac_thieu_muc_thi_tra_none():
    """AC-GRAPH-02: giải mã bằng (A, X), cặp không có mục, hoặc mục bị đổi chỗ đều trả None, không ném lỗi."""
    core = real_core()
    graph = export_graph(build_store(), 3)
    r = core["recipes"][0]
    pair = {r["a"], r["b"]}
    used = {frozenset((x["a"], x["b"])) for x in core["recipes"]}
    wrong = next(e["name"] for e in core["elements"] if frozenset((r["a"], e["name"])) not in used)
    assert decrypt_entry(graph, r["a"], wrong) is None
    assert decrypt_entry(graph, "Không Có Thật", "Cũng Không Có") is None
    # mục của cặp (a, b) đặt dưới khóa của cặp khác: thẻ GCM không khớp => None
    victim = next(x for x in core["recipes"] if {x["a"], x["b"]} != pair)
    tampered = json.loads(json.dumps(graph))
    tampered["entries"][recipe_id(victim["a"], victim["b"])] = graph["entries"][recipe_id(r["a"], r["b"])]
    assert decrypt_entry(tampered, victim["a"], victim["b"]) is None
    # bản mã bị hỏng
    broken = json.loads(json.dumps(graph))
    broken["entries"][recipe_id(r["a"], r["b"])] = "AAAA"
    assert decrypt_entry(broken, r["a"], r["b"]) is None


def test_ac_graph_02_khop_cai_dat_doc_lap_theo_adr_0002():
    """AC-GRAPH-02: HKDF-SHA256 + AES-256-GCM (aad = khóa tra cứu) cài độc lập giải ra đúng bản rõ."""
    core = real_core()
    rec = next(r for r in core["recipes"] if {r["a"], r["b"]} == {"Cay", "Cười"})
    expected = next(e for e in core["elements"] if e["name"] == rec["result"])
    graph = export_graph(build_store(), 7)
    plain = adr_decrypt(graph, "Cay", "Cười")
    assert plain["id"] == element_id(expected["name"])
    assert plain["name"] == expected["name"]
    assert plain["emoji"] == expected["emoji"]
    assert plain["added_version"] == 0
    assert plain["image_key"] is None
    assert set(plain) == {"id", "name", "emoji", "depth", "added_version", "image_key"}
    assert adr_decrypt(graph, "Cười", "Cay") == plain
    assert decrypt_entry(graph, "Cay", "Cười") == plain


B64URL = re.compile(r"^[A-Za-z0-9_-]+$")


def needs_search(s: str) -> bool:
    """Tên dài >= 6 hoặc có ký tự ngoài bảng base64url thì phải không xuất hiện trong graph."""
    return len(s) >= 6 or not B64URL.match(s)


def string_values(node) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [v for x in node.values() for v in string_values(x)]
    if isinstance(node, list):
        return [v for x in node for v in string_values(x)]
    return []


def test_ac_graph_03_graph_khong_lo_ten_va_emoji_ket_qua():
    """AC-GRAPH-03: graph chỉ có 3 khóa, khóa/giá trị base64url; không chứa tên dài/có dấu hay emoji depth >= 1."""
    core = real_core()
    graph = export_graph(build_store(), 3)
    blob = graph_to_bytes(graph)
    text = blob.decode("utf-8")
    assert set(graph) == {"format", "version", "entries"}
    for k, v in graph["entries"].items():
        assert B64URL.match(k) and B64URL.match(v)
    hidden = hidden_elements(core)
    assert len(hidden) >= 100
    for e in hidden:
        for form in (e["name"], fold(e["name"])):
            if needs_search(form):
                assert form.encode("utf-8") not in blob, e["name"]
        assert e["emoji"] not in text, e["name"]


def test_ac_graph_03_manifest_chi_lo_ten_4_phan_tu_khoi_dau():
    """AC-GRAPH-03: manifest có tên 4 phần tử khởi đầu dạng đọc được và không có tên phần tử khác."""
    core = real_core()
    manifest = make_manifest(build_store())
    assert [s["name"] for s in manifest["starters"]] == STARTERS
    assert [s["id"] for s in manifest["starters"]] == [element_id(s) for s in STARTERS]
    values = string_values({k: v for k, v in manifest.items() if k != "miss_lines"})
    for e in hidden_elements(core):
        for form in (e["name"], fold(e["name"])):
            pattern = re.compile(r"(?<!\w)" + re.escape(form) + r"(?!\w)")
            for v in values:
                assert not pattern.search(v), (e["name"], v)


def test_ac_graph_04_xuat_hai_lan_cho_byte_giong_nhau():
    """AC-GRAPH-04: xuất lại cùng store và version cho đúng cùng byte; đổi version thì mã hóa khác."""
    store = build_store()
    first = graph_to_bytes(export_graph(store, 3))
    assert first == graph_to_bytes(export_graph(build_store(), 3))
    assert first != graph_to_bytes(export_graph(store, 4))
    assert json.loads(first)["version"] == 3
    assert first == json.dumps(json.loads(first), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def test_ac_graph_04_manifest_co_version_va_gio_that():
    """AC-GRAPH-04: manifest có version, batch_at đúng T (UTC, hậu tố Z), graph_url, 4 món khởi đầu, 40 câu, daily."""
    store = build_store()
    daily = make_daily(store)
    manifest = build_manifest(store, version=3, batch_at=BATCH_AT, daily=daily, previous_version=2)
    assert manifest["version"] == 3
    assert manifest["batch_at"] == "2026-10-20T05:30:00Z"
    assert manifest["graph_url"] == "/api/graph/3"
    assert len(manifest["starters"]) == 4
    assert set(manifest["starters"][0]) == {"id", "name", "emoji"}
    assert len(manifest["miss_lines"]) == 40
    assert manifest["daily"] == daily
    assert "policy_version" not in manifest


def test_ac_graph_04_manifest_doi_mui_gio_ve_utc():
    """AC-GRAPH-04: giờ mẻ ở múi giờ khác vẫn xuất ra UTC."""
    from datetime import timedelta

    store = build_store()
    local = BATCH_AT.astimezone(timezone(timedelta(hours=7)))
    manifest = build_manifest(store, version=1, batch_at=local, daily=make_daily(store), previous_version=None)
    assert manifest["batch_at"] == "2026-10-20T05:30:00Z"


def test_ac_graph_04_version_phai_tang_nghiem_ngat():
    """AC-GRAPH-04: version bằng hoặc nhỏ hơn bản trước bị từ chối bằng ValueError."""
    store = build_store()
    daily = make_daily(store)
    for version in (5, 4, 1):
        with pytest.raises(ValueError):
            build_manifest(store, version=version, batch_at=BATCH_AT, daily=daily, previous_version=5)
    ok = build_manifest(store, version=6, batch_at=BATCH_AT, daily=daily, previous_version=5)
    assert ok["version"] == 6
    first = build_manifest(store, version=1, batch_at=BATCH_AT, daily=daily, previous_version=None)
    assert first["version"] == 1


def test_ac_graph_06_rollback_thanh_cong_khong_tham_so():
    """AC-GRAPH-06: 200 -> ok, version là bản đã chuyển về, client được gọi với version None."""
    from lau_meme_pipeline.rollback import run_rollback

    client = FakeClient(200, {"status": "rollback", "rollback_to": 7, "version": None})
    outcome = run_rollback(client, None)
    assert outcome.ok is True
    assert outcome.version == 7
    assert outcome.message
    assert client.calls == [None]


def test_ac_graph_06_rollback_chi_dinh_version():
    """AC-GRAPH-06: chỉ định version thì gửi đúng version đó lên client."""
    from lau_meme_pipeline.rollback import run_rollback

    client = FakeClient(200, {"status": "rollback", "rollback_to": 3})
    outcome = run_rollback(client, 3)
    assert client.calls == [3]
    assert outcome.ok is True and outcome.version == 3


def test_ac_graph_06_main_tra_0_va_nhan_version_tu_dong_lenh():
    """AC-GRAPH-06: main trả 0 khi thành công; --version được chuyển thành số nguyên."""
    from lau_meme_pipeline.rollback import main

    client = FakeClient(200, {"status": "rollback", "rollback_to": 2})
    assert main([], client) == 0
    assert main(["--version", "2"], client) == 0
    assert client.calls == [None, 2]


def test_ac_graph_06_workflow_rollback_chay_tay():
    """AC-GRAPH-06: .github/workflows/rollback.yml chạy tay, version tùy chọn, gọi module rollback."""
    assert ROLLBACK_WORKFLOW.is_file()
    text = ROLLBACK_WORKFLOW.read_text(encoding="utf-8")
    assert "workflow_dispatch" in text
    assert "inputs:" in text
    assert "version:" in text
    assert "python -m lau_meme_pipeline.rollback" in text
    assert "PIPELINE_TOKEN" in text


def test_ac_graph_07_khong_co_ban_truoc_that_bai_ro_rang():
    """AC-GRAPH-07: 409 -> ok False, thông báo tiếng Việt chứa title của problem."""
    from lau_meme_pipeline.rollback import main, run_rollback

    body = {"type": "about:blank", "title": "Không có bản trước để rollback", "status": 409}
    outcome = run_rollback(FakeClient(409, body), None)
    assert outcome.ok is False
    assert outcome.version is None
    assert "Không có bản trước để rollback" in outcome.message
    assert main([], FakeClient(409, body)) == 1


def test_ac_graph_07_version_khong_ton_tai_that_bai_ro_rang():
    """AC-GRAPH-07: 404 -> ok False, thông báo chứa title, main trả 1."""
    from lau_meme_pipeline.rollback import main, run_rollback

    body = {"type": "about:blank", "title": "Không còn lưu version này", "status": 404}
    outcome = run_rollback(FakeClient(404, body), 99)
    assert outcome.ok is False
    assert "Không còn lưu version này" in outcome.message
    assert main(["--version", "99"], FakeClient(404, body)) == 1


def test_ac_graph_07_loi_may_chu_khong_title_van_that_bai():
    """AC-GRAPH-07: phản hồi lỗi không có title vẫn trả ok False kèm thông báo không rỗng."""
    from lau_meme_pipeline.rollback import run_rollback

    outcome = run_rollback(FakeClient(500, {}), None)
    assert outcome.ok is False
    assert outcome.message
