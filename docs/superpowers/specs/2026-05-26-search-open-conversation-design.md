# 消息页客户搜索 → 打开会话(设计文档)

日期:2026-05-26
状态:已与用户对齐,进入实施

## 需求

消息页顶部搜索客户,点击下拉里的某个客户后:

1. 把该会话提到**接待列表非置顶区的顶部**(置顶行始终在最上)。
2. 调 `recentFriends`(传 `externalId` + `includeFirstHistory=true`)一次拿齐:
   - 顶层 `firstConversationId` = 服务端权威会话 ID(永远返回,前端/Rust 不再自算)。
   - `records`:0 或 1 条该好友的接待记录。
   - `firstConversationHistory.records`:首屏历史消息。
3. `records` 有记录 → upsert 进接待列表;为空 → 用 `firstConversationId` 建一条**本地空白会话行**(资料用前端传入的客户资料兜底)。
4. `firstConversationHistory.records` **冷写入**本地消息库(无窗口时才写,避免覆盖已有缓存),选中即秒显。
5. 完善搜索:打通点击→开会话;加载/空态微调。**不**加手机号搜索、不重做搜索 UI。

## 关键决策(用户拍板)

- conversationId 来源:`recentFriends` 响应顶层 `firstConversationId`(字符串)。**放弃** CRC32 客户端自算(32 位碰撞风险),**放弃** 独立 `createCoversationId` 接口。
- 「提到顶部」:接待表新增**客户端列 `opened_at_ms`**(迁移 **V17**),并入 `list_top`/`trim` 的 `MAX(...)` 排序。与 pinned/draft/muted 同一路子:持久化、重启仍在顶部、远端 upsert 不覆盖。
- 时间**显示**不含 `opened_at_ms`:行排到顶部但仍显示真实最后消息时间。

## 数据流

```
点击客户(WecomFriend)
 → 前端 open_friend_conversation(wecomAccountId, externalUserId, 兜底资料字段)
    → hub.list_recent_friends { externalId, includeFirstHistory=true, wecomAccountId, size=1 }
        conversationId = resp.firstConversationId
        ├─ records 命中  → record_to_remote → upsert_remote_one
        └─ records 为空  → 合成空白 RecentSessionRemote(消息字段空, sort_key_ms=0)→ upsert_remote_one
        firstConversationHistory.records(非空且会话冷)→ history_to_row + upsert_messages + upsert_window
    → set_opened(conversationId, now)
    → emit ChangeNotice(RecentSessions[, ConversationMessages])
    → 返回 conversationId
 → setSelectedId(conversationId);useResource 经 ChangeNotice 自动重读
```

## 改动清单

### chathub-net(契约)

- `ListRecentFriendsRequest` += `external_id: String` + `include_first_history: bool`(均 `#[serde(default)]`,不影响现有搜索/预填路径)。
- `ListRecentFriendsResp` += `#[serde(default)] first_conversation_id: String` + `#[serde(default)] first_conversation_history: Option<FirstConversationHistory>`,其中 `FirstConversationHistory { #[serde(default)] records: Vec<HistoryMessage> }`。

### chathub-state

- 迁移 `V17__recents_opened_at.sql`:`ADD COLUMN opened_at_ms INTEGER NOT NULL DEFAULT 0`。
- `RecentSessionRow` += `opened_at_ms: i64`;`map_row` 补读;`list_top` SELECT + `MAX(last_message_time_ms, local_draft_at_ms, opened_at_ms)`;`trim` 两处 ORDER BY 同步并入。
- 新方法 `set_opened(employee_id, conversation_id, ts_ms)`:独立 UPDATE(始终生效,类似 `set_pinned`),employee 过滤。
- 测试:opened 提到非置顶顶部、置顶仍在其上、远端 upsert 后保留、空白行 sort_key_ms=0 不覆盖既有真实行。

### backends/src/lib.rs

- 新 Tauri 命令 `open_friend_conversation`(编排逻辑同上);注册进 `invoke_handler`。
- `RecentSessionRow` 序列化新增 `openedAtMs`(camelCase 自动)。
- 首屏历史冷写入:复用 `history_to_row` + `upsert_messages` + `upsert_window`。

### relay

- `mock_downstream`:`ListRecentFriendsReq` += `external_id` + `include_first_history`;`external_id` 非空时返回 0/1 条匹配记录 + 顶层 `firstConversationId`(稳定派生)+ `firstConversationHistory.records`。无新路由(复用 recentFriends 端点)。

### 前端

- `recentFriends.ts`:`RecentFriendItem` += `openedAtMs`;新 `openFriendConversation(args) → { conversationId }`。
- `useRecentFriends.ts`:`RecentFriendListEntry` += `openedAtMs`;`fromCacheItem` 透传;暴露 `openFriend(args) → Promise<string>`。
- `MessagesPage.tsx`:`handleOpenCustomer` 改调 `openFriend` → `setSelectedId(返回 id)`;删旧 `searchRemote`+`pendingOpenRef`+「暂无会话」toast 回退路径。
- 搜索下拉:点击项在命令在途时给轻量 loading 反馈。
- `strings.ts`:清理不再使用的 `noConversationForCustomer`(若无其它引用)。

## 假设 / 风险

- 服务端对同一 `(wecomAccountId, externalUserId)`,`firstConversationId` 与后续推送事件里的 `conversationId` **逐位一致**;否则空白行与真实会话分裂成两行。以服务端为准已最大化降低风险。
- 首屏历史**仅冷写入**(无窗口才写),不覆盖已有更全缓存。
- `opened_at_ms` 进 `MAX()` 排序但不进时间显示,故行在顶部、时间显示仍为真实最后消息时间。
