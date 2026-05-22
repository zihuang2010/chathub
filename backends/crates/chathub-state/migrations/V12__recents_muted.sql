-- V12__recents_muted.sql — 接待会话本地"消息免打扰"标记
--
-- 与 pinned/removed 一样属于客户端独占列,远端 UPSERT 永不触碰
-- (muted 不在 INSERT 列表也不在 ON CONFLICT SET 列表 → 自动保留)。
--   - 用户点"消息免打扰" → set_muted(true) 写 muted=1, muted_at_ms=now
--   - "取消免打扰" → set_muted(false) 写 muted=0, muted_at_ms=0
--
-- 不进 ORDER BY(mute 不改排序)、不进 WHERE(muted 行仍展示),故无需新建索引。
ALTER TABLE hub_conversation_recents
    ADD COLUMN muted       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hub_conversation_recents
    ADD COLUMN muted_at_ms INTEGER NOT NULL DEFAULT 0;
