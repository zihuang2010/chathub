-- V26__recents_backfill_remote_display_time.sql — 回填纯远端接待行的显示时间(last_message_time_ms)
--
-- 背景:接待列表整页拉取持久化(net::record_to_remote)历史上用只认尾 `Z` 的 parse_iso_to_ms
-- 解析服务端 lastMessageTime。真实 payload 形态为无 `Z` 的 `2026-06-02T16:55:20`(或空格分隔
-- `2026-05-30 20:27:16`、带毫秒),一律解析失败置 0 → 纯远端会话行 last_message_time_ms 恒 0 →
-- 列表行右上角时间空白(重启后全量从缓存渲染时尤为明显)。写入口已改为复用健壮的
-- parse_server_time_to_ms 并以 sortKey 兜底;本迁移把存量坏行一次性补齐。
--
-- 规则:sortKey 首段即该会话权威 epoch-ms(健康行 last_message_time_ms == last_message_sort_key_ms),
-- 故用 sortKey 回填显示时间,绝不下调已有更新值。V25(本地发送行用 local_last_sent_at_ms 回填)
-- 先行;本迁移只补 V25 够不到的纯远端零时间行(local_last_sent_at_ms=0 但有 sortKey)。
-- 幂等:补齐后不再有 last_message_time_ms=0 且 sort_key>0 的行,重跑为 no-op。
UPDATE hub_conversation_recents
SET last_message_time_ms = last_message_sort_key_ms
WHERE last_message_time_ms = 0 AND last_message_sort_key_ms > 0;
