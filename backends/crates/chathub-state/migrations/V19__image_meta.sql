CREATE TABLE IF NOT EXISTS hub_image_meta (
  url           TEXT PRIMARY KEY,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  local_path    TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
