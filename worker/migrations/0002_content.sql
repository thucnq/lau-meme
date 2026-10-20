-- Migration number: 0002 	 2026-10-19T17:25:56.411Z
-- Content published by the pipeline (ADR 0003). Ids are hashes of folded names (ADR 0002), never readable names.
-- Times: INTEGER epoch milliseconds UTC. Current version pointer: app_meta key 'current_version'.

-- Catalog of every element ever published (admin lists, reports). What is active in a version lives in
-- batch_content.server_json; the block table overrides both.
CREATE TABLE element (
  id TEXT PRIMARY KEY,                       -- base64url(SHA-256("lm1|e|" + fold)), ADR 0002
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_fold TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  depth INTEGER NOT NULL CHECK (depth >= 0),
  origin TEXT CHECK (origin IS NULL OR origin IN ('vn', 'intl')),
  image_key TEXT CHECK (image_key IS NULL OR length(image_key) = 17), -- '<sha256-12>.webp' (phase 2)
  first_version INTEGER NOT NULL,
  last_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX element_last_version ON element (last_version);

-- One row per unordered pair; id is the graph lookup key of the pair (ADR 0002).
CREATE TABLE recipe (
  id TEXT PRIMARY KEY,
  a_id TEXT NOT NULL REFERENCES element (id),
  b_id TEXT NOT NULL REFERENCES element (id),
  result_id TEXT NOT NULL REFERENCES element (id),
  score INTEGER CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  first_version INTEGER NOT NULL,
  last_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (a_id <= b_id),
  UNIQUE (a_id, b_id)
);
CREATE INDEX recipe_result ON recipe (result_id);
CREATE INDEX recipe_b ON recipe (b_id);

-- Log of every batch run, including failed runs (version NULL) and rollbacks (rollback_to set).
CREATE TABLE batch_run (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  version INTEGER UNIQUE,
  batch_at INTEGER NOT NULL,                 -- real run time passed by the pipeline
  mode TEXT NOT NULL CHECK (mode IN ('core', 'full')),
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'rollback')),
  failed_step TEXT CHECK (failed_step IS NULL OR length(failed_step) <= 100),
  rollback_to INTEGER,
  daily_element_id TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json)),
  issue_url TEXT CHECK (issue_url IS NULL OR issue_url LIKE 'https://github.com/%'),
  created_at INTEGER NOT NULL
);
CREATE INDEX batch_run_created ON batch_run (created_at);

-- Published versions; only the 14 newest are kept (AC-GRAPH-05).
CREATE TABLE batch_content (
  version INTEGER PRIMARY KEY,
  batch_at INTEGER NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10),             -- GMT+7 date of batch_at, 'YYYY-MM-DD'
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  server_json TEXT NOT NULL CHECK (json_valid(server_json)), -- active ids for DISC/DAILY checks, never served
  created_at INTEGER NOT NULL
);

-- Hot block list (AC-REPORT-06): a row means the target is not active. Deleted on "show".
CREATE TABLE block (
  kind TEXT NOT NULL CHECK (kind IN ('element', 'recipe', 'image')),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('hidden', 'blocked')),
  reason TEXT NOT NULL CHECK (reason IN ('auto_report', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id)
);

-- Folded terms rejected in nicknames and new content (AC-DISC-03, AC-MOD-06, AC-MOD-10).
-- 'wordlist' is synced by the pipeline from a GitHub Secret, never committed (ADR 0005).
CREATE TABLE banned_term (
  term_fold TEXT NOT NULL CHECK (length(term_fold) BETWEEN 1 AND 100),
  source TEXT NOT NULL CHECK (source IN ('wordlist', 'mod', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (term_fold, source)
);
