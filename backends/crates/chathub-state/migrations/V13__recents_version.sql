-- V13__recents_version.sql — 接待会话每行 LWW 复合版本
--
-- 修 bug:冷 cursor 旧页会无条件覆盖更新的实时事件行。引入复合版本
-- (last_message_sort_key_ms, gmt_modified_time),`upsert_remote_in_tx` 仅当
-- incoming 版本 ≥ stored 才覆盖远端列(WHERE 守卫),stale 页直接丢弃。
--   - last_message_sort_key_ms:lastMessageSortKey 首段 epoch-ms(缺省回退 last_message_time_ms)
--   - gmt_modified_time:记录最后修改时间字符串,同 sortKey 时作次版本决胜
--
-- 均为远端权威列(由远端拉取 / 事件 applier 写入);DEFAULT 0 / '' 兼容存量行。
-- 不进 WHERE/ORDER BY,故无需新建索引。
ALTER TABLE hub_conversation_recents
    ADD COLUMN last_message_sort_key_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hub_conversation_recents
    ADD COLUMN gmt_modified_time TEXT NOT NULL DEFAULT '';
