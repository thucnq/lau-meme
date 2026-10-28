-- Migration number: 0011 	 2026-10-28T08:11:01.686Z
-- QUIZ, ADR 0021: a live mQuiz room lives in its Durable Object (QuizRoom); D1 only keeps the room-code registry
-- and the history of finished multiplayer games (AC-QUIZ-18..22). Solo games are never written here (AC-QUIZ-17).

-- One row per room code ever issued and not yet cleaned up. INSERT … ON CONFLICT(code) DO NOTHING picks a fresh
-- code (AC-QUIZ-01: a code still live or still in history is never reissued). The Worker checks this row before
-- waking the DO, so unknown codes are 404 without creating an object (AC-QUIZ-03/25). The DO deletes the row when
-- the room is cancelled with no history; otherwise the 90-day cleanup deletes it with the last game.
CREATE TABLE quiz_room (
  code TEXT PRIMARY KEY CHECK (length(code) = 6),
  created_at INTEGER NOT NULL,
  closed_at INTEGER                          -- set when the DO is cleaned up (AC-QUIZ-23); NULL while live
);
CREATE INDEX quiz_room_closed ON quiz_room (closed_at);

-- One row per finished multiplayer game; UNIQUE(room_code, game_no) makes the final write idempotent (AC-QUIZ-18).
CREATE TABLE quiz_game (
  id TEXT PRIMARY KEY,                       -- UUIDv7
  room_code TEXT NOT NULL REFERENCES quiz_room (code) ON DELETE CASCADE,
  game_no INTEGER NOT NULL CHECK (game_no >= 1),
  content_version INTEGER NOT NULL,
  questions INTEGER NOT NULL CHECK (questions BETWEEN 5 AND 15),   -- actual count (AC-QUIZ-09 may lower it)
  seconds INTEGER NOT NULL CHECK (seconds IN (10, 20, 30)),
  player_count INTEGER NOT NULL CHECK (player_count >= 2),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  UNIQUE (room_code, game_no)
);
CREATE INDEX quiz_game_finished ON quiz_game (finished_at);

-- Final standing of each player. player_id is NULL and nickname 'Thực khách ẩn danh' after the player erases their
-- data (AC-QUIZ-22, open question 88); score and rank stay so the other players' boards do not change.
CREATE TABLE quiz_player (
  game_id TEXT NOT NULL REFERENCES quiz_game (id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat >= 1),  -- join order, last tie-break (AC-QUIZ-14)
  player_id TEXT,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 40),
  score INTEGER NOT NULL CHECK (score >= 0),
  correct INTEGER NOT NULL CHECK (correct >= 0),
  correct_ms INTEGER NOT NULL CHECK (correct_ms >= 0),  -- total answer time of correct answers (tie-break)
  rank INTEGER NOT NULL CHECK (rank >= 1),
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX quiz_player_player ON quiz_player (player_id, game_id);
