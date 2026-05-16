-- 003_drop_legacy.sql — Plan 7:删除老 schema 的所有表
-- 老 events ring buffer / seq_counters / sessions / kv 全部移除。
-- events_v2(V002 创建)是唯一存留的业务表。

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS seq_counters;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS kv;
