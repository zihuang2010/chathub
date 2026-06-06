# 消息列表虚拟化 + 数据窗口化 设计（Phase 1 + Phase 2）

- 日期：2026-06-06
- 分支：`feat/messages-virtual-windowing`
- 状态：已与用户对齐，待实现
- 优先级约束：本仓库 `CLAUDE.md`（简单优先 / 最小修改 / 保持现有风格 / 先思考再编码）

---

## 0. 背景与现状（带代码定位）

### 0.1 需求来源

消息气泡列表需要"操作流畅 + 内存安全 + 后续量很大（单会话上万条）也恒定"。用户明确选择做**真正的虚拟化 + 数据窗口化**（已知此前回退过一次、已知渲染虚拟化单独即可压住"贵的内存"，仍决定做全量）。

### 0.2 现状

- **消息时间线当前未虚拟化**：`frontends/components/workbench/messages/ChatArea.tsx:245-268` 直接 `.map()` 渲染 `timelineItems`，每行 `memo` 化的 `MessageTimelineRow`。
- **曾虚拟化又被回退**：`34eca70 perf(frontend): 消息区虚拟化(@tanstack/react-virtual,长会话阈值门控)` 引入，`4b5f1f3 重构消息列表中消息气泡的交互，以及优化一些交互问题` 移除。残留 `virtualListSizing.ts`（行高估算 / overscan / measure 缓存）现无消费者——本设计**复用**它。
- **依赖已就位**：`@tanstack/react-virtual ^3.13.24`（`package.json:39`），已在 `ConversationList.tsx` / `customers/CustomerList.tsx` 使用。
- **硬上限 500**：`frontends/lib/api/useMessageHistory.ts:38` `MAX_MESSAGES_IN_MEMORY=500`，`:225` 到顶停止网络翻页。
- **滚动机制（最易碎、回退主因）**：`hooks/useScrollController.ts` —— 置底跟随、prepend 锚点（`refId`/`refTopRel` + 有界重断言 rAF，:332-410）、未读 above/below pill、切会话 snap-to-latest（:290-330）、离开补 markRead。
- **滚动容器**：`WorkbenchScrollArea.tsx` —— 原生 `overflow-y:auto`，rAF 节流上报 `ScrollMetrics`，ResizeObserver+MutationObserver 监测尺寸/内容变化，overscroll bounce + 近顶 smoothWheel（reduced-motion 下禁用）。
- **时间线派生**：`hooks/useChatTimeline.ts` —— 日期分隔 / 未读分隔（边界按会话冻结）/ burst 间距，纯 `useMemo`。
- **数据真相 store**：`store/chatStore.ts` —— slice `{order, byId, hasMore, loading, error}`；`replaceAuthoritative`（最易错，含乐观↔权威确定性配对 + 失败行按 sentAt 插入 + 内容等价短路）；`prependOlder`；LRU `MAX_HOT_CONVERSATIONS=30`。
- **数据 hook**：`lib/api/useMessageHistory.ts` —— 缓存优先 `readCache`（整窗 `replaceAuthoritative`）+ `loadMore`（网络 `loadOlderMessages` → `prependOlder`）+ 多订阅重读。
- **API 层**：`lib/api/messageHistory.ts` —— `FetchMessageHistoryRequest.cursor` **语义固定 earlier-only**；`loadConversationMessages`（最新窗口 + 水位门 reconcile）；`loadOlderMessages`（往更旧，无游标参数，后端有状态维护）。

### 0.3 后端现状（Rust，Phase 2 相关，已探查）

- Tauri 命令：`backends/src/lib.rs` —— `fetch_message_history`(:379)、`load_conversation_messages`(:418-584)、`load_older_messages`(:589-618)；命令注册 `:1889`。
- 翻页：`chathub-net/src/message_sync.rs::load_older`(:515-577)，靠 `MessageWindow.older_cursor` 单向往旧；`reconcile_newest`(:235-381) 朝最新对齐（NoOp/Replace/Stitch 三态，`:343-360` should_notify 防自激死循环）。
- 存储：`chathub-state/src/messages.rs` —— 表 `hub_conversation_messages`（`local_message_id` PK、`sort_key`、`message_time_ms`、`message_direction`、索引 `idx_hub_msgs_conv_sort (conversation_id, sort_key)`）+ 水位表 `hub_conversation_message_window`（`newest/oldest_sort_key`、`older_cursor`、`has_more_older`、`newest_message_time_ms`、LRU `last_accessed_ms`）。
  - `list_conversation_asc`(:281-307) 读整窗升序；`upsert_messages`(:80-157) 位置列不动；`get_window`/`upsert_window`/`touch_accessed`/`trim_conversations`/`delete_conversation`。
- 水位门：`lib.rs:476-480` `fresh = cache_newest_ms >= recents_latest_ms > 0`；`recents.latest_sort_key_ms()`（`recent_sessions.rs:634-658`）。
- ChangeNotice 发射：`message_sync.rs:370-379`（reconcile should_notify）、`:443-450`（seed_first_history）、`lib.rs:640-646`（clear）。
- **关键结论**：服务端 `fetch_message_history` 只能 earlier-only（向后），**无"往更新翻"网络能力**；`MessageWindow` 无 newer 游标。

---

## 1. 目标 / 非目标

### 目标

1. 渲染虚拟化消息时间线：DOM 节点与离屏图片解码位图恒定（≈可见 + overscan）。
2. 数据窗口化：JS store 只保留围绕锚点的有界窗口，单会话上万条时 JS 对象数恒定。
3. **完整保留**现有交互（见 §5 清单）。
4. 规避此前回退的根因（变高图片行 measure 抖动 / "整列下沉" / drop 致 scrollTop 漂移）。

### 非目标

- 不改服务端协议；不引入网络"往更新翻"游标。
- 不重写 reconcile / 水位门 / LRU / UPSERT / ChangeNotice。
- 不动 `useChatTimeline` 的派生语义（仅其消费方从全量 `.map` 变成虚拟器喂入）。
- 不顺手重构无关代码（遵循最小修改）。

---

## 2. 核心：三层内存模型

| 层            | 位置                                 | 容量                                   | 角色                                               |
| ------------- | ------------------------------------ | -------------------------------------- | -------------------------------------------------- |
| SQLite        | 后端 `hub_conversation_messages`     | 上万条无压力（已存在）                 | 全量持久缓存，翻更旧页持续写入                     |
| JS store 窗口 | 前端 `chatStore` slice               | 有界 `WINDOW_BUDGET≈240` 行（约 3 屏） | 围绕锚点的连续窗口，按 `sort_key` 边界从 SQLite 读 |
| 渲染虚拟化    | `ChatArea` `@tanstack/react-virtual` | 可见 + overscan                        | 只挂可见行；DOM/图片位图恒定                       |

→ DOM 恒定 + 图片位图恒定 + JS 对象恒定 + SQLite 扛全量。

### 2.1 关键纠偏（比"镜像网络 newer 游标"更简单）

窗口化"往更新翻"**只读本地 SQLite 缓存**（数据早已落库），不碰网络、不需服务端能力、不需 `MessageWindow` 加列：

- `WHERE sort_key > ? ORDER BY sort_key ASC LIMIT`（命中现有 `idx_hub_msgs_conv_sort` 索引）。
- 网络 `load_older_messages` 仅在窗口顶触到 SQLite 最旧、且服务端 `has_more_older` 时才用于"扩缓存"。

---

## 3. 分层设计

### Layer 0 — 后端 Rust（小改、无服务端依赖、无迁移列）

**新增本地缓存读（`chathub-state/src/messages.rs`）**

- `list_newer(employee_id, conversation_id, after_sort_key, limit) -> Vec<MessageRow>`
  SQL：`SELECT ... WHERE employee_id=?1 AND conversation_id=?2 AND sort_key > ?3 ORDER BY sort_key ASC LIMIT ?4`（升序）。
- `list_older_than(employee_id, conversation_id, before_sort_key, limit) -> Vec<MessageRow>`
  SQL：`SELECT ... WHERE employee_id=?1 AND conversation_id=?2 AND sort_key < ?3 ORDER BY sort_key DESC LIMIT ?4`，结果反转为升序返回。
- 复用 `list_conversation_asc` 的行→`HistoryMessage` 映射。

**新增 Tauri 命令（`backends/src/lib.rs`，注册于 `:1889`）**

- `load_cached_window(conversation_id, anchor_sort_key, before, after) -> CachedMessagesResp`
  - `before>0`：取锚点更旧 `before` 条（`list_older_than`）；`after>0`：取锚点更新 `after` 条（`list_newer`）；`anchor_sort_key=""` 视为取最新尾窗（复用 `list_conversation_asc` 取尾 N）。
  - 返回升序 `records` + `has_more_older`（窗口最旧是否仍 > 缓存最旧 / 或 window.has_more_older）+ `has_more_newer`（窗口最新是否 < 缓存最新）。
  - **复用**现有 `image_prefetcher`、`MessagesStore`、`get_window`，不触发 reconcile（纯本地读）。
- 形状仍用 `CachedMessagesResp`（`lib.rs:390`），追加 `has_more_newer: bool` 字段（向后兼容默认 false）。

**不动**：`reconcile_newest`、水位门、LRU/`trim_conversations`、`upsert_messages`、ChangeNotice、迁移（不加列）。

**测试**：`messages.rs` Rust 单测覆盖 `list_newer`/`list_older_than`（升序、边界相等 `sort_key`、空、limit 截断）。`env -u ALL_PROXY` 跑（参 relay 测试约定）。

---

### Layer 1 — 数据层（`chatStore` + `useMessageHistory`）

**slice 扩窗口语义（`store/chatStore.ts`）**

- `ConversationSlice` 追加：`windowOldestSortKey: string`、`windowNewestSortKey: string`、`atCacheTop: boolean`（窗口顶=缓存最旧且服务端无更旧）、`atCacheBottom: boolean`（窗口底=缓存最新）。
- 新增纯函数 reducer（导出供单测，沿用现有纯函数 + `sliceContentEqual` 复用引用风格）：
  - `appendNewerWindow(slice, newer: Message[], meta)`：尾部追加（去重），更新 `windowNewestSortKey`/`atCacheBottom`。
  - `prependOlderWindow(slice, older, meta)`：头部 prepend（复用 `prependOlder` 去重逻辑），更新 `windowOldestSortKey`/`atCacheTop`。
  - `dropFromTop(slice, n)` / `dropFromBottom(slice, n)`：从 order 两端裁剪 n 条，删 `byId`，更新对应边界 `sortKey` + `atCacheTop/Bottom=false`。**不裁剪含未收敛乐观气泡的尾部**（保 in-flight）。
- **`replaceAuthoritative` 塌缩改造（核心、最易错）**：
  - 现状（`:244-256`）整窗用最新页 `messages` 重建 → 丢上滚历史。
  - 改：仅当 `slice.atCacheBottom && 用户贴底`（由调用方传入 `collapseToLatest` 标志）时维持原"整窗替换最新"行为；否则走**缝合更新**——对窗口内已存在条目按 id `UPSERT`（保 order、不丢上滚历史），新出现的权威条目仅当落在当前窗口 `[windowOldest, windowNewest]` 区间内才并入。
  - 乐观↔权威确定性配对（`requestMessageId` 第一轮 + objectName/文本启发式第二轮）+ 失败行按 sentAt 插入 + `preserveOptimisticImageDimensions` + 内容等价短路 **全部保留**。
  - 现有全部 `chatStore.test.ts` 单测须保持绿；新增窗口缝合单测。

**`useMessageHistory` 窗口驱动（`lib/api/useMessageHistory.ts`）**

- `MAX_MESSAGES_IN_MEMORY=500` → `WINDOW_BUDGET≈240`（约 3 屏；可调）。
- 新增 `loadNewer()`：调 `load_cached_window(after=PAGE)` 本地读 → `appendNewerWindow`；窗口超预算则 `dropFromTop`。
- `loadMore()`（更旧）改：先 `load_cached_window(before=PAGE)` 本地读；若 `atCacheTop && window.has_more_older` 才网络 `loadOlderMessages` 扩缓存后再本地读 → `prependOlderWindow`；超预算则 `dropFromBottom`（仅 drop 远离视口的尾部、且不 drop 未收敛乐观）。
- `readCache`：传 `collapseToLatest = 用户贴底`（从 useScrollController 的 `wasAtBottomRef` 派生），不贴底时缝合不塌缩。
- 切会话首屏：初始为"贴底窗口"（取尾 `WINDOW_BUDGET` 或现有 pageSize）。
- 互斥：保留 `readingRef`/`loadingOlderRef`，新增 `loadingNewerRef`，三者互斥防整窗 REPLACE 覆盖窗口操作。

---

### Layer 2 — 滚动控制器（`hooks/useScrollController.ts` 适配虚拟器）

- 置底跟随、切会话 snap-to-latest、overscroll bounce、smoothWheel、reduced-motion、离开 markRead：作用于 scrollElement，思路保留。
- **prepend 锚点（最易抖、回退主因）**：保留 `refId`/`refTopRel` + 有界重断言 rAF 的语义；锚点位置改用虚拟器 `measureElement`/`getVirtualItems()` 坐标；估高 seed 与渲染盒一致（`estimateImageBoxHeight` 复用图片 dims 缓存）防"整列下沉"。
- 未读 above/below pill + 未读分隔：分隔条/锚点行可能被虚拟化卸载 → 判定改为"未读锚点 item index 是否在虚拟 range 内 + 估算 offset 与 viewport 比较"，不再依赖 DOM 节点常驻；`scrollToUnread` 改 `virtualizer.scrollToIndex(anchorIndex, {align:'center'})`。
- 新增"接近窗口底部 ≤ 一屏 → `loadNewer()`"边界（对称现有"接近顶部 ≤ 一屏 → loadOlder"）。
- drop/重水化防抖：仅 drop 视口外 ≥1 屏的行；estimateSize 维持 totalSize；drop 后用锚点 item 重断言 scrollTop，防漂移。

---

### Layer 3 — 渲染（`ChatArea.tsx`）

- `useVirtualizer({ count: timelineItems.length, getScrollElement: () => scrollNode, estimateSize: i => estimateTimelineRowHeight(timelineItems[i]), overscan: getVirtualOverscan(timelineItems), getItemKey: i => rowKey(timelineItems[i]), measureElement })`。
  - **复用 `virtualListSizing.ts`**：`estimateTimelineRowHeight` / `getVirtualOverscan` / `timelineRowHeightCacheKey`。
  - `getItemKey` = `clientMsgId ?? id`（保乐观→权威收敛零 remount、首帧不闪——沿用 `:250-253` 逻辑）。
- 渲染 `getVirtualItems()`：外层 `position:absolute; transform:translateY(start)`；行间距 mt-11/mt-12（burst）并入 `estimateSize` 或行内 padding；保留 `data-message-row-id`（锚点行须在 overscan 内）。
- `role="log" aria-live="polite"` 容器保留；虚拟容器高度 = `virtualizer.getTotalSize()`。
- scrollElement = `WorkbenchScrollArea` 的 viewport（经 `setScrollNode` 拿到的同一 node；`WorkbenchScrollArea` 的 ScrollMetrics 上报通道保留，二者共用同一 viewport）。

---

## 4. 数据流（窗口化后）

1. 切会话/mount → `readCache` 取尾窗（贴底窗口）→ slice 初始 `atCacheBottom=true`。虚拟器初始 offset 到底。
2. 上滚近顶 → `loadOlder`：本地缓存读（命中则 `prependOlderWindow`）/ 触缓存底再网络扩缓存；超预算 `dropFromBottom`。锚点重断言保位。
3. 下滚近底（曾 drop 过尾部）→ `loadNewer`：本地缓存读 `appendNewerWindow`；超预算 `dropFromTop`。
4. 新消息到达（reconcile → ChangeNotice → `readCache`）：贴底 → 塌缩到最新窗口并跟随置底；非贴底 → 缝合 UPSERT，不动上滚位置。
5. 发送：`enqueueOptimistic` 追加尾部（贴底窗口内）→ `markSent`/`replaceAuthoritative` 收敛（确定性配对，行 key 稳定）。

---

## 5. 交互保留清单（验收基线）

- [ ] 切会话即时 snap 到最新、贴底。
- [ ] 贴底时新消息自动跟随置底，无跳帧（layout effect 贴底语义保留）。
- [ ] 上滚翻历史：当前视口纹丝不动（无"整列下沉"/锚点漂移）。
- [ ] 下滚回底：曾释放的较新行无缝重水化，无空洞/无跳。
- [ ] "↓ N 条未读"底部 pill、"↑ N 条未读"顶部 pill 出现/消失/点击跳转正确。
- [ ] 未读分隔条按会话冻结、点击 `scrollToUnread` 居中。
- [ ] 日期分隔正确。
- [ ] 乐观→权威收敛零 remount、发图/图文不闪（行 key=clientMsgId）。
- [ ] 失败气泡按 sentAt 插入正确位置、重发/撤回/删除正常。
- [ ] 多端同步(dir=3)、转存升级、撤回折叠等既有行为不回归。
- [ ] overscroll 回弹、近顶 smoothWheel、reduced-motion 降级保留。
- [ ] LRU 30 会话淘汰、切员工 reset 不串台。

---

## 6. 实现顺序（增量、各自可测可回滚）

1. **Stage A — Layer 0 后端**：`list_newer`/`list_older_than` + `load_cached_window` 命令 + Rust 单测。前端 `messageHistory.ts` 加 `loadCachedWindow` API 包装 + `has_more_newer` 字段。**独立可编译、可测。**
2. **Stage B — Phase 1 渲染虚拟化**：在**现有"累加+500"数据模型**上接 `useVirtualizer`，把 §5 所有滚动交互在虚拟器上重接通过。**独立可交付、真机验证"流畅"的里程碑**；此阶段不动数据层窗口化。
3. **Stage C — Phase 2 数据窗口化**：slice 窗口 reducer + `useMessageHistory` 窗口驱动 + `replaceAuthoritative` 缝合改造 + drop/rehydrate 接滚动边界。叠加到 Stage B 之上，命中"内存恒定"。
4. **Stage D — 验收**：tsc/lint/test/build 全绿 + `gitnexus_detect_changes` 核查影响面 + 交互清单真机手测。

> 编辑任一既有 symbol 前按 `CLAUDE.md` 跑 `gitnexus_impact`（upstream），HIGH/CRITICAL 风险须告知用户。

---

## 7. 风险与缓解

| 风险                                                                            | 等级 | 缓解                                                                                                        |
| ------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| prepend 锚点抖动 / "整列下沉"（上次回退主因）                                   | 高   | 估高 seed 与渲染盒一致（图片 dims 缓存）+ 有界重断言保留 + measureElement；Stage B 单独真机过关再上 Stage C |
| 窗口 drop 致 scrollTop 漂移                                                     | 高   | 只 drop 视口外 ≥1 屏 + 估高维持 totalSize + 锚点重断言                                                      |
| `replaceAuthoritative` 缝合改造回归收敛/失败排序                                | 高   | 纯函数 + 扩单测，保持现有全部 `chatStore.test.ts` 绿                                                        |
| 切会话/多端同步/撤回/转存既有行为回归                                           | 中   | 沿用现有 e2e + 交互清单手测                                                                                 |
| 虚拟化与 WorkbenchScrollArea 的 ResizeObserver/MutationObserver/overscroll 冲突 | 中   | 共用同一 viewport node；虚拟容器高度走 getTotalSize，避免双写 scrollTop                                     |
| 并发工作树（本会话中途 HEAD 移动）                                              | 中   | 固定本分支；提交显式 add、绝不 `git add -A`                                                                 |

---

## 8. 测试

- 后端：Rust 单测 `list_newer`/`list_older_than`（升序/边界/空/limit）。
- 前端：`chatStore` 窗口 reducer 纯函数单测（append/prepend/drop/缝合）；现有全部单测保持绿。
- 虚拟化滚动行为：jsdom 无布局，沿用现有约定（纯状态单测 + 真机手测 §5 清单）。
- 命令工作目录：前端 `pnpm`（仓库根）、后端 `cargo`（`backends/`），见 `chathub-repo-map` 技能。

---

## 9. 待定 / 决策记录

- `WINDOW_BUDGET` 初值取 240（约 3 屏），真机可调。
- `load_cached_window` 单命令带 before/after，对称简单；若实现中发现两命令更清晰可拆。
- Stage B 完成即为一个可独立合并/验证的里程碑（用户已认可分阶段）。
