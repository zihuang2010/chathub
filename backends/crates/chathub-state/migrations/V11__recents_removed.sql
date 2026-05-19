-- V11__recents_removed.sql — 接待会话本地"移除"标记(软删除 + 自动恢复)
--
-- 与 pinned/pinned_at_ms 一样属于客户端独占列:
--   - 用户点"移除会话" → set_removed(true) 写 removed=1, removed_at_ms=now
--   - 远端事件(或本地落库)带来 last_message_time_ms > removed_at_ms 时,
--     UPSERT 的 ON CONFLICT 分支自动 removed=0(自动恢复)
--   - list_top WHERE removed = 0 过滤,首页不展示
--
-- 这两列不进 ORDER BY(因为已被 WHERE 过滤),仅追加一个支持
-- "WHERE employee_id=? AND removed=0" 的覆盖索引。
ALTER TABLE hub_conversation_recents
    ADD COLUMN removed       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hub_conversation_recents
    ADD COLUMN removed_at_ms INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_recents_employee_removed
    ON hub_conversation_recents(employee_id, removed, pinned DESC, pinned_at_ms DESC, last_message_time_ms DESC);
