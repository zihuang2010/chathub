-- 002_events_v2.sql — Plan 重构:events_v2 表
-- Scope:employee_id 维度,主键 (employee_id, notify_seq, event_index)
-- notify_seq 由业务后台分配,event_index 是 batch 内事件下标
-- payload_json 存整个 event 原文(relay 不解析业务字段)
--
-- 旧 events / seq_counters 表暂保留,stage 3/4 切换 callers 完成后 stage 5 清理。

CREATE TABLE events_v2 (
  employee_id      INTEGER NOT NULL,
  notify_seq       INTEGER NOT NULL,
  event_index      INTEGER NOT NULL,
  event_type       TEXT    NOT NULL,
  event_reason     TEXT,
  conversation_id  TEXT,
  customer_user_id TEXT,
  external_user_id TEXT,
  client_id        TEXT    NOT NULL,
  batch_id         TEXT,
  batch_time       TEXT,
  event_time       TEXT,
  payload_json     TEXT    NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (employee_id, notify_seq, event_index)
);

-- 续点查询的覆盖路径(employee_id 已是 PK 前缀,但显式索引便于优化器)
-- 清理 task 走 created_at_ms 范围扫描
CREATE INDEX idx_events_v2_cleanup ON events_v2(created_at_ms);
