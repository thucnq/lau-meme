"""Load the classic core (`noi-dung-loi.json`) into the content store — all or nothing (AC-SEED).

`load_core` is pure; only `main` touches files.
"""

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path

from lau_meme_pipeline.ids import element_id, recipe_id
from lau_meme_pipeline.text import fold

CLASSIC = "classic"
ACTIVE = "active"
MAX_NAME_WORDS = 4
# Source file codes → values accepted by D1 `element.origin` (worker/migrations/0002_content.sql).
ORIGINS = {"V": "vn", "Q": "intl"}


@dataclass(frozen=True)
class StoredElement:
    id: str
    name: str
    fold: str
    emoji: str
    origin: str
    depth: int
    image_hint: str
    batch: str
    status: str


@dataclass(frozen=True)
class StoredRecipe:
    id: str
    a: str
    b: str
    result: str
    batch: str
    status: str


@dataclass(frozen=True)
class ContentStore:
    elements: Mapping[str, StoredElement] = field(default_factory=dict)
    recipes: Mapping[str, StoredRecipe] = field(default_factory=dict)
    miss_lines: tuple[str, ...] = ()
    starters: tuple[str, ...] = ()

    @classmethod
    def empty(cls) -> "ContentStore":
        return cls()

    def to_json(self) -> str:
        data = {
            "elements": [asdict(self.elements[k]) for k in sorted(self.elements)],
            "recipes": [asdict(self.recipes[k]) for k in sorted(self.recipes)],
            "miss_lines": list(self.miss_lines),
            "starters": list(self.starters),
        }
        return json.dumps(data, ensure_ascii=False, sort_keys=True, indent=1) + "\n"

    @classmethod
    def from_json(cls, text: str) -> "ContentStore":
        data = json.loads(text)
        return cls(
            elements={e["id"]: StoredElement(**e) for e in data["elements"]},
            recipes={r["id"]: StoredRecipe(**r) for r in data["recipes"]},
            miss_lines=tuple(data["miss_lines"]),
            starters=tuple(data["starters"]),
        )


@dataclass(frozen=True)
class SeedResult:
    store: ContentStore
    changed: bool
    warnings: list[str]
    summary: str


class SeedError(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("\n".join(problems))
        self.problems = problems


def _check_elements(elements: list[Mapping]) -> list[str]:
    problems: list[str] = []
    by_fold: dict[str, list[str]] = {}
    by_emoji: dict[str, list[str]] = {}
    for e in elements:
        name, emoji = str(e.get("name", "")).strip(), str(e.get("emoji", "")).strip()
        if not name:
            problems.append(f"Phần tử có tên rỗng (emoji {emoji or '∅'})")
        elif len(name.split()) > MAX_NAME_WORDS:
            problems.append(f"Tên dài hơn {MAX_NAME_WORDS} từ: {name}")
        if not emoji:
            problems.append(f"Emoji rỗng: {name}")
        if e.get("origin") not in ORIGINS:
            problems.append(f"Nguồn không hợp lệ ({e.get('origin')!r}, cần V hoặc Q): {name}")
        if name:
            by_fold.setdefault(fold(name), []).append(name)
        if emoji:
            by_emoji.setdefault(emoji, []).append(name)
    problems += [f"Trùng tên sau chuẩn hóa: {', '.join(n)}" for n in by_fold.values() if len(n) > 1]
    problems += [f"Trùng emoji {em}: {', '.join(n)}" for em, n in by_emoji.items() if len(n) > 1]
    return problems


def _check_recipes(recipes: list[Mapping], known: set[str]) -> list[str]:
    problems: list[str] = []
    by_pair: dict[str, list[Mapping]] = {}
    for r in recipes:
        a, b, res = r["a"], r["b"], r["result"]
        label = f"{a} + {b} = {res}"
        missing = [n for n in (a, b, res) if fold(n) not in known]
        if missing:
            problems.append(f"Công thức tham chiếu phần tử không tồn tại ({', '.join(missing)}): {label}")
        if fold(res) in (fold(a), fold(b)):
            problems.append(f"Công thức tự tham chiếu: {label}")
        by_pair.setdefault(recipe_id(a, b), []).append(r)
    for dups in by_pair.values():
        if len(dups) > 1:
            labels = "; ".join(f"{r['a']} + {r['b']} = {r['result']}" for r in dups)
            problems.append(f"Trùng cặp: {labels}")
    return problems


def _bfs(starters: list[str], recipes: list[Mapping]) -> dict[str, int]:
    """Depth by fold: starters 0; a result gets level k once both inputs are known before round k."""
    depth = {fold(s): 0 for s in starters}
    level = 0
    while True:
        level += 1
        new: dict[str, int] = {}
        for r in recipes:
            a, b, res = fold(r["a"]), fold(r["b"]), fold(r["result"])
            if a in depth and b in depth and res not in depth:
                new.setdefault(res, level)
        if not new:
            return depth
        depth.update(new)


def load_core(core: Mapping, store: ContentStore) -> SeedResult:
    elements: list[Mapping] = list(core["elements"])
    recipes: list[Mapping] = list(core["recipes"])
    starters: list[str] = list(core["starters"])
    miss_lines: list[str] = list(core["miss_lines"])

    problems = _check_elements(elements)
    known = {fold(e["name"]) for e in elements if str(e.get("name", "")).strip()}
    problems += [f"Phần tử khởi đầu không có trong elements: {s}" for s in starters if fold(s) not in known]
    problems += _check_recipes(recipes, known)
    if problems:
        raise SeedError(problems)

    depth = _bfs(starters, recipes)
    unreachable = [e["name"] for e in elements if fold(e["name"]) not in depth]
    if unreachable:
        raise SeedError([f"Phần tử không tới được từ khởi đầu: {n}" for n in unreachable])

    warnings: list[str] = []
    new_elements: dict[str, StoredElement] = {}
    for e in elements:
        name = e["name"].strip()
        bfs_depth = depth[fold(name)]
        if e.get("depth") != bfs_depth:
            warnings.append(f"Depth lệch: {name} ghi {e.get('depth')}, BFS {bfs_depth}")
        eid = element_id(name)
        new_elements[eid] = StoredElement(
            id=eid,
            name=name,
            fold=fold(name),
            emoji=e["emoji"].strip(),
            origin=ORIGINS[e["origin"]],
            depth=bfs_depth,
            image_hint=e.get("image_hint", ""),
            batch=CLASSIC,
            status=ACTIVE,
        )
    new_recipes: dict[str, StoredRecipe] = {}
    for r in recipes:
        # Unordered pair stored as a <= b, the order D1 requires (CHECK a_id <= b_id, BINARY collation).
        a, b = sorted((element_id(r["a"]), element_id(r["b"])))
        rid = recipe_id(r["a"], r["b"])
        new_recipes[rid] = StoredRecipe(id=rid, a=a, b=b, result=element_id(r["result"]), batch=CLASSIC, status=ACTIVE)

    merged = ContentStore(
        elements={**store.elements, **new_elements},
        recipes={**store.recipes, **new_recipes},
        miss_lines=tuple(miss_lines),
        starters=tuple(element_id(s) for s in starters),
    )
    changed = merged != store
    counts = (
        f"{len(new_elements)} phần tử, {len(new_recipes)} công thức, "
        f"{len(miss_lines)} câu Nồi trào, {len(starters)} phần tử khởi đầu"
    )
    summary = f"Đã nạp lõi classic: {counts}." if changed else f"Lõi classic: không có thay đổi ({counts})."
    return SeedResult(store=merged if changed else store, changed=changed, warnings=warnings, summary=summary)


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m lau_meme_pipeline.seed", description="Nạp lõi classic vào kho")
    parser.add_argument("core", type=Path, help="đường dẫn noi-dung-loi.json")
    parser.add_argument("--store", type=Path, required=True, help="file kho nội dung (JSON)")
    args = parser.parse_args(argv)

    core = json.loads(args.core.read_text(encoding="utf-8"))
    store_exists = args.store.exists()
    store = ContentStore.from_json(args.store.read_text(encoding="utf-8")) if store_exists else ContentStore.empty()
    try:
        result = load_core(core, store)
    except SeedError as exc:
        print("Nạp lõi thất bại, kho không đổi:")
        for p in exc.problems:
            print(f"  - {p}")
        return 1
    for w in result.warnings:
        print(f"Cảnh báo: {w}")
    print(result.summary)
    if result.changed or not store_exists:
        _write_atomic(args.store, result.store.to_json())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
