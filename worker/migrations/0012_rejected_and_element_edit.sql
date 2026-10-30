-- Migration number: 0012 	 2026-10-30T07:14:34.991Z
-- Rejected concepts kept for the admin (AC-MOD-11, AC-ADMIN-13..15, AC-ADMIN-17), admin edits of live elements
-- (AC-ADMIN-16) and the unblocked/edited state the pipeline reads through /pipeline/state (AC-PIPE-21). ADR 0022.
-- Expand-only: new tables, nullable columns, indexes.

-- A concept the pipeline blocked at moderation (layer 1 word list / alias, layer 2 LLM), written by the Worker in the
-- same DB.batch that publishes a successful batch (a failed batch writes nothing). Same fold seen again: seen_count + 1,
-- last_seen_at, last_batch_id and the union of reasons. Public meme content only, never player data (AC-PIPE-13); may
-- name real people, so only the admin API reads it and rows go 90 days after last_seen_at (AC-ADMIN-17, open question
-- 96). status: blocked -> unblocked (admin, AC-ADMIN-14) -> added (batch linked it, AC-PIPE-21); blocked|unblocked ->
-- approved (Duyệt luôn, AC-ADMIN-15). added/approved rows are read-only.
CREATE TABLE rejected_concept (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_fold TEXT NOT NULL UNIQUE CHECK (length(name_fold) BETWEEN 1 AND 100),
  emoji TEXT CHECK (emoji IS NULL OR length(emoji) BETWEEN 1 AND 16),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  daily_hint TEXT CHECK (daily_hint IS NULL OR length(daily_hint) <= 200),
  image_hint TEXT CHECK (image_hint IS NULL OR length(image_hint) <= 300),
  source_name TEXT NOT NULL CHECK (length(source_name) BETWEEN 1 AND 50),
  source_url TEXT CHECK (source_url IS NULL OR (length(source_url) <= 500 AND source_url LIKE 'https://%')),
  context TEXT CHECK (context IS NULL OR length(context) <= 500),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'), -- [{code, label}]
  step TEXT NOT NULL CHECK (step IN ('layer1', 'layer2')),
  status TEXT NOT NULL DEFAULT 'blocked' CHECK (status IN ('blocked', 'unblocked', 'added', 'approved')),
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  first_batch_id TEXT NOT NULL,              -- batch_run.id of the first / last batch that blocked it
  last_batch_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  edited_at INTEGER,                         -- last admin edit (AC-ADMIN-14)
  decided_at INTEGER,                        -- unblock / approve time
  element_id TEXT,                           -- added: id the batch published; approved: ElementId of fold(name)
  a_id TEXT,                                 -- approved pair (Duyệt luôn), a_id <= b_id
  b_id TEXT,
  tier INTEGER CHECK (tier IS NULL OR tier BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL,
  CHECK ((status IN ('added', 'approved')) = (element_id IS NOT NULL)),
  CHECK ((status = 'approved') = (a_id IS NOT NULL AND b_id IS NOT NULL)),
  CHECK (a_id IS NULL OR a_id <= b_id)
);
CREATE INDEX rejected_concept_seen ON rejected_concept (last_seen_at);                  -- list order, 90-day sweep
CREATE INDEX rejected_concept_status ON rejected_concept (status, last_seen_at);        -- status filter, unblocked for state
CREATE INDEX rejected_concept_step ON rejected_concept (step, last_seen_at);            -- step filter
CREATE UNIQUE INDEX rejected_concept_approved_pair ON rejected_concept (a_id, b_id) WHERE status = 'approved';

-- Admin overrides of a live element's text fields (AC-ADMIN-16). NULL column = not overridden, the pipeline value
-- stands. The pipeline reads every row from /pipeline/state, applies them to its store on every batch and never
-- overwrites them; rev grows on each save and the publishing batch sends back the rev it applied, so applied_rev < rev
-- means "Chờ mẻ kế tiếp" (an edit made while a batch runs stays pending). Survives batches and rollbacks.
CREATE TABLE element_edit (
  element_id TEXT PRIMARY KEY,
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 100),
  name_fold TEXT UNIQUE CHECK (name_fold IS NULL OR length(name_fold) BETWEEN 1 AND 100),
  emoji TEXT CHECK (emoji IS NULL OR length(emoji) BETWEEN 1 AND 16),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  daily_hint TEXT CHECK (daily_hint IS NULL OR length(daily_hint) <= 200),
  image_hint TEXT CHECK (image_hint IS NULL OR length(image_hint) <= 300),
  origin TEXT CHECK (origin IS NULL OR origin IN ('vn', 'intl')),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  applied_rev INTEGER NOT NULL DEFAULT 0 CHECK (applied_rev >= 0),
  updated_at INTEGER NOT NULL,
  CHECK ((name IS NULL) = (name_fold IS NULL))
);

-- Old folded names of renamed elements (AC-ADMIN-16, open question 94): the id stays, the old name becomes an alias so
-- a re-crawl of it dedupes into the element instead of adding a new meme. Never deleted.
CREATE TABLE element_alias (
  fold TEXT PRIMARY KEY CHECK (length(fold) BETWEEN 1 AND 100),
  element_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX element_alias_element ON element_alias (element_id);

-- Current text of each element as the last batch published it (content.elements), so the admin "Nội dung" form can
-- show it; the overridden value, when any, is in element_edit.
ALTER TABLE element ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 200);
ALTER TABLE element ADD COLUMN daily_hint TEXT CHECK (daily_hint IS NULL OR length(daily_hint) <= 200);
ALTER TABLE element ADD COLUMN image_hint TEXT CHECK (image_hint IS NULL OR length(image_hint) <= 300);

-- Audit of the writes above (AC-ADMIN-09): admin_change's action CHECK cannot grow without a table rebuild, so they get
-- their own append-only table like daily_pin_change; /admin/audit lists it with the others. Kept 12 months, and kept
-- when the rejected row it points at is swept after 90 days (AC-ADMIN-17).
CREATE TABLE content_change (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  action TEXT NOT NULL CHECK (action IN ('edit_rejected', 'unblock_rejected', 'approve_rejected', 'edit_element')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('rejected', 'element')),
  target_id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),  -- changed fields only (AC-ADMIN-16)
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  token_fp TEXT NOT NULL CHECK (length(token_fp) = 8),
  created_at INTEGER NOT NULL
);
CREATE INDEX content_change_created ON content_change (created_at);
