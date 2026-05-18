-- V1__init.sql — Plan 2 first migration
-- 每个用户登录后此表恰好一行(单行约束 by id = 1);登出删除。
CREATE TABLE IF NOT EXISTS hub_current_session (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    user_id         TEXT    NOT NULL,
    display_name    TEXT    NOT NULL,
    avatar_url      TEXT    NOT NULL,
    role            TEXT    NOT NULL,
    tenant_id       TEXT    NOT NULL,
    logged_in_at_ms INTEGER NOT NULL
);

-- WecomAccount 缓存。Plan 2 在 Login 时一并写入,Plan 3 起业务用。
CREATE TABLE IF NOT EXISTS hub_wecom_accounts (
    wecom_account_id TEXT    PRIMARY KEY,
    user_id          TEXT    NOT NULL,
    corp_id          TEXT    NOT NULL,
    agent_id         INTEGER NOT NULL,
    display_name     TEXT    NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    cached_at_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hub_wecom_user ON hub_wecom_accounts(user_id);
