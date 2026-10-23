-- Migration number: 0007 	 2026-10-23T05:10:25.754Z
-- Meme contributions (CONTRIB), admin-assigned tiers (TIER), trending level (AC-PIPE-16) and the per-version creator
-- snapshot (AC-CONTRIB-10). ADR 0013. Expand-only: new tables, nullable columns, indexes.

-- A signed-in player's proposal of a new element made from an existing unordered pair (a_id <= b_id, ADR 0002 ids).
-- Never sent to an LLM before approval (open question 46); description and image_url never leave the Worker except to
-- the author (AC-CONTRIB-06, export) and the admin (AC-CONTRIB-07). Deleting the account deletes pending rows first,
-- then ON DELETE SET NULL unlinks approved/rejected ones (AC-CONTRIB-12).
CREATE TABLE contribution (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  account_id TEXT REFERENCES account (id) ON DELETE SET NULL,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  name_fold TEXT NOT NULL CHECK (length(name_fold) BETWEEN 1 AND 40),
  emoji TEXT CHECK (emoji IS NULL OR length(emoji) BETWEEN 1 AND 16),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  image_url TEXT CHECK (image_url IS NULL OR (length(image_url) <= 500 AND image_url LIKE 'https://%')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT CHECK (reject_reason IS NULL OR length(reject_reason) BETWEEN 1 AND 200),
  image_hint TEXT CHECK (image_hint IS NULL OR length(image_hint) BETWEEN 1 AND 300), -- written by the admin on approve
  element_id TEXT,                           -- ElementId of fold(name), set on approve
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,                        -- approve/reject time; Top cống hiến tie-break (AC-CONTRIB-11)
  CHECK (a_id <= b_id),
  CHECK ((status = 'approved') = (element_id IS NOT NULL)),
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL))
);
-- One pending proposal per account and pair (AC-CONTRIB-03); one approved element per pair and per folded name.
CREATE UNIQUE INDEX contribution_pending_pair ON contribution (account_id, a_id, b_id) WHERE status = 'pending';
CREATE UNIQUE INDEX contribution_approved_pair ON contribution (a_id, b_id) WHERE status = 'approved';
CREATE UNIQUE INDEX contribution_approved_name ON contribution (name_fold) WHERE status = 'approved';
CREATE INDEX contribution_pair ON contribution (a_id, b_id, status);
CREATE INDEX contribution_status ON contribution (status, created_at);           -- admin list, oldest first
CREATE INDEX contribution_account ON contribution (account_id, created_at);      -- my list, 5 per GMT+7 day
CREATE INDEX contribution_rank ON contribution (status, account_id, decided_at); -- Top cống hiến

-- Tier set by the admin (AC-ADMIN-12); no row = tier 1. Read by the pipeline through /pipeline/state and baked
-- into the next graph (AC-TIER-01, open question 53). Survives batches and rollbacks.
CREATE TABLE element_tier (
  element_id TEXT PRIMARY KEY,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL
);

-- Admin writes that admin_audit cannot hold (its CHECKs only know moderation states): tier changes and
-- contribution edit/approve/reject (AC-ADMIN-09/12, AC-CONTRIB-07/08). Append-only, kept 12 months like admin_audit;
-- /admin/audit lists both tables merged by created_at.
CREATE TABLE admin_change (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  action TEXT NOT NULL CHECK (action IN ('set_tier', 'edit_contribution', 'approve_contribution', 'reject_contribution')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('element', 'contribution')),
  target_id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  token_fp TEXT NOT NULL CHECK (length(token_fp) = 8),
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_change_created ON admin_change (created_at);

-- Highest trending level ever recorded (AC-PIPE-16), sent by the pipeline with each element; NULL = never crawled (0).
ALTER TABLE element ADD COLUMN trend_peak INTEGER CHECK (trend_peak IS NULL OR trend_peak >= 0);

-- { "<element_id>": "<nickname>" | null } for contributed elements active in this version, built by the Worker when
-- the batch is published (the pipeline never sees nicknames). Account deletion rewrites the entry to null in every
-- kept version (AC-CONTRIB-10/12).
ALTER TABLE batch_content ADD COLUMN creators_json TEXT CHECK (creators_json IS NULL OR json_valid(creators_json));
