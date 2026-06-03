-- V22__messages_revoked_fail_reason.sql — 消息行新增撤回/失败原因/请求去重三列。
-- 老库已有消息行:NOT NULL DEFAULT 平滑迁移,下次 upsert 被真实值覆盖。
ALTER TABLE hub_conversation_messages ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hub_conversation_messages ADD COLUMN fail_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE hub_conversation_messages ADD COLUMN request_message_id TEXT NOT NULL DEFAULT '';
