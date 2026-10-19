-- Migration 0001: platform table. D1 = SQLite. Expand-only: add tables/columns, never edit a committed file
-- (tools/check-migrations.sh --kind wrangler-seq). New file: npx wrangler d1 migrations create DB <slug>
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL -- epoch milliseconds (UTC)
);
INSERT INTO app_meta (key, value, updated_at) VALUES ('schema', '1', 0);
