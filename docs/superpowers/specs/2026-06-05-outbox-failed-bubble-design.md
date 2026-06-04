# 出站失败气泡持久化（outbox）设计 v3

日期：2026-06-05
状态：设计 v3（经两轮 fan-out 对抗式验证修订），待 writing-plans

> v1（后端 send_message 写、冒号 sort_key）被一轮 fan-out 推翻。v2 改前端驱动持久化。v3 折入二轮 fan-out 的修正：去重 DELETE 收窄、recents 不碰水位键、前端排序需带锚点稳定插入、IPC 身份通路、attachmentType 映射等。主干（前端驱动 outbox + 前端排序修正 + 去重 + reconcile 保活 + recents 展示列 + LRU 豁免）不变。

## 背景与根因

乐观气泡（发送中/失败）只活内存（Zustand `chatStore`），从不入本地库 → 失败气泡沉底（`replaceAuthoritative` 单调插入把 leftover 钉后缀，`chatStore.ts:208-313`）、卡底、重启丢失。消息行唯一写者是 `MESSAGE_UPSERT` applier（`message_event.rs:78`），本地失败无 push → 无行。

## 方案：前端驱动 outbox（全覆盖）

范围：只做出站发送。撤回单列。重启后**手动重发**。

### 0. 关键决策

1. 写入触发 = 前端 `persist_outbox_failure` IPC（不是后端 send_message）：上传/转码/fail-stop 失败全在前端 markFailed、从不调 send_message（`useChatActions.ts` 各 markFailed 点）；前端是唯一能看到全部失败路径、且手里有渲染正确气泡数据的地方。
2. 同时修前端 `replaceAuthoritative` 排序（光持久化救不全：失败行被判 knownAuth 后冻结在沉底 priorIndex 的竞态）。
3. 硬化：LRU 豁免、recents 一致性、never-uploaded 标不可重发。

### 1. 身份与数据模型（失败行）

- `local_message_id = client_msg_id`；`request_message_id = client_msg_id`（收敛桥）。
- `send_status = 4`；**`message_direction = 2`(out) 必须写列**——新下划线 sort_key 不含 direction 段，`normalize_local_direction_from_sort_key` 按 `:` split 失效后回落 stored 列（`message_sync.rs:116-121`），故方向只能靠列，且测试覆盖。
- **`sort_key`（下划线三段，与服务端同构）**：`format!("{:013}_{:020}_{}", sent_at_ms, 0, client_msg_id)`。段1=13位 epoch-ms、段2=20位零填充（失败态恒 0）、段3=id。严禁冒号格式。`sent_at_ms` 取乐观气泡 `sentAt` **同源**时刻（非写库 now）。
- `message_time_ms = sent_at_ms`（与乐观 sentAt 同源；后端测须断言，保证两次重读位置不跳）。
- `fail_reason`：前端按失败类型给中文文案（markFailed 不带 reason，choke point 补；当前网断/上传失败/超长 3 类**还没文案常量，需补 STRINGS**）。
- **`attachments_json`（由前端 parts 序列化，字段对齐 Rust `HistoryAttachment` camelCase）**：
  - `mediaId` = `entity.filePath`（objectName，**绝不取 part.url**；空 = 不可重发派生）。
  - `attachmentType`：**由 messageType 显式映射**（messageType 2图/3文件/4语音/6视频 → attachmentType 1图/2文件/3语音/4视频，两套编码错位，直接塞会让 readback 分类全错）。
  - `fileType`（扩展名，从 fileName 推）、`fileName`、`fileSize`、`width`/`height`（图片，从 part 取）、`durationSeconds`（取 **top-level `Message.durationSeconds`**，非 part；转码失败 voice 恒空，可接受因不可重发）。
  - 纯文本 → `"[]"`。前端补测须断言产出 JSON 能被 `Vec<HistoryAttachment>` 解析（后端 `unwrap_or_default` 会把解析失败静默吞成 `[]`）。
- **never-uploaded 不可重发**：mediaId 空 → 派生不可重发。**重发路径需显式拦截**——现 resend 用 `filePath ? 附件重发 : 纯文本重发`（`useChatActions.ts:471-483`），空 filePath 会把图当空文本发出；必须按 messageType 区分类型 + 禁用重发 + toast「请重新选择文件」。

### 2. IPC 契约与数据流

`persist_outbox_failure`（前端→后端，camelCase 入参）payload：

- `conversationId`（= `conversation.id` 裸值，非复合 store key）
- `wecomAccountId` / `externalUserId`（**useChatActions 当前拿不到，需新增 props 注入，与 `MessagesPage.handleSendMessage` 同源**——后端 MessageRow 需 wecom_account_id 列）
- `clientMsgId`、`sentAtMs`（取气泡 sentAt）、`messageType`、`contentText`、`failReason`、`attachmentsJson`
- **不传 employeeId**（后端 `current_session()` 取，与 send_message 一致，防串台）

流程：前端任一 markFailed 经统一 choke point `failBubble(chatStoreKey, clientMsgId, failReason, 身份字段)`：先 `markFailed`（即时态）→ 从 store 读气泡 → 调 IPC。后端命令：session 取 employee → `ensure_window` → 构造 MessageRow → `upsert_messages`（§3）→ 写 recents 展示列（§5）→ 发 ConversationMessages ChangeNotice 触发重读。重读后失败行作权威条目（id=client_msg_id，`mapSendStatus(4)→"failed"`）替换乐观气泡，经 §6 排序归位。happy path 不动。

`clear_outbox_row(clientMsgId)`：重发前先调（删本地失败行，气泡回纯乐观 sending）；失败容错（warn 不阻塞）。`DELETE WHERE employee_id=? AND local_message_id=?`。

### 3. 收敛去重（关键修正：DELETE 收窄到失败行）

`upsert_messages`（`messages.rs:76-137`）事务内，对每条 `request_message_id` 非空入库行附带：
`DELETE FROM hub_conversation_messages WHERE employee_id=?e AND request_message_id=?r AND request_message_id<>'' AND send_status=4 AND local_message_id<>?id`。

- **`send_status=4` 守卫是核心修正**：只塌缩「client 键失败行」，**绝不删服务端多态行**（PENDING+CONFIRMED 同 reqid 短暂共存于一页时，裸 DELETE 会在批内互删刚 INSERT 的兄弟行 → 丢合法 server 行）。加 `send_status=4` 后，server 行（status≠4）永不被误删，同时闭合 applier 批量路径与保活 reqid 碰撞。
- `request_message_id<>''` 守卫防空 reqid inbound 行互删。
- 重发成功 / 「服务端其实成功」时，server CONFIRMED 行落库触发该 DELETE 塌缩旧失败行。
- **新增迁移 `V24__idx_hub_msgs_req.sql`**：`CREATE INDEX idx_hub_msgs_req ON hub_conversation_messages(employee_id, request_message_id) WHERE request_message_id<>'';`（SQLite 3.46.1 支持部分索引；`pool.rs:76` 追加 `M::up`，项目无 down 纪律；只建结构不回填）。

### 4. reconcile 保活

`reconcile_newest` Replace 分支（`message_sync.rs:251-256`）`delete_conversation` 前先捞「未收敛失败行」（`send_status=4 AND request_message_id<>'' AND request_message_id NOT IN(本次服务端首页 reqids)`），删后 upsert 回。

- 按 reqid-not-in-page（非 local_message_id），配合 §3 收窄 DELETE，server 含同 reqid 成功行时失败行不保活（由 server 行取代）、不含时保活且 reqid 不交叉 → 无反噬。
- 纯本地失败会话服务端首页空 → `classify_reconcile` NoOp（`message_sync.rs:42`）不删，安全。Stitch 不删，安全。

### 5. recents 一致性（关键修正：不碰水位键）

`persist_outbox_failure` 同步更新 recents，但**绝不触碰 `last_message_sort_key_ms`**（它是水位/版本键；抬它会让水位门 `c=window.newest_message_time_ms` 恒 < `r` → 永久 not-fresh → 每开会话必网络、冷会话阻塞 10s；并破坏 `apply_summary` 版本门 → status 4 卡死回不到 3）。

- 只写**展示列**：`last_message_summary`、`last_send_status=4`；置顶用 `local_last_sent_at_ms`（已在 `list_top` ORDER BY、不在水位门、`mark_local_sent` 已写，`recent_sessions.rs:189-193/579`）。
- **放弃纯新会话 recents upsert**（INSERT 需 wecom_name/account/alias/external_mobile 等失败路径拿不到的资料列）→ 已知限制：首条即失败的全新会话，重发成功前不进最近会话列表（由服务端 summary 日后建全行）。
- 回正：重发成功由服务端 SESSION_SUMMARY 经 `apply_summary`（4→3 允许，`recent_sessions.rs:296-301`）+ send_message 成功路径 `mark_local_sent` 覆盖预览；前提是上面没抬 sort_key。

### 6. 前端排序修正（replaceAuthoritative，复杂度比 v2 估计的高）

目标：`status==='failed'` 条目（leftover 或刚转正的权威失败行）按 `sentAt` 归位；`sending` 仍贴底；已显示真实消息保位不抖。

- **不是「丢尾段」那么简单**：naive 实现（failed 一律丢进 `mergeByTimeAscending` 尾段）在「失败行 sentAt 落已显示中段」时产生新抖动（得 `[h0,S,A]` 而非 `[h0,A,S]`，因 knownAuth 前缀不参与尾段归并）。需**带锚点的稳定插入**（failed 行用其 sentAt 在整条时间线定位，含跨越前缀边界）。具体算法 writing-plans 定。
- **先写两个红测（TDD），确认在当前 main 上失败再实现**：
  1. 两次重读归位：发A失败→第一次重读只含后发成功 server 行（A 沉底为 leftover）→第二次重读加入同 id 权威失败行，断言 A 最终在成功行**之上**、status=failed（当前 main FAIL：A 撞沉底 priorIndex 被冻结）。
  2. 反例护栏：失败行 sentAt 落已显示历史中段，无关重读不得顶动已显示真实消息（naive 草图会 FAIL）。
- 不破坏既有 25 条排序断言（matchedEcho/preserveOptimisticImageDimensions/内容短路/单调插入三测/markSent 竞态等）。
- failed 权威行的「不参与 matchedEcho」用 `status==='failed'` 显式判定，不依赖 priorIds（防 LRU 清 leftover 后失守）。

### 7. LRU 豁免

`trim_conversations`（`messages.rs:371-407`）victim 选取 SQL 排除含失败行的会话：`... AND conversation_id NOT IN (SELECT DISTINCT conversation_id FROM hub_conversation_messages WHERE employee_id=?e AND send_status=4 AND request_message_id<>'')`。含失败行的会话根本不进 victim 名单（不破坏成对删除/不留孤儿窗）。文档明确「失败行会话豁免 LRU、可超 `MESSAGE_HOT_CONVERSATIONS_LIMIT`」。`clear_for_employee`（显式清除）不豁免。

### 8. 不做项 / 已知限制

- 撤回持久化、A2/写前 pending：不做。
- **全新会话首条即失败 → 重发成功前不进 recents 列表**（资料列缺失，§5）。
- 引用关系（replyTo）失败行不持久化（`MessageRow` 无 reply 列）。
- 图文内联（inline）readback 丢失（happy path 同样，非本设计引入）。
- never-uploaded 失败行可见但不可重发（blob 重启即死）。
- reqid 用 client_msg_id（UUID），碰撞概率可忽略，列为残差。

## 测试计划

后端：①`persist_outbox_failure` 写失败行（id/下划线 sort_key/status=4/**direction=2 列**/attachments camelCase/**message_time_ms 同源** 断言）；②`upsert_messages` 去重 DELETE **仅删 send_status=4**（同页 PENDING+CONFIRMED server 行不被误删）+ `<>''` 守卫；③Replace-reconcile 保活（reqid-not-in-page，含空窗，不反噬 server 行）；④Stitch 不删；⑤`trim_conversations` 豁免失败行会话（不破坏 LRU 成对删除）；⑥recents 只写展示列 + `local_last_sent_at_ms` 置顶、**不抬 sort_key**、不破坏 apply_summary 回正；⑦migration V24 部分索引。
前端：①两个红测（两次重读归位 + 反例护栏，先 FAIL 再实现）；②`failBubble` markFailed+IPC，IPC payload 身份字段齐（wecomAccountId/externalUserId 经新 props）；③attachments_json 可被 `Vec<HistoryAttachment>` 解析 + attachmentType 映射正确；④never-uploaded（mediaId 空）禁重发 + toast。
e2e：`scripts/push_test.py` 造文本/已传图发送失败/上传失败 → 重启 → 验证失败气泡仍在、位置正确、可/不可重发符合预期。

## 关键文件锚点（行号以当前 main 为准，近期有漂移）

- 前端：`chatStore.ts`（排序/actions）、`useChatActions.ts`（markFailed 各点/resend/textToSendUnit）、`messageHistory.ts`（映射/attachmentPreviewUrl）、`data.ts`（MessagePart/attachmentKindFromCode）、`MessagesPage.tsx`（身份闭包源）、`strings.ts`（补失败文案）、`constants.ts`（COMPOSER_MAX_CHARS=2000）。
- 后端：`message_sync.rs`（send_message/reconcile/normalize_local_direction_from_sort_key）、`messages.rs`（upsert/ensure_window/trim/删除路径）、`message_event.rs`（applier）、`recent_sessions.rs`（mark_local_sent/apply_summary/list_top）、`backends/src/lib.rs`（命令层/水位门 + 新增 2 个 IPC）。
- 迁移：`migrations/V24__idx_hub_msgs_req.sql` + `pool.rs` 追加。
