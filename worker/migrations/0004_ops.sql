-- Migration number: 0004 	 2026-10-19T17:26:16.312Z
-- Operational tables: fixed-window rate limits and the admin audit trail (ADR 0004).

-- bucket = '<scope>:<u|i>:<sha256 of player id or ip_hash, hex 16>:<window start>'; rows live ≤ 1 hour
-- (admin lockout: 15 min) and are purged daily by the Cron Trigger.
CREATE TABLE rate_counter (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_counter_expires ON rate_counter (expires_at);

-- Append-only, one row per successful admin write (AC-ADMIN-09); kept 12 months.
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  action TEXT NOT NULL CHECK (action IN ('hide', 'show', 'block', 'unblock', 'dismiss_reports')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('element', 'recipe', 'image')),
  target_id TEXT NOT NULL,
  before_state TEXT NOT NULL CHECK (before_state IN ('active', 'hidden', 'blocked')),
  after_state TEXT NOT NULL CHECK (after_state IN ('active', 'hidden', 'blocked')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  token_fp TEXT NOT NULL CHECK (length(token_fp) = 8), -- first 8 hex of SHA-256(token), never the token
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_audit_created ON admin_audit (created_at);
