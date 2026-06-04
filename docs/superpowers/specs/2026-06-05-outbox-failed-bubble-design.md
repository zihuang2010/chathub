# 出站失败气泡持久化（outbox）设计 v2

日期：2026-06-05
状态：设计 v2（经第一轮 5 维度 fan-out 对抗式验证修订），待用户复核 / 可选第二轮验证 → writing-plans

> v1（仅后端 `send_message` 写、冒号 sort_key）已被 fan-out 推翻：① 上传阶段失败根本不经过 `send_message`；② sort_key 格式整错。v2 改为**前端驱动持久化**并修正全部已知缺陷。

## 背景与问题

乐观气泡（发送中/失败）只活在前端 Zustand `chatStore`（内存），从不入本地库。引发三症状：失败气泡沉底、失败/撤回卡底、重启丢失。根因：失败/在途气泡没有对应的服务端 push，既无持久化路径，也不在权威列表里，于是是 `replaceAuthoritative`（`frontends/components/workbench/messages/store/chatStore.ts:208-313`）里的 leftover，被「单调插入」（278-309）钉进后缀；且消息行的唯一写者是 `MESSAGE_UPSERT` applier（`message_event.rs:78`），本地失败无 push → 无行。

## 方案：前端驱动 outbox（A，全覆盖）

范围：**只做出站发送**。撤回持久化单列。重启后**手动重发**。

### 0. 关键决策（来自 fan-out + 用户拍板）

1. **写入触发点 = 前端 `persist_outbox_failure` IPC**（不是后端 `send_message`）。理由：上传/转码/fail-stop 失败全在前端 markFailed、从不调 `send_message`（`useChatActions.ts:308-314 / 339-343 / 418-420 / 422-428`）；前端是唯一能看到全部失败路径、且手里已有渲染正确的气泡数据（parts/sentAt/replyTo）的地方，顺带绕开 attachments_json 重建难题、ms 与 sentAt 天然同源。
2. **同时修前端 `replaceAuthoritative` 排序**：光持久化救不全——失败行一旦被判 knownAuth 就按已沉底的 priorIndex 冻结（`chatStore.ts:290-309`），存在「先沉底→后发成功收敛→失败行才落库」竞态。
3. 纳入随附硬化：**LRU 保活失败行、recents 一致性、never-uploaded 标不可重发**。

### 1. 身份与数据模型

失败行复用前端乐观气泡 id：

- `local_message_id = client_msg_id`（前端 `clientMsgId`）；`request_message_id = client_msg_id`（与服务端日后回显的 `requestMessageId` 同值，作收敛桥）。
- `send_status = 4`，`message_direction = 2`(out)，`fail_reason` 由前端按失败类型给中文文案（网断/上传失败/转码失败/超限…），不直透内部错误码。
- **`sort_key`（修正）**：`format!("{:013}_{:020}_{}", sent_at_ms, 0, client_msg_id)` —— **下划线三段**、与服务端真实格式同构（段1=13位 epoch-ms、段2=20位零填充 platformSeq（失败态恒 0）、段3=消息 id）。**严禁冒号四段**（冒号 ASCII 58 < 数字，会钉到同毫秒消息上方）；**不在 sort_key 编 direction**（真实格式无此段）。`sent_at_ms` 取乐观气泡 `sentAt` 同源时刻（非写库 now），保证重启前后位置一致。
- `message_time_ms = sent_at_ms`。
- `attachments_json`：由前端**已渲染正确的 parts** 序列化，字段为前端 `HistoryAttachment` 期望的 camelCase（`mediaId`/`fileName`/`fileSize`/`attachmentType`(1图/2文件/3语音/4视频)/`durationSeconds`/`width`/`height`）。纯文本 → `"[]"`。
- **resendability 由 `mediaId` 是否非空派生**（不加 schema 列）：never-uploaded 单元无 objectName → `mediaId=""` → 前端渲染失败气泡时识别为不可重发、点重发提示「请重新选择文件」。

### 2. 写入与数据流

- 前端在**任一** markFailed 处经统一 choke point `failBubble(conversationId, clientMsgId, failReason)`：先 `chatStore.markFailed`，再从 store 读出该气泡完整数据、调 `persist_outbox_failure` IPC。
- 后端 `persist_outbox_failure` 命令：从 session 取 employee_id → `ensure_window` → 构造上述 `MessageRow` → `upsert_messages`（含 §3 去重）→ 写 recents 预览 + 发 RecentSessions ChangeNotice（§5）→ 发 ConversationMessages ChangeNotice 触发前端重读。
- 重读后失败行作为权威条目（id=client_msg_id，`mapSendStatus(4)→"failed"`，`messageHistory.ts:300`）原地替换乐观气泡，且经 §6 前端排序按 sentAt 归位。
- 成功路径（happy path）`send_message` 不动；成功仍由服务端 MESSAGE_UPSERT 落行。

### 3. 收敛去重（防重发后重影）

`upsert_messages`（`messages.rs:76-137`）对每条 **`request_message_id` 非空**的入库行，事务内附带：
`DELETE FROM hub_conversation_messages WHERE employee_id=?e AND request_message_id=?r AND request_message_id<>'' AND local_message_id<>?id`。

- 把同一逻辑消息的 client 键旧失败行塌缩进 server 键新行（重发成功 / 「服务端其实成功」）。
- **必须**带 `request_message_id<>''` 守卫（否则会让全部空 request_message_id 的 inbound 行互删）。
- happy path 无 client 键行 → 命中 0 行无副作用。
- **新增迁移**：`CREATE INDEX idx_hub_msgs_req ON hub_conversation_messages(employee_id, request_message_id) WHERE request_message_id<>'';`（部分索引；否则去重 DELETE 全表扫）。不加 UNIQUE（PENDING/CONFIRMED 短暂同 reqid 共存会冲突）。
- 重发时前端先调 `clear_outbox_row(client_msg_id)` 删本地失败行（让气泡回到纯乐观 sending、贴底），成功后 server 行落库；§3 去重为兜底。

### 4. reconcile 保活（修正批内竞态 + 覆盖空窗）

`reconcile_newest` Replace 分支（`message_sync.rs:251-256`）在 `delete_conversation` 前先保留「未收敛本地 outbox 行」，删后 upsert 回。

- **保活过滤按 `request_message_id NOT IN (本次服务端首页的 request_message_id 集合)`**（不是 `local_message_id NOT IN server ids`）——避免保活行与服务端行同 request_message_id 同批，触发 §3 DELETE 反噬刚落库的权威 server 行。
- 纯本地失败会话服务端首页为空 → `classify_reconcile` 判 NoOp（`message_sync.rs:42`），不删，安全；Replace 仅在「有服务端史 + gap」时发生，保活在此兜底。空 `newest_sort_key` 的 Replace 也走同一保活。
- Stitch（重叠）天然不删，安全。

### 5. recents 一致性

`persist_outbox_failure` 同时把失败消息写进 recents（预览=失败文案、`last_message_sort_key_ms=sent_at_ms`）并发 RecentSessions ChangeNotice，消除「消息页有失败气泡、最近会话列表无此会话/摘要旧」的不一致。注意 `mark_local_sent`「会话不在 recents 则 no-op」（`recent_sessions.rs:590`）——纯新会话需 upsert recents 行（plan 细化）。

### 6. 前端排序修正（replaceAuthoritative）

`status==='failed'` 的条目（无论来自 leftover 还是本轮刚转正的权威失败行）**按 `sentAt` 插入整条时间线**，而非作 knownAuth 冻结在沉底 priorIndex、也非强塞后缀；`status==='sending'`（在途）仍贴底；其余已显示权威保位不抖。实现细节（如何在 `chatStore.ts:290-309` 的 knownAuth/newAuth/mergeByTimeAscending 三段里落这条）留 writing-plans。

### 7. LRU 保活

`trim_conversations`（`messages.rs:371-407`，每次开会话触发 `lib.rs:457`）淘汰整会话时，保留仍含未收敛失败行（`send_status=4 AND request_message_id<>''`）的会话不被整删（或迁出最小窗+失败行）。`clear_for_employee`（用户显式清除）可不保活。

### 8. 不做项 / 已知限制

- 撤回持久化、A2/写前 pending：不做。
- **引用关系（replyTo）失败行不持久化**：`MessageRow` 无 reply 列，失败的引用消息重启后丢引用关系（low，单列后续；如要做需加列+迁移）。
- never-uploaded 失败行**可见但不可重发**（blob 重启即死，UI 标「请重新选择文件」）。
- LRU 整会话淘汰对「已保活仍超界」的极端情况、`clear_for_employee` 仍会带走失败行。

## 测试计划

后端：①`persist_outbox_failure` 写 client 键失败行（id/sort_key 下划线三段格式、status=4、direction=2、attachments_json camelCase）；②`upsert_messages` 按 request_message_id 去重（带 `<>''` 守卫，不误删空 reqid inbound 行）；③Replace-reconcile 保活（按 reqid-not-in-page，含空窗，且不反噬 server 行）；④Stitch 不误删；⑤`trim_conversations` 保活失败行；⑥recents 预览写入 + 新会话 upsert。
前端：①补「还原真实流程 + 两次重读」用例（enqueueOptimistic→markFailed→第一次重读只含后发成功 server 行让失败气泡沉底→第二次重读加入同 id 失败行，断言失败行最终在成功行**之上**、status=failed）——堵 `chatStore.test.ts:333` 漏掉的竞态；②`failBubble` 同时 markFailed + 调 IPC；③never-uploaded（mediaId 空）渲染不可重发。
e2e：`scripts/push_test.py` 造各类本地失败（文本/已传图发送失败/上传失败）→ 重启 → 验证失败气泡仍在、位置正确、可/不可重发符合预期。

## 关键文件锚点

- 前端：`chatStore.ts`（208-313 排序、326-399 actions）、`useChatActions.ts`（228-470 发送/重发/markFailed 五处）、`messageHistory.ts`（258-310 映射）、`data.ts:135`（attachmentKindFromCode）。
- 后端：`message_sync.rs`（387-445 send_message、194-314 reconcile）、`messages.rs`（76-137 upsert、207-246 ensure_window、343-439 删除路径）、`message_event.rs`（78 decode）、`recent_sessions.rs:559`（mark_local_sent）、`backends/src/lib.rs`（send_message 命令 + 新增 IPC）。
- 迁移：现有 `V14`/`V22`，新增 `Vxx` 加 `idx_hub_msgs_req` 部分索引。
