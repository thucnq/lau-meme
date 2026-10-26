-- Migration number: 0010 	 2026-10-26T04:13:46.609Z
-- AC-DAILY-19, ADR 0019: the admin pins the Món đặc biệt of the next batch. At most one pin (slot = 1); setting
-- again replaces it with a new id. The pipeline reads it from /pipeline/state and sends its id back when the batch is
-- published; the Worker deletes the row with that id in the publishing batch, so a pin set while the batch was
-- running (new id) survives. A failed batch never reaches the delete, so the pin waits for the next one.
CREATE TABLE daily_pin (
  id TEXT PRIMARY KEY,                       -- UUIDv7, new on every set
  slot INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (slot = 1),
  element_id TEXT NOT NULL,
  hint TEXT NOT NULL CHECK (length(hint) BETWEEN 1 AND 200),
  token_fp TEXT NOT NULL CHECK (length(token_fp) = 8),
  created_at INTEGER NOT NULL
);

-- Audit of set/clear (AC-ADMIN-09): admin_change's action CHECK cannot grow without a table rebuild, so pins get
-- their own append-only table like admin_image_change; /admin/audit lists it with the others. Kept 12 months.
CREATE TABLE daily_pin_change (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  action TEXT NOT NULL CHECK (action IN ('set_daily_pin', 'clear_daily_pin')),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),  -- {"element_id", "hint"} or null
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  token_fp TEXT NOT NULL CHECK (length(token_fp) = 8),
  created_at INTEGER NOT NULL
);
CREATE INDEX daily_pin_change_created ON daily_pin_change (created_at);
