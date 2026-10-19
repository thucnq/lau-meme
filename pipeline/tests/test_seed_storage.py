"""Store shape required by D1 (worker/migrations/0002_content.sql) — not an acceptance test."""

import json
from pathlib import Path

import pytest

from lau_meme_pipeline.seed import ContentStore, SeedError, load_core

CORE_PATH = Path(__file__).resolve().parents[2] / "docs" / "input" / "noi-dung-loi.json"


def real_core() -> dict:
    return json.loads(CORE_PATH.read_text(encoding="utf-8"))


def test_origin_mapped_to_d1_values():
    store = load_core(real_core(), ContentStore.empty()).store
    origins = {e.origin for e in store.elements.values()}
    assert origins == {"vn", "intl"}


def test_unknown_origin_fails():
    core = real_core()
    core["elements"][5]["origin"] = "X"
    with pytest.raises(SeedError) as exc:
        load_core(core, ContentStore.empty())
    assert core["elements"][5]["name"] in "\n".join(exc.value.problems)


def test_recipe_inputs_sorted_like_d1():
    core = real_core()
    store = load_core(core, ContentStore.empty()).store
    assert all(r.a <= r.b for r in store.recipes.values())
    swapped = real_core()
    for r in swapped["recipes"]:
        r["a"], r["b"] = r["b"], r["a"]
    assert load_core(swapped, ContentStore.empty()).store == store
