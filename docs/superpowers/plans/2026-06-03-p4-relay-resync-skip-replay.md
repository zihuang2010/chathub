# P4 — B2:relay resync 跳重放 + `replayed_to_seq=head` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 relay `subscribe` 判定 `resync_required == true`(回放截断 `more_available` 或缺口补偿失败 `needs_pull`)时,**不再逐帧发送回放帧**,而是把 ack 的 `replayed_to_seq` 直接设为该 employee 当前 head seq(`SELECT MAX(notify_seq)`),客户端据此(配合 P3-B1)把游标跳到 head 并走 REST 全量对齐。从根上消除"截断 → 客户端 since 不前进 → 反复重放同一批 1000 条"的稳态放大循环。`resync_required == false`(正常小回放)路径完全不变:照发重放帧、`replayed_to_seq = rows.last()`。

**Architecture:** relay 侧 `events.rs` 新增 `latest_for(employee_id) -> Option<i64>`(`SELECT MAX(notify_seq)`,镜像现有 `earliest_for` 的实现模板)。`hub_service.rs::subscribe` 在 ack 字段计算处分叉:`resync_required == true` → `replayed_to_seq = latest_for().unwrap_or(since)`(**空表/MAX=NULL 回退 since**,覆盖换机/全损 `RELAY_LOG_MISSING` 场景),并令回放循环短路(不发任何 PushBatch 帧);`resync_required == false` → 维持现状。本阶段叠加在 **P1 已落地**(ack 同步发 → register 同步 → 回放循环移入 `tokio::spawn`)之上,故回放循环改动落在 P1 改后的 spawn 块内。

**Tech Stack:** Rust(tonic 0.12 / tokio mpsc / rusqlite via deadpool `interact`)。relay crate `chathub-relay`。测试:`cargo test`(单测 + e2e),e2e 须 `env -u ALL_PROXY`。

**对应 spec:** `docs/superpowers/specs/2026-06-03-subscribe-deadlock-fix-and-resync-decoupling-design.md` §6.2(B2 head/跳帧/空表回退)、§6.5(部署序硬门槛)、§8(B2 测试)。

---

## 前置依赖(必须先确认)

> **硬前置:P1 必须已落地。** 本计划的 Task 2 改的是 P1 之后的 `subscribe` 结构 —— 回放循环已被移入 `tokio::spawn`(P1 计划 Task 2),ack 在 spawn 之前同步发出。**实施前先 Read `hub_service.rs::subscribe` 当前形态确认 P1 已合入**(回放循环在 `tokio::spawn(async move { ... })` 内)。若仓库尚未合入 P1(回放循环仍在 handler 主体、L596–606 那段),**停止**,先完成 P1。Task 2 的代码块同时给出「P1 已合入」的目标形态;如发现结构与 P1 计划描述不符,在此标 **TODO(需主工程师确认 subscribe 当前结构)** 再继续。

---

## 文件结构

| 文件                                                  | 职责                        | 改动                                                                                     |
| ----------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `backends/crates/chathub-relay/src/storage/events.rs` | hub_events 表读写           | 新增 `latest_for(employee_id) -> Option<i64>`(`SELECT MAX(notify_seq)`);新增单测         |
| `backends/crates/chathub-relay/src/hub_service.rs`    | relay `Hub::subscribe` 实现 | resync 路径:`replayed_to_seq = latest_for().unwrap_or(since)` + 跳过回放帧;新增 3 个单测 |
| `backends/crates/chathub-relay/tests/relay_e2e.rs`    | 真 gRPC server e2e          | 新增「1001 帧截断 → 无重放帧、replayed_to_seq=head、客户端不 loop」e2e                   |

---

## Task 1: `events.rs` 新增 `latest_for`(SELECT MAX(notify_seq))

**Files:**

- Modify: `backends/crates/chathub-relay/src/storage/events.rs`(在 `earliest_for` 之后、`cleanup_older_than` 之前,约 L159 后插入实现;测试模块 L186 后插入单测)

`latest_for` 用于 resync 路径取 employee 当前 head seq。镜像 `earliest_for`(L139–159)的 deadpool `interact` + rusqlite 模板,只把排序/聚合改为 `MAX(notify_seq)`。`SELECT MAX(...)` 在空表返回一行 `NULL` → 用 `Option<i64>` 列读取(`r.get::<_, Option<i64>>(0)`),空表得到 `Some(None)` → 归一为 `None`。

- [ ] **Step 1: 写失败单测**

在 `events.rs` 测试模块(`mod tests`)内、`event_log_earliest_for_returns_min_notify_seq`(L298–312)之后插入:

```rust
    #[tokio::test]
    async fn event_log_latest_for_returns_max_notify_seq() {
        let log = make_log().await;
        log.insert_batch(vec![
            row(1, 200, 0, "MESSAGE_UPSERT"),
            row(1, 100, 0, "MESSAGE_UPSERT"),
            row(1, 150, 0, "MESSAGE_UPSERT"),
        ])
        .await
        .unwrap();
        // 同一 notify_seq 多 event_index 不应改变 MAX。
        log.insert_batch(vec![row(1, 200, 1, "SESSION_SUMMARY_UPSERT")])
            .await
            .unwrap();
        assert_eq!(log.latest_for(1).await.unwrap(), Some(200));
    }

    #[tokio::test]
    async fn event_log_latest_for_empty_returns_none() {
        let log = make_log().await;
        // 空表 / 该 employee 无任何行:MAX(notify_seq) 返回 NULL → None。
        assert_eq!(log.latest_for(999).await.unwrap(), None);
    }

    #[tokio::test]
    async fn event_log_latest_for_isolates_per_employee() {
        let log = make_log().await;
        log.insert_batch(vec![row(1, 100, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        log.insert_batch(vec![row(2, 500, 0, "MESSAGE_UPSERT")])
            .await
            .unwrap();
        // employee 2 的 head 不污染 employee 1。
        assert_eq!(log.latest_for(1).await.unwrap(), Some(100));
        assert_eq!(log.latest_for(2).await.unwrap(), Some(500));
    }
```

- [ ] **Step 2: 跑测试确认失败(方法不存在 → 编译错)**

Run: `cd backends && cargo test -p chathub-relay --lib event_log_latest_for -- --nocapture`
Expected: FAIL —— 编译错 `no method named \`latest_for\` found for struct \`EventLog\``(方法尚未实现)。

- [ ] **Step 3: 实现 `latest_for`**

在 `events.rs` 中 `earliest_for`(以 `Ok(row)\n    }` 结尾,约 L159)之后、`cleanup_older_than`(L163)之前插入:

```rust
    /// 返回该 employee 当前事件日志中最大的 notify_seq(head 水位)。
    /// 用于 resync 路径:`replayed_to_seq` 直接跳到 head,跳过逐帧重放。
    /// 空表 / 该 employee 无任何行时 `SELECT MAX(...)` 返回 NULL → `None`
    /// (调用方据此回退为 `since`,覆盖换机 / 日志全损场景)。
    pub async fn latest_for(&self, employee_id: i64) -> Result<Option<i64>, StorageError> {
        let conn = self.storage.conn().await?;
        let row = conn
            .interact(move |c| -> Result<Option<i64>, rusqlite::Error> {
                let mut stmt = c.prepare(
                    "SELECT MAX(notify_seq) FROM hub_events WHERE employee_id = ?1",
                )?;
                // MAX 在空集上返回一行 NULL → Option<i64> 列读取得 None。
                let max: Option<i64> =
                    stmt.query_row(rusqlite::params![employee_id], |r| r.get(0))?;
                Ok(max)
            })
            .await
            .map_err(|e| StorageError::Interact(e.to_string()))??;
        Ok(row)
    }
```

> 说明:`stmt.query_row` 对 `SELECT MAX(...)` 必有一行(聚合查询恒返回单行),空集那行的值为 SQL `NULL`,rusqlite 把 `NULL` 映射到 `Option<i64>::None`。与 `earliest_for` 用 `query_map + next()` 不同(后者是非聚合、空集零行),此处用 `query_row` 更贴切。

- [ ] **Step 4: 跑单测确认通过**

Run: `cd backends && cargo test -p chathub-relay --lib event_log_latest_for`
Expected: PASS —— `event_log_latest_for_returns_max_notify_seq`、`event_log_latest_for_empty_returns_none`、`event_log_latest_for_isolates_per_employee` 三绿。

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-relay/src/storage/events.rs
git commit -m "feat(relay): events 新增 latest_for(SELECT MAX(notify_seq)) 取 head 水位"
```

---

## Task 2: subscribe resync 路径 —— `replayed_to_seq=head` + 跳过回放帧

**Files:**

- Modify: `backends/crates/chathub-relay/src/hub_service.rs`(`subscribe`:`replayed_to_seq` 计算处 ~L571;P1 改后 spawn 内的回放循环)

当前(P1 已合入态)`replayed_to_seq` 由 `rows.last()` 决定(L571),回放循环在 spawn 内逐组发 PushBatch。改为:`resync_required == true` 时 `replayed_to_seq = latest_for().unwrap_or(since)`、且回放循环不执行(`rows` 清空或加守卫跳过);`resync_required == false` 路径不变。

> **设计要点(与 spec §6.2 对齐):**
>
> - `resync_required` 在两处可置真:① needs_pull 补偿失败(L540);② 截断 `more_available`(L559)。两条都走 head 跳帧分支。
> - head 取 `latest_for`(真·全表 MAX),**不是** `rows.last()`(截断后的 last 只是窗口内第 1000 条,远小于 head)。这正是 spec 要的"跳到 head/水位"。
> - **空表回退 since**:`latest_for().unwrap_or(since)`。换机/全损 `RELAY_LOG_MISSING` 场景日志空 → `latest_for=None` → `replayed_to_seq=since`(客户端游标不倒退,REST 全量兜底)。
> - **跳帧实现选 rows 清空**:在 resync 分支把待回放的 `rows` 清空(`rows.clear()`),P1 spawn 内的回放循环对空 `rows` 自然零迭代,无需在循环里加 seq 比较守卫。`replayed_to_seq` 必须在 `rows.clear()` **之前或用独立变量**算好(不依赖被清空的 rows)。

- [ ] **Step 1: 写失败单测(3 个)**

在 `hub_service.rs` 测试模块,`subscribe_with_since_replays_events_grouped_by_notify_seq`(以 `}` 结束,约 L1069)之后插入:

```rust
    /// B2:resync_required(此处由截断触发,>REPLAY_LIMIT 行)→ ack.replayed_to_seq 跳到
    /// head(latest_for=MAX),且**不发任何回放帧**(回放循环短路)。
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_resync_skips_replay_and_acks_head() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;

        // 1001 个 distinct notify_seq(>REPLAY_LIMIT=1000)→ 截断 → resync_required。
        // head = MAX(notify_seq) = 1001(而非截断窗口内的 last=1000)。
        let rows: Vec<EventRow> = (1..=1001_i64)
            .map(|seq| make_event_row(42, seq, 0))
            .collect();
        svc.events_log.insert_batch(rows).await.unwrap();

        let resp = svc.subscribe(sub_request("dev-A", 0)).await.unwrap();
        let mut stream = resp.into_inner();

        // 首帧:ack.resync_required=true 且 replayed_to_seq=1001(head),不是 1000。
        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert!(ack.resync_required, "1001>1000 → 截断 → resync");
                assert_eq!(ack.replayed_to_seq, 1001, "replayed_to_seq 应=head(MAX),非截断 last");
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }

        // 后续不应有任何 PushBatch 帧:resync 跳重放。给短 timeout,超时即"无帧"(符合预期)。
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            StreamExt::next(&mut stream),
        )
        .await;
        match next {
            Err(_) => {} // 超时 = 无更多帧,正确。
            Ok(Some(Ok(ev))) => panic!("resync 路径不应发回放帧,却收到 {:?}", ev.body),
            Ok(other) => panic!("意外的流终止:{other:?}"),
        }
    }

    /// B2 空表回退(spec §6.2 / MAJOR D):日志空 + since>0 + notify_pull 失败 → resync_required,
    /// latest_for=None → replayed_to_seq 回退为 since,且不发回放帧。
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_resync_empty_log_falls_back_to_since() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        // notify_pull 503 → 补偿失败 → resync 兜底(needs_pull 路径)。
        mount_notify_pull_status(&mock, 503).await;
        let svc = build_svc(&mock).await;
        // 不插任何 hub_events → 日志空 → latest_for=None。

        // since=10 > 0 且日志空 → needs_pull;补偿失败 → resync_required。
        let resp = svc.subscribe(sub_request("dev-A", 10)).await.unwrap();
        let mut stream = resp.into_inner();

        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert!(ack.resync_required, "空日志+since>0+pull失败 → resync");
                assert_eq!(ack.replayed_to_seq, 10, "空表 latest_for=None → 回退 since=10");
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }

        // 无回放帧。
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            StreamExt::next(&mut stream),
        )
        .await;
        assert!(
            matches!(next, Err(_)),
            "resync 空表路径不应发回放帧"
        );
    }

    /// B2 不影响正常小回放:resync_required=false → 照发重放帧、replayed_to_seq=rows.last()。
    /// (回归保护,确保 B2 分叉没把非 resync 路径带歪。)
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_non_resync_still_replays_frames() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;
        // since=100,日志含 101/102 → earliest=101=since+1 → 无缺口 → 不截断 → resync_required=false。
        svc.events_log
            .insert_batch(vec![
                make_event_row(42, 101, 0),
                make_event_row(42, 102, 0),
            ])
            .await
            .unwrap();

        let resp = svc.subscribe(sub_request("dev-A", 100)).await.unwrap();
        let mut stream = resp.into_inner();

        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match first.body {
            Some(Body::SubscribeAck(ack)) => {
                assert!(!ack.resync_required, "earliest=since+1 → 无缺口 → 不 resync");
                assert_eq!(ack.replayed_to_seq, 102, "非 resync:replayed_to_seq=rows.last()");
            }
            other => panic!("expected SubscribeAck, got {other:?}"),
        }
        // 照发 2 个回放帧 101、102。
        let f2 = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match f2.body {
            Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 101),
            other => panic!("expected PushBatch 101, got {other:?}"),
        }
        let f3 = StreamExt::next(&mut stream).await.unwrap().unwrap();
        match f3.body {
            Some(Body::PushBatch(pb)) => assert_eq!(pb.notify_seq, 102),
            other => panic!("expected PushBatch 102, got {other:?}"),
        }
    }
```

> **TODO(需主工程师确认 mock helper 可见性):** `subscribe_resync_empty_log_falls_back_to_since` 用到 `mount_notify_pull_status`。该 helper 现存于 e2e 的 `tests/common/mod.rs`,**hub_service.rs 单测模块未必有同名 helper**。实施时先 `grep -n "mount_notify_pull_status\|fn mount_notify_pull" backends/crates/chathub-relay/src/hub_service.rs` 确认:
>
> - 若单测模块**已有** `mount_notify_pull_status`(或等价的"让 backfill 失败"的 mock),直接用;
> - 若**没有**,在 hub_service.rs 单测模块内补一个最小 helper(挂 notify/pull 返回 503):
>   ```rust
>   async fn mount_notify_pull_503(mock: &MockServer) {
>       Mock::given(method("POST"))
>           .and(path("/wechat-business-app/rpc/v1/wecomAggregate/notify/pull"))
>           .respond_with(ResponseTemplate::new(503))
>           .mount(mock)
>           .await;
>   }
>   ```
>   并把测试里的 `mount_notify_pull_status(&mock, 503).await;` 改为 `mount_notify_pull_503(&mock).await;`。**路径常量** `/wechat-business-app/rpc/v1/wecomAggregate/notify/pull` 取自 `tests/common/mod.rs::mount_notify_pull_status`,实施前再核对一次该路径与 hub_service backfill 实际请求路径一致。

- [ ] **Step 2: 跑这 3 个测试确认失败**

Run: `cd backends && cargo test -p chathub-relay --lib subscribe_resync_skips_replay_and_acks_head subscribe_resync_empty_log_falls_back_to_since subscribe_non_resync_still_replays_frames -- --nocapture`
Expected:

- `subscribe_resync_skips_replay_and_acks_head` FAIL —— 现状 `replayed_to_seq=1000`(截断 last)≠ 1001,且仍发 1000 个回放帧(收到 PushBatch 而非超时)。
- `subscribe_resync_empty_log_falls_back_to_since` —— 现状 `replayed_to_seq` 由 `rows.last().unwrap_or(since)` 算,空 rows 已是 `since=10`,ack 字段碰巧对;但若现状在某些路径发帧则 panic。**此测试在改前可能部分通过**,改后必须稳定通过(主要锁定"回退语义不被 B2 改坏")。
- `subscribe_non_resync_still_replays_frames` —— 现状应已 PASS(回归基线)。

> 关键失败信号是 `subscribe_resync_skips_replay_and_acks_head` 的 `replayed_to_seq 应=head` 断言。

- [ ] **Step 3: 改 `subscribe` —— resync 分支算 head + 清空 rows 跳帧**

定位 `hub_service.rs` 中 `let replayed_to_seq = rows.last().map(|r| r.notify_seq as u64).unwrap_or(since);`(P1 后约 L571,在 truncation 块之后、ack_frame 构造之前)。把这一行替换为:

```rust
        // B2(spec §6.2):resync_required 时 ack 直接报 head(MAX(notify_seq)),并跳过逐帧重放,
        // 让客户端(P3-B1)把游标跳到 head + 走 REST 全量对齐,消除"截断→since不前进→反复重放"循环。
        // 空表 / 日志全损 → latest_for=None → 回退 since(游标不倒退)。
        let replayed_to_seq = if resync_required {
            let head = self
                .events_log
                .latest_for(ctx.employee_id)
                .await
                .map_err(|e| Status::from(RelayError::from(e)))?
                .map(|s| s as u64)
                .unwrap_or(since);
            // 跳重放:清空待发回放集,P1 spawn 内的回放循环对空 rows 零迭代。
            rows.clear();
            head
        } else {
            // 正常小回放路径不变:replayed_to_seq = 窗口内最后一条(此时即 head)。
            rows.last().map(|r| r.notify_seq as u64).unwrap_or(since)
        };
```

> **改动充分性核对:** 此改动**只**动 `replayed_to_seq` 的计算并在 resync 时 `rows.clear()`。P1 已把回放循环移入 `tokio::spawn(async move { ... for i in 0..rows.len() ... })`,`rows` 被 move 进 spawn —— `rows.clear()` 必须在 `rows` 被 move 进 spawn **之前**执行(本改动位置在 ack 构造前,远早于 spawn,满足)。spawn 内回放循环 `for i in 0..rows.len()` 对空 `rows` 自然零迭代,**无需改 spawn 块本身**。`ack_frame` 用此 `replayed_to_seq`、tracing 的 `replay_rows = rows.len()` 在 resync 时变 0(符合"不发帧"语义)。

- [ ] **Step 4: 跑 Step 1 的 3 个测试,确认通过**

Run: `cd backends && cargo test -p chathub-relay --lib subscribe_resync_skips_replay_and_acks_head subscribe_resync_empty_log_falls_back_to_since subscribe_non_resync_still_replays_frames`
Expected: PASS —— 三绿。

- [ ] **Step 5: 跑全部 subscribe 单测,确认既有不破**

Run: `cd backends && cargo test -p chathub-relay --lib subscribe_`
Expected: PASS —— 既有 `first_connection_returns_ack_no_replay`、`with_since_replays_events_grouped_by_notify_seq`、`rejects_when_employee_id_missing` + P1 的 `with_large_replay_does_not_deadlock` + 本任务 3 个新测,全绿。

> 注:`with_since_replays_events_grouped_by_notify_seq` 断言 `resync_required==true` 且 `replayed_to_seq==101`。该测试 since=50、earliest=100>since+1 → needs_pull → 走 resync 分支。**改后 `replayed_to_seq` 变为 head=MAX=101**(该 fixture head 恰为 101,与原断言值相同),但**回放帧会被跳过** —— 原测试 Step 还断言收到 PushBatch(100)、PushBatch(101)。**这两帧在 B2 后不再发送 → 该既有测试会 FAIL。**

> **TODO(需主工程师确认既有测试取舍):** `subscribe_with_since_replays_events_grouped_by_notify_seq` 在 B2 后语义改变(resync 路径不再发回放帧)。两个合理处理:
>
> 1. **改造该测试**:把它从"resync + 回放"改为只断言 ack 字段(`resync_required==true`、`replayed_to_seq==101`)+ 无后续 PushBatch 帧(与 `subscribe_resync_skips_replay_and_acks_head` 同模式),删掉对 PushBatch(100)/(101) 的断言;
> 2. **改 fixture 使其落非 resync 路径**:把 since 调到 99(earliest=100=since+1 → 无缺口 → resync_required=false)→ 保留回放断言。
>    倾向**方案 1**(直接表达 B2 新语义),但这等于改写既有测试,超出"最小改动"默认,**需主工程师拍板**。实施时先与主工程师确认后再动该测试;在确认前**不要**把它标记为通过。

- [ ] **Step 6: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-relay/src/hub_service.rs
git commit -m "fix(relay): resync 路径 replayed_to_seq 跳到 head 并跳过重放帧(空表回退 since)"
```

---

## Task 3: e2e —— 1001 帧截断场景:无重放帧、replayed_to_seq=head、客户端不 loop

**Files:**

- Modify(test): `backends/crates/chathub-relay/tests/relay_e2e.rs`(接在 `subscribe_with_since_replays_persisted_events` 之后,约 L403 后)

P1 的 e2e(`subscribe_with_huge_backlog_does_not_deadlock`)断言 1001 帧**不死锁**且**收齐 1000 帧**。B2 改语义后:1001 帧截断 → resync → **零回放帧**、`replayed_to_seq=1001`(head)。本 e2e 在真 gRPC server 下锁定 B2 新语义,并验证"客户端拿到 head 后下次 `subscribe(since=head)` 不再触发重放"(消除 loop)。

> **TODO(需主工程师确认与 P1 e2e 的关系):** P1 e2e `subscribe_with_huge_backlog_does_not_deadlock` 断言"收齐 1000 回放帧"。B2 上线后该断言**不再成立**(零帧)。两测试**互斥**,不能同时存在。处理:实施 B2 时**改写** P1 那个 e2e 为本任务的 B2 版本(或删旧加新)。倾向直接把 P1 e2e 升级成 B2 语义(下方测试体),并在 commit message 注明"P1 e2e 的回放帧断言随 B2 失效,改为断言跳帧"。**需主工程师确认**是否保留 P1 e2e 的历史形态(如保留则需给它换一个不会触发截断的小 backlog 才能继续断言收帧)。

- [ ] **Step 1: 写 e2e 测试**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn subscribe_resync_truncation_skips_replay_and_acks_head() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-big", 88, "dev-A").await;

    // 预置 1001 个 distinct notify_seq(>REPLAY_LIMIT=1000 → 截断 + resync_required)。
    // head = MAX = 1001。
    let rows: Vec<chathub_relay::storage::events::EventRow> = (1..=1001_i64)
        .map(|seq| chathub_relay::storage::events::EventRow {
            employee_id: 88,
            notify_seq: seq,
            event_index: 0,
            event_type: "MESSAGE_UPSERT".into(),
            event_reason: Some("CUSTOMER_MESSAGE_RECEIVED".into()),
            conversation_id: Some("conv-1".into()),
            customer_user_id: Some("u-c".into()),
            external_user_id: Some("ext-1".into()),
            client_id: "rh_wxchat".into(),
            batch_id: Some(format!("rh_wxchat:88:{seq}")),
            batch_time: Some("2026-05-14 10:30:00".into()),
            event_time: Some("2026-05-14 10:30:00".into()),
            payload_json: r#"{"eventType":"MESSAGE_UPSERT"}"#.into(),
            created_at_ms: seq * 1000,
        })
        .collect();
    h.events_log.insert_batch(rows).await.unwrap();

    let ch = raw_channel(h.grpc_addr).await;
    let mut hub = hub_client(ch, "tok-big".into());

    // 第一次订阅 since=0:截断 → resync,ack 报 head=1001,无回放帧。
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        hub.subscribe(SubscribeRequest {
            since_notify_seq: 0,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        }),
    )
    .await
    .expect("subscribe 必须立即返回响应头")
    .unwrap()
    .into_inner();

    let first = stream.next().await.unwrap().unwrap();
    match first.body {
        Some(Body::SubscribeAck(ack)) => {
            assert!(ack.resync_required, "1001>1000 → 截断 → resync");
            assert_eq!(ack.replayed_to_seq, 1001, "ack 报 head(MAX),非截断 last(1000)");
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }

    // 不应有任何回放帧:resync 跳重放。短 timeout 内无帧 = 正确。
    let next =
        tokio::time::timeout(std::time::Duration::from_millis(500), stream.next()).await;
    assert!(
        next.is_err(),
        "resync 截断路径不应发回放帧,却收到了一帧"
    );
    drop(stream); // 断开第一条流,释放注册。

    // 第二次订阅 since=head(=1001):无新事件 → 无截断 → resync_required=false、零回放帧。
    // 这就是 B1+B2 消除 loop 的体现:客户端把游标推到 head 后不再被反复重放轰炸。
    let ch2 = raw_channel(h.grpc_addr).await;
    let mut hub2 = hub_client(ch2, "tok-big".into());
    let mut stream2 = hub2
        .subscribe(SubscribeRequest {
            since_notify_seq: 1001,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        })
        .await
        .unwrap()
        .into_inner();
    let ack2 = stream2.next().await.unwrap().unwrap();
    match ack2.body {
        Some(Body::SubscribeAck(ack)) => {
            assert!(!ack.resync_required, "since=head 无积压 → 不再 resync(loop 消除)");
            assert_eq!(ack.replayed_to_seq, 1001);
        }
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    let none =
        tokio::time::timeout(std::time::Duration::from_millis(500), stream2.next()).await;
    assert!(none.is_err(), "since=head 续点不应有任何回放帧");
}
```

> **签名核对:** `EventRow` 字段(`employee_id/notify_seq/event_index/event_type/event_reason/conversation_id/customer_user_id/external_user_id/client_id/batch_id/batch_time/event_time/payload_json/created_at_ms`)、`h.events_log.insert_batch`、`raw_channel`/`hub_client`/`SubscribeRequest{since_notify_seq,device_id,client_version}`、`Body::{SubscribeAck,PushBatch}` 均与 `tests/common/mod.rs` + `relay_e2e.rs` 现有用法一致。`since=head` 续点 ack 的 `replayed_to_seq` 值:since=1001 且无 >1001 的行 → 非 resync 路径 `rows.last().unwrap_or(since)` = `since` = 1001。

- [ ] **Step 2: 跑 e2e,确认通过**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-relay --test relay_e2e subscribe_resync_truncation_skips_replay_and_acks_head -- --nocapture`
Expected: PASS。

> 必须 `env -u ALL_PROXY`,否则 socks5 代理导致 e2e 假失败(见团队约定)。

- [ ] **Step 3:(可选)确认它能抓 bug**

临时 `git stash`(回到 Task 2 改 `subscribe` 之前)再跑此 e2e → 应在 `ack 报 head(MAX),非截断 last` 断言处失败(现状报 1000),或在"不应发回放帧"处失败(现状发 1000 帧)。确认后 `git stash pop` 恢复。

- [ ] **Step 4: 跑全部 relay e2e,确认无回归**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-relay --test relay_e2e`
Expected: PASS。

> 若按 Step 上方 TODO 改写/删除了 P1 e2e `subscribe_with_huge_backlog_does_not_deadlock`,确认它已不存在或已改为 B2 语义;`subscribe_resync_required_when_notify_pull_fails`(L474,只断言 `resync_required` 不断言帧)不受影响。

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-relay/tests/relay_e2e.rs
git commit -m "test(relay): e2e 截断场景跳重放+ack报head,since=head 续点不再 loop"
```

---

## Task 4: 提交前影响核验

**Files:** 无改动(仅核验)。

- [ ] **Step 1: 跑 relay 全量测试(单测 + e2e)**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-relay`
Expected: PASS —— 全绿。e2e 必须 `env -u ALL_PROXY`(单测不需要但带上无害)。

- [ ] **Step 2: 变更影响检测**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && npx gitnexus detect_changes` 或在会话内用 MCP `gitnexus_detect_changes()`
Expected: 变更只命中 `EventLog::latest_for`(新增)与 `HubSvc::subscribe`;无意外波及其它执行流。`subscribe` upstream 全为测试,风险 LOW。

---

## 备注:部署序硬门槛(spec §6.5)

**B2 上线以「P3-B1 客户端覆盖率达阈值」为硬门槛,不只是排序在 B1 之后。**

原因:旧客户端(无 B1,即不会在 `resync_required==true` 时从 ack 推进 `notify_seq` 游标)遇到 B2 的"无重放帧 + resync ack"会:`since` 不前进 → 每次重连 `resync → REST 全量对齐 → since 不变 → 再 resync` 的**稳态放大循环**。数据不丢(resync 广播是既有代码,REST 全量兜底),但带宽/CPU 放大 + 前端反复"对齐中"。

故 B2 部署前置条件(在发布工单中显式 gate):

- P3-B1 已发布且客户端覆盖率达到约定阈值(**TODO:具体阈值由主工程师/发布负责人定**,spec §6.5 标注阈值在实施计划定但未给数值 —— 需主工程师拍板,例如 "≥95% 活跃客户端版本号 ≥ 含 B1 的最小版本")。
- 回滚预案:B2(relay)可独立 `revert` 回"发重放帧"语义(此时 P1 已修死锁,大回放不再死锁,仅恢复重放开销),不影响 P1/P2/P3。

> 残余有界风险(spec §6.4(5)):未打开会话仍为惰性自愈;最坏丢失对齐量 = `head − old`(可远超 1000)。承认为已知有界风险,不在 B2 范围内进一步治理。

---

## 自检(写完计划后)

- **spec 覆盖**:
  - §6.2「`replayed_to_seq` = head(`SELECT MAX(notify_seq)`)」→ Task 1(`latest_for`)+ Task 2 Step 3。
  - §6.2「空表回退 `since`(`unwrap_or(since)`)」→ Task 1 空表 `None` 语义 + Task 2 `subscribe_resync_empty_log_falls_back_to_since` 单测。
  - §6.2「跳过重放帧发送(回放循环不执行)」→ Task 2 `rows.clear()` + `subscribe_resync_skips_replay_and_acks_head` 单测。
  - §6.2「`resync_required==false` 路径不变(发帧、`replayed_to_seq=rows.last()`)」→ Task 2 `else` 分支 + `subscribe_non_resync_still_replays_frames` 回归测。
  - §8 B2「resync 时 head 且无重放帧 / 空表+since>0+backfill 失败 断言 ==since」→ Task 2 两单测。
  - §8 B2「e2e 截断场景客户端不再 loop」→ Task 3 第二次 `subscribe(since=head)` 段。
  - §6.5 部署序硬门槛 → 备注章节。
  - §6.2「P1 的 subscribe spawn 改动叠加(P1 先上)」→ 前置依赖章节 + Task 2 改动充分性核对。
- **占位符**:无 TBD/"同上"/"适当处理"。所有代码块基于现有签名(`earliest_for` 模板、`EventRow` 字段、`build_svc`/`sub_request`/`make_event_row`/`mount_verify_token`/`mount_notify_pull_status`/`spawn_relay`/`raw_channel`/`hub_client`)。少数无法在不读 P1 合入后代码定论之处,用显式 **TODO(需主工程师确认 ...)** 标注(共 4 处:subscribe 当前结构、mock helper 可见性、既有 grouped 测试取舍、P1 e2e 与本 e2e 互斥、阈值数值)。
- **类型/签名一致**:`latest_for(employee_id: i64) -> Result<Option<i64>, StorageError>`(对齐 `earliest_for` 返回 `Result<Option<(i64,i64)>, StorageError>` 的风格);`replayed_to_seq: u64`(proto `SubscribeAck.replayed_to_seq`);`rows: Vec<EventRow>`、`rows.clear()`;`Status::from(RelayError::from(e))`(与现有错误映射一致)。
