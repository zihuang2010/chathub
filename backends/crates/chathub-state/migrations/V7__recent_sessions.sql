-- V7__recent_sessions.sql — session/recentFriends 接待好友列表的本地"头部热缓存"
--
-- 设计要点(对照 V6 friends_store):
--   1) 服务端是顺序权威(按 last_message_time 倒序);客户端只缓存"头部一窗口",
--      默认 LIMIT 200 即可秒开 IM 消息页。
--   2) 行内字段分两组:
--      - 远端权威列(17 个 + updated_at_ms),只由 list_recent_friends_remote_page
--        与 recent_session_event applier 写入。
--      - 客户端独占列(pinned / pinned_at_ms / local_draft_at_ms),只由
--        set_conversation_pinned / set_conversation_draft_at 写入。
--      两路写入互不重叠,UPSERT 用 ON CONFLICT DO UPDATE SET <仅远端列> 严防覆盖。
--   3) ORDER BY 多键合成:
--        pinned DESC, pinned_at_ms DESC,
--        MAX(last_message_time_ms, local_draft_at_ms) DESC,
--        last_message_time_ms DESC
--      —— 客户端字段全 0 时退化为纯服务端时序。
--   4) trim 策略只裁 pinned=0,置顶永不被裁。
--   5) watermark 沿用 V4/V6 模板,"取大不取小"应对 relay redelivery。

CREATE TABLE hub_conversation_recents (
    -- 远端权威列(17 个,只由远端拉取 / 事件 applier 写入)
    conversation_id        TEXT    PRIMARY KEY,
    wecom_account_id       TEXT    NOT NULL,
    wecom_name             TEXT    NOT NULL,
    wecom_account          TEXT    NOT NULL,
    wecom_alias            TEXT    NOT NULL,
    external_user_id       TEXT    NOT NULL,
    external_name          TEXT    NOT NULL,
    external_avatar        TEXT    NOT NULL,
    external_mobile        TEXT    NOT NULL,
    last_local_message_id  TEXT    NOT NULL,
    last_message_type      INTEGER NOT NULL,
    last_message_direction INTEGER NOT NULL,
    last_send_status       INTEGER NOT NULL,
    last_message_summary   TEXT    NOT NULL,
    -- ISO `lastMessageTime` 由 Rust 侧转 epoch ms(失败置 0,行仍写入)
    last_message_time_ms   INTEGER NOT NULL,
    unread_count           INTEGER NOT NULL DEFAULT 0,
    has_unread             INTEGER NOT NULL DEFAULT 0,
    updated_at_ms          INTEGER NOT NULL,
    -- 客户端独占列(只由 set_conversation_pinned / set_conversation_draft_at 写入)
    pinned                 INTEGER NOT NULL DEFAULT 0,
    pinned_at_ms           INTEGER NOT NULL DEFAULT 0,
    local_draft_at_ms      INTEGER NOT NULL DEFAULT 0
);

-- 默认列表排序覆盖索引:pinned 先、再 pinned_at_ms、再时序
CREATE INDEX idx_recents_sort
    ON hub_conversation_recents(pinned DESC, pinned_at_ms DESC, last_message_time_ms DESC);
-- 多账号过滤路径:WHERE wecom_account_id = ? ORDER BY ...
-- (employee_id 列与索引升级见 V9 ALTER —— 不放 V7,避免旧 SQLite 已 applied V7 后 schema drift)
CREATE INDEX idx_recents_account_sort
    ON hub_conversation_recents(wecom_account_id, pinned DESC, last_message_time_ms DESC);

-- 事件水位,完全对照 V6 hub_wecom_friend_watermark 设计("取大不取小")
CREATE TABLE hub_recent_session_watermark (
    client_id     TEXT    NOT NULL,
    employee_id   TEXT    NOT NULL,
    last_seq      INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (client_id, employee_id)
);
