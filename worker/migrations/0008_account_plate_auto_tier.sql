-- Migration number: 0008 	 2026-10-24T17:17:45.953Z
-- Account plate (SYNC), depth-based tier (AC-TIER-04/05) and admin-uploaded drawings (AC-ART-13). ADR 0015, 0016.
-- Expand-only: new tables, nullable columns.

-- Elements an account has made, merged from every browser signed in to it (AC-SYNC-01..03). The 4 starters are
-- implicit and never stored. found_at = server receive time of the first accepted write; later writes of the same
-- element keep it (INSERT ... ON CONFLICT DO NOTHING). Rows stay when the element is hidden/blocked or leaves the
-- graph (AC-SYNC-08); the client hides them. No delete endpoint (AC-SYNC-07): only account deletion removes rows,
-- through ON DELETE CASCADE (AC-SYNC-10). Board positions are never synced.
CREATE TABLE account_element (
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  element_id TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, element_id)
) WITHOUT ROWID;

-- Depth-based tier the pipeline computed for the published version (AC-TIER-04), sent as content.elements[].auto_tier.
-- Already lowered to 3 when the element has no usable image (open question 69). NULL = published before TIER-04.
-- The effective tier is element_tier.tier when a row exists, else auto_tier (AC-TIER-05).
ALTER TABLE element ADD COLUMN auto_tier INTEGER CHECK (auto_tier IS NULL OR auto_tier BETWEEN 1 AND 5);

-- Who made element.image_key: 'ai' (Workers AI, ADR 0012) or 'admin' (hand drawing, AC-ART-13). NULL = no image or
-- published before this column. Batches never overwrite an 'admin' image (the pipeline reads them from /pipeline/state).
ALTER TABLE element ADD COLUMN image_source TEXT CHECK (image_source IS NULL OR image_source IN ('ai', 'admin'));

-- Admin image uploads (AC-ART-13, AC-ADMIN-09): admin_change's CHECK has no image action and SQLite cannot widen it.
-- Append-only, kept 12 months; /admin/audit merges it with admin_audit and admin_change.
CREATE TABLE admin_image_change (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  element_id TEXT NOT NULL,
  before_key TEXT CHECK (before_key IS NULL OR length(before_key) = 17),
  after_key TEXT NOT NULL CHECK (length(after_key) = 17),
  token_fp TEXT NOT NULL CHECK (length(token_fp) = 8),
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_image_change_created ON admin_image_change (created_at);
