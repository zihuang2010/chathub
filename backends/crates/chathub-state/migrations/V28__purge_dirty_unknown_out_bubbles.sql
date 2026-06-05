-- V28__purge_dirty_unknown_out_bubbles.sql — 一次性清除存量「语义矛盾脏气泡」。
-- 这类行是入站 messageType=99 消息被 to_local_direction(1→2) 误判成出站、且 send_status=0
-- 落库的产物,前端渲染成「出站永久发送中」无限转圈。V27 起新事件已在落库前被拦截入异常库,
-- 此迁移负责清掉升级前已写入的存量坏行。
-- 安全性:本端从不发送 messageType=99;真实出站 send_status 恒为 1..4,绝不为 0;
-- 故 (message_type=99 AND message_direction=2 AND send_status=0) 必为此类脏行,删除安全。
-- 窗口表无需动:留窗无害,删消息行即止转圈。
DELETE FROM hub_conversation_messages
WHERE message_type = 99 AND message_direction = 2 AND send_status = 0;
