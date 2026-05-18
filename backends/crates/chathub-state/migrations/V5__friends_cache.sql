-- V5__friends_cache.sql — listFriends 响应分页缓存
--
-- 设计:服务端分页 + 服务端筛选已经覆盖业务诉求,无需把 records 拆行存。
-- cache_key 把请求规范化(sorted account_ids + filter + current + size)成 hash,
-- 命中即返回 body_json,5 分钟 TTL。这是 minimum-viable cache,无事件增量需求。
-- 注:V6 已 DROP 此表,改用行存 hub_wecom_friends + 水位。

CREATE TABLE hub_wecom_friends_cache (
    cache_key      TEXT    PRIMARY KEY,
    body_json      TEXT    NOT NULL,
    cached_at_ms   INTEGER NOT NULL
);

CREATE INDEX idx_hub_wecom_friends_cache_age ON hub_wecom_friends_cache(cached_at_ms);
