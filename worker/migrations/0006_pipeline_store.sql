-- Migration number: 0006 	 2026-10-21T08:39:30.171Z
-- Phase 2 pipeline store (ADR 0009): trend elements/recipes, link queue, asked pairs and this batch's LLM answers,
-- carried from one full-mode batch to the next. Opaque to the Worker: written in the same DB.batch as
-- batch_content (AC-PIPE-11, AC-INV-06), read back by the pipeline token only, trimmed with it to 14 versions.
-- No player data (AC-PIPE-13).

CREATE TABLE pipeline_store (
  version INTEGER PRIMARY KEY,               -- the batch version that wrote it (= batch_content.version)
  store_json TEXT NOT NULL CHECK (json_valid(store_json)),
  created_at INTEGER NOT NULL
);
