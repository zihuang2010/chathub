-- 用户设置(设置页):按登录账号(employee_id)分键的偏好 KV。
-- 与 hub_settings(notify_seq 水位等连接级内部状态)分表:语义不同、生命周期不同,
-- 见 docs/db/conventions.md KV 拆分约定。value 统一存 JSON 字面量(布尔/数字/字符串)。
CREATE TABLE hub_user_settings (
  employee_id   TEXT    NOT NULL,
  key           TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (employee_id, key)
);
