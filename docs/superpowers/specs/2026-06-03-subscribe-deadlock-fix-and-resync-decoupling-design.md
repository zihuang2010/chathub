# Subscribe 死锁修复 + 登录/Resync/Subscribe 解耦 设计 (v2)

- 日期:2026-06-03
- 状态:已评审 + 多代理对抗式验证(6 agent / 53 万 token)后修订;待落实施计划(writing-plans)
- 范围:relay(`chathub-relay`)+ 客户端(`chathub-net` / `backends/src/lib.rs` / `frontends`)
- 触发:客户端长期卡"连接中",消息不下发

> **v2 修订说明**:v1 经 5 维度独立验证发现 3 个阻断项(B1 破坏 apply-then-advance、A 的 register 时机引入实时丢帧、"测试不破"不成立)与 6 个重要项。本 v2 已全部并入修正。关键变化见 §13 修订记录。

---

## 1. 背景与根因

### 1.1 现象

客户端 UI 永久"连接中",登录成功但服务端事件永不下发;同期 unary 调用(登录、拉历史、OSS)全部正常。

### 1.2 证据链(已闭环 + 已复现)

- **relay 健康**:`subscribe ack sent replayed_to_seq=948 resync_required=true replay_rows=1000`。
- **客户端从不处理 ack**:今天只处理过 3 条 `resumed_from_seq=152`(空回放)ack,从未处理 `since=0 / replayed_to_seq=948`(大回放)ack。
- **死循环**:relay 反复收到 `since_notify_seq=0` 重订阅,每次截断回放同样 1000 条。
- **模式**:`since=152`(空回放)成;`since=0`(1000 条)败。触发 = 回放积压量。
- **独立复现**:`mpsc(256)` + handler 内顺序 `send().await`,边界精确 —— `current(256)=Ok`、`current(257)=DEADLOCK`、`current(300)=DEADLOCK`。

### 1.3 根因(relay 端死锁)

`backends/crates/chathub-relay/src/hub_service.rs::HubSvc::subscribe`(476–630):

```text
let (tx, rx) = mpsc::channel(256);          // L503 有界 256(按 live burst <10/s 设计)
tx.send(ack_frame).await;                    // L584 发 ack(1 帧)
for group in rows { send_replay_batch().await }  // L596–606 逐帧 send().await(可达 ~948 帧)
register_employee(...);                       // L609 注册实时
Ok(Response::new(ReceiverStream::new(rx)))    // L629 最后才返回流式 Response
```

tonic 服务端流式:**handler 必须先 `return Response`,框架才开始 drain `rx`**。但 handler 在返回前把 ack(1 帧)+ 全部 replay 帧(按 `notify_seq` 分组)灌进 `mpsc(256)`。

**精确阈值**:`ack + replay 总发送数 > 256` 即在第 257 次 `send().await` 永久阻塞 —— 即 **distinct-`notify_seq` 的 replay 帧数 ≥ 256**(256 replay + 1 ack = 257)就触发。日志里 "~948" 指 `replayed_to_seq` 水位,对应约 948 个 distinct-seq 帧。

阻塞 → handler 不返回 → 客户端 `subscribe()` 拿不到响应头 → 卡 `Connecting` → `.timeout(30s)` 触发 → 静默退避重连 → `since` 仍是 0 → relay 再死锁 → **无限循环**。

> 现有 subscribe 测试只覆盖小回放(≤3 行),从未覆盖 ≥256;随任一 employee 积压越过 256 即踩雷。

### 1.4 放大与不可见副作用

- **S1 `start()` 幂等陷阱**:run_loop 卡住时 `start()`(`hub.rs:1045`)静默 return,但 login(`lib.rs:128`)仍无条件打印 "ConnectionManager started" → 重登录全是空操作且日志误导。
- **S2 错误无埋点**:run_loop 的 `subscribe Err / Ok(None) / 退避`(`hub.rs:1111-1131 / 1250-1279`)全程无 `tracing`,失败路径在日志里"什么都没发生"。

---

## 2. 目标 / 非目标

**目标**:① 彻底修死锁(根因),所有存量客户端零升级自愈;② 把"上线收实时(subscribe)"与"数据全量对齐(REST resync)"物理解耦,消除大回放压力;③ 修掉"无法自愈/不可观测"的副作用;④ 每阶段独立可上线、独立回滚。

**非目标**:不改 `chathub-proto`(`SubscribeAck` 已有 `replayed_to_seq`/`resync_required`);不重构 messages/recents 的 reconcile 整体架构(但本方案要**硬化**其 resync 安全网,见 §6.4);不改鉴权/token。

---

## 3. 方案总览(C:四阶段,各自独立可上线)

| 阶段        | 内容                                         | 端             | 性质          | 部署序 |
| ----------- | -------------------------------------------- | -------------- | ------------- | ------ |
| **P1 — A**  | relay subscribe 死锁修复 + event_tx 背压     | relay + client | 根因/救火     | 1      |
| **P2 — S**  | S1 `start()` 幂等修正 + S2 错误埋点          | client         | 健壮性/可观测 | 2      |
| **P3 — B1** | 客户端游标推进(仅 resync 路径)+ 安全网硬化   | client         | 解耦/数据完整 | 3      |
| **P4 — B2** | relay resync 跳重放 + `replayed_to_seq=head` | relay          | 解耦/减压     | 4      |

> 注:event_tx 背压(原 MAJOR A)归入 P1 一并上,因为 A 修死锁后大回放才真正发得出去,不同步修会把死锁换成"5 秒一次重连抖动"。

---

## 4. P1 — A:relay subscribe 死锁修复

### 4.1 决策粒度:ack 同步发 + register 同步 + 只 spawn 回放循环

死锁的根源是**回放循环**(可达 ~948 帧),而非单帧 ack(1 帧在 256 缓冲上绝不阻塞)。故:

**保留在 `Response` 之前同步执行**(均不会死锁):

1. 鉴权、`employee_id==0` 早失败(返回 `Status`)。
2. `earliest_for` / `query_since` / `notify_pull` backfill 查询、ack 字段计算。
3. **发 ack 帧**(`tx.send(ack)`,1 帧不阻塞);若失败(客户端已走)→ 早返回空流、不 spawn。
4. **`register_employee`**(同步)。

**移入 `tokio::spawn`**:回放帧循环(`for group in rows { send_replay_batch().await }`)+ cleanup task(`tx.closed()`)。

**`Response` 立即返回**。

### 4.2 为何这个顺序同时关掉死锁 + blocker(实时丢帧 / flaky 测试)

- **死锁修复**:唯一可能 >256 的回放循环放进 spawn,与框架 drain `rx` 并发 → 256 背压正常工作。
- **ack 仍是首帧**:ack 在 register 之前同步发,无任何 live/replay 帧能先于它 → 既有 `subscribe_full_stack_first_frame_is_subscribe_ack` 不破。
- **register 先于客户端可见 ack**:register 在 `Response` 返回之前同步完成;客户端只能在 `Response` 返回后读到 ack。故"读到 ack → 立即 push → 实时必达"成立 → 修复 blocker(原 §4 把 register 排在 replay 之后引入的实时丢帧窗口),且既有 e2e `subscribe_with_no_since_returns_ack_then_realtime_push` 不再 flaky。
- **flaky 测试消除**:`subscribe_first_connection_returns_ack_no_replay` 断言 `employee_connection_count==1` —— register 现在同步先于 `Response`,断言确定成立(无需改测试)。

### 4.3 顺序与正确性边界(实施须验证)

- register 之后,live fanout(`try_send`)可能与 spawn 内的回放帧**交错**:回放帧 `seq ≤ replayed_to_seq`、live `seq > replayed_to_seq`。
- 安全前提:四个 applier 均为 **LWW/版本门**(新值胜,与到达序无关),`notify_seq` 用 `upsert_if_greater` 单调。→ 交错对数据安全。
- **实施硬要求**:核验四个 applier(account/friend/recent_session/message)均满足 LWW 同 seq 重投幂等;新增"回放/实时交错"单测。

### 4.4 边界

- 客户端中途断:spawn 内 `send().await` 返 `Err` → producer break;cleanup task(`tx.clone()` 调 `tx.closed()`)照常 `drop_employee_stream`,无泄漏。
- `tx` 三份 clone:producer 持原 `tx` 发回放;register 用 `tx.clone()`;cleanup 用 `tx.clone()`。`Sender::closed()` 仅监视 receiver drop,与 sender clone 数无关。
- producer task 生命周期 = 直到回放 flush 完或 `rx` 关闭,**均有界**。

### 4.5 event_tx 背压(原 MAJOR A;决策:回放帧不走 event_tx 广播)

A 修死锁后,大回放真正发得出去,run_loop 对每帧 `self.event_tx.send`(`hub.rs:1239`)会瞬时灌爆 `event_tx` broadcast(256)(`hub.rs:998`)→ 前端 `hub:event` 消费慢 → `Lagged` → `lib.rs:1579` `stop()/start()` 重连 → 再大回放 → 5 秒一次重连抖动。

**修法(决策)**:**回放帧不走 `event_tx` 广播**。判定用**逐帧 seq 比较**(抗 live/replay 交错):run_loop 记下当次订阅 `ack.replayed_to_seq`;收到的 PushBatch 帧若 `pb.notify_seq <= replayed_to_seq` 视为回放帧 → 只跑 applier 落库 + 推进水位,**不** `self.event_tx.send`;`> replayed_to_seq` 视为 live 帧 → 正常广播。无需"回放中"模式状态,逐帧判断即可。

- 前端数据对齐本就走 applier 发的 `ChangeNotice`(hub:change)与 resync,不依赖每条 replay 帧的 `hub:event`。
- **实施硬要求**:核验 `hub:event` 消费者(`lib.rs:1562-1589` 桥接的前端侧)不依赖 replay 帧;补一句到实施计划。

### 4.6 测试(原 0 覆盖)

- **relay 单测**:构造 **≥256 个 distinct-`notify_seq`** 回放,断言 `subscribe()` 不阻塞、收齐 ack+全部帧。
- **relay e2e(纳入 P1 闭环,原 MAJOR E)**:真 gRPC server 订阅,relay 预置 **1001 distinct-seq**,断言 `subscribe()` 立即返回响应头(非 30s 后)+ 收齐 ack+全部帧 + 无重连。**`env -u ALL_PROXY` 跑**(否则 socks5 假失败)。
- 既有 4 个 subscribe 测试:`first_frame_is_ack`、`first_connection_ack_no_replay`、`employee_id_missing_rejected`、`since_replays_grouped` —— 本顺序下**均不破**。

### 4.7 自愈 & 风险

A 上线后所有卡死客户端**下次重连即恢复**,无需升级客户端。`subscribe` 仅 4 个 upstream 全为测试,风险 LOW。

---

## 5. P2 — S:客户端健壮性 + 可观测性

### 5.1 S1 — `start()` 幂等陷阱(决策:login 改 stop→start)

- `lib.rs:128` login 路径:`cm.start().await` → `cm.stop().await; cm.start().await;`(强制干净重连)。
- resume(`lib.rs:1537`)维持 `start()`;lag-reconnect(`lib.rs:1580`)已是 stop→start,不动。
- **边界(原 MAJOR F)**:`stop()` 用 `h.abort()`(`hub.rs:1060`),可能在四个 async applier 的 `.await` 链(`hub.rs:1213-1230`)中点切断,留下"部分 applier 落库 + `notify_seq` 未前进"中间态。方向安全(靠重连重放 + applier 同 seq 重投幂等兜底,**不是** abort 原子性),须随 §4.3 一起核验四个 applier 幂等。**禁止**后续把 abort 改成不 await 的 fire-and-forget(会破坏 start/stop 共用 task mutex 的串行保证 → 双 run_loop)。
- **已知体验抖动**:首登/正常态改 stop→start 会多发一次 `Disconnected`(`hub.rs:1063`)→ `hub:connection` UI 瞬时闪一下"离线"。前端对 `Disconnected` 做 <300ms 去抖即可,标注为已知,不阻断。

### 5.2 S2 — run_loop 错误埋点(零行为改动)

`hub.rs::Inner::run_loop` 补 `tracing`(target `chathub_net::hub`):每轮 `Connecting since=<n>`、`Subscribed`、`subscribe/stream Err`(打 classify 结果+错误)、`Ok(None) 服务端关流`、`backoff sleep <dur>`。

---

## 6. P3/P4 — B:登录/Resync/Subscribe 解耦

### 6.1 B1 — 客户端游标推进(P3;**仅 resync_required 路径**,原 BLOCKER 1 修正)

`hub.rs` run_loop 处理 `SubscribeAck`:

- **`ack.resync_required == true`**:`notify_seq_store.upsert_if_greater(ack.replayed_to_seq)` —— 游标跳到 head/水位。该路径 B2 不发重放帧,且 resync 信号已让上层走 REST 全量兜底,提前推进安全。
- **`ack.resync_required == false`**:**不**从 ack 推游标 —— 维持现状 apply-then-advance(只靠 PushBatch 经 applier 落库后 `upsert_if_greater(pb.notify_seq)`,`hub.rs:1233`)。

> **为何必须区分**(原 BLOCKER 1):relay 是 ack 先发、replay 帧后发,ack 的 `replayed_to_seq` 预告了"还没落库"的帧最高 seq。在 `false` 小回放路径从 ack 提前推游标 = 在落库前推进 → 崩溃重启跳过这批、且无 REST 兜底 → 永久丢。这正是 `hub.rs:1207` apply-then-advance 注释要防的。从 ack 推进(落库前)与从重放帧推进(落库后)**崩溃语义不同,不是幂等关系**。

### 6.2 B2 — relay resync 跳重放(P4)

`hub_service.rs::subscribe`,当 `resync_required == true`(截断 `more_available` 或缺口 `needs_pull`):

- `replayed_to_seq` 设为 **employee 当前 head seq**:新增 `SELECT MAX(notify_seq)` 查询;**空表回退为 `since`**(`head = max.unwrap_or(since)`,原 MAJOR D —— 换机/全损 `RELAY_LOG_MISSING` 场景 MAX 返回 NULL)。
- **跳过重放帧发送**(`for group in rows` 不执行)。
- ack 照发(`resync_required=true` + `replayed_to_seq=head`)。
- **head 是查询时刻快照**:`(head, register 时刻]` 之间的事件由"下次 `subscribe(since=head)` 续点"兜底,与现有 replay-window 语义一致;`register_employee` 仍在 ack 之后。

`resync_required == false`(正常小回放)路径不变:照发重放帧,`replayed_to_seq = rows.last()`(此时即 head)。

### 6.3 解耦后的数据流(B 完成态)

```text
落后/换机客户端登录 → subscribe(since=old) → relay 判 backlog>cap 或有缺口
  → ack(replayed_to_seq=head, resync_required=true, 无重放帧)
  → 客户端:① notify_seq=head(B1,仅 resync 路径)
            ② 广播 ResyncSignal → 前端 REST 全量对齐(硬化后,见 §6.4)
            ③ 流保持 → 收实时 push
  → 下次 subscribe(since=head) → 无重放
```

### 6.4 崩溃窗口 + 安全网硬化(原 MAJOR B/C 修正;决策:硬化)

B2 下,游标在 ack 跳到 head 而 REST 对齐异步未完成时崩溃,会丢这段对齐。v1 称靠 cold-align/reconcile 自愈,**验证发现对活跃用户大面积失效**,故硬化:

1. **recents(原 MAJOR C)**:resync 的对齐当前经 `prefill_to_watermark`,在 `local_count >= 200`(`lib.rs:881-888`)直接短路返回 0 行。改:resync 的 recents 对齐 `force` 透传到后端,**跳过 local_count 短路**,做首页 LWW 重拉。
2. **账号(原 MAJOR C)**:resync 走 `useResource.doFetch → queryFn(force=false)` 只读缓存(`accounts.ts:29-31`),不拉 `listMine`。改:resync 路径对 accounts **置 `force=true`**。
3. **温缓存会话(原 MAJOR C)**:漏消息从未落本地 → 重启后水位 `c>=r` 命中"水位门 fresh"(`lib.rs:466`)零网络不 reconcile。改:resync 后对受影响/打开会话**忽略 fresh 一次**,强制一次绕过水位门的 `reconcile_newest`。
4. **已打开会话气泡(原 MAJOR B;决策)**:B2 跳重放后,`reconcile_newest` 的触发恰依赖被跳的 MESSAGE_UPSERT push,故不触发 → 气泡稳态延迟对齐。改:**resync 信号额外对"当前打开的会话"主动触发一次 `reconcile_newest`**(绕过水位门),补齐气泡。
5. **残余有界风险**:未打开会话仍为"惰性自愈(按用户打开触发)";最坏丢失量 = `head − old`(可远超 1000)。承认为已知有界风险并在文档点名。

### 6.5 部署序硬门槛(原 minor 修正)

旧客户端(无 B1)遇 B2 的"无重放帧 resync ack"会 `since` 不前进 → 每次重连 `resync→REST 全量→since 不变→再 resync` 的**稳态放大循环**(数据不丢,因 resync 广播是既有代码;但带宽/CPU 放大 + 反复"对齐中")。故 **B2 上线以"B1 客户端覆盖率达阈值"为硬门槛**(阈值在实施计划定),而非仅排序在后。

---

## 7. 向后兼容 & 部署序

1. **P1 A + event_tx 背压**先上(救火;A relay 改 + event_tx 客户端改,需同版本)。
2. **P2 S** 随客户端版本上。
3. **P3 B1 + 安全网硬化** 上(客户端,兼容旧 relay)。
4. **P4 B2** 最后上(relay;以 B1 覆盖率达标为门槛)。

每阶段独立 commit/PR,独立 revert。

---

## 8. 测试策略

- **A**:relay 单测 ≥256 distinct-seq 不阻塞 + e2e 1001 帧不阻塞/不重连(`env -u ALL_PROXY`);回放/实时交错单测;四 applier LWW 幂等核验。
- **event_tx**:大回放期不再触发 Lagged→stop/start(日志验证无 "hub event lag")。
- **B1**:单测 —— `resync_required=true` 从 ack 推 `notify_seq`;`false` 路径不从 ack 推(仍 apply-then-advance)。
- **B2**:单测 —— `resync_required` 时 `replayed_to_seq=head` 且不发重放帧;**空表 + since>0 + backfill 失败** 格断言 `replayed_to_seq==since`。
- **安全网硬化**:手动 —— 活跃用户(recents≥200 / 温缓存 / 有账号)崩溃后 resync 真拉到数据。
- **S1/S2**:手动 + 日志。

---

## 9. 回滚

四阶段四独立 commit。A 可独立 revert(回死锁但不影响 S/B);B2(relay)可独立 revert 回"发重放帧"(此时 A 已修死锁,大回放不再死锁,仅恢复重放开销)。

---

## 10. 影响面(gitnexus_impact,均 LOW)

- `HubSvc::subscribe`(relay):4 upstream 全为测试。
- `Inner::run_loop` / `ConnectionManager::start`(client):0 upstream;`start` 实际调用点 `lib.rs` login/resume/lag-reconnect 三处。

---

## 11. 已被代码核实成立的关键论断(给信心)

死锁根因+精确边界(复现 256=OK/257=死锁);P1-A spawn 确实解锁且不乱序/不增内存/无泄漏;`.timeout(30s)`(tonic 0.12.3)只 bound 响应头到达、不杀健康长流;proto 无需改;`NotifySeqStore` SQLite 单调幂等;多设备同 employee 不互污(per-device 游标);apply-then-advance 真实且有意为之;`start()` 幂等陷阱属实、stop/start 共用 task mutex 串行不产生双 run_loop;"B1 先于 B2"方向正确。

---

## 12. 实施计划入口

进入 writing-plans,按 P1(A + event_tx + applier 幂等核验 + 单测/e2e)→ P2(S1/S2)→ P3(B1 仅 resync 推 + 安全网硬化四项)→ P4(B2 head/跳帧/空表回退)拆分为可独立验证的步骤,每步带测试与验证命令。

---

## 13. v2 修订记录(多代理验证后)

| 原问题                                                          | 严重度  | 修正                                                         |
| --------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| B1 无条件从 ack 推游标破坏 apply-then-advance(小回放崩溃丢数据) | BLOCKER | §6.1 改为**仅 resync_required 路径**推                       |
| A 把 register 排在 replay 后 → 实时丢帧窗口 + flaky 测试        | BLOCKER | §4.1 改为 **ack 同步发 → register 同步 → 只 spawn 回放循环** |
| "现有 4 测试原样保留/不破"不成立                                | BLOCKER | §4.2 新顺序下确实不破(register 同步先于 Response)            |
| 大回放灌爆 event_tx → Lagged→stop/start 抖动                    | MAJOR   | §4.5 **回放帧不走 event_tx 广播**                            |
| B2 跳重放 → 打开会话气泡稳态延迟                                | MAJOR   | §6.4(4) **resync 额外触发当前会话 reconcile**                |
| 崩溃安全网对活跃用户失效                                        | MAJOR   | §6.4(1-3) **硬化 recents/账号/温缓存对齐**                   |
| B2 head 空表未定义                                              | MAJOR   | §6.2 **head=MAX.unwrap_or(since)**                           |
| relay e2e 根因零覆盖                                            | MAJOR   | §4.6 e2e 纳入 P1 闭环                                        |
| S1 abort 切断正在 apply 的批                                    | MAJOR   | §5.1 记录边界 + 核验 applier 幂等                            |
| 阈值表述/producer 生命周期/首登抖动/多设备 等                   | minor   | §1.3 / §4.4 / §5.1 / §11 已补                                |
