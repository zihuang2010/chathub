-- V14__conversation_messages.sql — 消息页单会话消息流本地持久化
--
-- 两张表:
--   hub_conversation_messages        消息行(日志本体),local_message_id 为 PK
--   hub_conversation_message_window  每会话一行,即"连续性水位"
--                                    (newest/oldest_sort_key + older_cursor + has_more_older
--                                     + newest_message_time_ms 跨源新鲜度键)
--
-- 与 hub_recent_session_watermark(推送流 notify_seq)正交:那个管"事件处理到第几条",
-- 本表 window 管"本地这段缓存覆盖哪到哪、能否继续往老翻"。
-- newest_message_time_ms 是 epoch-ms,用于 load_conversation_messages 的会话水位门
-- (比 recents 行 last_message_sort_key_ms;sort_key 是 opaque 串不可跨源比)。
CREATE TABLE hub_conversation_messages (
    local_message_id   TEXT    NOT NULL PRIMARY KEY,
    conversation_id    TEXT    NOT NULL,
    employee_id        TEXT    NOT NULL,
    wecom_account_id   TEXT    NOT NULL DEFAULT '',
    sort_key           TEXT    NOT NULL DEFAULT '',
    message_time_ms    INTEGER NOT NULL DEFAULT 0,
    message_direction  INTEGER NOT NULL DEFAULT 0,
    message_type       INTEGER NOT NULL DEFAULT 0,
    content_text       TEXT    NOT NULL DEFAULT '',
    send_status        INTEGER NOT NULL DEFAULT 0,
    attachments_json   TEXT    NOT NULL DEFAULT '[]',
    gmt_modified_time  TEXT    NOT NULL DEFAULT '',
    updated_at_ms      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hub_msgs_conv_sort
    ON hub_conversation_messages (conversation_id, sort_key);
CREATE INDEX idx_hub_msgs_employee
    ON hub_conversation_messages (employee_id);

CREATE TABLE hub_conversation_message_window (
    conversation_id        TEXT    NOT NULL PRIMARY KEY,
    employee_id            TEXT    NOT NULL,
    wecom_account_id       TEXT    NOT NULL DEFAULT '',
    external_user_id       TEXT    NOT NULL DEFAULT '',
    newest_sort_key        TEXT    NOT NULL DEFAULT '',
    oldest_sort_key        TEXT    NOT NULL DEFAULT '',
    older_cursor           TEXT    NOT NULL DEFAULT '',
    has_more_older         INTEGER NOT NULL DEFAULT 0,
    newest_message_time_ms INTEGER NOT NULL DEFAULT 0,
    last_accessed_ms       INTEGER NOT NULL DEFAULT 0,
    reconciled_at_ms       INTEGER NOT NULL DEFAULT 0,
    updated_at_ms          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hub_msg_window_employee
    ON hub_conversation_message_window (employee_id);
