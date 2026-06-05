-- V25__recents_backfill_display_time.sql — 回填接待行的显示时间(last_message_time_ms)
--
-- 背景:发送/失败的本地乐观写(mark_local_sent / mark_local_failed)历史上只写
-- local_last_sent_at_ms(进 list_top 排序),不写 last_message_time_ms(进时间显示)。
-- 对"只有本地发送/失败、从无服务端确认消息"的会话,last_message_time_ms 恒为 0 →
-- 列表行右上角时间空白;failBubble 落库后这种行会长期驻留。写入口已改为同时抬
-- last_message_time_ms = MAX(last_message_time_ms, now);本迁移把存量行一次性补齐。
--
-- 规则与写入口/排序一致:仅当本地发送时间更新时抬齐显示时间(取 MAX 语义,绝不下调;
-- 已有更新的真实消息时间不动)。opened_at_ms 不参与——打开空白会话无消息,不应有显示时间。
-- 幂等:补齐后 local_last_sent_at_ms 不再 > last_message_time_ms,重跑为 no-op。
UPDATE hub_conversation_recents
SET last_message_time_ms = local_last_sent_at_ms
WHERE local_last_sent_at_ms > last_message_time_ms;
