"""Fixed-seed generator of the golden dataset for docs/acceptance/inv.md (AC-INV-*).

Stand-alone and independent of production code: it imports nothing from lau_meme_pipeline. Everything in
`expected.json` (BFS depths, counts, daily targets) is computed here with its own reference implementation.

    python3 pipeline/tests/golden/generate.py          # (re)writes the files next to this script
    build_all() -> {filename: text}                    # same content without touching the disk (used by the tests)

Files:
    synthetic-<seed>.json   a core in the same format as docs/input/noi-dung-loi.json
    expected.json           independent expectations for the classic core and for every synthetic graph
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLASSIC_PATH = HERE.parents[2] / "docs" / "input" / "noi-dung-loi.json"

# seed -> (elements besides the 4 starters, extra recipes that give existing elements one more recipe)
SYNTHETIC = {7: (14, 3), 11: (40, 10), 22: (80, 25), 33: (120, 40), 44: (60, 60)}
TINY_SEED = 7

STARTERS = [("Gạo Nếp", "🍚"), ("Muối Tiêu", "🧂"), ("Lửa Than", "🔥"), ("Nước Mắm", "🍶")]
ADJ = ["Giòn", "Ngọt", "Béo", "Chua", "Mặn", "Thơm", "Nóng", "Lạnh", "Dai", "Mềm", "Đậm", "Nhạt"]
NOUN = ["Bánh", "Chè", "Phở", "Bún", "Xôi", "Gỏi", "Nem", "Chả", "Cháo", "Lẩu", "Mì", "Cơm"]
CHAIN_LENGTH = 8  # chain element i (0-based) has BFS depth i + 1
MASK64 = (1 << 64) - 1


class Rng:
    """SplitMix64: tiny fixed-seed PRNG, identical on every Python version (no dependency on `random`)."""

    def __init__(self, seed: int) -> None:
        self.state = seed & MASK64

    def next64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def randrange(self, n: int) -> int:
        return self.next64() % n

    def choice(self, seq):
        return seq[self.randrange(len(seq))]

    def sample(self, seq, k: int) -> list:
        pool = list(seq)
        for i in range(k):
            j = i + self.randrange(len(pool) - i)
            pool[i], pool[j] = pool[j], pool[i]
        return pool[:k]


def reference_depths(core: dict) -> dict:
    """BFS rounds from the starters: a result joins round k once both inputs are known (own implementation)."""
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


def unordered(a: str, b: str) -> tuple:
    return tuple(sorted((a, b)))


def make_core(seed: int, count: int, extra: int) -> dict:
    rng = Rng(seed)
    names = [n for n, _ in STARTERS]
    emoji = {n: e for n, e in STARTERS}
    primary: dict = {}  # result -> (a, b), the recipe that created it
    recipes: list = []
    used: set = set()
    emoji_counter = 0

    def new_name(i: int) -> str:
        return f"{ADJ[i % len(ADJ)]} {NOUN[(i // len(ADJ)) % len(NOUN)]}"

    def add(a: str, b: str, result: str) -> None:
        used.add(unordered(a, b))
        recipes.append({"a": a, "b": b, "result": result, "best": False})

    def new_element(i: int) -> str:
        nonlocal emoji_counter
        name = new_name(i)
        emoji[name] = chr(0x1F400 + emoji_counter)
        emoji_counter += 1
        names.append(name)
        return name

    chain: list = []
    for i in range(CHAIN_LENGTH):
        name = new_element(i)
        a, b = (names[0], names[1]) if i == 0 else (chain[-1], names[rng.randrange(4)])
        add(a, b, name)
        primary[name] = (a, b)
        chain.append(name)
    for i in range(CHAIN_LENGTH, count):
        name = new_element(i)
        while True:
            known = names[:-1]
            a, b = rng.choice(known), rng.choice(known)
            if unordered(a, b) not in used:
                break
        add(a, b, name)
        primary[name] = (a, b)
    free = [n for n in names[4:] if n not in chain]
    for _ in range(extra):
        for _attempt in range(200):
            r = rng.choice(free)
            a, b = rng.choice(names), rng.choice(names)
            if r not in (a, b) and unordered(a, b) not in used:
                add(a, b, r)
                break

    core = {
        "starters": [n for n, _ in STARTERS],
        "elements": [
            {
                "name": n,
                "emoji": emoji[n],
                "origin": "V" if k % 2 == 0 else "Q",
                "depth": 0,
                "image_hint": f"hình minh họa số {k}",
            }
            for k, n in enumerate(names)
        ],
        "recipes": recipes,
        "miss_lines": [f"Nồi trào số {k}, hai món này không ăn chung được." for k in range(40)],
        "daily_examples": [],
    }
    depths = reference_depths(core)
    assert set(depths) == set(names), "generator bug: unreachable element"
    for e in core["elements"]:
        e["depth"] = depths[e["name"]]

    def path_to(target: str) -> list:
        steps: list = []
        seen: set = set()

        def visit(n: str) -> None:
            if n in seen or n not in primary:
                return
            seen.add(n)
            a, b = primary[n]
            visit(a)
            visit(b)
            steps.append([a, b, n])

        visit(target)
        return steps

    for k, idx in enumerate((3, 5, 7)):
        target = chain[idx]
        core["daily_examples"].append(
            {"target": target, "hint": f"Món bí ẩn số {k + 1} của bộ vàng", "path": path_to(target)}
        )
    return core


def summarize(core: dict) -> dict:
    depths = reference_depths(core)
    pairs = {unordered(r["a"], r["b"]) for r in core["recipes"]}
    return {
        "elements": len(core["elements"]),
        "recipes": len(core["recipes"]),
        "unique_pairs": len(pairs),
        "starters": list(core["starters"]),
        "depth": depths,
        "unreachable": sorted(e["name"] for e in core["elements"] if e["name"] not in depths),
        "daily_targets": {e["target"]: depths[e["target"]] for e in core["daily_examples"]},
    }


def build_all() -> dict:
    files: dict = {}
    expected: dict = {"seeds": sorted(SYNTHETIC), "tiny_seed": TINY_SEED, "datasets": {}}
    classic = json.loads(CLASSIC_PATH.read_text(encoding="utf-8"))
    expected["datasets"]["classic"] = {"source": "docs/input/noi-dung-loi.json", **summarize(classic)}
    for seed, (count, extra) in sorted(SYNTHETIC.items()):
        core = make_core(seed, count, extra)
        key = f"synthetic-{seed}"
        files[f"{key}.json"] = json.dumps(core, ensure_ascii=False, indent=1) + "\n"
        expected["datasets"][key] = {"file": f"{key}.json", **summarize(core)}
    files["expected.json"] = json.dumps(expected, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    return files


def main() -> None:
    for name, text in build_all().items():
        (HERE / name).write_text(text, encoding="utf-8")
        print("wrote", name)


if __name__ == "__main__":
    main()
