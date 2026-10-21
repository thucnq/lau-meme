-- Migration number: 0005 	 2026-10-21T04:54:47.147Z
-- Google sign-in (AUTH, ADR 0010). An account is HMAC-SHA256(ACCOUNT_HASH_KEY, Google `sub`): no raw `sub`,
-- email, name or picture anywhere. Daily results, streak and the leaderboard nickname belong to the account
-- (DAILY rework); discoveries, reports, votes, events and consent stay on the browser UUID (ADR 0004).
-- The old UUID-keyed `daily_result` / `streak` are no longer written (open question 34, staging data only).

CREATE TABLE account (
  id TEXT PRIMARY KEY,                       -- UUIDv7, the only account id that leaves D1 (never in public responses)
  sub_hash BLOB NOT NULL UNIQUE CHECK (length(sub_hash) = 32),
  nickname TEXT CHECK (nickname IS NULL OR length(nickname) BETWEEN 2 AND 20),
  nickname_fold TEXT UNIQUE,                 -- AC-DISC-04 across accounts; vs player.nickname_fold checked in the same statement
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Browser UUIDs that signed in to an account (AC-AUTH-01/04). One account per UUID: the last sign-in wins.
CREATE TABLE account_player (
  player_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL
);
CREATE INDEX account_player_account ON account_player (account_id);

-- Session token = 32 random bytes (base64url, cookie `laumeme_sid`); only SHA-256 of it is stored (AC-AUTH-02).
-- Sliding expiry: every authenticated request sets last_used_at = now, expires_at = now + 90 days.
CREATE TABLE session (
  token_hash BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX session_account ON session (account_id);
CREATE INDEX session_expires ON session (expires_at);

-- One result per (account, version) (AC-DAILY-06/08). solved_at = server receive time; solve_ms = solved_at -
-- batch_at of the version. seq breaks ms ties in write order (AC-DAILY-09). day = GMT+7 date of batch_at: the
-- streak day and the week/month period key (AC-DAILY-10/14).
CREATE TABLE daily_entry (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  solved_at INTEGER NOT NULL,
  solve_ms INTEGER NOT NULL CHECK (solve_ms >= 0),
  UNIQUE (version, account_id)
);
CREATE INDEX daily_entry_rank ON daily_entry (version, solved_at, seq);
CREATE INDEX daily_entry_period ON daily_entry (day, account_id);
CREATE INDEX daily_entry_account ON daily_entry (account_id, day);

CREATE TABLE account_streak (
  account_id TEXT PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  current INTEGER NOT NULL CHECK (current >= 0),
  longest INTEGER NOT NULL CHECK (longest >= current),
  last_day TEXT NOT NULL CHECK (length(last_day) = 10),
  reached_at INTEGER NOT NULL,               -- when `current` was reached (tie-break, AC-DAILY-11)
  updated_at INTEGER NOT NULL
);
CREATE INDEX account_streak_rank ON account_streak (last_day, current, reached_at);
