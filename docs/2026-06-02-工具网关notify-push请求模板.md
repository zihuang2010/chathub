# 工具网关 notify/push 真实 curl 样例

本文不再提供字段模板。以下 curl 的请求体来自云端 dev `wechat-business` 业务侧真实 outbox 日志，也就是服务实际推送给工具网关的 `payload_json`。

使用前先在执行环境设置两个变量：

```bash
export WECOM_AGGREGATE_GATEWAY_BASE_URL="http://<工具网关地址>"
export RELAY_PUSH_SECRET="<wecom-aggregate.gateway.push-secret>"
```

说明：文档不记录真实密钥。每个样例都会先写入 `/tmp/notify-push-*.json`，再用 `curl --data-binary @file` 发起请求，避免手工复制长 JSON 时出现转义错误。

## 覆盖情况

| eventType                | reason                        | notifySeq | 来源                   | 说明                                                                   |
| ------------------------ | ----------------------------- | --------- | ---------------------- | ---------------------------------------------------------------------- |
| `MESSAGE_UPSERT`         | `SEND_PENDING_CREATED`        | `1360`    | dev 当前日志 all.log   | 员工侧发送消息创建 pending 气泡；该 batch 同时带会话最后消息刷新。     |
| `MESSAGE_UPSERT`         | `SEND_CONFIRMED`              | `1361`    | dev 当前日志 all.log   | Easy/企微发送成功回写；该 batch 同时带会话最后发送状态刷新。           |
| `MESSAGE_UPSERT`         | `SEND_FAILED`                 | `1249`    | dev 当前日志 all.log   | 发送失败回写；该 batch 同时带会话最后发送状态刷新。                    |
| `MESSAGE_UPSERT`         | `CUSTOMER_MESSAGE_RECEIVED`   | `1357`    | dev 当前日志 all.log   | Easy 入站客户消息。                                                    |
| `MESSAGE_UPSERT`         | `MESSAGE_REVOKED`             | `1351`    | dev 当前日志 all.log   | Easy 撤回消息状态事件。                                                |
| `MESSAGE_UPSERT`         | `MESSAGE_DELETED`             | 无        | 未生成真实 payload     | 当前业务没有可达触发入口，云端当前日志和滚动日志均没有真实 payload。   |
| `MESSAGE_UPSERT`         | `ATTACHMENT_TRANSFER_CHANGED` | `1334`    | dev 当前日志 all.log   | 附件转存完成后的消息覆盖通知。                                         |
| `SESSION_SUMMARY_UPSERT` | `SUMMARY_CREATED`             | `1339`    | dev 当前日志 all.log   | 新好友首次产生会话摘要；该 batch 同时包含发送 pending 消息。           |
| `SESSION_SUMMARY_UPSERT` | `LAST_MESSAGE_CHANGED`        | `1359`    | dev 当前日志 all.log   | 最近会话最后一条消息变化；该 batch 同时包含消息 pending。              |
| `SESSION_SUMMARY_UPSERT` | `LAST_SEND_STATUS_CHANGED`    | `1361`    | dev 当前日志 all.log   | 最近会话最后一条员工发送状态变化；该 batch 同时包含发送成功/失败消息。 |
| `SESSION_SUMMARY_UPSERT` | `UNREAD_CHANGED`              | `1350`    | dev 当前日志 all.log   | 入站消息导致未读数变化。                                               |
| `SESSION_SUMMARY_UPSERT` | `MARK_READ`                   | `1344`    | dev 当前日志 all.log   | 客户端已读上报后会话未读清零。                                         |
| `FRIEND_UPSERT`          | `FRIEND_CREATED`              | `1346`    | dev 当前日志 all.log   | 外部联系人好友关系新增。                                               |
| `FRIEND_UPSERT`          | `DETAIL_REFRESHED`            | `1347`    | dev 当前日志 all.log   | 外部联系人基础资料刷新。                                               |
| `FRIEND_UPSERT`          | `FOLLOW_INFO_CHANGED`         | `1348`    | dev 当前日志 all.log   | 外部联系人跟进信息刷新。                                               |
| `FRIEND_UPSERT`          | `TAGS_CHANGED`                | `1349`    | dev 当前日志 all.log   | 外部联系人标签刷新。                                                   |
| `FRIEND_UPSERT`          | `FRIEND_DELETED`              | `1297`    | dev 当前日志 all.log   | 外部联系人好友关系删除。                                               |
| `ACCOUNT_BINDING_CHANGE` | `ACCOUNT_ADDED`               | `23`      | dev 滚动日志 all.\*.gz | 管理端保存配置新增可管理企微账号；取自 dev 滚动日志真实配置变更。      |
| `ACCOUNT_BINDING_CHANGE` | `ACCOUNT_DISABLED`            | `95`      | dev 滚动日志 all.\*.gz | 管理端保存配置移除可管理企微账号；取自 dev 滚动日志真实配置变更。      |
| `ACCOUNT_BINDING_CHANGE` | `CONFIG_ENABLED`              | `94`      | dev 滚动日志 all.\*.gz | 管理端启用聚合配置；取自 dev 滚动日志真实配置变更。                    |
| `ACCOUNT_BINDING_CHANGE` | `CONFIG_DISABLED`             | `92`      | dev 滚动日志 all.\*.gz | 管理端禁用聚合配置；取自 dev 滚动日志真实配置变更。                    |
| `ACCOUNT_STATUS_CHANGE`  | `EASY_STATUS_CALLBACK`        | `1356`    | dev 当前日志 all.log   | Easy 账号状态回调。                                                    |
| `CONNECTION_FORCE_CLOSE` | `EXCLUSIVE_LOGIN`             | `1362`    | dev 当前日志 all.log   | 排他登录强制旧连接下线。                                               |
| `CONNECTION_FORCE_CLOSE` | `EMPLOYEE_DISABLED`           | `1363`    | dev 当前日志 all.log   | 2026-06-02 在 dev 通过 forceClose RPC 补跑生成。                       |
| `CONNECTION_FORCE_CLOSE` | `CONFIG_DISABLED`             | `1299`    | dev 当前日志 all.log   | 配置禁用强制连接下线。                                                 |
| `CONNECTION_FORCE_CLOSE` | `ACCESS_REVOKED`              | `1364`    | dev 当前日志 all.log   | 2026-06-02 在 dev 通过 forceClose RPC 补跑生成。                       |
| `CONNECTION_FORCE_CLOSE` | `TOKEN_RECHECK_FAILED`        | `1365`    | dev 当前日志 all.log   | 2026-06-02 在 dev 通过 forceClose RPC 补跑生成。                       |

## MESSAGE_UPSERT

### `SEND_PENDING_CREATED`

员工侧发送消息创建 pending 气泡；该 batch 同时带会话最后消息刷新。

来源：dev 当前日志 all.log，`notifySeq=1360`，`eventCount=2`。

```bash
cat > /tmp/notify-push-message-upsert-send-pending-created.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1360,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1360","batchTime":"2026-06-02 16:55:20","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1360","events":[{"eventReason":"SEND_PENDING_CREATED","eventType":"MESSAGE_UPSERT","message":{"attachments":[{"attachmentType":3,"conversationId":2060260503288029184,"durationSeconds":12,"fileName":"130857_5475baf3.amr","fileSize":18566,"fileSuffix":"amr","id":118,"isDeleted":0,"localMessageId":"2061733392617046016","ossFilePath":"t/dev/wechat-business-app/2026/06/02/130857_5475baf3.amr","shardNo":58,"transferStatus":2}],"chatMessageType":4,"conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"LOCAL_SEND:v1:GuoHeZuZi:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg:codex-dev-voice-env-amr-20260602165518986","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"localMessageId":"2061733392617046016","localPendingSeq":1780390520611,"messageDirection":1,"messageStatus":0,"messageTime":"2026-06-02T16:55:20.611","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","requestMessageId":"codex-dev-voice-env-amr-20260602165518986","sendStatus":2,"sequenceSource":"LOCAL_PENDING","shardNo":58,"sortKey":"1780390520611_00000000000000000000_2061733392617046016","wecomAccountId":"GuoHeZuZi"}},{"eventReason":"LAST_SEND_STATUS_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2060260503288029184,"externalAvatar":"http://wx.qlogo.cn/mmhead/UGrobmT8GcIiczeewHQhyeXibhUQuArGz71nnYnr4GdsXsD9yscYd1oVicvsEq89OlCmQJJqoyYa8o/0","externalMobile":"","externalName":"早.","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"lastLocalMessageId":"2061733392617046016","lastMessageDirection":1,"lastMessageSummary":"[语音]","lastMessageTime":"2026-06-02T16:55:20.611","lastMessageType":4,"lastSendStatus":2,"lastSortKey":"1780390520611_00000000000000000000_2061733392617046016","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":0,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-message-upsert-send-pending-created.json
```

### `SEND_CONFIRMED`

Easy/企微发送成功回写；该 batch 同时带会话最后发送状态刷新。

来源：dev 当前日志 all.log，`notifySeq=1361`，`eventCount=2`。

```bash
cat > /tmp/notify-push-message-upsert-send-confirmed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1361,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1361","batchTime":"2026-06-02 16:55:21","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1361","events":[{"eventReason":"SEND_CONFIRMED","eventType":"MESSAGE_UPSERT","message":{"attachments":[{"attachmentType":3,"conversationId":2060260503288029184,"durationSeconds":12,"fileName":"130857_5475baf3.amr","fileSize":18566,"fileSuffix":"amr","id":118,"isDeleted":0,"localMessageId":"2061733392617046016","ossFilePath":"t/dev/wechat-business-app/2026/06/02/130857_5475baf3.amr","shardNo":58,"transferStatus":2}],"chatMessageType":4,"conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"LOCAL_SEND:v1:GuoHeZuZi:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg:codex-dev-voice-env-amr-20260602165518986","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"localMessageId":"2061733392617046016","localPendingSeq":1780390520611,"messageDirection":1,"messageStatus":0,"messageTime":"2026-06-02T16:55:19","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","platformMessageId":"CAQQ9rT60AYY2LrY1ZKAgAMgoM3n+Qk=","platformSeq":11975156,"requestMessageId":"codex-dev-voice-env-amr-20260602165518986","sendStatus":3,"sequenceSource":"LOCAL_PENDING","shardNo":58,"sortKey":"1780390519000_00000000000011975156_2061733392617046016","wecomAccountId":"GuoHeZuZi"}},{"eventReason":"LAST_SEND_STATUS_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2060260503288029184,"externalAvatar":"http://wx.qlogo.cn/mmhead/UGrobmT8GcIiczeewHQhyeXibhUQuArGz71nnYnr4GdsXsD9yscYd1oVicvsEq89OlCmQJJqoyYa8o/0","externalMobile":"","externalName":"早.","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"lastLocalMessageId":"2061733392617046016","lastMessageDirection":1,"lastMessageSummary":"[语音]","lastMessageTime":"2026-06-02T16:55:19","lastMessageType":4,"lastSendStatus":3,"lastSortKey":"1780390519000_00000000000011975156_2061733392617046016","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":0,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-message-upsert-send-confirmed.json
```

### `SEND_FAILED`

发送失败回写；该 batch 同时带会话最后发送状态刷新。

来源：dev 当前日志 all.log，`notifySeq=1249`，`eventCount=2`。

```bash
cat > /tmp/notify-push-message-upsert-send-failed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1249,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1249","batchTime":"2026-06-02 12:37:08","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1249","events":[{"eventReason":"SEND_FAILED","eventType":"MESSAGE_UPSERT","message":{"attachments":[],"chatMessageType":1,"contentText":"dev notify failed codex-dev-ntc-fail-20260602123706511","conversationId":2059874973899558912,"createOperatorId":1674614956223361024,"dedupKey":"LOCAL_SEND:v1:18037286184:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg:codex-dev-ntc-fail-20260602123706511","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","failReason":"MAPPING_NOT_FOUND:2:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"localMessageId":"2061668414664998912","localPendingSeq":1780375028660,"messageDirection":1,"messageStatus":0,"messageTime":"2026-06-02T12:37:08.660","modifyOperatorId":1674614956223361024,"platformAccountId":"","platformCode":"EASY","requestMessageId":"codex-dev-ntc-fail-20260602123706511","sendStatus":4,"sequenceSource":"LOCAL_PENDING","shardNo":34,"sortKey":"1780375028660_00000000000000000000_2061668414664998912","wecomAccountId":"18037286184"}},{"eventReason":"LAST_SEND_STATUS_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2059874973899558912,"externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"lastLocalMessageId":"2061668414664998912","lastMessageDirection":1,"lastMessageSummary":"dev notify failed codex-dev-ntc-fail-20260602123706511","lastMessageTime":"2026-06-02T12:37:08.660","lastMessageType":1,"lastSendStatus":4,"lastSortKey":"1780375028660_00000000000000000000_2061668414664998912","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":0,"wecomAccount":"18037286184","wecomAccountId":"18037286184","wecomAlias":"12312312323","wecomName":"123123123"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-message-upsert-send-failed.json
```

### `CUSTOMER_MESSAGE_RECEIVED`

Easy 入站客户消息。

来源：dev 当前日志 all.log，`notifySeq=1357`，`eventCount=1`。

```bash
cat > /tmp/notify-push-message-upsert-customer-message-received.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1357,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1357","batchTime":"2026-06-02 16:35:11","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1357","events":[{"eventReason":"CUSTOMER_MESSAGE_RECEIVED","eventType":"MESSAGE_UPSERT","message":{"attachments":[{"attachmentType":4,"conversationId":2060260503288029184,"durationSeconds":5,"fileMd5":"publicvideo20260602163458816","fileName":"public-video-20260602163458816.mp4","fileSize":319044,"gmtCreatedTime":"2026-06-02T16:35:06","gmtModifiedTime":"2026-06-02T16:35:09","id":117,"isDeleted":0,"localMessageId":"2061728305425416192","messageId":0,"ossFilePath":"t/dev/wechat-business-app/wecom/chat/2026/06/02/163511_93184281.mp4","ossPreviewFilePath":"https://filet.jdd51.com/t/dev/wechat-business-app/wecom/chat/2026/06/02/163511_93184281.mp4","platformFileUrl":"https://www.w3school.com.cn/example/html5/mov_bbb.mp4","shardNo":58,"transferStatus":2}],"chatMessageType":6,"conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"EASY#3B8E1408-2647-49AD-A3E7-B86FC4585807#codex-dev-public-video-20260602163458816","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","gmtCreatedTime":"2026-06-02T16:35:06","gmtModifiedTime":"2026-06-02T16:35:06","id":307,"isDeleted":0,"localMessageId":"2061728305425416192","messageDirection":2,"messageStatus":0,"messageTime":"2026-06-02T16:34:59","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","platformMessageId":"codex-dev-public-video-20260602163458816","platformSeq":1780389298822,"rawEventId":2,"sendStatus":0,"sequenceSource":"EASY_CALLBACK","shardNo":58,"sortKey":"1780389298822_00000001780389298822_2061728305425416192","wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-message-upsert-customer-message-received.json
```

### `MESSAGE_REVOKED`

Easy 撤回消息状态事件。

来源：dev 当前日志 all.log，`notifySeq=1351`，`eventCount=1`。

```bash
cat > /tmp/notify-push-message-upsert-message-revoked.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1351,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1351","batchTime":"2026-06-02 16:35:02","sourceApp":"wechat-business-app","traceId":"e9f1c339181a45b989b392ea618c02c4","events":[{"eventReason":"MESSAGE_REVOKED","eventType":"MESSAGE_UPSERT","message":{"chatMessageType":1,"contentText":"public callback text 20260602163458816","conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"EASY#3B8E1408-2647-49AD-A3E7-B86FC4585807#codex-dev-public-text-20260602163458816","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","gmtCreatedTime":"2026-06-02T16:34:59","gmtModifiedTime":"2026-06-02T16:34:59","id":302,"isDeleted":0,"localMessageId":"2061728278200188928","messageDirection":2,"messageStatus":0,"messageTime":"2026-06-02T16:34:59","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","platformMessageId":"codex-dev-public-text-20260602163458816","platformSeq":1780389298816,"rawEventId":1,"sendStatus":0,"sequenceSource":"EASY_CALLBACK","shardNo":58,"sortKey":"1780389298816_00000001780389298816_2061728278200188928","wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-message-upsert-message-revoked.json
```

### `MESSAGE_DELETED`

当前业务没有可达触发入口，云端当前日志和滚动日志均没有真实 payload。

当前没有可请求通过的真实 curl：云端当前日志、滚动日志均未发现该 reason 的 `payload_json`；当前业务入口只可达撤回语义 `MESSAGE_REVOKED`，不提供手写伪 payload。后续若产品确认删除语义并补业务入口，再通过真实业务链路补充。

### `ATTACHMENT_TRANSFER_CHANGED`

附件转存完成后的消息覆盖通知。

来源：dev 当前日志 all.log，`notifySeq=1334`，`eventCount=1`。

```bash
cat > /tmp/notify-push-message-upsert-attachment-transfer-changed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1334,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1334","batchTime":"2026-06-02 16:20:24","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1334","events":[{"eventReason":"ATTACHMENT_TRANSFER_CHANGED","eventType":"MESSAGE_UPSERT","message":{"attachments":[{"attachmentType":2,"conversationId":2060260503288029184,"fileMd5":"codex-dev-att-slowfile-md5-20260602162020034","fileName":"codex-dev-att-slowfile-20260602162020034.bin","fileSize":3000000,"fileSuffix":"bin","gmtCreatedTime":"2026-06-02T16:20:18","gmtModifiedTime":"2026-06-02T16:20:22","id":111,"isDeleted":0,"localMessageId":"2061724582376636416","messageId":0,"ossFilePath":"t/dev/wechat-business-app/wecom/chat/2026/06/02/162024_f8c575f2.bin","ossPreviewFilePath":"https://filet.jdd51.com/t/dev/wechat-business-app/wecom/chat/2026/06/02/162024_f8c575f2.bin","platformFileAesKey":"codex-dev-att-slowfile-aes-20260602162020034","platformFileId":"easy-file-slow-20260602162020034","platformFileUrl":"https://speed.cloudflare.com/__down?bytes=3000000","shardNo":58,"transferStatus":2}],"chatMessageType":3,"conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"EASY#3B8E1408-2647-49AD-A3E7-B86FC4585807#codex-dev-att-slowfile-20260602162020034","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","gmtCreatedTime":"2026-06-02T16:20:18","gmtModifiedTime":"2026-06-02T16:20:18","id":300,"isDeleted":0,"localMessageId":"2061724582376636416","messageDirection":2,"messageStatus":0,"messageTime":"2026-06-02T16:20:20","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","platformMessageId":"codex-dev-att-slowfile-20260602162020034","platformSeq":1780388420035,"rawEventId":2,"sendStatus":0,"sequenceSource":"EASY_CALLBACK","shardNo":58,"sortKey":"1780388420035_00000001780388420035_2061724582376636416","wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-message-upsert-attachment-transfer-changed.json
```

## SESSION_SUMMARY_UPSERT

### `SUMMARY_CREATED`

新好友首次产生会话摘要；该 batch 同时包含发送 pending 消息。

来源：dev 当前日志 all.log，`notifySeq=1339`，`eventCount=2`。

```bash
cat > /tmp/notify-push-session-summary-upsert-summary-created.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1339,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1339","batchTime":"2026-06-02 16:28:28","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1339","events":[{"eventReason":"SEND_PENDING_CREATED","eventType":"MESSAGE_UPSERT","message":{"attachments":[],"chatMessageType":1,"contentText":"dev SUMMARY_CREATED new contact 20260602162826713","conversationId":2061726528261062656,"createOperatorId":1674614956223361024,"dedupKey":"LOCAL_SEND:v1:GuoHeZuZi:wmITqmBgAA-cQjvngUuQbscbfyj0nOuA:codex-dev-newfriend-send-20260602162826713","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","isDeleted":0,"localMessageId":"2061726630295896064","localPendingSeq":1780388908348,"messageDirection":1,"messageStatus":0,"messageTime":"2026-06-02T16:28:28.348","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","requestMessageId":"codex-dev-newfriend-send-20260602162826713","sendStatus":1,"sequenceSource":"LOCAL_PENDING","shardNo":20,"sortKey":"1780388908348_00000000000000000000_2061726630295896064","wecomAccountId":"GuoHeZuZi"}},{"eventReason":"SUMMARY_CREATED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2061726528261062656,"externalAvatar":"http://wx.qlogo.cn/mmhead/rLpHsVF9HCXTmX2rEx1TdGGXX5uEOVGjkHtJiccwXh9UpJgM4Cng9oA3icqEGULLXCVhASPGabd1g/0","externalMobile":"","externalName":"生椰拿铁","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","isDeleted":0,"lastLocalMessageId":"2061726630295896064","lastMessageDirection":1,"lastMessageSummary":"dev SUMMARY_CREATED new contact 20260602162826713","lastMessageTime":"2026-06-02T16:28:28.348","lastMessageType":1,"lastSendStatus":1,"lastSortKey":"1780388908348_00000000000000000000_2061726630295896064","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":0,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-session-summary-upsert-summary-created.json
```

### `LAST_MESSAGE_CHANGED`

最近会话最后一条消息变化；该 batch 同时包含消息 pending。

来源：dev 当前日志 all.log，`notifySeq=1359`，`eventCount=2`。

```bash
cat > /tmp/notify-push-session-summary-upsert-last-message-changed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1359,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1359","batchTime":"2026-06-02 16:55:20","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1359","events":[{"eventReason":"SEND_PENDING_CREATED","eventType":"MESSAGE_UPSERT","message":{"attachments":[{"attachmentType":3,"conversationId":2060260503288029184,"durationSeconds":12,"fileName":"130857_5475baf3.amr","fileSize":18566,"fileSuffix":"amr","id":118,"isDeleted":0,"localMessageId":"2061733392617046016","ossFilePath":"t/dev/wechat-business-app/2026/06/02/130857_5475baf3.amr","shardNo":58,"transferStatus":2}],"chatMessageType":4,"conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"LOCAL_SEND:v1:GuoHeZuZi:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg:codex-dev-voice-env-amr-20260602165518986","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"localMessageId":"2061733392617046016","localPendingSeq":1780390520611,"messageDirection":1,"messageStatus":0,"messageTime":"2026-06-02T16:55:20.611","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","requestMessageId":"codex-dev-voice-env-amr-20260602165518986","sendStatus":1,"sequenceSource":"LOCAL_PENDING","shardNo":58,"sortKey":"1780390520611_00000000000000000000_2061733392617046016","wecomAccountId":"GuoHeZuZi"}},{"eventReason":"LAST_MESSAGE_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2060260503288029184,"externalAvatar":"http://wx.qlogo.cn/mmhead/UGrobmT8GcIiczeewHQhyeXibhUQuArGz71nnYnr4GdsXsD9yscYd1oVicvsEq89OlCmQJJqoyYa8o/0","externalMobile":"","externalName":"早.","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"lastLocalMessageId":"2061733392617046016","lastMessageDirection":1,"lastMessageSummary":"[语音]","lastMessageTime":"2026-06-02T16:55:20.611","lastMessageType":4,"lastSendStatus":1,"lastSortKey":"1780390520611_00000000000000000000_2061733392617046016","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":0,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-session-summary-upsert-last-message-changed.json
```

### `LAST_SEND_STATUS_CHANGED`

最近会话最后一条员工发送状态变化；该 batch 同时包含发送成功/失败消息。

来源：dev 当前日志 all.log，`notifySeq=1361`，`eventCount=2`。

```bash
cat > /tmp/notify-push-session-summary-upsert-last-send-status-changed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1361,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1361","batchTime":"2026-06-02 16:55:21","sourceApp":"wechat-business-app","traceId":"outbox:rh_wxchat:1674614956223361024:1361","events":[{"eventReason":"SEND_CONFIRMED","eventType":"MESSAGE_UPSERT","message":{"attachments":[{"attachmentType":3,"conversationId":2060260503288029184,"durationSeconds":12,"fileName":"130857_5475baf3.amr","fileSize":18566,"fileSuffix":"amr","id":118,"isDeleted":0,"localMessageId":"2061733392617046016","ossFilePath":"t/dev/wechat-business-app/2026/06/02/130857_5475baf3.amr","shardNo":58,"transferStatus":2}],"chatMessageType":4,"conversationId":2060260503288029184,"createOperatorId":1674614956223361024,"dedupKey":"LOCAL_SEND:v1:GuoHeZuZi:wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg:codex-dev-voice-env-amr-20260602165518986","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"localMessageId":"2061733392617046016","localPendingSeq":1780390520611,"messageDirection":1,"messageStatus":0,"messageTime":"2026-06-02T16:55:19","modifyOperatorId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","platformMessageId":"CAQQ9rT60AYY2LrY1ZKAgAMgoM3n+Qk=","platformSeq":11975156,"requestMessageId":"codex-dev-voice-env-amr-20260602165518986","sendStatus":3,"sequenceSource":"LOCAL_PENDING","shardNo":58,"sortKey":"1780390519000_00000000000011975156_2061733392617046016","wecomAccountId":"GuoHeZuZi"}},{"eventReason":"LAST_SEND_STATUS_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2060260503288029184,"externalAvatar":"http://wx.qlogo.cn/mmhead/UGrobmT8GcIiczeewHQhyeXibhUQuArGz71nnYnr4GdsXsD9yscYd1oVicvsEq89OlCmQJJqoyYa8o/0","externalMobile":"","externalName":"早.","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"lastLocalMessageId":"2061733392617046016","lastMessageDirection":1,"lastMessageSummary":"[语音]","lastMessageTime":"2026-06-02T16:55:19","lastMessageType":4,"lastSendStatus":3,"lastSortKey":"1780390519000_00000000000011975156_2061733392617046016","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":0,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-session-summary-upsert-last-send-status-changed.json
```

### `UNREAD_CHANGED`

入站消息导致未读数变化。

来源：dev 当前日志 all.log，`notifySeq=1350`，`eventCount=3`。

```bash
cat > /tmp/notify-push-session-summary-upsert-unread-changed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1350,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1350","batchTime":"2026-06-02 16:35:01","sourceApp":"wechat-business-app","traceId":"d3242269391543d99b2b27ebbcb2e1e1","events":[{"eventReason":"CUSTOMER_MESSAGE_RECEIVED","eventType":"MESSAGE_UPSERT","message":{"attachments":[],"callbackEventTableMonth":"202606","contentJson":"{\"senderId\":\"7881302491971218\",\"msgType\":0,\"receiverId\":\"1688854871809368\",\"fromRoomId\":\"0\",\"guid\":\"3B8E1408-2647-49AD-A3E7-B86FC4585807\",\"cmd\":15000,\"msgData\":{\"content\":\"public callback text 20260602163458816\"},\"msgUniqueIdentifier\":\"codex-dev-public-text-20260602163458816\",\"seq\":1780389298816,\"timestamp\":1780389298816,\"direction\":2}","contentText":"public callback text 20260602163458816","conversationId":2060260503288029184,"dedupKey":"EASY#3B8E1408-2647-49AD-A3E7-B86FC4585807#codex-dev-public-text-20260602163458816","eventShardNo":0,"externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","localMessageId":"2061728278200188928","messageDirection":2,"messageStatus":0,"messageTimeMillis":1780389298816,"messageType":1,"ownerEmployeeId":1674614956223361024,"platformAccountId":"3B8E1408-2647-49AD-A3E7-B86FC4585807","platformCode":"EASY","platformEventType":"15000","platformMessageId":"codex-dev-public-text-20260602163458816","platformReceiverId":"1688854871809368","platformSenderId":"7881302491971218","platformSeq":1780389298816,"rawEventId":1,"sendStatus":0,"sortKey":"1780389298816_00000001780389298816_2061728278200188928","traceId":"d3242269391543d99b2b27ebbcb2e1e1","wecomAccountId":"GuoHeZuZi"}},{"eventReason":"LAST_MESSAGE_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":2060260503288029184,"externalAvatar":"http://wx.qlogo.cn/mmhead/UGrobmT8GcIiczeewHQhyeXibhUQuArGz71nnYnr4GdsXsD9yscYd1oVicvsEq89OlCmQJJqoyYa8o/0","externalMobile":"","externalName":"早.","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","isDeleted":0,"lastLocalMessageId":"2061728278200188928","lastMessageDirection":2,"lastMessageSummary":"public callback text 20260602163458816","lastMessageTime":"2026-06-02T16:34:58.816","lastMessageType":1,"lastSendStatus":0,"lastSortKey":"1780389298816_00000001780389298816_2061728278200188928","ownerEmployeeId":1674614956223361024,"ownerShardNo":0,"summaryStatus":1,"unreadCount":1,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}},{"eventReason":"UNREAD_CHANGED","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"$ref":"$.events[1].sessionSummary"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-session-summary-upsert-unread-changed.json
```

### `MARK_READ`

客户端已读上报后会话未读清零。

来源：dev 当前日志 all.log，`notifySeq=1344`，`eventCount=1`。

```bash
cat > /tmp/notify-push-session-summary-upsert-mark-read.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1344,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1344","batchTime":"2026-06-02 16:30:35","sourceApp":"wechat-business-app","traceId":"markRead:1674614956223361024:2061726528261062656","events":[{"eventReason":"MARK_READ","eventType":"SESSION_SUMMARY_UPSERT","sessionSummary":{"conversationId":"2061726528261062656","externalAvatar":"http://wx.qlogo.cn/mmhead/rLpHsVF9HCXTmX2rEx1TdGGXX5uEOVGjkHtJiccwXh9UpJgM4Cng9oA3icqEGULLXCVhASPGabd1g/0","externalMobile":"","externalName":"生椰拿铁","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","gmtModifiedTime":"2026-06-02 16:30:10","hasUnread":false,"lastLocalMessageId":"2061727067619196928","lastMessageDirection":2,"lastMessageSortKey":"1780389010559_00000001780389010559_2061727067619196928","lastMessageSummary":"dev newfriend inbound unread 20260602163010559","lastMessageTime":"2026-06-02 16:30:11","lastMessageType":1,"lastSendStatus":0,"unreadCount":0,"wecomAccount":"GuoHeZuZi","wecomAccountId":"GuoHeZuZi","wecomAlias":"","wecomName":"过河卒子"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-session-summary-upsert-mark-read.json
```

## FRIEND_UPSERT

### `FRIEND_CREATED`

外部联系人好友关系新增。

来源：dev 当前日志 all.log，`notifySeq=1346`，`eventCount=1`。

```bash
cat > /tmp/notify-push-friend-upsert-friend-created.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1346,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1346","batchTime":"2026-06-02 16:32:05","sourceApp":"wechat-business-app","traceId":"friendChanged:codex-dev-newfriend-friend-created-20260602163203151","events":[{"eventReason":"FRIEND_CREATED","eventType":"FRIEND_UPSERT","friend":{"changedFields":["relation"],"deleted":false,"eventTime":"2026-06-02 16:32:01","externalAvatar":"http://wx.qlogo.cn/mmhead/rLpHsVF9HCXTmX2rEx1TdGGXX5uEOVGjkHtJiccwXh9UpJgM4Cng9oA3icqEGULLXCVhASPGabd1g/0","externalMobile":"","externalName":"生椰拿铁","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","followDescription":"","followRemark":"俊涛","remarkMobiles":[],"tags":[],"wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-friend-upsert-friend-created.json
```

### `DETAIL_REFRESHED`

外部联系人基础资料刷新。

来源：dev 当前日志 all.log，`notifySeq=1347`，`eventCount=1`。

```bash
cat > /tmp/notify-push-friend-upsert-detail-refreshed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1347,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1347","batchTime":"2026-06-02 16:32:05","sourceApp":"wechat-business-app","traceId":"friendChanged:codex-dev-newfriend-friend-profile-20260602163203151","events":[{"eventReason":"DETAIL_REFRESHED","eventType":"FRIEND_UPSERT","friend":{"changedFields":["profile"],"deleted":false,"eventTime":"2026-06-02 16:32:02","externalAvatar":"http://wx.qlogo.cn/mmhead/rLpHsVF9HCXTmX2rEx1TdGGXX5uEOVGjkHtJiccwXh9UpJgM4Cng9oA3icqEGULLXCVhASPGabd1g/0","externalMobile":"","externalName":"生椰拿铁","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","followDescription":"","followRemark":"俊涛","remarkMobiles":[],"tags":[],"wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-friend-upsert-detail-refreshed.json
```

### `FOLLOW_INFO_CHANGED`

外部联系人跟进信息刷新。

来源：dev 当前日志 all.log，`notifySeq=1348`，`eventCount=1`。

```bash
cat > /tmp/notify-push-friend-upsert-follow-info-changed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1348,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1348","batchTime":"2026-06-02 16:32:05","sourceApp":"wechat-business-app","traceId":"friendChanged:codex-dev-newfriend-friend-follow-20260602163203151","events":[{"eventReason":"FOLLOW_INFO_CHANGED","eventType":"FRIEND_UPSERT","friend":{"changedFields":["follow"],"deleted":false,"eventTime":"2026-06-02 16:32:03","externalAvatar":"http://wx.qlogo.cn/mmhead/rLpHsVF9HCXTmX2rEx1TdGGXX5uEOVGjkHtJiccwXh9UpJgM4Cng9oA3icqEGULLXCVhASPGabd1g/0","externalMobile":"","externalName":"生椰拿铁","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","followDescription":"","followRemark":"俊涛","remarkMobiles":[],"tags":[],"wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-friend-upsert-follow-info-changed.json
```

### `TAGS_CHANGED`

外部联系人标签刷新。

来源：dev 当前日志 all.log，`notifySeq=1349`，`eventCount=1`。

```bash
cat > /tmp/notify-push-friend-upsert-tags-changed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1349,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1349","batchTime":"2026-06-02 16:32:05","sourceApp":"wechat-business-app","traceId":"friendChanged:codex-dev-newfriend-friend-tags-20260602163203151","events":[{"eventReason":"TAGS_CHANGED","eventType":"FRIEND_UPSERT","friend":{"changedFields":["tags"],"deleted":false,"eventTime":"2026-06-02 16:32:04","externalAvatar":"http://wx.qlogo.cn/mmhead/rLpHsVF9HCXTmX2rEx1TdGGXX5uEOVGjkHtJiccwXh9UpJgM4Cng9oA3icqEGULLXCVhASPGabd1g/0","externalMobile":"","externalName":"生椰拿铁","externalUserId":"wmITqmBgAA-cQjvngUuQbscbfyj0nOuA","followDescription":"","followRemark":"俊涛","remarkMobiles":[],"tags":[],"wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-friend-upsert-tags-changed.json
```

### `FRIEND_DELETED`

外部联系人好友关系删除。

来源：dev 当前日志 all.log，`notifySeq=1297`，`eventCount=1`。

```bash
cat > /tmp/notify-push-friend-upsert-friend-deleted.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1297,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1297","batchTime":"2026-06-02 15:11:12","sourceApp":"wechat-business-app","traceId":"friendChanged:codex-dev-ret-friend-deleted-20260602151108685","events":[{"eventReason":"FRIEND_DELETED","eventType":"FRIEND_UPSERT","friend":{"changedFields":["relation"],"deleted":true,"eventTime":"2026-06-02 15:10:34","externalUserId":"wmITqmBgAAZg4SntYu9tFAcrFp1GZrKg","remarkMobiles":[],"tags":[],"wecomAccountId":"GuoHeZuZi"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-friend-upsert-friend-deleted.json
```

## ACCOUNT_BINDING_CHANGE

### `ACCOUNT_ADDED`

管理端保存配置新增可管理企微账号；取自 dev 滚动日志真实配置变更。

来源：dev 滚动日志 all.\*.gz，`notifySeq=23`，`eventCount=1`。

```bash
cat > /tmp/notify-push-account-binding-change-account-added.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":23,"clientId":"rh_wxchat","employeeId":2046043266615037952,"batchId":"rh_wxchat:2046043266615037952:23","batchTime":"2026-05-30 14:51:17","sourceApp":"wechat-business-app","traceId":"accountBinding:5:ACCOUNT_ADDED","events":[{"accountBinding":{"changedAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"","wecomName":"梁垒"}],"changedTime":"2026-05-30 14:51:17","configId":5,"configStatus":1,"employeeId":2046043266615037952,"manageableAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"栗露苹","wecomAccountId":"18836123521","wecomAlias":"栗露苹","wecomName":"栗露苹"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"19139966119","wecomAccountId":"19139966119","wecomAlias":"19139966119","wecomName":"19139966119"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"张文博","wecomAccountId":"zhangwenbo","wecomAlias":"文博","wecomName":"张文博"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"胡婷婷","wecomAccountId":"18239970726","wecomAlias":"胡婷婷","wecomName":"胡婷婷"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"lianglei","wecomAlias":"梁垒","wecomName":"梁垒"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"","wecomName":"梁垒"}],"reason":"ACCOUNT_ADDED"},"eventReason":"ACCOUNT_ADDED","eventType":"ACCOUNT_BINDING_CHANGE"}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-account-binding-change-account-added.json
```

### `ACCOUNT_DISABLED`

管理端保存配置移除可管理企微账号；取自 dev 滚动日志真实配置变更。

来源：dev 滚动日志 all.\*.gz，`notifySeq=95`，`eventCount=1`。

```bash
cat > /tmp/notify-push-account-binding-change-account-disabled.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":95,"clientId":"rh_wxchat","employeeId":2046043266615037952,"batchId":"rh_wxchat:2046043266615037952:95","batchTime":"2026-05-30 23:03:36","sourceApp":"wechat-business-app","traceId":"accountBinding:5:ACCOUNT_DISABLED","events":[{"accountBinding":{"changedAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"19139966119","wecomAccountId":"19139966119","wecomAlias":"19139966119","wecomName":"19139966119"}],"changedTime":"2026-05-30 23:03:36","configId":5,"configStatus":1,"employeeId":2046043266615037952,"manageableAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"栗露苹","wecomAccountId":"18836123521","wecomAlias":"栗露苹","wecomName":"栗露苹"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"张文博","wecomAccountId":"zhangwenbo","wecomAlias":"文博","wecomName":"张文博"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"胡婷婷","wecomAccountId":"18239970726","wecomAlias":"胡婷婷","wecomName":"胡婷婷"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"lianglei","wecomAlias":"梁垒","wecomName":"梁垒"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"梁垒","wecomName":"梁垒"}],"reason":"ACCOUNT_DISABLED"},"eventReason":"ACCOUNT_DISABLED","eventType":"ACCOUNT_BINDING_CHANGE"}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-account-binding-change-account-disabled.json
```

### `CONFIG_ENABLED`

管理端启用聚合配置；取自 dev 滚动日志真实配置变更。

来源：dev 滚动日志 all.\*.gz，`notifySeq=94`，`eventCount=1`。

```bash
cat > /tmp/notify-push-account-binding-change-config-enabled.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":94,"clientId":"rh_wxchat","employeeId":2046043266615037952,"batchId":"rh_wxchat:2046043266615037952:94","batchTime":"2026-05-30 23:02:33","sourceApp":"wechat-business-app","traceId":"accountBinding:5:CONFIG_ENABLED","events":[{"accountBinding":{"changedAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"栗露苹","wecomAccountId":"18836123521","wecomAlias":"栗露苹","wecomName":"栗露苹"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"19139966119","wecomAccountId":"19139966119","wecomAlias":"19139966119","wecomName":"19139966119"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"张文博","wecomAccountId":"zhangwenbo","wecomAlias":"文博","wecomName":"张文博"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"胡婷婷","wecomAccountId":"18239970726","wecomAlias":"胡婷婷","wecomName":"胡婷婷"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"lianglei","wecomAlias":"梁垒","wecomName":"梁垒"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"","wecomName":"梁垒"}],"changedTime":"2026-05-30 23:02:33","configId":5,"configStatus":1,"employeeId":2046043266615037952,"manageableAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"栗露苹","wecomAccountId":"18836123521","wecomAlias":"栗露苹","wecomName":"栗露苹"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"19139966119","wecomAccountId":"19139966119","wecomAlias":"19139966119","wecomName":"19139966119"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"张文博","wecomAccountId":"zhangwenbo","wecomAlias":"文博","wecomName":"张文博"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"胡婷婷","wecomAccountId":"18239970726","wecomAlias":"胡婷婷","wecomName":"胡婷婷"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"lianglei","wecomAlias":"梁垒","wecomName":"梁垒"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"","wecomName":"梁垒"}],"reason":"CONFIG_ENABLED"},"eventReason":"CONFIG_ENABLED","eventType":"ACCOUNT_BINDING_CHANGE"}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-account-binding-change-config-enabled.json
```

### `CONFIG_DISABLED`

管理端禁用聚合配置；取自 dev 滚动日志真实配置变更。

来源：dev 滚动日志 all.\*.gz，`notifySeq=92`，`eventCount=1`。

```bash
cat > /tmp/notify-push-account-binding-change-config-disabled.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":92,"clientId":"rh_wxchat","employeeId":2046043266615037952,"batchId":"rh_wxchat:2046043266615037952:92","batchTime":"2026-05-30 23:01:20","sourceApp":"wechat-business-app","traceId":"accountBinding:5:CONFIG_DISABLED","events":[{"accountBinding":{"changedAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"栗露苹","wecomAccountId":"18836123521","wecomAlias":"栗露苹","wecomName":"栗露苹"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"19139966119","wecomAccountId":"19139966119","wecomAlias":"19139966119","wecomName":"19139966119"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"张文博","wecomAccountId":"zhangwenbo","wecomAlias":"文博","wecomName":"张文博"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"胡婷婷","wecomAccountId":"18239970726","wecomAlias":"胡婷婷","wecomName":"胡婷婷"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"lianglei","wecomAlias":"梁垒","wecomName":"梁垒"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"","wecomName":"梁垒"}],"changedTime":"2026-05-30 23:01:20","configId":5,"configStatus":0,"employeeId":2046043266615037952,"manageableAccounts":[{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"栗露苹","wecomAccountId":"18836123521","wecomAlias":"栗露苹","wecomName":"栗露苹"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"19139966119","wecomAccountId":"19139966119","wecomAlias":"19139966119","wecomName":"19139966119"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"张文博","wecomAccountId":"zhangwenbo","wecomAlias":"文博","wecomName":"张文博"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccount":"胡婷婷","wecomAccountId":"18239970726","wecomAlias":"胡婷婷","wecomName":"胡婷婷"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"lianglei","wecomAlias":"梁垒","wecomName":"梁垒"},{"bindStatus":1,"ownerEmployeeId":2046043266615037952,"wecomAccountId":"probina","wecomAlias":"","wecomName":"梁垒"}],"reason":"CONFIG_DISABLED"},"eventReason":"CONFIG_DISABLED","eventType":"ACCOUNT_BINDING_CHANGE"}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-account-binding-change-config-disabled.json
```

## ACCOUNT_STATUS_CHANGE

### `EASY_STATUS_CALLBACK`

Easy 账号状态回调。

来源：dev 当前日志 all.log，`notifySeq=1356`，`eventCount=1`。

```bash
cat > /tmp/notify-push-account-status-change-easy-status-callback.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1356,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1356","batchTime":"2026-06-02 16:35:09","sourceApp":"wechat-business-app","traceId":"2a1f8868457c41769f65c409a48a9676","events":[{"accountStatus":{"accountStatus":1,"sendDisabled":false,"statusReason":"public account status 20260602163458816","statusTime":"2026-06-02 16:35:09","wecomAccountId":"GuoHeZuZi"},"eventReason":"EASY_STATUS_CALLBACK","eventType":"ACCOUNT_STATUS_CHANGE"}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-account-status-change-easy-status-callback.json
```

## CONNECTION_FORCE_CLOSE

### `EXCLUSIVE_LOGIN`

排他登录强制旧连接下线。

来源：dev 当前日志 all.log，`notifySeq=1362`，`eventCount=1`。

```bash
cat > /tmp/notify-push-connection-force-close-exclusive-login.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1362,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1362","batchTime":"2026-06-02 16:55:53","sourceApp":"wechat-business-app","traceId":"forceClose:1674614956223361024:EXCLUSIVE_LOGIN","events":[{"eventReason":"EXCLUSIVE_LOGIN","eventType":"CONNECTION_FORCE_CLOSE","forceClose":{"clearLocalToken":true,"closeMode":"IMMEDIATE","closeScope":"EMPLOYEE","closeTime":"2026-06-02 16:55:53","employeeId":1674614956223361024,"previousTerminalId":"","reasonCode":"EXCLUSIVE_LOGIN","reasonMessage":"账号已在其他设备登录","reloginRequired":true,"terminalId":"test_local_001"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-connection-force-close-exclusive-login.json
```

### `EMPLOYEE_DISABLED`

2026-06-02 在 dev 通过 forceClose RPC 补跑生成。

来源：dev 当前日志 all.log，`notifySeq=1363`，`eventCount=1`。

```bash
cat > /tmp/notify-push-connection-force-close-employee-disabled.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1363,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1363","batchTime":"2026-06-02 18:55:35","sourceApp":"wechat-business-app","traceId":"forceClose:1674614956223361024:EMPLOYEE_DISABLED","events":[{"eventReason":"EMPLOYEE_DISABLED","eventType":"CONNECTION_FORCE_CLOSE","forceClose":{"clearLocalToken":true,"closeMode":"IMMEDIATE","closeScope":"EMPLOYEE","closeTime":"2026-06-02 18:55:35","employeeId":1674614956223361024,"previousTerminalId":"","reasonCode":"EMPLOYEE_DISABLED","reasonMessage":"dev curl sample: employee disabled","reloginRequired":true,"terminalId":"codex-doc-force-employee-20260602"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-connection-force-close-employee-disabled.json
```

### `CONFIG_DISABLED`

配置禁用强制连接下线。

来源：dev 当前日志 all.log，`notifySeq=1299`，`eventCount=1`。

```bash
cat > /tmp/notify-push-connection-force-close-config-disabled.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1299,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1299","batchTime":"2026-06-02 15:11:42","sourceApp":"wechat-business-app","traceId":"forceClose:1674614956223361024:CONFIG_DISABLED","events":[{"eventReason":"CONFIG_DISABLED","eventType":"CONNECTION_FORCE_CLOSE","forceClose":{"clearLocalToken":true,"closeMode":"IMMEDIATE","closeScope":"EMPLOYEE","closeTime":"2026-06-02 15:11:42","employeeId":1674614956223361024,"previousTerminalId":"","reasonCode":"CONFIG_DISABLED","reasonMessage":"当前员工企微聚合聊天配置已禁用","reloginRequired":true,"terminalId":"codex-dev-terminal-config-20260602151140158"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-connection-force-close-config-disabled.json
```

### `ACCESS_REVOKED`

2026-06-02 在 dev 通过 forceClose RPC 补跑生成。

来源：dev 当前日志 all.log，`notifySeq=1364`，`eventCount=1`。

```bash
cat > /tmp/notify-push-connection-force-close-access-revoked.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1364,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1364","batchTime":"2026-06-02 18:55:35","sourceApp":"wechat-business-app","traceId":"forceClose:1674614956223361024:ACCESS_REVOKED","events":[{"eventReason":"ACCESS_REVOKED","eventType":"CONNECTION_FORCE_CLOSE","forceClose":{"clearLocalToken":true,"closeMode":"IMMEDIATE","closeScope":"EMPLOYEE","closeTime":"2026-06-02 18:55:35","employeeId":1674614956223361024,"previousTerminalId":"","reasonCode":"ACCESS_REVOKED","reasonMessage":"dev curl sample: access revoked","reloginRequired":true,"terminalId":"codex-doc-force-access-20260602"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-connection-force-close-access-revoked.json
```

### `TOKEN_RECHECK_FAILED`

2026-06-02 在 dev 通过 forceClose RPC 补跑生成。

来源：dev 当前日志 all.log，`notifySeq=1365`，`eventCount=1`。

```bash
cat > /tmp/notify-push-connection-force-close-token-recheck-failed.json <<'JSON'
{"protocolVersion":"1.0","notifySeq":1365,"clientId":"rh_wxchat","employeeId":1674614956223361024,"batchId":"rh_wxchat:1674614956223361024:1365","batchTime":"2026-06-02 18:55:35","sourceApp":"wechat-business-app","traceId":"forceClose:1674614956223361024:TOKEN_RECHECK_FAILED","events":[{"eventReason":"TOKEN_RECHECK_FAILED","eventType":"CONNECTION_FORCE_CLOSE","forceClose":{"clearLocalToken":true,"closeMode":"IMMEDIATE","closeScope":"EMPLOYEE","closeTime":"2026-06-02 18:55:35","employeeId":1674614956223361024,"previousTerminalId":"","reasonCode":"TOKEN_RECHECK_FAILED","reasonMessage":"dev curl sample: token recheck failed","reloginRequired":true,"terminalId":"codex-doc-force-token-20260602"}}]}
JSON

curl -sS -X POST "${WECOM_AGGREGATE_GATEWAY_BASE_URL}/rpc/v1/wecomAggregate/notify/push" \
  -H "Authorization: Bearer ${RELAY_PUSH_SECRET}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/notify-push-connection-force-close-token-recheck-failed.json
```
