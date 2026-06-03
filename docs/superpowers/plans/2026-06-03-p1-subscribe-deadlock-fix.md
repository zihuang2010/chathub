# P1 — Subscribe 死锁修复 + event_tx 背压 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 relay `subscribe` 在返回 `Response` 前把 ack+回放帧灌满 `mpsc(256)` 导致的死锁(客户端永久"连接中"),并避免修好后大回放灌爆客户端 `event_tx` broadcast 触发 5 秒重连抖动。

**Architecture:** relay 侧把 `subscribe` 改为「ack 同步发 → `register_employee` 同步 → 只把回放循环移入 `tokio::spawn` → 立即返回 `Response`」,让生产者与 tonic drain `rx` 并发、256 背压正常工作。客户端侧 `run_loop` 对「回放帧」(`notify_seq <= ack.replayed_to_seq`)不再 `event_tx.send` 广播。本阶段单独可上线即治好停摆,所有存量客户端下次重连自愈。

**Tech Stack:** Rust(tonic 0.12 / tokio mpsc + broadcast / rusqlite)。relay crate `chathub-relay`,客户端 crate `chathub-net`。测试:`cargo test`(单测 + e2e),e2e 须 `env -u ALL_PROXY`。

**对应 spec:** `docs/superpowers/specs/2026-06-03-subscribe-deadlock-fix-and-resync-decoupling-design.md` §4(P1-A + §4.5 event_tx)。

---

## 文件结构

| 文件                                                                                                 | 职责                        | 改动                                                |
| ---------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| `backends/crates/chathub-relay/src/hub_service.rs`                                                   | relay `Hub::subscribe` 实现 | 改 `subscribe` 发送顺序(573–630);新增 ≥256 回归单测 |
| `backends/crates/chathub-relay/tests/relay_e2e.rs`                                                   | 真 gRPC server e2e          | 新增 1001 帧不死锁 e2e                              |
| `backends/crates/chathub-net/src/hub.rs`                                                             | 客户端 `run_loop`           | 回放帧不走 `event_tx` 广播                          |
| `backends/crates/chathub-net/src/{account_event,friend_event,recent_session_event,message_event}.rs` | 四个 applier                | 仅**核验** LWW 同 seq 重投幂等(交错安全前提),不改   |

---

## Task 1: 写失败单测 —— ≥256 帧回放触发死锁

**Files:**

- Modify(test): `backends/crates/chathub-relay/src/hub_service.rs`(测试模块,接在 `subscribe_with_since_replays_events_grouped_by_notify_seq` 之后,约 L1069 后)

说明:单测直接调 `svc.subscribe(req).await`。当前代码 handler 在第 257 次 `send().await` 阻塞、永不返回,故 `subscribe().await` 挂起。用 `tokio::time::timeout` 包住,当前必超时(失败),修好后立即返回。

- [ ] **Step 1: 写失败测试**

在 `hub_service.rs` 测试模块加入:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn subscribe_with_large_replay_does_not_deadlock() {
        let mock = MockServer::start().await;
        mount_verify_token(&mock, "tok-A", 42, "dev-A").await;
        let svc = build_svc(&mock).await;

        // 300 个 distinct notify_seq → 300 回放帧 + 1 ack = 301 > mpsc(256)。
        let rows: Vec<EventRow> = (1..=300_i64)
            .map(|seq| make_event_row(42, seq, 0))
            .collect();
        svc.events_log.insert_batch(rows).await.unwrap();

        // 当前代码:handler 在第 257 次 send().await 阻塞、subscribe() 永不返回 → 超时(FAIL)。
        // 修好后:subscribe() 立即返回 Response。
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            svc.subscribe(sub_request("dev-A", 0)),
        )
        .await
        .expect("subscribe 必须立即返回响应头,不能死锁")
        .expect("subscribe 应成功");

        // drain 整条流:1 ack + 300 PushBatch 全部收到。
        let mut stream = resp.into_inner();
        let first = StreamExt::next(&mut stream).await.unwrap().unwrap();
        assert!(
            matches!(first.body, Some(Body::SubscribeAck(_))),
            "首帧必须是 SubscribeAck"
        );
        let mut push_frames = 0;
        while let Ok(Some(Ok(ev))) =
            tokio::time::timeout(std::time::Duration::from_secs(5), StreamExt::next(&mut stream))
                .await
        {
            if matches!(ev.body, Some(Body::PushBatch(_))) {
                push_frames += 1;
            }
            if push_frames == 300 {
                break;
            }
        }
        assert_eq!(push_frames, 300, "应收齐全部 300 个回放帧");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backends && cargo test -p chathub-relay subscribe_with_large_replay_does_not_deadlock -- --nocapture`
Expected: FAIL —— `subscribe 必须立即返回响应头,不能死锁` panic(timeout elapsed,handler 死锁挂起)。

- [ ] **Step 3: 提交失败测试**(可选,便于二分)

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-relay/src/hub_service.rs
git commit -m "test(relay): 复现 subscribe >256 帧回放死锁(当前 FAIL)"
```

---

## Task 2: 修 relay subscribe —— ack 同步发 → register 同步 → 只 spawn 回放循环

**Files:**

- Modify: `backends/crates/chathub-relay/src/hub_service.rs:573-630`(`subscribe` 的 ③④⑤⑥ 段)

当前(L573–629)顺序:发 ack → 回放循环(L596–606)→ register(L609)→ cleanup spawn(L615–627)→ return(L629)。改为:发 ack → register(同步)→ spawn{ 回放循环 + cleanup }→ return。

- [ ] **Step 1: 替换 ③④⑤⑥ 段**

把 `hub_service.rs` 中从 `// ③ 首帧 SubscribeAck` 到 `Ok(Response::new(ReceiverStream::new(rx)))`(约 L573–629)整体替换为:

```rust
        // ③ 首帧 SubscribeAck —— 同步发(单帧,256 缓冲不阻塞)。
        let ack_frame = ServerEvent {
            body: Some(chathub_proto::v1::server_event::Body::SubscribeAck(
                chathub_proto::v1::SubscribeAck {
                    resumed_from_seq: since,
                    replayed_to_seq,
                    resync_required,
                    resync_reason: resync_reason.clone(),
                },
            )),
        };
        if tx.send(Ok(ack_frame)).await.is_err() {
            tracing::debug!("subscribe client gone before ack delivered");
            return Ok(Response::new(ReceiverStream::new(rx)));
        }
        tracing::info!(
            replayed_to_seq,
            resync_required,
            replay_rows = rows.len(),
            "subscribe ack sent"
        );

        // ④ 注册 employee 路由 —— **同步**,先于 Response 返回。
        //    保证客户端可见 ack 时连接已注册:读到 ack 后立即 push 必达实时流,
        //    且既有 first_connection 测试断言连接数=1 确定成立(register 不在 spawn 内)。
        let reg =
            self.router
                .register_employee(ctx.employee_id, device_id.clone(), tx.clone());
        let connection_id = reg.connection_id;
        tracing::info!(connection_id = %connection_id, "subscribe registered");

        // ⑤ 回放 + cleanup 移入 spawn:回放帧数可达 REPLAY_LIMIT(1000)> mpsc(256),
        //    必须在 Response 返回后与 tonic drain rx 并发发送,否则 send().await 在缓冲满时
        //    死锁(handler 不返回 → 客户端拿不到响应头 → 永久 Connecting)。
        let router = self.router.clone();
        let emp_id = ctx.employee_id;
        let conn_id_for_drop = connection_id.clone();
        tokio::spawn(async move {
            // 按 notify_seq 分组重放 PushBatchOut(同 seq 多事件视为一个原子 batch)。
            let mut group_start = 0usize;
            for i in 0..rows.len() {
                let is_last = i + 1 == rows.len();
                let boundary = !is_last && rows[i].notify_seq != rows[i + 1].notify_seq;
                if is_last || boundary {
                    send_replay_batch(&tx, &rows[group_start..=i], emp_id).await;
                    group_start = i + 1;
                }
            }
            // 客户端断开(rx 被 drop)→ 摘除 router 注册。
            tx.closed().await;
            router.drop_employee_stream(emp_id, &conn_id_for_drop);
            tracing::debug!(
                employee_id = emp_id,
                connection_id = %conn_id_for_drop,
                "subscribe stream dropped"
            );
        });

        Ok(Response::new(ReceiverStream::new(rx)))
```

> 说明:`tx` 原件 move 进 spawn(发回放 + `tx.closed()`);`register` 用 `tx.clone()`。两份 sender 足够,cleanup 折进同一 spawn(比原来的独立 cleanup spawn 更简)。`rows` move 进 spawn,峰值内存不变(本就全量物化)。

- [ ] **Step 2: 跑 Task 1 测试,确认通过**

Run: `cd backends && cargo test -p chathub-relay subscribe_with_large_replay_does_not_deadlock`
Expected: PASS。

- [ ] **Step 3: 跑全部 subscribe 单测,确认既有 4 个不破**

Run: `cd backends && cargo test -p chathub-relay subscribe_`
Expected: PASS —— `first_connection_returns_ack_no_replay`、`with_since_replays_events_grouped_by_notify_seq`、`rejects_when_employee_id_missing`、`with_large_replay_does_not_deadlock` 全绿。

- [ ] **Step 4: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-relay/src/hub_service.rs
git commit -m "fix(relay): subscribe 改 ack同步发→register同步→spawn回放,解 >256 帧死锁"
```

---

## Task 3: e2e —— 真 gRPC server,1001 帧不死锁、不重连

**Files:**

- Modify(test): `backends/crates/chathub-relay/tests/relay_e2e.rs`(接在 `subscribe_with_since_replays_persisted_events` 之后)

这是唯一在真 tonic server(而非直接调 handler)下复现死锁的层级:死锁时客户端 `hub.subscribe().await` 拿不到响应头而挂起。

- [ ] **Step 1: 写 e2e 测试**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn subscribe_with_huge_backlog_does_not_deadlock() {
    let h = spawn_relay().await;
    mount_verify_token(&h.downstream, "tok-big", 88, "dev-A").await;

    // 预置 1001 个 distinct notify_seq(超 REPLAY_LIMIT=1000 → 截断 + resync_required)。
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

    // 死锁时 subscribe() 拿不到响应头 → 挂起;timeout 把死锁变成可断言的失败。
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        hub.subscribe(SubscribeRequest {
            since_notify_seq: 0,
            device_id: "dev-A".into(),
            client_version: "1.0.0".into(),
        }),
    )
    .await
    .expect("subscribe 必须立即返回响应头,不能死锁")
    .unwrap();
    let mut stream = stream.into_inner();

    // 收齐 ack + 1000 回放帧(截断到 REPLAY_LIMIT)。
    let first = stream.next().await.unwrap().unwrap();
    match first.body {
        Some(Body::SubscribeAck(ack)) => assert!(ack.resync_required, "1001>1000 应截断 resync"),
        other => panic!("expected SubscribeAck, got {other:?}"),
    }
    let mut frames = 0;
    while let Ok(Some(Ok(ev))) =
        tokio::time::timeout(std::time::Duration::from_secs(8), stream.next()).await
    {
        if matches!(ev.body, Some(Body::PushBatch(_))) {
            frames += 1;
        }
        if frames == 1000 {
            break;
        }
    }
    assert_eq!(frames, 1000, "应收齐 1000 个回放帧,无死锁");
}
```

- [ ] **Step 2: 跑 e2e,确认通过**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-relay --test relay_e2e subscribe_with_huge_backlog_does_not_deadlock -- --nocapture`
Expected: PASS。

> 必须 `env -u ALL_PROXY`,否则 socks5 代理导致 e2e 假失败(见团队约定)。

- [ ] **Step 3:(可选)确认它能抓 bug**

临时 `git stash`(回到 Task 2 之前的 relay 代码)再跑此 e2e → 应在 `subscribe 必须立即返回响应头` 处超时失败;确认后 `git stash pop` 恢复。

- [ ] **Step 4: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-relay/tests/relay_e2e.rs
git commit -m "test(relay): e2e 1001 帧回放不死锁、不重连(真 gRPC server)"
```

---

## Task 4: 客户端 —— 回放帧不走 event_tx 广播

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(`run_loop`:`Subscribed` 之后 ~L1134、SubscribeAck 处理 ~L1179、`event_tx.send` ~L1239)

A 修死锁后大回放真发得出去,run_loop 对每帧 `self.event_tx.send`(L1239)会瞬时灌爆 `event_tx` broadcast(256)(L998)→ 前端 `hub:event` 消费慢 → `Lagged` → `lib.rs:1579` stop/start 重连 → 5 秒一次抖动。修法:回放帧(`pb.notify_seq <= ack.replayed_to_seq`)不广播。

- [ ] **Step 1: 进入 Subscribed 后声明回放水位**

在 `run_loop` 里 `self.state_tx.send_replace(ConnectionState::Subscribed);`(约 L1134)之后、内层 `loop` 之前,加:

```rust
            // 本次订阅的回放上界:收到 SubscribeAck 后从 ack.replayed_to_seq 取;
            // 在此之前以 since 兜底(<=since 的都已处理过)。回放帧不进 event_tx 广播,
            // 避免大回放灌爆 broadcast(256) 触发 Lagged→stop/start 抖动。
            let mut replay_high: u64 = since;
```

- [ ] **Step 2: 从 ack 捕获 replayed_to_seq**

在 `Ok(Some(event)) => {` 分支内、现有 `match &event.body { Some(Body::SubscribeAck(ack)) if ack.resync_required => ...}` 之前,加一个无条件捕获:

```rust
                            // 捕获本次订阅回放上界(所有 ack,不止 resync)。
                            if let Some(chathub_proto::v1::server_event::Body::SubscribeAck(ack)) =
                                &event.body
                            {
                                replay_high = ack.replayed_to_seq;
                            }
```

- [ ] **Step 3: 广播前过滤回放帧**

把 `let _ = self.event_tx.send(event);`(约 L1239)替换为:

```rust
                            // 回放帧(notify_seq <= 本次回放上界)只落库 + 推进水位,不进 event_tx
                            // 广播;live 帧(> 上界)正常广播。逐帧判断,抗 live/replay 交错。
                            let is_replay_frame = matches!(
                                &event.body,
                                Some(chathub_proto::v1::server_event::Body::PushBatch(pb))
                                    if pb.notify_seq <= replay_high
                            );
                            if !is_replay_frame {
                                let _ = self.event_tx.send(event);
                            }
```

- [ ] **Step 4: 编译 + 跑 chathub-net 全测,确认无回归**

Run: `cd backends && cargo test -p chathub-net`
Expected: PASS（既有单测不破；本改动无新单测——hub.rs 无驱动 run_loop 的假流夹具）。

- [ ] **Step 5: 集成验证(联调跑一遍)**

用大积压账号(`since=0`,>256 帧)连本地/dev relay,确认:① UI 从"连接中"变"在线";② 客户端日志**不再出现** `hub event lag`。
Run: `grep -c "hub event lag" ~/Library/Logs/com.pis0sion.chathub/chathub.log.*`(应为 0)

- [ ] **Step 6: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-net/src/hub.rs
git commit -m "fix(client): 回放帧不走 event_tx 广播,避免大回放触发 Lagged 重连抖动"
```

---

## Task 5: 核验四个 applier LWW 同 seq 重投幂等(交错安全前提)

**Files(只读核验,不改):**

- `backends/crates/chathub-net/src/account_event.rs`
- `backends/crates/chathub-net/src/friend_event.rs`
- `backends/crates/chathub-net/src/recent_session_event.rs`
- `backends/crates/chathub-net/src/message_event.rs`

P1 把 register 提到 replay 之前,register 后 live fanout(`seq>replayed_to_seq`)可能与 spawn 内回放帧(`seq<=replayed_to_seq`)**交错**到达客户端。交错对数据安全的前提:四个 applier 均为 LWW/版本门(新值胜,与到达序无关),且同 seq 重投幂等(S1 的 abort 中途切断也依赖此)。

- [ ] **Step 1: 逐个核验 apply_push_batch**

对四个 applier 各确认:写库走"按 sortKey / 版本 / gmtModified 的 LWW upsert"或"INSERT OR IGNORE / upsert_if_greater 单调",**不是**无条件覆盖。记下每个的判据(文件:行)。

- [ ] **Step 2: 结论**

- 若四个**均** LWW/幂等 → 在本计划勾选确认,P1 交错安全成立,无需额外改动。
- 若发现**任一** applier 是"无条件覆盖 / 顺序相关" → **停止**,新建任务把该 applier 改为 LWW(或在 P1 暂保留 register-after-replay 的折中并接受实时-during-replay 丢帧),再继续。此为 P1 正确性硬门槛,不可跳过。

---

## 自检(写完计划后)

- **spec 覆盖**:§4.1/§4.2(ack→register→spawn 回放)→ Task 2;§4.3(交错 + applier LWW 核验)→ Task 5;§4.4(tx clone/生命周期)→ Task 2 说明;§4.5(回放帧不走 event_tx)→ Task 4;§4.6(≥256 单测 + 1001 e2e + 既有 4 测不破)→ Task 1/2/3。全覆盖。
- **占位符**:无 TBD;所有代码块为可直接落地的真实代码(基于现有 `build_svc`/`sub_request`/`make_event_row`/`spawn_relay`/`raw_channel`/`hub_client` 夹具)。
- **类型一致**:`EventRow` 字段、`SubscribeAck{resumed_from_seq,replayed_to_seq,resync_required,resync_reason}`、`Body::{SubscribeAck,PushBatch}`、`router.register_employee/drop_employee_stream`、`send_replay_batch(&tx,&rows[..],emp_id)` 均与现有代码签名一致。

---

## 备注:上线 = 救火

P1 单独上线即治好停摆:relay 改完部署后,**所有卡死客户端下次重连自愈**(无需升级客户端);客户端 event_tx 改动随下个客户端版本上(在 relay 改好之前,客户端旧版遇大回放仍会有 Lagged 抖动,但不再死锁)。P2/P3/P4 另出计划。
