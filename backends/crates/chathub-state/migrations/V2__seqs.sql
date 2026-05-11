-- V2__seqs.sql — Plan 3:每账号 last_seq 持久化
-- ConnectionManager 的 SeqStore 用单条 UPSERT 写,WAL 模式下亚毫秒。
CREATE TABLE IF NOT EXISTS wecom_account_seqs (
    wecom_account_id TEXT    PRIMARY KEY,
    last_seq         INTEGER NOT NULL DEFAULT 0,
    updated_at_ms    INTEGER NOT NULL
);
