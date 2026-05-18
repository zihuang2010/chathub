-- V3__kv.sql — 本地 KV 拆分:hub_secrets + hub_settings。
--
-- 历史上是单张 `kv` 通用表,把"凭据"(device_id/token)和"运行时水位"(notify_seq)
-- 混塞在一张。规范化后(见 docs/db/conventions.md §3)拆成两张同构表,语义解耦:
--   - hub_secrets  → LocalTokenStore:本地凭据(敏感),例 device_id / token
--   - hub_settings → NotifySeqStore:运行时状态(可重建,非敏感),例 notify_seq
CREATE TABLE IF NOT EXISTS hub_secrets (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
