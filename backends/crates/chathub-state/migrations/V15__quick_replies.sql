-- V15__quick_replies.sql — 快捷回复(纯客户端本地功能,不与服务端同步)
--
-- 设计要点:
--   1) 客户端独有:无远端来源,CRUD 全在本地;不接事件 applier、不进 watermark。
--   2) 按 employee_id 隔离(同 hub_conversation_recents):每个登录员工一套快捷回复,
--      所有读写都 `WHERE employee_id = ?` 兜底,切员工互不可见。
--   3) sort_order 决定展示顺序(新建时取该员工 max+1);created/updated 仅作审计/兜底排序。
--   4) id 由前端生成(crypto.randomUUID),作 PK。
CREATE TABLE hub_quick_replies (
    id            TEXT    PRIMARY KEY,
    employee_id   TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

-- 列表读取路径:WHERE employee_id = ? ORDER BY sort_order, created_at_ms
CREATE INDEX idx_quick_replies_employee
    ON hub_quick_replies(employee_id, sort_order, created_at_ms);
