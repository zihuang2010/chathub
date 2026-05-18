-- V4__account_cache.sql — 企微账号本地缓存 + 事件水位
--
-- 1) 清掉 Plan 3 死表(SeqStore 已下线,改用 NotifySeqStore 单 seq 水位)
DROP TABLE IF EXISTS wecom_account_seqs;

-- 2) 重建 wecom_accounts:旧 5 字段 → 新 8 字段契约,内部统一 employee_id
--    (业务后台 2026-05 重设的 listMine 响应形态:wecomAccountId/wecomName/wecomAccount/
--     wecomAlias/wecomAvatar/wecomStatus/gender/position)
DROP TABLE IF EXISTS wecom_accounts;
CREATE TABLE wecom_accounts (
    wecom_account_id TEXT    PRIMARY KEY,
    employee_id      TEXT    NOT NULL,           -- = UserProfile.user_id(同 String,边界 user_id ↔ 内部 employee_id)
    wecom_name       TEXT    NOT NULL,
    wecom_account    TEXT    NOT NULL,
    wecom_alias      TEXT    NOT NULL,
    wecom_avatar     TEXT    NOT NULL,
    wecom_status     INTEGER NOT NULL,           -- 1=启用, 0=停用
    gender           INTEGER NOT NULL,
    position         TEXT    NOT NULL,
    updated_at_ms    INTEGER NOT NULL
);
CREATE INDEX idx_wecom_accounts_employee ON wecom_accounts(employee_id);

-- 3) 账号事件水位(独立于 NotifySeqStore;只反映"账号缓存吃完了到哪个 seq")
--    PK = (client_id, employee_id),粒度跟 relay 推送 scoping 一致。
--    收到 ACCOUNT_* 事件时套 NotifySeqStore::upsert_if_greater 的"取大不取小"。
CREATE TABLE wecom_account_watermark (
    client_id     TEXT    NOT NULL,
    employee_id   TEXT    NOT NULL,
    last_seq      INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (client_id, employee_id)
);
