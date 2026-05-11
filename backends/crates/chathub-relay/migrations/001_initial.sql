-- 001_initial.sql — Plan 5 schema:sessions / seq_counters / events ring / kv
CREATE TABLE sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_exp_ms INTEGER NOT NULL,
  kicked_at_ms INTEGER,
  accounts_json TEXT NOT NULL,                -- JSON array of wecom_account_ids (snapshot at login;refresh 时反序列化用)
  created_at_ms INTEGER NOT NULL,
  UNIQUE(user_id, device_id)
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE seq_counters(
  wecom_account_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE events(
  wecom_account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(wecom_account_id, seq)
);

CREATE TABLE kv(
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
