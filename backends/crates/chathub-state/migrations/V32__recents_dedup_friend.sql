-- V32__recents_dedup_friend.sql — 接待列表同好友重复行清理 + 业务键索引
--
-- 背景:服务端会对同一 (employee_id, wecom_account_id, external_user_id) 换发新的
-- 雪花 conversation_id(接待重开/会话重建),旧版客户端按 conversation_id 主键 UPSERT
-- 无业务键收敛 → 同一好友落两行,接待列表出现重复会话。
-- 运行时去重已在 upsert_remote_in_tx 落地(新 id 收编旧行);本迁移一次性清理存量:
-- 每组业务键只保留版本最新的一行(last_message_sort_key_ms 最大;同值取雪花 id 更大者,
-- 与运行时守卫同序,保证迁移后不会被滞后重放复活)。
-- external_user_id 为空的行无业务键可比,不参与清理。
DELETE FROM hub_conversation_recents
 WHERE external_user_id <> ''
   AND conversation_id NOT IN (
     SELECT conversation_id FROM (
       SELECT conversation_id,
              ROW_NUMBER() OVER (
                PARTITION BY employee_id, wecom_account_id, external_user_id
                ORDER BY last_message_sort_key_ms DESC,
                         CAST(conversation_id AS INTEGER) DESC
              ) AS rn
         FROM hub_conversation_recents
        WHERE external_user_id <> ''
     ) WHERE rn = 1
   );

-- 业务键查找索引:运行时去重(守卫/收编)与 find_conversation_id 均按此三键查。
CREATE INDEX IF NOT EXISTS idx_recents_friend
    ON hub_conversation_recents(employee_id, wecom_account_id, external_user_id);
