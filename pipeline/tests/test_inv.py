"""Acceptance tests for docs/acceptance/inv.md, pipeline part: AC-INV-01..07, 10, 12 (AC-INV-08/09 live in the
worker tests, AC-INV-11 in worker/test/inv.test.ts).

Properties are checked on the golden dataset in tests/golden/: the classic core docs/input/noi-dung-loi.json plus
synthetic graphs written by tests/golden/generate.py (fixed seeds) with `expected.json` computed there by an
independent reference implementation (own BFS), never by production code.

Expected module `lau_meme_pipeline.invariants` (pure; no network/clock):

    class InvariantError(Exception)                       # .violations: list[str]
    check_symmetric(graph, names) -> list[str]            # INV-01
    check_unique_pairs(store) -> list[str]                # INV-02
    check_reachability(store) -> list[str]                # INV-03
    check_opaque(graph, store) -> list[str]               # INV-04
    check_moderation(store, lists) -> list[str]           # INV-07
    check_daily(manifest, store) -> list[str]             # INV-10
    check_all(graph, manifest, store, lists) -> None      # raises InvariantError with every violation
    simulate_miss_rate(graph, starters, *, games=1000, turns=100, seed=0) -> (first20, overall)   # INV-12
    miss_rate_warning(first20, overall) -> str | None

Wiring: batch.run_batch (core mode) and full.run_full call check_all before publishing; a violation fails the batch
with failed_step == "invariants"; the INV-12 warning only goes into the report body.
Imports happen inside the tests so a missing module fails at runtime, not at collection.
"""

import base64
import copy
import importlib.util
import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ROOT = Path(__file__).resolve().parents[2]
CORE_PATH = ROOT / "docs" / "input" / "noi-dung-loi.json"
GOLDEN = Path(__file__).resolve().parent / "golden"

T = datetime(2026, 10, 20, 17, 0, 0, tzinfo=UTC)
T_VERSION = 202610210000
PREV_VERSION = 202610200000
GRAPH_VERSION = 5
DATASETS = ["classic", "synthetic-7", "synthetic-11", "synthetic-22", "synthetic-33", "synthetic-44"]
TINY = "synthetic-7"
BATCH_STEPS = ["state", "seed", "daily", "export", "check", "banned", "publish"]
B64URL = re.compile(r"^[A-Za-z0-9_-]+$")


# ================================================================ golden dataset


def load_generator():
    spec = importlib.util.spec_from_file_location("golden_generate", GOLDEN / "generate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seeded(seed: int):
    """Fixed-seed PRNG of the golden generator (SplitMix64), deterministic on every Python version."""
    return load_generator().Rng(seed)


def expected_all() -> dict:
    return json.loads((GOLDEN / "expected.json").read_text(encoding="utf-8"))


def expected_of(case: str) -> dict:
    return expected_all()["datasets"][case]


def core_of(case: str) -> dict:
    path = CORE_PATH if case == "classic" else GOLDEN / f"{case}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def store_of(core: dict):
    from lau_meme_pipeline.seed import ContentStore, load_core

    return load_core(core, ContentStore.empty()).store


def eid(name: str) -> str:
    from lau_meme_pipeline.ids import element_id

    return element_id(name)


def names_of(core: dict) -> list[str]:
    return [e["name"] for e in core["elements"]]


def mod_lists(**over):
    from lau_meme_pipeline.moderation import ModLists

    return ModLists(**{k: frozenset(v) for k, v in over.items()})


def clean_lists():
    """Lists whose terms match no name in the golden dataset."""
    return mod_lists(banned_words={"zzqx cam"}, aliases={"qqzx bi danh"}, admin_blocked={"wwzx chan"})


def tamper(obj, **attrs) -> None:
    """Set attributes even when the stored object is a frozen dataclass."""
    for k, v in attrs.items():
        object.__setattr__(obj, k, v)


def patch_everywhere(monkeypatch, name: str, fn) -> None:
    """Replace `name` in every pipeline module that defines or imported it (works for `from x import name` and for
    `module.name(...)` call styles alike)."""
    import importlib

    for mod in ("invariants", "batch", "full", "graph", "moderation"):
        try:
            module = importlib.import_module(f"lau_meme_pipeline.{mod}")
        except ImportError:
            continue
        if hasattr(module, name):
            monkeypatch.setattr(module, name, fn)


@pytest.fixture
def fast_sim(monkeypatch):
    """The 1000 x 100 simulation is exercised by the INV-12 tests; elsewhere it is replaced by a fast stub."""
    patch_everywhere(monkeypatch, "simulate_miss_rate", lambda graph, starters, **kw: (0.1, 0.1))


# ================================================================ fakes (same shapes as tests/test_batch.py)


def make_state(history=None, blocked_elements=None, current_version=PREV_VERSION) -> dict:
    return {
        "current_version": current_version,
        "blocklist": {"elements": list(blocked_elements or []), "recipes": [], "images": []},
        "banned_aliases": [],
        "daily_history": list(history or []),
        "feedback": [],
    }


class FakeClient:
    """Records posts; a success post moves current_version like the server does (a failed one never does)."""

    def __init__(self, state=None, fail_state=False, fail_success=False):
        self.state = state if state is not None else make_state()
        self.fail_state = fail_state
        self.fail_success = fail_success
        self.posted: list[dict] = []
        self.calls: list[str] = []
        self._n = 0

    def get_state(self):
        self.calls.append("get_state")
        if self.fail_state:
            raise RuntimeError("state unavailable")
        return copy.deepcopy(self.state)

    def post_batch(self, body):
        self.calls.append("post_batch")
        if self.fail_success and body.get("status") == "success":
            raise RuntimeError("deploy failed")
        self._n += 1
        self.posted.append(copy.deepcopy(body))
        if body.get("status") == "success":
            self.state["current_version"] = body["version"]
        return {
            "id": f"00000000-0000-4000-8000-{self._n:012d}",
            "version": body.get("version"),
            "batch_at": body["batch_at"],
            "mode": body["mode"],
            "status": body["status"],
            "failed_step": body.get("failed_step"),
            "stats": body["stats"],
            "issue_url": None,
            "created_at": body["batch_at"],
        }

    def patch_batch(self, run_id, issue_url):
        self.calls.append("patch_batch")
        return {"id": run_id, "issue_url": issue_url}

    @property
    def success_posts(self):
        return [b for b in self.posted if b["status"] == "success"]

    @property
    def error_posts(self):
        return [b for b in self.posted if b["status"] == "error"]


class FakeReporter:
    def __init__(self):
        self.issues: list[tuple[str, str]] = []

    def create_issue(self, title, body):
        self.issues.append((title, body))
        return f"https://github.com/o/r/issues/{len(self.issues)}"


def run(core, client=None, reporter=None, batch_at=T):
    from lau_meme_pipeline.batch import run_batch

    client = client if client is not None else FakeClient()
    reporter = reporter if reporter is not None else FakeReporter()
    return run_batch(mode="core", batch_at=batch_at, core=core, client=client, reporter=reporter, log=lambda msg: None)


def posted_body(core, history=None) -> dict:
    client = FakeClient(make_state(history=history))
    outcome = run(core, client)
    assert outcome.ok is True, outcome
    (body,) = client.success_posts
    return body


def dumps(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")


# ================================================================ independent ADR 0002 crypto (as in test_graph)


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sorted_fold(a: str, b: str) -> tuple[str, str]:
    from lau_meme_pipeline.text import fold

    x, y = sorted((fold(a), fold(b)), key=lambda s: s.encode("utf-8"))
    return x, y


def adr_key_id(a: str, b: str) -> str:
    from hashlib import sha256

    x, y = sorted_fold(a, b)
    return b64u(sha256(("lm1|k|" + x + "\0" + y).encode("utf-8")).digest())


def adr_key_iv(version: int, a: str, b: str) -> tuple[bytes, bytes]:
    x, y = sorted_fold(a, b)
    okm = HKDF(
        algorithm=hashes.SHA256(), length=44, salt=("lm1|graph|v" + str(version)).encode("utf-8"), info=b"lm1|aes-gcm"
    ).derive((x + "\0" + y).encode("utf-8"))
    return okm[:32], okm[32:]


def adr_try_decrypt(graph: dict, entry_pair: tuple[str, str], with_pair: tuple[str, str]) -> bytes | None:
    """Decrypt the entry stored for `entry_pair` using the key derived from `with_pair`."""
    key_id = adr_key_id(*entry_pair)
    key, iv = adr_key_iv(graph["version"], *with_pair)
    try:
        return AESGCM(key).decrypt(iv, unb64u(graph["entries"][key_id]), key_id.encode("ascii"))
    except InvalidTag:
        return None


def adr_encrypt(version: int, with_pair: tuple[str, str], aad_pair: tuple[str, str], plain: bytes) -> str:
    key, iv = adr_key_iv(version, *with_pair)
    return b64u(AESGCM(key).encrypt(iv, plain, adr_key_id(*aad_pair).encode("ascii")))


# ================================================================ golden sanity (not an AC: guards the data itself)


def test_golden_files_khop_generator_va_expected():
    """Golden: file trên đĩa == đầu ra của generator seed cố định; expected.json khớp lõi (đếm, depth BFS độc lập)."""
    for name, text in load_generator().build_all().items():
        assert (GOLDEN / name).read_text(encoding="utf-8") == text, f"{name} lệch generator — chạy lại generate.py"
    for case in DATASETS:
        core, exp = core_of(case), expected_of(case)
        assert exp["elements"] == len(core["elements"])
        assert exp["recipes"] == len(core["recipes"]) == exp["unique_pairs"]
        assert exp["unreachable"] == []
    assert expected_of("classic")["elements"] == 139 and expected_of("classic")["recipes"] == 363


# ================================================================ AC-INV-01


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_01_doi_xung_tren_bo_vang(case):
    """AC-INV-01: mọi cặp có thứ tự (A,B)/(B,A) của graph cho cùng kết quả, đúng với công thức của bộ vàng."""
    from lau_meme_pipeline.invariants import check_symmetric

    from lau_meme_pipeline.graph import decrypt_entry, export_graph

    core, store = core_of(case), store_of(core_of(case))
    graph = export_graph(store, GRAPH_VERSION)
    names = names_of(core)
    want = {frozenset((r["a"], r["b"])): r["result"] for r in core["recipes"]}
    hits = 0
    for a in names:
        for b in names:
            got = decrypt_entry(graph, a, b)
            expected = want.get(frozenset((a, b)))
            assert (got["name"] if got else None) == expected, (a, b)
            hits += got is not None
    assert hits == sum(2 if len(pair) == 2 else 1 for pair in want)  # every ordered pair of every recipe, no extras
    assert check_symmetric(graph, names) == []


def test_ac_inv_01_phat_hien_cap_khong_doi_xung(monkeypatch):
    """AC-INV-01: tra A+B có mà B+A không thì check_symmetric báo vi phạm."""
    from lau_meme_pipeline.invariants import check_symmetric

    from lau_meme_pipeline.graph import decrypt_entry, export_graph

    core = core_of("classic")
    graph = export_graph(store_of(core), GRAPH_VERSION)
    r = next(x for x in core["recipes"] if x["a"] != x["b"])
    original = decrypt_entry

    def lopsided(g, a, b):
        return None if (a, b) == (r["b"], r["a"]) else original(g, a, b)

    patch_everywhere(monkeypatch, "decrypt_entry", lopsided)
    violations = check_symmetric(graph, names_of(core))
    assert violations and all(isinstance(v, str) and v for v in violations)


# ================================================================ AC-INV-02


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_02_moi_cap_toi_da_mot_cong_thuc(case):
    """AC-INV-02: gom theo cặp không thứ tự đã fold, mỗi cặp tối đa 1 công thức (số cặp khớp expected độc lập)."""
    from lau_meme_pipeline.invariants import check_unique_pairs

    store = store_of(core_of(case))
    assert len(store.recipes) == expected_of(case)["unique_pairs"]
    assert check_unique_pairs(store) == []


@pytest.mark.parametrize("swap", [False, True], ids=["cung-chieu", "dao-chieu"])
def test_ac_inv_02_phat_hien_cap_co_hai_cong_thuc(swap):
    """AC-INV-02: thêm công thức thứ hai cho cùng cặp (kể cả đảo thứ tự a/b) thì báo đúng một vi phạm."""
    from lau_meme_pipeline.invariants import check_unique_pairs

    core = core_of("synthetic-11")
    store = store_of(core)
    rec = next(iter(store.recipes.values()))
    dup = copy.copy(rec)
    tamper(dup, result=eid(core["elements"][20]["name"]))
    if swap:
        tamper(dup, a=rec.b, b=rec.a)
    store.recipes["dup" + "x" * 40] = dup
    violations = check_unique_pairs(store)
    assert len(violations) == 1 and violations[0]


def test_ac_inv_02_cong_thuc_khong_hoat_dong_khong_tinh():
    """AC-INV-02: chỉ xét công thức đang hoạt động — bản trùng đã ẩn không gây vi phạm."""
    from lau_meme_pipeline.invariants import check_unique_pairs

    core = core_of("synthetic-11")
    store = store_of(core)
    rec = next(iter(store.recipes.values()))
    dup = copy.copy(rec)
    tamper(dup, result=eid(core["elements"][20]["name"]), status="hidden")
    store.recipes["dup" + "x" * 40] = dup
    assert check_unique_pairs(store) == []


# ================================================================ AC-INV-03


def reference_reachable(store) -> dict:
    """Own BFS over the store: element id -> depth, active recipes/elements only."""
    active = {i for i, e in store.elements.items() if e.status == "active"}
    depth = {s: 0 for s in store.starters if s in active}
    level = 0
    while True:
        level += 1
        new = {}
        for r in store.recipes.values():
            if r.status != "active" or r.result not in active:
                continue
            if r.a in depth and r.b in depth and r.result not in depth:
                new.setdefault(r.result, level)
        if not new:
            return depth
        depth.update(new)


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_03_moi_phan_tu_toi_duoc_va_depth_bang_bfs(case):
    """AC-INV-03: không vi phạm; depth lưu của từng phần tử bằng depth BFS độc lập của bộ vàng."""
    from lau_meme_pipeline.invariants import check_reachability

    core = core_of(case)
    store = store_of(core)
    expected = expected_of(case)["depth"]
    assert len(expected) == len(store.elements)
    for name, depth in expected.items():
        assert store.elements[eid(name)].depth == depth, name
    assert check_reachability(store) == []


def single_recipe_element(core: dict) -> tuple[str, dict]:
    count: dict = {}
    for r in core["recipes"]:
        count.setdefault(r["result"], []).append(r)
    name = next(n for n in names_of(core)[4:] if len(count.get(n, [])) == 1)
    return name, count[name][0]


@pytest.mark.parametrize("case", ["classic", "synthetic-11"])
def test_ac_inv_03_phat_hien_phan_tu_hoat_dong_nhung_mat_duong(case):
    """AC-INV-03: ẩn công thức duy nhất sinh ra X mà X vẫn hoạt động thì báo vi phạm."""
    from lau_meme_pipeline.invariants import check_reachability

    from lau_meme_pipeline.ids import recipe_id

    core = core_of(case)
    store = store_of(core)
    _, rec = single_recipe_element(core)
    tamper(store.recipes[recipe_id(rec["a"], rec["b"])], status="hidden")
    violations = check_reachability(store)
    assert violations and all(isinstance(v, str) and v for v in violations)


@pytest.mark.parametrize("case", ["classic", "synthetic-22"])
def test_ac_inv_03_phat_hien_depth_luu_lech_bfs(case):
    """AC-INV-03: depth lưu khác độ dài đường ngắn nhất thì báo vi phạm."""
    from lau_meme_pipeline.invariants import check_reachability

    core = core_of(case)
    store = store_of(core)
    victim = store.elements[eid(names_of(core)[10])]
    tamper(victim, depth=victim.depth + 1)
    assert check_reachability(store)


@pytest.mark.parametrize("case", ["classic", "synthetic-33"])
def test_ac_inv_03_phan_tu_mat_duong_do_an_thi_danh_dau_khong_hoat_dong_la_hop_le(case):
    """AC-INV-03: công thức bị ẩn làm phần tử mất đường; nếu các phần tử đó đã ở trạng thái không hoạt động trong
    graph này (và depth còn lại là BFS) thì không có vi phạm."""
    from lau_meme_pipeline.invariants import check_reachability

    from lau_meme_pipeline.ids import recipe_id

    core = core_of(case)
    store = store_of(core)
    _, rec = single_recipe_element(core)
    tamper(store.recipes[recipe_id(rec["a"], rec["b"])], status="hidden")
    reachable = reference_reachable(store)
    lost = [i for i, e in store.elements.items() if i not in reachable]
    assert lost, "bộ vàng phải làm mất đường ít nhất một phần tử"
    for i in lost:
        tamper(store.elements[i], status="hidden")
    reachable = reference_reachable(store)
    for i, d in reachable.items():
        tamper(store.elements[i], depth=d)
    assert check_reachability(store) == []


# ================================================================ AC-INV-04


def has_readable(text: str, name: str) -> bool:
    return (len(name) >= 6 or not B64URL.match(name)) and name in text


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_04_graph_bo_vang_khong_lo_va_khong_giai_ma_duoc_khi_thieu_dau_vao(case):
    """AC-INV-04: (độc lập) file graph không chứa tên/emoji depth ≥ 1; mục (A,B) không giải mã được bằng (A,X)/(B,X)."""
    from lau_meme_pipeline.graph import export_graph, graph_to_bytes
    from lau_meme_pipeline.text import fold

    core = core_of(case)
    graph = export_graph(store_of(core), GRAPH_VERSION)
    text = graph_to_bytes(graph).decode("utf-8")
    depth = expected_of(case)["depth"]
    for e in core["elements"]:
        if depth[e["name"]] >= 1:
            assert not has_readable(text, e["name"]), e["name"]
            assert not has_readable(text, fold(e["name"])), e["name"]
            assert e["emoji"] not in text, e["name"]
    rng = seeded(4)
    names = names_of(core)
    for r in core["recipes"]:
        own = adr_try_decrypt(graph, (r["a"], r["b"]), (r["a"], r["b"]))
        assert own is not None
        for keep, other in ((r["a"], r["b"]), (r["b"], r["a"])):
            for x in rng.sample(names, min(10, len(names))):
                if fold(x) == fold(other):
                    continue
                assert adr_try_decrypt(graph, (r["a"], r["b"]), (keep, x)) is None, (r, x)


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_04_check_opaque_khong_vi_pham_tren_bo_vang(case):
    """AC-INV-04: check_opaque trả rỗng trên graph xuất từ từng graph của bộ vàng."""
    from lau_meme_pipeline.invariants import check_opaque

    from lau_meme_pipeline.graph import export_graph

    store = store_of(core_of(case))
    assert check_opaque(export_graph(store, GRAPH_VERSION), store) == []


def test_ac_inv_04_phat_hien_ten_va_emoji_ro_ri_nhung_khong_phat_ten_khoi_dau():
    """AC-INV-04: tên hoặc emoji của phần tử depth ≥ 1 xuất hiện trong file graph thì vi phạm; tên khởi đầu (depth 0)
    thì không."""
    from lau_meme_pipeline.invariants import check_opaque

    from lau_meme_pipeline.graph import export_graph

    core = core_of("synthetic-11")
    store = store_of(core)
    base = export_graph(store, GRAPH_VERSION)
    hidden = next(e for e in core["elements"] if e["name"] == "Chua Bánh")
    for leak in (hidden["name"], hidden["emoji"]):
        leaky = copy.deepcopy(base)
        leaky["note"] = f"gỡ lỗi {leak}"
        violations = check_opaque(leaky, store)
        assert violations and all(isinstance(v, str) and v for v in violations), leak
    starter = copy.deepcopy(base)
    starter["note"] = f"khởi đầu {core['starters'][0]}"
    assert check_opaque(starter, store) == []


def test_ac_inv_04_phat_hien_muc_giai_ma_duoc_bang_cap_thieu():
    """AC-INV-04: mục (A,B) mà giải mã được bằng khóa của (A,X), X ≠ B, thì vi phạm (graph nhỏ, kiểm toàn bộ X)."""
    from lau_meme_pipeline.invariants import check_opaque

    from lau_meme_pipeline.graph import export_graph

    core = core_of(TINY)
    store = store_of(core)
    graph = export_graph(store, GRAPH_VERSION)
    r = core["recipes"][0]
    plain = adr_try_decrypt(graph, (r["a"], r["b"]), (r["a"], r["b"]))
    assert plain is not None
    x = next(n for n in names_of(core) if n not in (r["a"], r["b"]))
    weak = copy.deepcopy(graph)
    weak["entries"][adr_key_id(r["a"], r["b"])] = adr_encrypt(GRAPH_VERSION, (r["a"], x), (r["a"], r["b"]), plain)
    assert adr_try_decrypt(weak, (r["a"], r["b"]), (r["a"], x)) is not None  # the fault really exists
    assert check_opaque(weak, store)


# ================================================================ AC-INV-05


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_05_run_batch_hai_lan_giong_het_byte(case, fast_sim):
    """AC-INV-05: cùng kho/lõi, trạng thái và batch_at ⇒ graph và manifest đăng đi giống hệt từng byte
    (có/không lịch sử)."""
    core = core_of(case)
    first_target = core["daily_examples"][0]["target"]
    for history in ([], [{"version": 1, "element_id": eid(first_target), "batch_at": "2026-10-11T17:00:00Z"}]):
        a, b = posted_body(core, history), posted_body(core, history)
        assert dumps(a["graph"]) == dumps(b["graph"])
        assert dumps(a["manifest"]) == dumps(b["manifest"])
        assert dumps(a) == dumps(b)


def test_ac_inv_05_run_batch_voi_mo_phong_that_van_giong_het_byte():
    """AC-INV-05: kể cả khi chạy mô phỏng INV-12 thật (seed cố định) kết quả đăng đi vẫn giống hệt từng byte."""
    core = core_of("classic")
    a, b = posted_body(core), posted_body(core)
    assert dumps(a) == dumps(b)


NAME_A = ["Cú", "Gấu", "Mèo", "Thỏ", "Vịt", "Ếch", "Sóc", "Dơi"]
NAME_B = ["Phi Hành Gia", "Ngủ Gật", "Đòi Nợ", "Lướt Sóng", "Đu Trend", "Thả Thính"]


def synthetic_crawl(seed: int):
    from lau_meme_pipeline.crawl import CrawlResult, RawConcept

    rng = seeded(seed)
    names = []
    while len(names) < 2 + seed % 3:
        n = f"Meme {rng.choice(NAME_A)} {rng.choice(NAME_B)}"
        if n not in names:
            names.append(n)
    if seed % 2:
        names.append(names[0].upper())  # same fold: must be de-duplicated, never published twice
    concepts = [
        RawConcept(
            name=n,
            quote=f"câu nói {i}",
            context=f"ngữ cảnh {seed}-{i}",
            source_url=f"https://ex.com/{seed}/{i}",
            source_name="RSS",
        )
        for i, n in enumerate(names)
    ]
    return CrawlResult(concepts=concepts, errors=[])


def fake_llm() -> dict:
    import hashlib

    def same(items):
        return [False for _ in items]

    def classify(items):
        return [
            {
                "key": i["key"],
                "category": "safe",
                "confidence": 0.95,
                "person": {"targets": False, "name": None, "aliases": []},
                "accusation": False,
                "hot_person": False,
                "flagged_fields": [],
            }
            for i in items
        ]

    def describe(items):
        out = []
        for i in items:
            h = int(hashlib.sha256(i["name"].encode("utf-8")).hexdigest(), 16)
            out.append(
                {
                    "key": i.get("key", i["name"]),
                    "emoji": chr(0x1F400 + h % 200),
                    "description": f"Mô tả {i['name']}",
                    "daily_hint": f"Gợi ý {i['name']}",
                    "image_hint": f"Ảnh {i['name']}",
                }
            )
        return out

    def link(items):
        fallback = [["AFK", "Aura"], ["AFK", "Bom Hàng"], ["AFK", "Brainrot"]]
        out = []
        for n, i in enumerate(items):
            cands = i.get("candidates") or []
            pairs = [[cands[0], cands[1]]] if len(cands) >= 2 else fallback[n % 3 : n % 3 + 1]
            out.append({"key": i["key"], "pairs": pairs})
        return out

    def judge(items):
        return {i["id"]: 4 for i in items}

    return {"same": same, "classify": classify, "describe": describe, "link": link, "judge": judge}


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_ac_inv_05_run_full_hai_lan_giong_het_byte_voi_crawl_tong_hop(seed, fast_sim):
    """AC-INV-05: crawl tổng hợp sinh từ seed cố định, LLM giả tất định ⇒ hai lần run_full cho graph, manifest và
    kho giống hệt từng byte."""
    from lau_meme_pipeline.full import run_full

    outs = [run_full(core_of("classic"), {}, synthetic_crawl(seed), fake_llm(), T, mod_lists()) for _ in range(2)]
    assert dumps(outs[0].graph) == dumps(outs[1].graph)
    assert dumps(outs[0].manifest) == dumps(outs[1].manifest)
    assert dumps(outs[0].store) == dumps(outs[1].store)


# ================================================================ AC-INV-06


def boom_for(step):
    def boom(*args, **kwargs):
        raise RuntimeError(f"lỗi chèn vào bước {step}")

    return boom


def failing_setup(step, monkeypatch):
    """Returns (core, client) with a fault injected into `step` of run_batch."""
    core = core_of("classic")
    client = FakeClient()
    if step == "state":
        client = FakeClient(fail_state=True)
    elif step == "seed":
        core["recipes"].append({"a": "Không Có A", "b": "Không Có B", "result": "Không Có C", "best": False})
    elif step == "daily":
        client = FakeClient(make_state(blocked_elements=[eid(e["target"]) for e in core["daily_examples"]]))
    elif step == "export":
        patch_everywhere(monkeypatch, "export_graph", boom_for(step))
    elif step == "check":
        patch_everywhere(monkeypatch, "check_all", boom_for(step))
    elif step == "banned":
        patch_everywhere(monkeypatch, "ModLists", boom_for(step))
        patch_everywhere(monkeypatch, "layer1", boom_for(step))
    elif step == "publish":
        client = FakeClient(fail_success=True)
    else:
        raise AssertionError(step)
    return core, client


@pytest.mark.parametrize("step", BATCH_STEPS)
def test_ac_inv_06_loi_o_tung_buoc_khong_doi_ban_dang_chay(step, monkeypatch, fast_sim):
    """AC-INV-06: lỗi chèn vào từng bước của đợt (mỗi bước một lần chạy) ⇒ không bản success nào được đăng,
    version hiện hành của client giữ nguyên."""
    from lau_meme_pipeline.batch import STEPS

    assert step in STEPS
    core, client = failing_setup(step, monkeypatch)
    outcome = run(core, client)
    assert outcome.ok is False
    assert outcome.status == "error"
    assert outcome.failed_step
    assert client.success_posts == []
    assert all(b["status"] == "error" for b in client.posted)
    assert client.state["current_version"] == PREV_VERSION
    assert outcome.version is None


def test_ac_inv_06_vi_pham_bat_bien_lam_dot_that_bai_o_buoc_invariants(monkeypatch, fast_sim):
    """AC-INV-06: một kiểm tra bất biến báo vi phạm ⇒ failed_step "invariants", không đăng success,
    không đổi version."""
    patch_everywhere(monkeypatch, "check_unique_pairs", lambda store: ["cặp trùng giả lập"])
    client, reporter = FakeClient(), FakeReporter()
    outcome = run(core_of("classic"), client, reporter)
    assert outcome.ok is False
    assert outcome.failed_step == "invariants"
    assert client.success_posts == []
    assert [b["failed_step"] for b in client.error_posts] == ["invariants"]
    assert client.state["current_version"] == PREV_VERSION
    assert len(reporter.issues) == 1


def test_ac_inv_06_check_all_duoc_goi_truoc_khi_dang(monkeypatch, fast_sim):
    """AC-INV-06: run_batch gọi check_all đúng một lần, với graph/manifest/kho của đợt, trước lần post success."""
    import lau_meme_pipeline.invariants as inv

    original = inv.check_all
    events: list = []
    client = FakeClient()
    real_post = client.post_batch

    def spy(graph, manifest, store, lists):
        events.append(("check", graph, manifest))
        return original(graph, manifest, store, lists)

    def post(body):
        events.append(("post", body["status"]))
        return real_post(body)

    client.post_batch = post
    patch_everywhere(monkeypatch, "check_all", spy)
    outcome = run(core_of("classic"), client)
    assert outcome.ok is True
    kinds = [e[0] for e in events]
    assert kinds.count("check") == 1
    assert kinds.index("check") < kinds.index("post")
    (body,) = client.success_posts
    check = next(e for e in events if e[0] == "check")
    assert dumps(check[1]) == dumps(body["graph"])
    assert dumps(check[2]) == dumps(body["manifest"])


def test_ac_inv_06_run_full_goi_check_all(monkeypatch, fast_sim):
    """AC-INV-06: run_full cũng chạy check_all trên graph/manifest của đợt trước khi trả kết quả để đăng."""
    import lau_meme_pipeline.invariants as inv

    from lau_meme_pipeline.full import run_full

    original = inv.check_all
    seen: list = []

    def spy(graph, manifest, store, lists):
        seen.append((graph, manifest))
        return original(graph, manifest, store, lists)

    patch_everywhere(monkeypatch, "check_all", spy)
    outcome = run_full(core_of("classic"), {}, synthetic_crawl(1), fake_llm(), T, mod_lists())
    assert len(seen) == 1
    assert dumps(seen[0][0]) == dumps(outcome.graph)
    assert dumps(seen[0][1]) == dumps(outcome.manifest)


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_06_check_all_khong_loi_tren_bo_vang(case, fast_sim):
    """AC-INV-06: check_all trả None trên graph, manifest và kho hợp lệ của mọi graph vàng."""
    from lau_meme_pipeline.invariants import check_all

    core = core_of(case)
    body = posted_body(core)
    assert check_all(body["graph"], body["manifest"], store_of(core), clean_lists()) is None


def test_ac_inv_06_check_all_gom_moi_vi_pham_cua_inv_02_03_07_10():
    """AC-INV-06: check_all ném InvariantError chứa vi phạm của mọi kiểm tra (đây: INV-02, 03, 07, 10)."""
    from lau_meme_pipeline.invariants import InvariantError, check_all

    from lau_meme_pipeline.graph import export_graph

    assert issubclass(InvariantError, Exception)
    core = core_of("synthetic-11")
    store = store_of(core)
    graph = export_graph(store, GRAPH_VERSION)
    manifest = {
        "version": GRAPH_VERSION,
        "daily": {"element_id": eid(core["starters"][0]), "emoji": "x", "hint": "h", "depth": 4},
    }
    rec = next(iter(store.recipes.values()))
    dup = copy.copy(rec)
    tamper(dup, result=eid(core["elements"][20]["name"]))
    store.recipes["dup" + "x" * 40] = dup
    victim = store.elements[eid(core["elements"][30]["name"])]
    tamper(victim, depth=victim.depth + 3)
    lists = mod_lists(banned_words={core["elements"][12]["name"]})
    with pytest.raises(InvariantError) as exc:
        check_all(graph, manifest, store, lists)
    violations = exc.value.violations
    assert isinstance(violations, list) and all(isinstance(v, str) for v in violations)
    assert len(set(violations)) >= 4


# ================================================================ AC-INV-07


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_07_khong_phan_tu_hoat_dong_nao_khop_danh_muc_cam(case):
    """AC-INV-07: lớp 1 chạy lại trên mọi phần tử đang hoạt động của bộ vàng ⇒ không vi phạm."""
    from lau_meme_pipeline.invariants import check_moderation

    assert check_moderation(store_of(core_of(case)), clean_lists()) == []


@pytest.mark.parametrize("kind", ["banned_words", "aliases", "admin_blocked"])
def test_ac_inv_07_phat_hien_khop_tu_cam_bi_danh_va_ten_bi_chan(kind):
    """AC-INV-07: từ cấm, bí danh bị chặn hoặc tên bị quản trị chặn khớp một phần tử hoạt động ⇒ vi phạm."""
    from lau_meme_pipeline.invariants import check_moderation

    core = core_of("classic")
    store = store_of(core)
    term = "Còn Cái Nịt"
    assert term in names_of(core)
    violations = check_moderation(store, mod_lists(**{kind: {term}}))
    assert violations and all(isinstance(v, str) and v for v in violations)


def test_ac_inv_07_phan_tu_khong_hoat_dong_khong_bi_xet():
    """AC-INV-07: phần tử đã ẩn/chặn không còn hoạt động nên khớp từ cấm cũng không tính."""
    from lau_meme_pipeline.invariants import check_moderation

    from lau_meme_pipeline.text import fold

    core = core_of("classic")
    store = store_of(core)

    def squash(s: str) -> str:
        return re.sub(r"[^a-z0-9]", "", fold(s))

    term = next(
        n
        for n in names_of(core)[4:]
        if len(squash(n)) >= 5 and sum(squash(n) in squash(m) for m in names_of(core)) == 1
    )
    lists = mod_lists(banned_words={term})
    assert check_moderation(store, lists)
    tamper(store.elements[eid(term)], status="hidden")
    assert check_moderation(store, lists) == []


# ================================================================ AC-INV-10


@pytest.mark.parametrize("case", DATASETS)
def test_ac_inv_10_mon_dac_biet_hop_le_tren_manifest_da_xuat(case, fast_sim):
    """AC-INV-10: manifest do run_batch xuất: món đặc biệt hoạt động, tới được, depth trong [4, 8]
    (theo BFS độc lập)."""
    from lau_meme_pipeline.invariants import check_daily

    core = core_of(case)
    body = posted_body(core)
    daily_id = body["manifest"]["daily"]["element_id"]
    expected = expected_of(case)
    by_id = {eid(n): d for n, d in expected["depth"].items()}
    assert 4 <= by_id[daily_id] <= 8
    assert check_daily(body["manifest"], store_of(core)) == []


def daily_manifest(element_id: str) -> dict:
    return {"version": T_VERSION, "daily": {"element_id": element_id, "emoji": "🍲", "hint": "Gợi ý", "depth": 5}}


def test_ac_inv_10_phat_hien_mon_dac_biet_khong_hop_le():
    """AC-INV-10: món là phần tử khởi đầu, depth 3, depth 9, không tồn tại, đã ẩn hoặc mất đường ⇒ đều vi phạm."""
    from lau_meme_pipeline.invariants import check_daily

    from lau_meme_pipeline.ids import recipe_id

    core = core_of("synthetic-11")
    depth = expected_of("synthetic-11")["depth"]
    chain = {d: n for n, d in depth.items() if n in [e["target"] for e in core["daily_examples"]]}
    good = eid(next(e["target"] for e in core["daily_examples"] if depth[e["target"]] == 6))
    assert check_daily(daily_manifest(good), store_of(core)) == []

    bad = {
        "khởi đầu": eid(core["starters"][0]),
        "depth 3": eid(next(n for n, d in depth.items() if d == 3)),
        "không tồn tại": eid("Món Không Hề Tồn Tại"),
    }
    for label, element_id in bad.items():
        violations = check_daily(daily_manifest(element_id), store_of(core))
        assert violations and all(isinstance(v, str) and v for v in violations), label

    store = store_of(core)
    tamper(store.elements[good], depth=9)
    assert check_daily(daily_manifest(good), store), "depth 9"

    store = store_of(core)
    tamper(store.elements[good], status="hidden")
    assert check_daily(daily_manifest(good), store), "đã ẩn"

    store = store_of(core)
    producers = [r for r in core["recipes"] if r["result"] == chain[6]]
    assert len(producers) == 1
    tamper(store.recipes[recipe_id(producers[0]["a"], producers[0]["b"])], status="hidden")
    assert check_daily(daily_manifest(good), store), "mất đường tới"


def test_ac_inv_10_depth_bien_4_va_8_hop_le():
    """AC-INV-10: món đặc biệt depth đúng 4 và đúng 8 nằm trong khoảng, hợp lệ."""
    from lau_meme_pipeline.invariants import check_daily

    core = core_of("synthetic-11")
    store = store_of(core)
    for target in ("Chua Bánh", "Lạnh Bánh"):
        assert expected_of("synthetic-11")["daily_targets"][target] in (4, 8)
        assert check_daily(daily_manifest(eid(target)), store) == [], target


# ================================================================ AC-INV-12


def classic_graph_and_starters():
    from lau_meme_pipeline.graph import export_graph

    core = core_of("classic")
    store = store_of(core)
    starters = [
        {"id": eid(n), "name": n, "emoji": e["emoji"]}
        for n in core["starters"]
        for e in core["elements"]
        if e["name"] == n
    ]
    return export_graph(store, GRAPH_VERSION), starters


def test_ac_inv_12_choi_ngau_nhien_loi_trong_nguong():
    """AC-INV-12: 1 000 ván × 100 lượt (mặc định, seed cố định) trên lõi: trượt 20 lượt đầu ≤ 45 %, cả ván ≤ 70 %."""
    from lau_meme_pipeline.invariants import simulate_miss_rate

    graph, starters = classic_graph_and_starters()
    first20, overall = simulate_miss_rate(graph, starters)
    assert 0.0 < first20 <= 0.45, first20
    assert 0.0 < overall <= 0.70, overall


def test_ac_inv_12_tat_dinh_theo_seed():
    """AC-INV-12: cùng seed cho đúng cùng kết quả; hai seed khác nhau cho kết quả khác."""
    from lau_meme_pipeline.invariants import simulate_miss_rate

    graph, starters = classic_graph_and_starters()
    a = simulate_miss_rate(graph, starters, games=100, seed=3)
    assert a == simulate_miss_rate(graph, starters, games=100, seed=3)
    assert a != simulate_miss_rate(graph, starters, games=100, seed=4)
    for rate in a:
        assert 0.0 <= rate <= 1.0


def test_ac_inv_12_graph_rong_luon_truot():
    """AC-INV-12: graph không có công thức nào thì mọi lượt đều trượt (tỉ lệ 1,0 cả hai chỉ số),
    kể cả chọn cùng món hai lần."""
    from lau_meme_pipeline.invariants import simulate_miss_rate

    _, starters = classic_graph_and_starters()
    empty = {"format": 1, "version": GRAPH_VERSION, "entries": {}}
    assert simulate_miss_rate(empty, starters, games=5, turns=40, seed=1) == (1.0, 1.0)


def test_ac_inv_12_canh_bao_khi_vuot_nguong_va_im_lang_khi_dat():
    """AC-INV-12: miss_rate_warning trả cảnh báo tiếng Việt khi 20 lượt đầu > 45 % hoặc cả ván > 70 %; đúng ngưỡng và
    lõi hiện tại (≈ 41 % / ≈ 67 %) thì None."""
    from lau_meme_pipeline.invariants import miss_rate_warning

    assert miss_rate_warning(0.41, 0.67) is None
    assert miss_rate_warning(0.45, 0.70) is None
    assert miss_rate_warning(0.0, 0.0) is None
    for first20, overall in ((0.46, 0.5), (0.3, 0.71), (0.9, 0.95)):
        warning = miss_rate_warning(first20, overall)
        assert isinstance(warning, str) and warning.strip(), (first20, overall)
        assert re.search(r"[À-ỹ]", warning), "cảnh báo phải bằng tiếng Việt có dấu"


def test_ac_inv_12_vuot_nguong_van_dang_nhung_bao_cao_canh_bao(monkeypatch):
    """AC-INV-12: mô phỏng vượt ngưỡng ⇒ đợt vẫn đăng success, nội dung báo cáo chứa cảnh báo, không có failed_step."""
    patch_everywhere(monkeypatch, "simulate_miss_rate", lambda graph, starters, **kw: (0.9, 0.95))
    patch_everywhere(
        monkeypatch, "miss_rate_warning", lambda f, o: "CẢNH BÁO GIẢ LẬP INV-12" if f > 0.45 or o > 0.70 else None
    )
    client, reporter = FakeClient(), FakeReporter()
    outcome = run(core_of("classic"), client, reporter)
    assert outcome.ok is True and outcome.status == "success"
    assert outcome.failed_step is None
    assert len(client.success_posts) == 1
    assert "CẢNH BÁO GIẢ LẬP INV-12" in outcome.report_body
    assert outcome.report_body == reporter.issues[0][1]


def test_ac_inv_12_dat_nguong_thi_bao_cao_khong_co_canh_bao(monkeypatch):
    """AC-INV-12: mô phỏng đạt ngưỡng ⇒ báo cáo không chứa cảnh báo."""
    patch_everywhere(monkeypatch, "simulate_miss_rate", lambda graph, starters, **kw: (0.41, 0.67))
    patch_everywhere(
        monkeypatch, "miss_rate_warning", lambda f, o: "CẢNH BÁO GIẢ LẬP INV-12" if f > 0.45 or o > 0.70 else None
    )
    outcome = run(core_of("classic"))
    assert outcome.ok is True
    assert "CẢNH BÁO GIẢ LẬP INV-12" not in outcome.report_body
