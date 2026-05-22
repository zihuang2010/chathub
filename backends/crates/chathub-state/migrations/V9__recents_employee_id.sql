-- V9__recents_employee_id.sql — 给 hub_conversation_recents 加 employee_id 列
--
-- 背景:
--   V7 上线时未带 employee_id 列;升级方案对照 V8(friends 加 employee_id):
--     - V7 (CREATE) 保持原样,不动 schema(避免对已 applied V7 的 SQLite 形成 drift)
--     - V9 (ALTER) 在所有部署上无差别地把 employee_id 列加入
--
-- 防御目的:多 employee 切换 + 异常退出场景下,所有读写都 WHERE employee_id = ? 兜底,
-- 防止上个登录者的残留行被新员工看到。

ALTER TABLE hub_conversation_recents ADD COLUMN employee_id TEXT NOT NULL DEFAULT '';

-- employee 维度查询主索引:WHERE employee_id = ? (AND wecom_account_id = ?) ORDER BY ...
-- 旧 idx_recents_account_sort 仍保留(只走 wecom_account_id 时仍有用)
CREATE INDEX idx_recents_employee_account_sort
    ON hub_conversation_recents(employee_id, wecom_account_id, pinned DESC, last_message_time_ms DESC);
