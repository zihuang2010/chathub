-- V30__session_terminal_id.sql — 会话持久化本(设备×账号)终端标识 terminal_id。
-- 用途:relay 登录权威回传的 terminalId(= terminal_id_for(device_id, username) UUIDv5)随会话落库,
-- 冷启动 resume 自动带回 → subscribe 上行,供 force_close 终端粒度路由(排他登录只踢旧端、保留新端)。
-- 老库已有 session 行:NOT NULL DEFAULT '' 平滑迁移,下次登录被真实值覆盖。
-- 升级后未重登的旧会话 terminal_id='':relay 视为无保留端、会被当作可踢端(自愈于下次手动登录)。
ALTER TABLE hub_current_session ADD COLUMN terminal_id TEXT NOT NULL DEFAULT '';
