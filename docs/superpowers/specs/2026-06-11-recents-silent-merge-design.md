# 接待列表数据流设计：静默合并门 + 切账号本地化（2026-06-11）

## 背景与问题

**Bug 现象**：切换账号筛选后，接待列表热数据被覆盖、大量静默消息会话被凭空创建。

**根因**：静默语义（`clientSilent`）此前只在推送事件路径（`RecentSessionEventApplier`）实现为代码分支；
切账号触发的远端水位预填（`prefill_recent_friends`）→ `upsert_remote_in_tx` 完全没有静默概念：

1. 未知会话无条件 INSERT → 静默会话批量建行；
2. removed 自动恢复 CASE 只比时间 → 软删会话被静默消息复活（打穿吸收水位）；
3. 版本门被静默消息抬高的服务端 sortKey 轻松通过 → 热字段被覆盖；
4. trim 配额被灌入的静默行挤占 → 真实热会话可能被驱逐。

## 后端契约（2026-06-11 已确认）

| 契约项              | 确认结果                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| `clientSilent` 语义 | **该会话最后一条消息是静默消息**（与事件 `sessionSummary.clientSilent` 同语义） |
| 服务端过滤          | **不过滤**，带标如实返回（显示语义由客户端门控决定）                            |
| `unreadCount` 口径  | **不包含**静默消息                                                              |
| true 样本验证       | 客户端编写完成后，后端可模拟发送静默消息回归                                    |
| 会话移除推送事件    | **延期**（后端后续迭代做，本期客户端不依赖；见「延期项」）                      |
| 拉取并发            | 后端要求客户端**控制并发数**（绑定企微号会很多）                                |

接口实测（dev 环境）：响应已含 `clientSilent` / `clientSilentReason` / `clientSilentSource`。

**`clientSilentReason` 枚举**（命中原因）：

| 枚举值              | 说明                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `WEAPP_CARD`        | 小程序卡片类消息；当前默认由 Easy 原始 `msgType=78` 命中                    |
| `AUTO_REPLY`        | 添加好友成功后的平台或系统自动回复消息（协议预留，待规则/配置命中后使用）   |
| `FRIEND_ADD_NOTICE` | 好友添加成功后发送的通知类消息（协议预留，待规则/配置命中后使用）           |
| `CONFIG_MATCHED`    | 通用配置命中（按融合标准 messageType 或关键词配置命中、无更具体业务原因时） |

**`clientSilentSource` 枚举**（命中来源）：

| 枚举值              | 说明                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `EASY_MSG_TYPE`     | 根据 Easy 原始消息类型命中（如 msgType=78 小程序消息）                     |
| `MESSAGE_TYPE`      | 根据融合标准 messageType 配置命中                                          |
| `KEYWORD`           | 根据消息文本/摘要/内容 JSON 关键词配置命中                                 |
| `PERSISTED_MESSAGE` | 从已持久化消息表静默字段恢复（附件转存后续通知、延迟首包等非首次解析场景） |
| `UPSTREAM_CONTEXT`  | 上游标准事件已显式携带静默上下文，服务端沿用下发                           |

两个伴随字段客户端**暂不解析不入库**（最小修改）；备案用途：排障 + 将来存量清理时按
source 区分营销类静默来源（可能是清存量唯一靠谱依据）。

## 总体设计：三层收敛

### 第 1 层（后端客户端侧，已落地 2026-06-11）：silent 贯穿拉取管道，upsert 单点设门

改动 4 个文件，全部写入仍汇聚于唯一的 `upsert_remote_in_tx`：

1. **`RecentFriendRecord`**（chathub-net/src/hub.rs）：`#[serde(default)] client_silent: bool`，
   旧后端无字段 → 缺省 false → 行为不变，灰度安全。
2. **`RecentSessionRemote`** 加 `silent`；`record_to_remote` 透传；事件路径 `!exists` 分支
   填 `silent: false`（能走到即已过非静默守卫）。
3. **`upsert_remote_in_tx`**（chathub-state/src/recent_sessions.rs）两道门：
   - **门 A（静默不建行）**：业务键收编段**之后**、INSERT 之前按 `conversation_id` 查存在性，
     `silent && !exists → Ok(0)`。位置关键：旧 id 行改 id 续命后按新 id 判才算"存在"。
   - **门 B（静默不复活）**：removed CASE 加 `?22`（镜像 `apply_summary` 的 `?17`）：
     静默时 removed 保持、removed_at_ms 抬到消息时间（吸收水位）。
4. **`open_friend_conversation`**（lib.rs）：**主动打开豁免静默门**（`remote.silent = false`）——
   用户点开会话建行就是意图本身；否则"最后一条恰为静默消息"的好友会打不开会话。

版本门 / 已读水位门 / 业务键收编 / trim 全部未动（静默未知会话不再插入，trim 配额自然不受污染）。

**合并矩阵（已全部落为测试）**：

| 远端记录               | 本地状态     | 结果                               | 测试                                                                |
| ---------------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------- |
| silent                 | 无行         | 不插入（门 A）                     | `upsert_remote_silent_unknown_does_not_insert`                      |
| silent                 | removed=1    | 不复活，水位抬到消息时间           | `..._does_not_unremove_soft_deleted` + `..._bumps_removed_at_ms...` |
| silent                 | 可见行       | 摘要照常更新                       | `..._on_visible_row_still_updates_summary`                          |
| silent                 | 旧 id 兄弟行 | 先改 id 续命 → 判为存在 → 照常更新 | `..._with_renamed_sibling_still_updates`                            |
| 非 silent 更晚         | removed=1    | 照常复活（回归）                   | `upsert_remote_nonsilent_newer_still_unremoves_after_silent`        |
| 旧后端无字段           | 任意         | serde 缺省 false → 行为不变        | 既有套件全绿即证                                                    |
| 主动打开 + silent 记录 | 任意         | 豁免门控，照常建行                 | lib.rs 强制 `silent=false`                                          |

**messageHistory 不需要此字段**：事件侧 `clientSilent` 只挂在 SESSION_SUMMARY_UPSERT 上、
MESSAGE_UPSERT 没有；拉取侧 messageHistory 只写消息气泡库，从不创建/复活接待行。

### 第 2 层（前端，已落地 2026-06-11）：切账号 = 纯本地查询 + 零行兜底

`useRecentFriends.ts` 水位预填分 scope 策略：

- 「全部」scope：本地 < 触发线自动预填（冷启动主路径，全量拉取天然覆盖各账号）；
- 账号筛选 scope：纯本地过滤为主，**仅本地 0 行兜底预填一次**（冷门账号空列表死路兜底；
  silent 双门落地后被动预填已数据安全，兜底只付一次网络成本）；
- `isStale`（切 scope 新列表未返回）窗口期不决策，防按旧 scope 数据误判。

保留的远端对齐入口：手动刷新（force）、resync（force）、打开会话（单行 upsert，豁免静默门）。

### 第 3 层：拉取时机收敛后的全景

| 远端写入入口      | 触发条件                             | 经过的门                                |
| ----------------- | ------------------------------------ | --------------------------------------- |
| 冷启动水位预填    | 全部 scope 本地 < 100 行，本会话一次 | upsert 五门（版本/已读/业务键/门A/门B） |
| 手动刷新          | 用户点击                             | 同上                                    |
| resync force 预填 | relay gap 超 retention               | 同上                                    |
| 打开会话          | 用户主动打开                         | upsert（豁免静默门，建行是意图）        |
| 推送事件          | SESSION_SUMMARY_UPSERT               | apply_summary（既有静默 CASE）          |

## 高性能接待列表（50W 客户规模）

**规模前提**：绑定企微号多、客户量 50W。核心架构判断：**50W 客户永远不进本地全量——
本地只持有界热窗口（trim：每账号 500 / 全局 2000），全量靠远端搜索**。这个形状已经是对的，
规模化要解决的是以下压力点：

1. **多账号预填并发控制**（后端硬要求）：当前预填是单 scope 串行循环分页，天然并发=1，合规。
   将来若做"按账号分水位"（每账号保底 N 行），必须加**有界并发信号量（建议 2~3 路）+
   撞限流退避**（复用发送链路 sendPacer 的 AIMD 经验，403 正则判定退避重试）。
2. **事件风暴下的重读合并**：50W 客户 × 多账号的推送事件密度高，每个 ChangeNotice 触发
   `list_top(limit)` 重读（limit 最大 2000）。需要**通知合并/防抖窗口**（~100-200ms 聚合一次重读），
   防事件爆发期重读风暴。落地点在 useResource 或后端 ChangeNotice 发射侧，做之前先量化
   （事件峰值频率 × 重读耗时），避免过度设计。
3. **SQLite 索引**：`list_top` 的 scope 查询（employee_id + 可选 wecom_account_id + 多键排序）
   需要复合索引兜底；行数有界（≤2000）所以即使全表扫也在亚毫秒级——索引是保险不是救命。
   真正要看的是 `hub_conversation_messages`（每会话 500 上限）和聚合未读计数的查询计划。
4. **每账号配额保底**：切账号本地化后，冷门账号的体验取决于本地有没有它的行。trim 的
   每账号 500 上限已经天然保底（活跃账号挤不掉冷门账号的配额）；缺的是**预填侧**的按账号
   保底，归入"水位编排下沉后端"二期。
5. **搜索体验**（50W 全量的主要入口）：远端搜索已是临时态不写库；规模化要补**输入防抖 +
   in-flight 取消**（快速连续输入只保留最后一次请求落地），防止慢响应乱序覆盖。
6. **安全**：token 走 hub_secrets 本地库 + relay Bearer 透传（不落日志，set-cookie 脱敏已做）；
   搜索输入全参数化 SQL；日志 PII 已降 trace。规模化不新增攻击面。

## 实施状态

- [x] 第 1 层后端双门：4 文件改动 + 7 个新测试，workspace 全测绿（state 148 / net 129 / lib 38），未提交
- [x] 第 2 层前端切账号本地化 + 零行兜底 + isStale 守卫：`useRecentFriends.ts` + 测试（530 测绿 / tsc / eslint 净），未提交
- [x] 门控可观测（轻量）：`upsert_remote_many` 记录 applied/skipped debug 计数（被静默门/版本门/滞后重放拒掉的行数一眼可见）
- [x] 契约探针固化：`scripts/probe_recent_friends.py`（token 自取、代理绕过、dev 自签链降级重试、silent 分布统计），已实跑验证
- [x] **合并内核收编（2026-06-11，用户拍板提前执行）**：`upsert_remote_in_tx` 升级为唯一写入内核
      ——吸收原 `apply_summary` 四项语义（资料/身份字段**非空才覆盖**、`last_send_status` 不倒退
      CASE、同消息守卫进 WHERE、时间/排序键 MAX 只进不退、空 gmt 视为不携带放行）；事件 applier
      exists/!exists 双分支塌缩为"构造摘要形态 remote → upsert"单路径（省一次 exists 查询）；
      `upsert_remote_one` 返回 bool（门拒不计 applied、不发 ChangeNotice）；`apply_summary` 删除，
      其 16 个语义测试全部移植为内核测试（`summary_merge_*`）；列所有权表落内核文档注释。
      收编副产物：事件路径从此也享有业务键收编（换发 id 去重）保护。
- [ ] 真机回归：后端模拟发送静默消息验证 true 样本 + 切账号不再灌行 + 收编后事件链路回归
- [ ] 存量脏行清理：等拿到 `clientSilentSource` 真实分布后决定（接受现状 vs 按 source 启发式清理）
- [ ] 二期：水位编排下沉后端（ensure 命令 + 删前端 filledScopes）；**按账号分水位主动扇出已否决**
      ——零行兜底就是它的懒加载形态（按需、天然并发=1，符合后端控并发要求），主动全账号扇出过度设计
- [ ] 待量化后决策：事件风暴下 ChangeNotice 重读防抖（先测峰值频率 × 重读耗时，避免过度设计）

## 合并内核行为变化备忘（收编引入，真机回归重点）

| 路径 | 变化                                                     | 性质                            |
| ---- | -------------------------------------------------------- | ------------------------------- |
| 拉取 | 资料字段空值不再覆盖本地（非空才覆盖）                   | 收紧，防写空                    |
| 拉取 | last_send_status 不再无条件覆盖（不倒退 CASE）           | 收紧，对齐"状态不倒退"修复方向  |
| 拉取 | 同消息 id 的记录可进门刷新（原版本门可能拒）             | 放宽，水位门保护未读/时间不倒退 |
| 事件 | 已知会话也会用账号缓存刷新 wecom 展示字段（非空才覆盖）  | 行为微调                        |
| 事件 | 带 externalUserId 的事件享受业务键收编（换发 id 去重）   | 增强                            |
| 事件 | 静默未知会话由内核门 A 跳过（原 applier 守卫，语义等价） | 等价迁移                        |

## 延期项（已记录，本期不做）

- **会话移除类推送事件**（删除/归档/转接对齐）：后端后续迭代提供；客户端在此之前
  接受"服务端删除的会话本地残留至 trim 驱逐"的现状。事件落地后客户端需要：事件类型解码 +
  软删落库 + 纳入 notifySeq 重放语义。
