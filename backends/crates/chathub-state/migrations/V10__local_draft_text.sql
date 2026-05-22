-- V10__local_draft_text.sql — 给 hub_conversation_recents 加 local_draft_text 列
--
-- 背景:
--   V7-V9 已有 local_draft_at_ms(草稿时间戳),但没存草稿文本本身。
--   生产场景:用户输入一半切走会话,回来时输入框应该恢复草稿,而非空白。
--
-- 设计:
--   - 本地列,远端 UPSERT 永不触碰(ON CONFLICT 不动 draft 字段)
--   - text='' = 无草稿;非空 = 有草稿,同时 local_draft_at_ms 应被设为 now
--   - 不限长度,信任 UI 层做合理截断

ALTER TABLE hub_conversation_recents ADD COLUMN local_draft_text TEXT NOT NULL DEFAULT '';
