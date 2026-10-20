-- Migration number: 0003 	 2026-10-19T17:26:06.719Z
-- Personal data (basic only, BRD 5.2). player_id = browser UUID v4. No raw IP anywhere; ip_hash is
-- HMAC-SHA256 with secret IP_HASH_KEY and is nulled after 7 days (AC-PRIV-06). Erasure: AC-PRIV-05.

CREATE TABLE player (
  id TEXT PRIMARY KEY,
  nickname TEXT CHECK (nickname IS NULL OR length(nickname) BETWEEN 2 AND 20),
  nickname_fold TEXT UNIQUE,                 -- AC-DISC-04 (NULLs do not collide)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Append-only consent evidence; outlives the player for 1 year after an 'erase' row (BRD 5.2).
CREATE TABLE consent (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  player_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('play', 'nickname', 'all')),
  action TEXT NOT NULL CHECK (action IN ('grant', 'withdraw', 'erase')),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  ip_hash BLOB,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web')),
  created_at INTEGER NOT NULL
);
CREATE INDEX consent_player ON consent (player_id, purpose, created_at);
CREATE INDEX consent_created ON consent (created_at);

-- First discovery per element (AC-DISC-05/08): the primary key makes the race safe.
CREATE TABLE discovery (
  element_id TEXT PRIMARY KEY,
  player_id TEXT,                            -- NULL after erasure ("Thực khách ẩn danh")
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  discovered_at INTEGER NOT NULL
);
CREATE INDEX discovery_player ON discovery (player_id);

CREATE TABLE daily_result (
  version INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10), -- GMT+7 date of the version's batch_at
  steps INTEGER NOT NULL CHECK (steps BETWEEN 1 AND 200),
  path_json TEXT NOT NULL CHECK (json_valid(path_json)),
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (version, player_id)
);
CREATE INDEX daily_result_rank ON daily_result (version, steps, submitted_at);
CREATE INDEX daily_result_player ON daily_result (player_id);

CREATE TABLE streak (
  player_id TEXT PRIMARY KEY,
  current INTEGER NOT NULL CHECK (current >= 0),
  longest INTEGER NOT NULL CHECK (longest >= current),
  last_day TEXT NOT NULL CHECK (length(last_day) = 10),
  reached_at INTEGER NOT NULL,               -- when `current` was reached (tie-break, AC-DAILY-11)
  updated_at INTEGER NOT NULL
);
CREATE INDEX streak_rank ON streak (last_day, current, reached_at);

-- Report counting window per target: "show"/"dismiss" bumps cycle so old reports stop counting.
CREATE TABLE report_target (
  kind TEXT NOT NULL CHECK (kind IN ('element', 'image')),
  target_id TEXT NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, target_id)
);

CREATE TABLE report (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  kind TEXT NOT NULL CHECK (kind IN ('element', 'image')),
  target_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  player_id TEXT,                            -- NULL after erasure; the row still counts
  reason TEXT NOT NULL CHECK (reason IN ('real_person', 'politics_religion', 'sexual', 'discrimination',
                                          'violence_drugs_selfharm', 'inappropriate_image', 'other')),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'resolved_hidden', 'resolved_shown', 'resolved_dismissed')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX report_once ON report (kind, target_id, cycle, player_id); -- AC-REPORT-03
CREATE INDEX report_status ON report (status, kind, target_id);
CREATE INDEX report_player ON report (player_id);

-- FEEDBACK (optional): one vote per player per recipe (unordered pair = recipe id).
CREATE TABLE vote (
  recipe_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('ngon', 'nhat')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipe_id, player_id)
);
CREATE INDEX vote_player ON vote (player_id);

-- Anonymous play events (AC-METRIC-02): no IP, no user agent, kept 90 days.
CREATE TABLE event (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  player_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('session_start', 'combine_summary', 'daily_start', 'daily_complete',
                                      'share', 'report', 'feedback')),
  props_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props_json)),
  day TEXT NOT NULL CHECK (length(day) = 10), -- GMT+7 date of received_at
  received_at INTEGER NOT NULL
);
CREATE INDEX event_received ON event (received_at);
CREATE INDEX event_type_day ON event (type, day);
CREATE INDEX event_player ON event (player_id, day);
