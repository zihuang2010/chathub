-- V24__idx_hub_msgs_req.sql — 出站失败气泡去重/保活用的 request_message_id 索引
--
-- upsert_messages 的「仅删 send_status=4」去重 DELETE 与 reconcile/trim 保活都按
-- (employee_id, request_message_id) 过滤。部分索引只覆盖非空 request_message_id
-- (出站行才有,= 客户端 client_msg_id),避免大量空串 inbound 行膨胀索引。
-- SQLite 3.46.1 支持 partial index(WHERE 子句)。
CREATE INDEX IF NOT EXISTS idx_hub_msgs_req
    ON hub_conversation_messages (employee_id, request_message_id)
    WHERE request_message_id <> '';
