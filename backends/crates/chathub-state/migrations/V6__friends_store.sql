-- V6__friends_store.sql — listFriends 行存重构
--
-- 用行存表 + 同步状态 + 水位 取代 V5 引入的响应级整页缓存。
-- 目标:
--   1) 每行带 wecom_account_id,多账号查询时单条 record 仍知道归属(修复"多选 chip 数字消失")
--   2) 前端可以查全量算 tabCounts / accountCounts,不再被单页 100 卡住
--   3) 配 FRIEND_* 推送事件 + 水位,实现增量同步,事件 keep data fresh,TTL 仅兜底
--
-- 模板对照 V4__account_cache.sql 的 wecom_accounts + wecom_account_watermark 设计。

-- 1) 删 V5 整页缓存表(被行存取代)
DROP TABLE IF EXISTS wecom_friends_cache;

-- 2) 好友行存:per (wecom_account_id, external_user_id);wecom_account_id 来自查询入参,
--    不依赖 API 响应的单条 accountId 字段(响应不下发),写入时由 Tauri 层附加。
CREATE TABLE wecom_friends (
    wecom_account_id         TEXT    NOT NULL,
    external_user_id         TEXT    NOT NULL,
    external_name            TEXT    NOT NULL,
    external_position        TEXT    NOT NULL,
    external_avatar          TEXT    NOT NULL,
    external_corp_name       TEXT    NOT NULL,
    external_corp_full_name  TEXT    NOT NULL,
    external_type            INTEGER NOT NULL,   -- 1=微信用户, 2=企微用户
    external_gender          INTEGER NOT NULL,   -- 0=未知, 1=男, 2=女
    external_mobile          TEXT    NOT NULL,   -- 已脱敏
    follow_remark            TEXT    NOT NULL,
    follow_description       TEXT    NOT NULL,
    remark_corp_name         TEXT    NOT NULL,
    add_time                 TEXT    NOT NULL,   -- yyyy-MM-dd HH:mm:ss
    add_way                  INTEGER NOT NULL,
    follow_state             TEXT    NOT NULL,
    wechat_channels_nickname TEXT    NOT NULL,
    wechat_channels_source   INTEGER NOT NULL,
    last_sync_time           TEXT    NOT NULL,
    sync_status              INTEGER NOT NULL,
    updated_at_ms            INTEGER NOT NULL,
    PRIMARY KEY (wecom_account_id, external_user_id)
);
CREATE INDEX idx_wecom_friends_account_addtime ON wecom_friends(wecom_account_id, add_time DESC);

-- 3) 同步状态:per wecom_account_id 标记"是否已全量同步过 + 上次同步时间"。
--    Tauri list_friends 命令据此判断 TTL 兜底要不要重拉。
CREATE TABLE wecom_friend_sync_state (
    wecom_account_id  TEXT    PRIMARY KEY,
    employee_id       TEXT    NOT NULL,
    full_synced_at_ms INTEGER NOT NULL,
    last_total        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_wecom_friend_sync_state_employee ON wecom_friend_sync_state(employee_id);

-- 4) 事件水位,完全对照 wecom_account_watermark 设计("取大不取小"应对 redelivery)。
CREATE TABLE wecom_friend_watermark (
    client_id     TEXT    NOT NULL,
    employee_id   TEXT    NOT NULL,
    last_seq      INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (client_id, employee_id)
);
