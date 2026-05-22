# 消息页本地持久化 + 水位设计

- 日期:2026-05-20
- 状态:设计待实现
- 范围:为消息页(单会话消息流)增加本地持久化缓存,并定义"水位/连续性"模型。
  接住后续将落地的消息级推送。

## 1. 背景与目标

当前 `useMessageHistory` 把历史消息当"临时查询语义":每会话从 `fetch_message_history`
实拉、切会话整套 state 重置、不缓存跨会话、不订阅变更总线。会话列表元数据
(`hub_conversation_recents`)已持久化并由推送 applier 维护,但**单条消息从不落盘**。
推送通道(Subscribe v2 → `PushBatchOut`)已存在,但消息级落地尚未实现。

本设计要同时满足四个目标:

1. **切会话秒开** — 切换会话先用本地缓存瞬间渲染,再后台对齐网络。
2. **离线可读** — 断网/弱网下打开 app 仍能看历史消息,恢复后补齐。
3. **承接推送落地** — 推送来的新消息 append 到持久化日志,既让打开中的会话实时更新,
   又在重启后不丢。
4. **减少重复拉取** — 已拉过的分页不再重复打服务端。

## 2. 关键决策(已确认)

| 决策点     | 选择                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| 缓存范围   | 热会话 + 有限窗口                                                             |
| 连续性模型 | **单连续窗口 + 遇洞丢旧**                                                     |
| 体量收口   | **整会话 LRU 淘汰(方案 A)**:按会话数 N 整体淘汰,不对单会话切尾                |
| 读取策略   | **Rust 缓存优先 + 后台重对齐**(stale-while-revalidate);前端 hook 订阅变更总线 |
| 持久化位置 | Rust `chathub-state` crate(SQLite WAL),前端只调 Tauri 命令                    |

复用既有范式:`employee_id` 防御隔离列、camelCase serde、ChangeNotice 总线、
`clear_for_employee` 登出清理。不引入新依赖。

## 3. 存储 Schema(迁移 V13,两张表)

### 3.1 `hub_conversation_messages` — 消息行(日志本体)

| 列                  | 类型           | 说明                                                                     |
| ------------------- | -------------- | ------------------------------------------------------------------------ |
| `local_message_id`  | TEXT PK        | 稳定去重键                                                               |
| `conversation_id`   | TEXT (indexed) | 归属会话                                                                 |
| `employee_id`       | TEXT (indexed) | 防御隔离,所有读写 `WHERE employee_id` 兜底                               |
| `wecom_account_id`  | TEXT           | 归属企微账号                                                             |
| `sort_key`          | TEXT           | 服务端排序令牌,本地 `ORDER BY` 主键                                      |
| `message_time_ms`   | INTEGER        | 解析后时间;排序兜底 + 显示                                               |
| `message_direction` | INTEGER        | 1=入 / 2=出                                                              |
| `message_type`      | INTEGER        | 1=文本 / 2=图片 / …                                                      |
| `content_text`      | TEXT           | 正文                                                                     |
| `send_status`       | INTEGER        | 可变列(UPSERT 刷新)                                                      |
| `attachments_json`  | TEXT           | 附件**元数据** JSON(media_id/file_name/file_size/file_type),不下载二进制 |
| `gmt_modified_time` | TEXT           | 记录最后修改时间                                                         |
| `updated_at_ms`     | INTEGER        | 本地更新时间                                                             |

索引:`INDEX(conversation_id, sort_key)`。

写入纪律:`ON CONFLICT(local_message_id) DO UPDATE SET` 只刷**可变列**
(`send_status` / `content_text` / `attachments_json` / `gmt_modified_time` / `updated_at_ms`);
`sort_key`、`message_time_ms`、方向、类型不动(位置稳定)。

### 3.2 `hub_conversation_message_window` — 每会话一行,即"水位"

| 列                 | 类型    | 说明                                                     |
| ------------------ | ------- | -------------------------------------------------------- |
| `conversation_id`  | TEXT PK |                                                          |
| `employee_id`      | TEXT    | 隔离                                                     |
| `wecom_account_id` | TEXT    | 重对齐拉取需要                                           |
| `external_user_id` | TEXT    | history API 按 (wecom_account_id, external_user_id) 查询 |
| `newest_sort_key`  | TEXT    | 窗口上界 = 已知最新                                      |
| `oldest_sort_key`  | TEXT    | 窗口下界                                                 |
| `older_cursor`     | TEXT    | 服务端游标,继续翻 `oldest` 之下;**恒精确指向当前下界**   |
| `has_more_older`   | INTEGER | 下界之下服务端是否还有                                   |
| `last_accessed_ms` | INTEGER | LRU 淘汰用                                               |
| `reconciled_at_ms` | INTEGER | 上次成功重对齐时间                                       |
| `updated_at_ms`    | INTEGER |                                                          |

> **两个水位是正交的,不要混淆:**
>
> - `hub_recent_session_watermark`(已存在,per `client_id+employee_id` 的 `notify_seq`)是
>   **推送流水位**,记"事件处理到第几条"。本设计**不动它**。
> - `hub_conversation_message_window`(新增,per `conversation_id`)是**每会话连续性水位**,
>   记"本地这段缓存覆盖哪到哪、能不能继续往老翻"。

## 4. 连续性模型(核心)

### 4.1 不变式

每会话本地消息恒为**一段连续区间**,且**结尾 = 已知最新**。
窗口完全由 `[oldest_sort_key, newest_sort_key] + older_cursor + has_more_older` 描述,
本地不需要任何 gap 记账。

```
服务端时间轴(老 ──────────────────► 新)
        ┌───────── 本地连续窗口 ─────────┐
   ......│ oldest_sk ............ newest_sk│   ← 结尾贴最新
        └────────────┬──────────────────┘
       older_cursor ─┘ (has_more_older=1 时可继续往老翻)
```

因为方案 A 不对单会话切尾,`older_cursor` 永远精确指向当前下界 —— 绕开了
"服务端游标 opaque、切尾后无法本地构造续翻游标"的难题。

### 4.2 重对齐(后台,朝最新方向)

拉首页 `fetch_message_history(direction="before", cursor="")`(= 最新页),与缓存比较:

- **冷启动**(无 window 行 / 缓存为空):首页直接作为初始窗口落库,
  `newest_sort_key=max / oldest_sort_key=min / older_cursor=nextCursor / has_more_older=hasMore`。
  (等价于对空缓存的"丢旧重置"。)
- **能缝合** — 首页最老一条 `sort_key ≤ newest_sort_key`(首页向下够到了缓存顶):
  UPSERT 去重落库,`newest_sort_key = max(首页)`,下界 / `older_cursor` / `has_more_older`
  **不动** → 窗口仍连续。
- **有洞** — 首页最老一条 `sort_key > newest_sort_key`(中间断了):**遇洞丢旧** —
  `DELETE` 该会话全部消息行,首页作为新窗口落库,
  `newest_sort_key=max / oldest_sort_key=min / older_cursor=nextCursor / has_more_older=hasMore`。
  代价:长期离线后可能重拉一段旧消息(可接受)。

完成后发 `ChangeNotice { topic: ConversationMessages, scope:{ employee_id, conversation_id } }`。

### 4.3 往上翻(scroll-up,load older)

`has_more_older` 为真且 `older_cursor` 非空 → `fetch_message_history(before, older_cursor)`:
UPSERT 落库、`oldest_sort_key = min`、推进 `older_cursor = nextCursor`、刷 `has_more_older`。
`has_more_older=0` 时无操作。

### 4.4 推送落地(预留接口)

新消息(`sort_key > newest_sort_key` 且贴着上界)→ append、推进 `newest_sort_key`。
若检测到可能漏(推送流不连续 / 引用了本地没有的更老消息)→ 触发一次重对齐,
由 4.2 的"遇洞丢旧"兜底。

会话**未缓存**(冷/已淘汰)时,消息日志忽略该推送(会话列表 summary 仍由现有
`RecentSessionEventApplier` 更新);用户下次打开走正常重对齐拉新。

> **依赖:** 实际订阅回路接线依赖"推送消息体契约"(单条消息是否携带 `sort_key`、
> 全字段等),该契约由后端确定后再接。本设计先把 store 的 ingest 接口与前端 hook 备好。

## 5. 读取链路(缓存优先 + 后台重对齐)

新增 Tauri 命令(Rust 持久化,前端只调命令):

- `load_conversation_messages(conversationId, wecomAccountId, externalUserId, limit)`
  → **立即**返回缓存窗口(最新 `limit` 条,升序)+ `hasMoreOlder`;
  同时后台 spawn 重对齐(4.2)。刷新 `last_accessed_ms`,触发 LRU(见 §6)。
- `load_older_messages(conversationId, wecomAccountId, externalUserId, size)`
  → 网络拉更老页(4.3),落库,返回新增消息(升序)+ `hasMoreOlder`。
- 重对齐完成 → 发 `ChangeNotice`(topic `ConversationMessages`,scope 带 conversation_id)。

前端 `useMessageHistory` 改造为缓存优先 + 订阅:

1. mount / 切会话 → 调 `load_conversation_messages` 拿缓存窗口立即渲染。
2. **订阅变更总线**,按 `conversation_id` 过滤;收到 `ConversationMessages` 通知 → 重读缓存。
3. `loadMore` → `load_older_messages`。

> 这**反转**了 `useMessageHistory` 当前显式的"不订阅 ChangeBus / 每会话重拉"设计,
> 转为 stale-while-revalidate。切会话丢弃过期 in-flight 响应的现有防护保留。

## 6. 淘汰(整会话 LRU,方案 A)

- `load_conversation_messages` 每次刷该会话 `last_accessed_ms`。
- 会话数 > `N`(per-employee)时,按 `last_accessed_ms` 升序删**最冷的整个会话**
  (消息行 + window 行),事务内执行。
- **不**对单会话切尾 —— 单会话翻多少存多少。文本行很小,N 会话 × 上千条对 SQLite 无压力。
- 登出 / 切员工:复用 / 扩展 `clear_for_employee`,连带删该 employee 的消息行与 window 行。

容量参数(初值,可调):

- `MESSAGE_HOT_CONVERSATIONS_LIMIT: N = 40`(per-employee 热会话数上限)。
- 读取首屏 `limit = 20`(对齐现有 `DEFAULT_PAGE_SIZE`),`load_older` `size = 20`。

## 7. 边界与假设

- **`sort_key` 契约(待验证风险)**:连续性判断依赖 `sort_key` **字典序单调**、且
  **history 接口与推送两路一致**。mock 是定宽零填充串(`sort_00000001`,可比),
  但 API 注释写"opaque 客户端不解析"。**需向后端确认真实格式。** 若不可比,退化为
  `message_time_ms + 本地到达序`兜底(`message_time` 为秒粒度、可能并秒,故需到达序兜底)。
- **附件**:仅存元数据 JSON,不下载媒体二进制。离线下图片/语音 body 不可得(占位),
  v1 接受。
- **send_status / 内容编辑**:同 `local_message_id` 再次到达时 UPSERT 刷可变列,不移动位置。
- **多 employee / 多账号隔离**:`employee_id` 列 + 全路径 `WHERE` 过滤,镜像 recents 纪律。
- **(wecom_account_id, external_user_id) ↔ conversation_id**:前端 `useChatMessages` 三者都有,
  命令直接以 `conversation_id` 为主键落库/读取,`wecom_account_id+external_user_id` 仅用于
  重对齐的网络拉取(history API 的查询键)。

## 8. 不在本设计范围内

- 媒体二进制的离线下载 / 资源代理。
- 消息全文搜索 / 跨会话索引。
- 多设备消息同步语义(本地缓存只服务本设备)。
- 推送消息体契约本身的定义(由后端确定;本设计只备 ingest 接口)。

## 9. 测试策略

Rust store 层(对照 `recent_sessions.rs` 的 in-memory pool 单测):

- UPSERT 去重 / 可变列刷新 / 位置不动。
- 重对齐:能缝合(扩上界、下界不动)、有洞(整段丢旧重置)。
- load older:推进下界与游标、`has_more_older` 翻转。
- LRU:超 N 删最冷整会话;`employee_id` 隔离不误删他人;`clear_for_employee` 连带清理。
- 排序:`sort_key` 升序;并秒场景下 `message_time_ms` + 到达序兜底正确。

前端 hook 层:

- 缓存优先首渲染、收到 ChangeNotice 重读、切会话丢弃过期响应、loadMore 翻老页。

## 10. 实现切片(供后续 plan 细化)

1. V13 迁移 + `MessagesStore`(行 UPSERT / 窗口读写 / 缝合-丢旧 / load older / LRU trim /
   clear_for_employee)+ 单测。
2. Tauri 命令 `load_conversation_messages` / `load_older_messages` + 后台重对齐 + ChangeNotice。
3. 前端 `useMessageHistory` 改缓存优先 + 订阅总线;接 `useChatMessages`。
   4.(依赖推送契约)订阅回路调 `MessagesStore` ingest,接 4.4 推送落地。
