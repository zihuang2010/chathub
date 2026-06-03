-- V23__recents_local_last_sent.sql — 接待会话本地"本次发送置顶"信号列
--
-- 与 pinned/local_draft/muted/opened_at 一样属于客户端独占列,远端 UPSERT 永不触碰
-- (local_last_sent_at_ms 不在 INSERT 列表也不在 ON CONFLICT SET 列表 → 自动保留)。
--   - 用户发出一条消息 → mark_local_sent(now) 乐观把该行提到非置顶区顶部(预览先行)。
--
-- 进 list_top / trim 的 MAX(last_message_time_ms, local_draft_at_ms, opened_at_ms, local_last_sent_at_ms)
-- 排序,但**不进时间显示**(显示仍取 last_message_time_ms / draft):行排到顶部、时间仍是真实最后消息时间。
-- 与 opened_at_ms 同等待遇,MAX(...) 为计算表达式无法走索引,无需新建索引。
ALTER TABLE hub_conversation_recents
    ADD COLUMN local_last_sent_at_ms INTEGER NOT NULL DEFAULT 0;
