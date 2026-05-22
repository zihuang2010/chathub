-- V8__friends_employee_id.sql — 给 hub_wecom_friends 加 employee_id 列做防御性隔离
--
-- 背景:
--   V6 之前 hub_wecom_friends 仅按 (wecom_account_id, external_user_id) 联合主键唯一,
--   clear_for_employee 通过 hub_wecom_friend_sync_state.employee_id 间接定位行;
--   异常退出 / 崩溃时 sync_state 行缺失则 friends 行存留,下个 employee 登录会"串号"。
--
-- 方案:
--   1) ALTER TABLE 加 employee_id 列,存量行默认空串(下次 clear_for_employee('') 或
--      该账号被新 employee 重拉时被覆盖,不主动回填)。
--   2) 建 (employee_id, wecom_account_id) 索引,支持读路径直接按 employee_id 过滤。
--   3) clear_for_employee 改为按 employee_id 直接 DELETE,不再依赖 sync_state 关联。

ALTER TABLE hub_wecom_friends ADD COLUMN employee_id TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_hub_wecom_friends_employee_account
    ON hub_wecom_friends(employee_id, wecom_account_id);
