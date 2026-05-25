-- V16__retire_friends_store_and_watermarks.sql — 退役好友行存 + per-resource notifySeq 水位
--
-- 背景:
--   1) 好友(客户)列表自"阶段 3"起改纯 cursor 滚动(list_friends 直接透传业务后台 keyset 分页),
--      原本的行存 + 全量同步态已不再读写(见 friends_cache.rs 历史注释)。
--   2) 三张 per-resource 水位表(account / friend / recent_session)只在事件 applier 里 advance(写),
--      get_watermark 从无生产读路径 —— 连接级续点由 hub_settings.notify_seq(NotifySeqStore)负责,
--      事件幂等由各 applier 自身 SQL(INSERT OR REPLACE / UPDATE / DELETE)+ recents V13 行级 LWW 保证。
--      故这三张水位表是纯冗余,一并退役。
--
-- 真正在用的续点水位仍在 hub_settings(key='notify_seq'),本迁移不动它。
DROP TABLE IF EXISTS hub_wecom_friends;
DROP TABLE IF EXISTS hub_wecom_friend_sync_state;
DROP TABLE IF EXISTS hub_wecom_friend_watermark;
DROP TABLE IF EXISTS hub_wecom_account_watermark;
DROP TABLE IF EXISTS hub_recent_session_watermark;
