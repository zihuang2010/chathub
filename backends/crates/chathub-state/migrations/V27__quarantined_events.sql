-- V27__quarantined_events.sql — 异常事件隔离库(异常库)。
-- 存放被判定为「语义矛盾、不入正常消息库」的 push 事件原文,供后续排查。
-- 触发场景:入站客户消息(eventReason=CUSTOMER_MESSAGE_RECEIVED)却被上游标成发送方
--   (messageDirection=1)+ 未知类型(messageType=99)+ 无 send_status(0)。若入正常消息库,
--   会被 to_local_direction(1→2) 判成出站、send_status=0 永远算「发送中」→ 无限转圈。
CREATE TABLE hub_quarantined_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id      TEXT    NOT NULL,
    conversation_id  TEXT    NOT NULL,
    local_message_id TEXT    NOT NULL DEFAULT '',
    reason           TEXT    NOT NULL,
    raw_event_json   TEXT    NOT NULL,
    created_at_ms    INTEGER NOT NULL
);
CREATE INDEX idx_hub_quarantined_employee
    ON hub_quarantined_events (employee_id, created_at_ms DESC);
