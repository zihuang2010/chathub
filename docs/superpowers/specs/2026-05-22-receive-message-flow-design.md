# 客户端接收消息流程设计（MESSAGE_UPSERT → 气泡）

- 日期：2026-05-22
- 范围：聚合客户端「回复消息流程」对接 —— 实时 `MESSAGE_UPSERT` 推送如何落到单会话消息气泡，并新增对接测试。
- 权威协议：`docs/工具网关通知事件与字段规范.md`（§6 events 通用字段、§8 MESSAGE_UPSERT、§14 原子 batch、§15 ACK 与缺口）。

## 1. 背景与现状

业务后台 → relay → 客户端 的实时通知链路已存在：

- **relay 侧**（`chathub-relay/src/push.rs`）：`handle_push` 接收 `PushBatchIn`，鉴权、入 event log、把 `PushBatchOut`（proto）fan-out 给在线员工 gRPC 流。已完整实现。
- **客户端侧**（`chathub-net/src/hub.rs` 的 `ConnectionManager` run_loop）：每收到一个 `PushBatchOut`，依次调用三个 applier，再推进全局 `notify_seq` 水位：
  1. `AccountEventApplier` —— `ACCOUNT_*`
  2. `FriendEventApplier` —— `FRIEND_*`
  3. `RecentSessionEventApplier` —— `MESSAGE_UPSERT` / `SESSION_SUMMARY_UPSERT` → 更新**最近接待列表摘要** `hub_conversation_recents`

### 缺口

`MESSAGE_UPSERT` 目前**只**被 `RecentSessionEventApplier` 消费，用来刷新列表摘要。没有任何 applier 把推送里的 `message{}` 快照写进**消息气泡存储** `MessagesStore`（`hub_conversation_messages`）。气泡存储当前仅由 `MessageSync` 填充：

- 打开会话时拉历史（`reconcile_newest`）；
- 本端发送（`send_message`）落出站气泡。

因此一条**客户回复**只能间接进会话窗口：列表摘要先更新 → 「会话水位门」发现 recents 比本地窗口新 → 触发一次 `reconcile_newest`（额外历史拉取）→ 气泡才出现。

规范 §8.3 要求的是：客户端按 `localMessageId` **直接 upsert 当前会话消息**，仅在「字段不足 / 本地没有该 `localMessageId` / 附件仍在转存」时才用 `message/history` 兜底。

## 2. 目标

1. 新增 `MessageEventApplier`，把实时 `MESSAGE_UPSERT` 直接落成消息气泡（命中规范 §8.3），即时显示、happy path 零额外网络往返。
2. 新增对接测试，证明「业务推送 → relay fan-out → 客户端落气泡」的回复消息流程端到端可用。

### 非目标（follow-up）

- `MESSAGE_REVOKED` / `MESSAGE_DELETED`（`messageStatus` 1/2）：`MessageRow` 无 `message_status` 列，完整支持需 schema 迁移 + 前端撤回/删除渲染，单独排期。
- `ATTACHMENT_TRANSFER_CHANGED` 的完整附件转存态机：本设计仅在「附件仍在转存」时走兜底，不实现转存状态机。

## 3. messageDirection 约定与翻译

业务后台按**规范约定**发：

| spec messageDirection | 含义                                           |
| --------------------- | ---------------------------------------------- |
| 1                     | 我方客户端发送                                 |
| 2                     | 收到客户的消息                                 |
| 3                     | 多端同步（我方在其他设备回复，同步回本客户端） |

本地存储 + 前端用**另一套约定**：`messageHistory.ts` 里 `direction = (messageDirection === 2) ? "out" : "in"`，且 `send_message` 给出站气泡写 `message_direction = 2`。即本地 `2 = 出站(out)`，其余 `= 入站(in)`。

因此 applier 必须做一次**显式翻译** spec → 本地：

```text
1 (我方发送)      → 本地 2 (out)
3 (多端同步=我方) → 本地 2 (out)
2 (客户消息)      → 本地 1 (in)
其他/缺省         → 本地 1 (in)
```

集中在一个函数里，便于将来若统一为 spec 约定时单点切换。

## 4. 组件设计：MessageEventApplier

位置：`backends/crates/chathub-net/src/message_event.rs`，`lib.rs` 导出。形态与 `friend_event` / `recent_session_event` 同构。

依赖（构造注入）：

- `MessagesStore` —— 气泡行存与窗口。
- `MessageSync` —— 兜底复用其 `reconcile_newest`（已含 fetch → classify → stitch/replace → upsert window → 发 `ConversationMessages` 通知）。
- `change_notice_tx: broadcast::Sender<ChangeNotice>` —— 直接 upsert 成功后发 `ConversationMessages` 通知。
- `last_fallback_ms: Arc<AtomicI64>` —— 兜底节流（全局 1s 窗口，与 `RecentSessionEventApplier` 同口径）。

### 入口：`apply_push_batch(&self, batch: &PushBatchOut)`

1. 解析 `events_json`；失败 → `warn` 后 return（best-effort，不影响 dispatch loop）。
2. `employee_id = batch.employee_id.to_string()`。
3. 遍历事件，只处理 `eventType == "MESSAGE_UPSERT"`；其余跳过。无命中 → return。
4. 对每个命中事件：取事件级 `conversationId` / `wecomAccountId` / `externalUserId` + `message{}` 快照。

#### 热会话门控

`store.get_window(employee_id, conversation_id)`：

- **窗口不存在（冷会话）→ 跳过气泡**。冷会话由 `RecentSessionEventApplier`（列表摘要）+ 打开会话时的 reconcile 处理，绝不在此创建孤儿窗口/气泡。
- 窗口存在（热会话）→ 进入应用。

#### Hybrid 应用（规范 §8.3）

解码 `message{}` → `MessageRow`（含方向翻译）。判定：

- **直接 upsert**：必填字段齐（`localMessageId` / `sortKey` / `messageTime`），且附件不在转存中（无附件，或附件 `transferStatus != 1`）：
  1. `store.upsert_messages(&[row])`。`ON CONFLICT(local_message_id)` 只刷可变列（content/send_status/attachments/gmt_modified），位置列不动 —— `SEND_CONFIRMED`/`SEND_FAILED` 落在同一 `localMessageId`，更新原气泡不新增第二条。
  2. **扩窗 newest 上界**：用真实 `sort_key`（绝不用 `~` 出站键污染）。`if row.sort_key > w.newest_sort_key { w.newest_sort_key = row.sort_key }`；`w.newest_message_time_ms = max(w.newest_message_time_ms, freshness)`；bump `last_accessed_ms`/`updated_at_ms`。
  3. 发 `ChangeNotice::server_upsert(ConversationMessages, {employee_id, conversation_id})`。
- **兜底**（字段不足 / 解码失败 / 附件转存中）：节流后调 `MessageSync.reconcile_newest(conv, acct, ext, employee, page_size=20)`。reconcile 自己会发 `ConversationMessages` 通知。节流命中（1s 内已兜底过）则跳过本次，不发通知。

#### 水位

消息不像 friends/recents 有 per-resource watermark（消息按窗口对齐），故此 applier **不推进任何 watermark**。全局 `notify_seq` 仍由 `hub.rs` 在所有 applier 跑完后推进（既有设计：applier 均 best-effort，失败内部 log + 安排兜底）。

### freshness / 时间解析复用

- `split_sort_key_ms`（`recent_session_event.rs`，已 `pub`）解析 `sortKey` 首段 epoch-ms。
- `message_sync` 的服务端时间解析（`"yyyy-MM-dd HH:mm:ss"`，UTC+8）提升为 `pub(crate)` 复用，算 `message_time_ms`。`freshness = split_sort_key_ms(sortKey).max(parse_time(messageTime))`，与 `message_freshness_ms` 同构，保证会话水位门两侧可比。不重复造日期算法。

## 5. 数据流（端到端）

```text
业务后台 MESSAGE_UPSERT(CUSTOMER_MESSAGE_RECEIVED)
  → relay handle_push: 入 event log + fanout PushBatchOut
  → 客户端 run_loop 收 PushBatchOut
    → AccountEventApplier   (跳过)
    → FriendEventApplier    (跳过)
    → RecentSessionEventApplier → 更新列表摘要 + 发 RecentSessions 通知
    → MessageEventApplier   → 热会话: 落气泡 + 扩窗 + 发 ConversationMessages 通知
    → 推进 notify_seq 全局水位
  → 前端 useMessageHistory 收 conversation-messages → 重读本地缓存 → 气泡即时追加
```

§14 原子 batch（同 `notifySeq` 内 `MESSAGE_UPSERT + SESSION_SUMMARY_UPSERT`）：两个 applier 各取所需，列表与气泡都更新，天然原子。

## 6. 错误处理

- 全程 best-effort：`warn` + 继续，绝不 panic，绝不让 dispatch loop 失败。
- `events_json` 解析失败 / 解码失败 / store 报错 → 记日志，必要时安排兜底。
- 兜底自身失败 → `warn`；下次推送或打开会话时的 reconcile 会再对齐。

## 7. 接线（blast radius）

- `chathub-net/src/lib.rs`：导出 `MessageEventApplier`。
- `chathub-net/src/hub.rs`：`Inner` 加字段 `message_event_applier: Option<Arc<MessageEventApplier>>`；`ConnectionManager::new` 加第 4 个 applier 参数（位于 `recent_session_event_applier` 之后、`change_notice_tx` 之前）；dispatch loop 在 recent-session applier 之后调一次 `apply_push_batch`。
- `backends/src/lib.rs`：构造 `MessageEventApplier`（复用已存在的 `message_sync` + `messages_store` + `change_notice_tx`），传入 `ConnectionManager::new`。

`ConnectionManager::new` 仅 **1 个生产调用点**（`backends/src/lib.rs:876`）+ 新 e2e 测试。编辑前先跑 `gitnexus_impact` 复核。

## 8. 测试

### 8.1 单元测试（`message_event.rs`，对照 friend/recent 模式）

- 客户消息（spec dir 2）落热会话 → 气泡入库，本地 `message_direction == 1` (in)，发 `ConversationMessages` 通知，窗口 newest 扩界。
- 我方发送（spec dir 1）/ 多端同步（spec dir 3）→ 本地 `message_direction == 2` (out)。
- `SEND_CONFIRMED` 复用同 `localMessageId` → `send_status` 更新、不新增第二条、位置列不变。
- **冷会话（无窗口）→ 不落气泡、不建孤儿窗口**，不影响 recents applier。
- 非 `MESSAGE_UPSERT` batch → no-op。
- 缺 `sortKey`/`localMessageId` 的瘦 payload（热会话）→ 走兜底分支（在有 hub stub 处覆盖，见 8.2）。

### 8.2 ConnectionManager 对接 e2e（`tests/message_e2e.rs`，新增）

复用 `stub_relay` + `tests/common`：

1. `start_stub_full()` → addr + `hub_state`。
2. `TokenStore::new` + `store.login("alice","pwd")`（stub 返回 token）；`HubClient::new` 带 `AuthInterceptor`。
3. in-memory `SqlitePool` → `MessagesStore` / `NotifySeqStore` / `MessageSync` / `MessageEventApplier`。
4. `ConnectionManager::new(... Some(message_applier) ...)`；`cm.start()`；`wait_for_state(Connected)`。
5. 预置一扇会话窗口（热会话）。
6. `push_event(&hub_state, ServerEvent{ PushBatch(MESSAGE_UPSERT, dir=2) })`。
7. 轮询 `MessagesStore.list_recent` 直到气泡出现；断言内容、`message_direction == 1` (in)、`sort_key` 来自 payload。

这是「测试对接回复消息流程」的端到端证明。relay 传输层已由 `relay_e2e.rs` 既有 push/subscribe 用例覆盖，保持不动。

## 9. 验收

- 客户回复 `MESSAGE_UPSERT` 到达且会话已打开（热）→ 气泡即时出现在底部，方向正确（in），无重复行。
- 我方发送确认 `SEND_CONFIRMED` → 原出站气泡 `send_status` 更新，不新增气泡。
- 冷会话 → 气泡存储不变，仅列表摘要由 recents applier 更新。
- 瘦 payload → 兜底拉历史补齐，不渲染半截气泡。
- 单元 + CM e2e 测试全绿；`cargo test -p chathub-net` 通过。
