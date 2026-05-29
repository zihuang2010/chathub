-- V17__recents_opened_at.sql — 接待会话本地"主动打开"时间戳
--
-- 与 pinned/local_draft/muted 一样属于客户端独占列,远端 UPSERT 永不触碰
-- (opened_at_ms 不在 INSERT 列表也不在 ON CONFLICT SET 列表 → 自动保留)。
--   - 用户从搜索点开某客户 → set_opened(now) 把该行提到非置顶区顶部。
--
-- 进 list_top / trim 的 MAX(last_message_time_ms, local_draft_at_ms, opened_at_ms) 排序,
-- 但**不进时间显示**(显示仍取 last_message_time_ms / draft):行排到顶部、时间仍是真实最后消息时间。
-- 已有排序索引覆盖 pinned/pinned_at_ms/last_message_time_ms;MAX(...) 为计算表达式无法走索引,
-- 与 local_draft_at_ms 同等待遇,无需新建索引。
ALTER TABLE hub_conversation_recents
    ADD COLUMN opened_at_ms INTEGER NOT NULL DEFAULT 0;
