#!/usr/bin/env python3
"""Acceptance-criteria traceability: every mandatory AC in docs/acceptance must be referenced by a test.

Usage: ac-trace.py [--markdown] [--feature SLUG] [--started-only]
Exit 1 when a mandatory AC has no test (this is the deterministic FR gate).
--started-only: only enforce features (docs/acceptance/<file>.md) that already have at least one AC
referenced by a test. CI uses it so the gate matches the project phase: before /dk:build starts a
feature, its ACs are reported but do not fail the build. /dk:review and /dk:ship run without it.
With .dk/stack.toml (dk 0.7.0) the test files come from each component's test_dirs; Python tests may name the AC
in snake case (test_ac_graph_01_x ⇒ AC-GRAPH-01) because function names cannot hold dashes. This file is copied
into projects (tools/ac-trace.py), so it reads the profile itself instead of importing the plugin.
"""
import re
import signal
import sys
from pathlib import Path

AC_HEAD = re.compile(r"^###\s+(AC-[A-Z0-9]+-[A-Z0-9]+)\s*[:\-–]\s*(.*)$")
AC_REF = re.compile(r"\bAC-[A-Z0-9]+-[A-Z0-9]+\b")
AC_SNAKE = re.compile(r"(?:^|[^A-Za-z0-9])ac_([a-z0-9]+)_([a-z0-9]+)(?=_|[^A-Za-z0-9]|$)", re.I)
TEST_GLOBS = ["backend/src/test/**/*.java", "backend/src/test/**/*.kt",
              "frontend/src/**/*.test.ts", "frontend/src/**/*.test.tsx", "e2e/**/*.ts"]
KIND_PATTERNS = {"python": ["test_*.py", "*_test.py"], "ts-worker": ["*.test.ts", "*.spec.ts"],
                 "react-vite": ["*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx"], "java-maven": ["*.java", "*.kt"]}


def test_globs():
    """Globs of test files: from .dk/stack.toml when present, else the java-spring layout."""
    f = Path(".dk/stack.toml")
    if not f.is_file():
        return TEST_GLOBS
    import tomllib  # Python ≥ 3.11; only projects with a stack profile need it
    globs = ["e2e/**/*.ts"]
    for c in tomllib.loads(f.read_text(encoding="utf-8")).get("component", []):
        pats = c.get("test_glob") or KIND_PATTERNS.get(c.get("kind"), [])
        pats = [pats] if isinstance(pats, str) else pats
        for d in c.get("test_dirs", []):
            globs += [f"{d.rstrip('/')}/**/{p}" for p in pats]
    return globs


def load_acs(feature=None):
    acs = {}
    for f in sorted(Path("docs/acceptance").glob("*.md")):
        if feature and f.stem != feature:
            continue
        cur = None
        for line in f.read_text(encoding="utf-8").splitlines():
            m = AC_HEAD.match(line.strip())
            if m:
                cur = m.group(1)
                acs[cur] = {"title": m.group(2).strip(), "file": f.name, "optional": False}
            elif cur and re.search(r"Ưu tiên\s*:\s*Tùy chọn", line, re.I):
                acs[cur]["optional"] = True
    return acs


def load_refs():
    refs = {}
    seen = set()
    for g in test_globs():
        for f in Path(".").glob(g):
            if f in seen or "node_modules" in f.parts:
                continue
            seen.add(f)
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            ids = [m.group(0) for m in AC_REF.finditer(text)]
            if f.suffix == ".py":
                ids += [f"AC-{a.upper()}-{b.upper()}" for a, b in AC_SNAKE.findall(text)]
            for a in ids:
                refs.setdefault(a, set()).add(str(f))
    return refs


def main():
    md = "--markdown" in sys.argv
    feature = sys.argv[sys.argv.index("--feature") + 1] if "--feature" in sys.argv else None
    started_only = "--started-only" in sys.argv
    acs, refs = load_acs(feature), load_refs()
    if not acs:
        print("ac-trace: no acceptance criteria found in docs/acceptance/*.md")
        return 0
    started = {v["file"] for a, v in acs.items() if a in refs}
    not_started = sorted({v["file"] for v in acs.values()} - started)
    missing = [a for a, v in acs.items() if not v["optional"] and a not in refs
               and (not started_only or v["file"] in started)]
    orphans = sorted(r for r in refs if r not in acs and not r.endswith(("-TENANT", "-VALIDATION", "-ABUSE"))
                     and (not feature or f"-{feature.upper()}-" in r))
    covered = sum(1 for a in acs if a in refs)
    if md:
        print(f"### Truy vết tiêu chí nghiệm thu: {covered}/{len(acs)} có test\n")
        print("| AC | Tiêu chí | Ưu tiên | Test |\n|---|---|---|---|")
        for a, v in acs.items():
            t = ", ".join(sorted(Path(p).stem for p in refs.get(a, []))) or "❌ CHƯA CÓ"
            print(f"| {a} | {v['title']} | {'Tùy chọn' if v['optional'] else 'Bắt buộc'} | {t} |")
    else:
        print(f"ac-trace: {covered}/{len(acs)} ACs referenced by tests; {len(missing)} mandatory missing")
        if started_only and not_started:
            print(f"  not started (not enforced yet): {len(not_started)} feature file(s): {', '.join(Path(f).stem for f in not_started)}")
        for a in missing:
            print(f"  MISSING {a} ({acs[a]['file']}): {acs[a]['title']}")
    for o in orphans:
        print(f"  WARN test references unknown {o}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
