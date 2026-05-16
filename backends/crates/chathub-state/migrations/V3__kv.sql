-- V3__kv.sql — 通用 kv 表,替代 macOS Keychain。
-- LocalTokenStore 用它存 device_id 与业务后台 token。
CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
