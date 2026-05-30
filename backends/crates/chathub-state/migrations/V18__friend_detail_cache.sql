-- 好友(客户)详情本地缓存。客户管理页 / 接待页打开详情时落一份快照,
-- 当天(本地日历日)有效:命中则取本地零远程往返;强制刷新或跨天则远程重拉并覆盖。
--
-- TTL 判定下沉到读 SQL 的 date(cached_at_ms/1000,'unixepoch','localtime') = date('now','localtime'),
-- 用 SQLite 自带本地时区计算,无需后端引入时区库。
--
-- 复合主键 (wecom_account_id, external_user_id):同一外部联系人可被多账号添加,按归属账号分别缓存。
-- detail_json 存 WecomFriendDetail 的原始 JSON(camelCase),Store 不感知其内部结构。
CREATE TABLE IF NOT EXISTS hub_friend_detail_cache (
    wecom_account_id TEXT    NOT NULL,
    external_user_id TEXT    NOT NULL,
    detail_json      TEXT    NOT NULL,
    cached_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (wecom_account_id, external_user_id)
);
