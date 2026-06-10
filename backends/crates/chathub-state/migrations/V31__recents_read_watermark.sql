-- V31:接待会话已读水位。
-- clear_unread(本地 markRead / 多端 MARK_READ 事件)清零未读时,把 read_at_ms 抬到行内
-- last_message_time_ms(服务端消息时间,不用客户端时钟)。此后 last_message_time_ms <=
-- read_at_ms 的迟到/重放事件(同版本摘要、同消息守卫分支、冷页 UPSERT)不得回灌
-- unread_count/has_unread —— 根治"切出会话后列表红标瞬时复活"。
ALTER TABLE hub_conversation_recents ADD COLUMN read_at_ms INTEGER NOT NULL DEFAULT 0;
