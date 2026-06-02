-- V21__session_user_fields.sql — 个人信息卡片新增 username/mobile 展示。
-- 老库已有 session 行:NOT NULL DEFAULT '' 平滑迁移,下次登录被真实值覆盖。
ALTER TABLE hub_current_session ADD COLUMN username TEXT NOT NULL DEFAULT '';
ALTER TABLE hub_current_session ADD COLUMN mobile   TEXT NOT NULL DEFAULT '';
