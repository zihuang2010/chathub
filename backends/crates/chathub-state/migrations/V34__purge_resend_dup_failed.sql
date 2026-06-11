-- V34__purge_resend_dup_failed.sql — 一次性收编存量「重发链增殖」的重复失败行。
--
-- 背景:上游 message/history 不回传 requestMessageId(实测全空),服务端又为每次发送尝试
-- 各记一条失败行 → 存量库里同一逻辑消息积累出多条无键失败行(满屏 778/898 重复失败气泡);
-- 失败行 reqid 为空时前端只能拿行 id 当幂等键重发,服务端为新键再建一行(reqid=前任行 id),
-- 链式 +1。升级后:摄入侧已过滤无键失败行、upsert 已按键链收编,此迁移负责清掉存量。
--
-- 安全性:两步都只删 send_status=4(失败占位行,从未送达对端),绝不触碰已送达消息。
-- 顺序敏感:先①内容收编把同内容失败副本聚到「最新一条」,再②键链收编 —— 若最新失败行
-- 已被某次重发(成功或失败)取代,②连这「最后一条」也收掉(如重发终于成功的 898 链,
-- 最终只剩成功行,不留失败残影)。
--
-- ① 同内容收编:同会话、同类型、同正文、同附件的多条失败行只保留 sort_key 最新一条。
--    存量无键失败行之间没有任何键可链(reqid 已被 history 抹空),按内容收敛是唯一手段;
--    被删的只是「发送失败」占位的冗余副本,保留的最新行仍可重发。
DELETE FROM hub_conversation_messages
 WHERE send_status = 4
   AND EXISTS (
     SELECT 1 FROM hub_conversation_messages AS n
      WHERE n.employee_id = hub_conversation_messages.employee_id
        AND n.conversation_id = hub_conversation_messages.conversation_id
        AND n.send_status = 4
        AND n.message_type = hub_conversation_messages.message_type
        AND n.content_text = hub_conversation_messages.content_text
        AND n.attachments_json = hub_conversation_messages.attachments_json
        AND n.sort_key > hub_conversation_messages.sort_key
   );

-- ② 键链收编:失败行的 id 被同会话其它行作为 request_message_id 引用 = 它是某次重发的
--    前任尝试行(后继行无论成败都已取代它),删除。
DELETE FROM hub_conversation_messages
 WHERE send_status = 4
   AND EXISTS (
     SELECT 1 FROM hub_conversation_messages AS n
      WHERE n.employee_id = hub_conversation_messages.employee_id
        AND n.conversation_id = hub_conversation_messages.conversation_id
        AND n.request_message_id = hub_conversation_messages.local_message_id
        AND n.local_message_id <> hub_conversation_messages.local_message_id
   );
