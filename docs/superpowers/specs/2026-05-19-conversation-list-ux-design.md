# 会话列表 UX 优化（置顶角标 / 未读徽标 / 移除会话持久化）

**日期**：2026-05-19
**范围**：`frontends/components/workbench/messages/ConversationList.tsx`、`MessagesPage.tsx`、`useRecentFriends.ts`、`recentFriends.ts`、`backends/src/lib.rs`、`backends/crates/chathub-state/src/recent_sessions.rs`、新增 V11 迁移
**动机**：用户在使用接待会话列表时反馈了三处体感问题，本次一并修复。

---

## 1. 置顶角标改成头像左上 pin 图标

### 现状

`ConversationList.tsx:259-268`：置顶会话在 row 右上角用 `clip-path: polygon(0 0, 100% 0, 100% 100%)` 画一个 12×12 蓝色直角三角，与右上角的时间数字（"16:28"）位置叠合，视觉竞争。

### 目标

- 移除 row 右上角的三角折角元素。
- 在 `ConversationAvatar`（44×44 头像）左上角叠加一个小尺寸 pin 图标徽标，作为置顶视觉指示。

### 视觉规范

- 徽标：14×14px 圆形，背景 `bg-workbench-accent`，内部居中放置 `Pin` 图标（lucide-react，10px，white，旋转 ~45°）。
- 位置：相对 avatar 容器 `absolute -left-0.5 -top-0.5`（轻微外悬，保证与圆角头像视觉分离）。
- ARIA：`aria-label={STRINGS.conversationList.contextUnpin}`，`pointer-events-none`（点击仍由 row 接收）。
- 选中态：徽标维持原色，不参与 row 的 `bg-workbench-surface-active` 变化（保持对比）。

### 代码改动

- `ConversationList.tsx`：删 `isPinned && <span clip-path ...>` 整段；在 `ConversationAvatar` 内部追加 `pinned?: boolean` prop 并渲染左上 pin 徽标。
- 头像组件位置：现有 `<ConversationAvatar name={name} color={avatarColor} online={online} />` 处加 `pinned={isPinned}`。
- 移除 row className 中关于"折角"的注释（lines 254-255）。

---

## 2. 未读：去掉 `[N条]` 文本前缀 + 红色徽标缩小

### 现状

- `ConversationList.tsx:289-293` + `strings.ts:35`：preview 行起首拼一个 `[4条]` 文本前缀。
- `ConversationList.tsx:310-319`：右下角红色圆形数字徽标，`h-[18px] min-w-[18px]`，`text-[10px]`。

两处同时表达"有 4 条未读"，信息冗余；徽标尺寸偏大与 row 内文字对比突兀。

### 目标

- 完全删除 `[N条]` 前缀（preview 文本不带未读条数）。
- 红色徽标：`h-[16px] min-w-[16px]`，`text-[10px]`，`px-1`。1-2 位数字仍为圆形，99+ 自动横向胶囊。

### 代码改动

- `ConversationList.tsx:289-293`：删 `{unread > 0 && <span ...>[N条]</span>}` 整段，preview 直接渲染 `{preview}`。
- `ConversationList.tsx:315`：尺寸 className 改 `h-[16px] min-w-[16px] px-1`（`px-1.5 → px-1`，跟随高度收一格内边距）。
- `strings.ts:35`：保留 `unreadPreviewPrefix` 还是删除？**删除**——本提交起无消费方，YAGNI。同步删除测试中对该字段的引用（如有）。

### Draft 互斥

draft 文本现有逻辑会替换整段 preview（`ConversationList.tsx:280-296`）。本次改动不动 draft 分支，仅清理 unread 分支的前缀。

---

## 3. 「移除接待」→「移除会话」+ 持久化

### 现状

- 文案：`strings.ts:43` `contextRemove: "移除接待"`。
- 持久化：`MessagesPage.tsx:158-178` 使用 session 内 `hiddenIds: Set<string>`，关窗即失，下次启动重新出现。

### 目标

| 行为           | 规则                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| 菜单文案       | "移除接待" → "移除会话"                                                                                           |
| 二次确认       | 否，直接移除                                                                                                      |
| 持久化         | SQLite，跨会话/重启仍隐藏                                                                                         |
| 自动恢复触发   | 仅当 `last_message_time_ms > removed_at_ms`（远端事件或本地 send 落库后）                                         |
| 草稿不触发恢复 | `local_draft_at_ms` 变化不影响 `removed` 标志                                                                     |
| 搜索结果可见性 | 搜索远端 page（`fetchRecentFriendsPage` with filters）不查 `hub_conversation_recents`，命中条目自然出现；无需特判 |

### 数据层方案：在 `hub_conversation_recents` 加两列（V11）

**理由**：表 schema 已有"远端权威列 / 客户端独占列"分层（V7 注释明示），`removed` 与 `pinned` 是同形态的客户端独占列。

#### V11 迁移 `migrations/V11__recents_removed.sql`

```sql
-- V11__recents_removed.sql — 接待会话本地"移除"标记（软删除 + 自动恢复）
ALTER TABLE hub_conversation_recents
    ADD COLUMN removed       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hub_conversation_recents
    ADD COLUMN removed_at_ms INTEGER NOT NULL DEFAULT 0;

-- 默认列表排序不需要 removed 进入排序键（已被 WHERE 过滤），所以不改原 idx_recents_sort。
-- 仅追加一个支持 "WHERE employee_id=? AND removed=0" 的覆盖索引帮助首页查询。
CREATE INDEX idx_recents_employee_removed
    ON hub_conversation_recents(employee_id, removed, pinned DESC, pinned_at_ms DESC, last_message_time_ms DESC);
```

注册：`pool.rs:51` 后追加 `M::up(include_str!("../migrations/V11__recents_removed.sql"))`。

#### `recent_sessions.rs` 改动

- `RecentSessionRow` 增加 `pub removed: bool, pub removed_at_ms: i64`，`map_row` 索引 23/24 取列；SELECT 字段列表加这两列。
- `list_top` 的 WHERE 追加 `AND removed = 0`（hidden 行不出现在默认列表）。
- 新增 `set_removed(employee_id, conversation_id, removed: bool)`：
  - `removed=true` → `UPDATE ... SET removed=1, removed_at_ms=now()`。
  - `removed=false` → `UPDATE ... SET removed=0, removed_at_ms=0`（清零供下次重新隐藏；语义对称）。
  - employee_id 过滤防越权。
- `upsert_remote_in_tx` 的 ON CONFLICT 分支追加：

  ```sql
  removed = CASE
    WHEN excluded.last_message_time_ms > hub_conversation_recents.removed_at_ms THEN 0
    ELSE removed
  END
  ```

  即"远端事件带来的 last_message_time_ms 严格大于 removed_at_ms 才取消隐藏"。Relay redelivery 旧事件不会误唤醒。

- `trim` 无需改动：`removed=1 AND pinned=0` 的行可被裁，符合"用户已隐藏 + 非置顶 = 冷数据"语义。
- 测试新增：
  - `set_removed_then_list_excludes_row`
  - `upsert_with_newer_ts_clears_removed`
  - `upsert_with_older_ts_keeps_removed`
  - `pinned_row_set_removed_is_excluded_but_pin_preserved`（验证移除不破坏 pin 列）

#### Tauri 命令 `set_conversation_removed`

仿 `set_conversation_pinned`（`backends/src/lib.rs:432-463`）：

- 入参 `{ conversation_id, removed: bool }`，从 `auth_api.current_session()` 取 employee_id。
- 调 `store.set_removed(...)`。
- 成功后 emit `ChangeNotice::command_upsert(ChangeTopic::RecentSessions, scope{employee_id, conversation_id})`，让 `useResource` 自动 refetch。
- 在 `tauri::Builder::invoke_handler` 列表追加 `set_conversation_removed`。

### 前端改动

- `frontends/lib/api/recentFriends.ts`：
  - `RecentFriendItem` 新增 `removed: boolean, removedAtMs: number`（与 backend 列映射，保留供调试/测试用，列表行不需要展示）。
  - 新增 `setConversationRemoved(conversationId: string, removed: boolean): Promise<void>` → `invoke("set_conversation_removed", { conversationId, removed })`。
- `frontends/lib/api/useRecentFriends.ts`：
  - `RecentFriendListEntry` 增加 `removed: boolean, removedAtMs: number`；`fromCacheItem` / `fromRemoteRecord` 透传。
  - 远端搜索路径（`searchRemote`）返回的 record 没有 `removed` 概念，统一置 `removed=false`（搜索结果天然显示）。
  - export 新增 `remove(conversationId: string): Promise<void>`，body 调 `setConversationRemoved(id, true)`，**不**直接乐观更新（依赖 ChangeNotice → refetch）。
- `frontends/components/workbench/messages/MessagesPage.tsx`：
  - 删 `hiddenIds` state、`hideConversation` 回调、`conversations.filter((e) => !hiddenIds.has(...))`。
  - 后端 SQL `WHERE removed=0` 已过滤；前端不再二次过滤。
  - `<ConversationList ... onRemove={remove} />` 传入新 hook 暴露的 `remove`。
- `frontends/components/workbench/messages/strings.ts:43`：`contextRemove: "移除会话"`。
- `frontends/components/workbench/messages/ConversationList.tsx:25`：注释更新为"右键菜单'移除会话'。后端持久化软删除，新消息到达后自动恢复"。

### 边界与不变量

- **未读条数**：被移除的会话若有未读，移除时不主动 `mark_as_read`（与"草稿不丢"相同尊重原则）；自动恢复时未读数仍是后端最新。
- **置顶 + 移除**：允许同时存在；移除胜出（不显示）。取消移除后置顶状态仍在。
- **employee 隔离**：employee 切换（少见，但 schema 已按 employee_id 分行）后，A 隐藏的会话不影响 B。
- **事件 applier redelivery**：保证 `last_message_time_ms > removed_at_ms` 严格大于，确保即使 ms 时间戳碰巧相同也不会误唤醒。

---

## 测试矩阵

| 层                  | 测试                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| backend unit        | V11 迁移幂等 / set_removed roundtrip / list_top 排除 / UPSERT 新>removed_at 取消 / UPSERT 旧≤removed_at 保留           |
| backend integration | tauri `set_conversation_removed` + ChangeNotice 触发                                                                   |
| frontend hook       | `useRecentFriends.remove` 调命令后列表过滤生效（mock cache 返回 removed=1 行被 SQL 已过滤，前端组件断言列表中无该 id） |
| frontend component  | `ConversationList` 渲染快照（pin 徽标位置 / 无 `[N条]` 前缀 / 16×16 徽标尺寸）                                         |
| 手工回归            | 移除会话 → 重启应用 → 仍隐藏；mock 推一条新消息（mock_downstream）→ 自动出现                                           |

---

## YAGNI 检查

- **不**做：批量移除、移除时确认弹窗、设置页"已移除会话"列表、移除事件后端同步给其他设备、"取消移除"菜单项（移除后默认行不可见，恢复靠新消息/搜索）。
- **不**做：撤销提示（toast undo）。当前需求未提，且行为已经是"软"删除（新消息自然恢复），误操作成本低。
- **不**做：移除时把 `unread_count` 清零（用户没提，强行清零会丢失"我离开时还欠 4 条"的信息）。
