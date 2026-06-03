# P3 — B1 客户端游标推进(仅 resync 路径)+ 崩溃安全网硬化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① B1:客户端 `run_loop` 处理 `SubscribeAck` 时,**仅当 `ack.resync_required == true`** 才用 `notify_seq_store.upsert_if_greater(ack.replayed_to_seq)` 把游标跳到 head;`false` 路径**不**从 ack 推(维持 `hub.rs:1207` apply-then-advance 不变量)。② 崩溃安全网硬化四项,堵住"B2 下游标在 ack 跳到 head 而 REST 对齐异步未完成时崩溃丢对齐"对活跃用户的失效:recents 首页 force 重拉(跳过 `local_count>=200` 短路)、accounts resync 置 `force=true`(拉 listMine)、温缓存会话 resync 后忽略水位门 fresh 一次强制 `reconcile_newest`、当前打开会话 resync 额外主动触发一次 `reconcile_newest`。

**Architecture:** B1 是纯客户端改动,把 ack 游标推进逻辑抽成一个无副作用的纯函数 `cursor_after_subscribe_ack`(便于单测,绕开 run_loop 无假流夹具的现实),run_loop 在已有的 `match &event.body` 分支里调它。安全网硬化跨 `backends/src/lib.rs`(Rust:`prefill_to_watermark` 加 `force` 形参穿透短路;`load_conversation_messages` 加一个绕水位门的强制 reconcile 入口)+ `frontends`(TS:`prefillRecentFriends` 透传 `force`;`useAccounts` 在 resync 时置 `force=true`;`broadcast_resync_to_all_topics` 补发 `ConversationMessages` topic;`useMessageHistory` 消费该 resync notice 触发一次强制 `reconcile_newest`)。本阶段兼容旧 relay(B1 推进对旧 relay 的小回放 ack 无害,因为旧 relay `resync_required=false` 时不进 true 分支),独立可上线/回滚。

**Tech Stack:** Rust(tokio / rusqlite / tauri command,crate `chathub-net` + `backends`(bin crate))+ TypeScript/React(单一根 `package.json`,pnpm,vitest)。后端测试:`cd backends && cargo test -p <crate> <name>`;前端测试/类型校验在**仓库根目录**:`pnpm vitest run <path>`、`pnpm tsc --noEmit`。

**对应 spec:** `docs/superpowers/specs/2026-06-03-subscribe-deadlock-fix-and-resync-decoupling-design.md` §6.1(B1)、§6.4(安全网硬化四项)。

---

## 文件结构

| 文件                                         | 职责                                                                                        | 改动                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backends/crates/chathub-net/src/hub.rs`     | 客户端 `run_loop` 的 `SubscribeAck` 处理                                                    | 新增纯函数 `cursor_after_subscribe_ack` + 在 resync 分支调用推进游标(B1);`broadcast_resync_to_all_topics` 补 `ConversationMessages` topic(安全网 #4 触发源)                                                       |
| `backends/src/lib.rs`                        | `prefill_to_watermark` / `prefill_recent_friends` / `load_conversation_messages` Tauri 命令 | `prefill_to_watermark` + `prefill_recent_friends` 加 `force` 形参,`force=true` 跳过 `local_count>=200` 短路(安全网 #1);`load_conversation_messages` 加 `force` 形参绕水位门强制一次 `reconcile_newest`(安全网 #3) |
| `frontends/lib/api/recentFriends.ts`         | `prefillRecentFriends` API 桥                                                               | 加 `force` 第二参,透传到命令(安全网 #1)                                                                                                                                                                           |
| `frontends/lib/api/useRecentFriends.ts`      | recents hook                                                                                | resync 路径调 `prefillRecentFriends(accountFilter, true)`(安全网 #1)                                                                                                                                              |
| `frontends/lib/api/useAccounts.ts`           | accounts hook                                                                               | 监听 `resyncing` 跃迁置 `forceNextRef.current=true`,使 resync 触发的 `doFetch` 拉 listMine(安全网 #2)                                                                                                             |
| `frontends/lib/api/messageHistory.ts`        | message IPC 桥                                                                              | `loadConversationMessages` 加可选 `force` 透传(安全网 #3/#4)                                                                                                                                                      |
| `frontends/lib/api/useMessageHistory.ts`     | 打开会话历史 hook                                                                           | 新增订阅 `conversation-messages` 的 resync notice → 调 `readCache(false, { force: true })` 强制一次绕水位门 reconcile(安全网 #3/#4)                                                                               |
| `frontends/lib/api/useRecentFriends.test.ts` | recents hook 测                                                                             | 更新现有 resync 用例断言 `force` 参为 true                                                                                                                                                                        |

> **依赖关系**:Task 1(B1)纯客户端、独立。Task 2/3(安全网 #1 recents:Rust 后端 + TS 前端)有跨端契约依赖,先改后端再改前端。Task 4(#2 accounts)独立 TS。Task 5/6(#3+#4 messages:Rust 后端 + TS 前端 + topic 补发)有跨端契约依赖。各 Task 内部按 TDD 推进。

---

## Task 1: B1 —— SubscribeAck 游标推进(仅 resync 路径)

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(新增纯函数 + 测试模块用例 + run_loop resync 分支调用)

**背景与不变量**:relay 是 ack 先发、replay 帧后发,ack 的 `replayed_to_seq` 预告了"还没落库"的帧最高 seq。`false` 小回放路径从 ack 提前推游标 = 在落库前推进 → 崩溃重启跳过这批且无 REST 兜底 → 永久丢(`hub.rs:1207` apply-then-advance 注释要防的正是这个)。`true` resync 路径 B2 不发重放帧、且已广播 ResyncSignal 让上层走 REST 全量兜底,故提前推进安全。run_loop 内无假流夹具(测试模块只有 backoff / 序列化用例),故把判定抽成纯函数单测。

- [ ] **Step 1: 写失败单测 —— 纯函数 `cursor_after_subscribe_ack`**

在 `hub.rs` 测试模块(`#[cfg(test)] mod tests`,`use super::*;` 之后,接在 `exponential_backoff_*` 用例之后,约 L1330 前)加入:

```rust
    #[test]
    fn ack_cursor_advances_only_when_resync_required() {
        // resync_required=true:游标跳到 ack.replayed_to_seq(head/水位),提前推进安全。
        assert_eq!(cursor_after_subscribe_ack(true, 948), Some(948));
        // resync_required=false:不从 ack 推(维持 apply-then-advance,靠 PushBatch 落库后推进)。
        assert_eq!(cursor_after_subscribe_ack(false, 152), None);
        // resync_required=true 但 head=0(空表回退 since=0 的换机场景):推进到 0 无害(单调存储不回退)。
        assert_eq!(cursor_after_subscribe_ack(true, 0), Some(0));
    }
```

- [ ] **Step 2: 跑测试确认失败(函数未定义,编译错)**

Run: `cd backends && cargo test -p chathub-net ack_cursor_advances_only_when_resync_required`
Expected: FAIL —— 编译错误 `cannot find function 'cursor_after_subscribe_ack' in this scope`。

- [ ] **Step 3: 实现纯函数**

在 `hub.rs` 的 `impl Inner` 之外(模块级,放在 `broadcast_resync_to_all_topics` 所在 `impl Inner` 块之前、约 L1069 `impl Inner {` 之上),加入纯函数:

```rust
/// B1(spec §6.1):订阅首帧 `SubscribeAck` 后,该不该从 ack 提前推进 notify_seq 游标?
///
/// - `resync_required == true`:返回 `Some(replayed_to_seq)` —— 跳到 head/水位。该路径
///   B2 不发重放帧、且已广播 ResyncSignal 让上层走 REST 全量兜底,提前推进安全。
/// - `resync_required == false`:返回 `None` —— **不**从 ack 推,维持 apply-then-advance
///   (只靠 PushBatch 经 applier 落库后 `upsert_if_greater(pb.notify_seq)`)。在 false 小回放
///   路径从 ack 提前推 = 落库前推进 → 崩溃重启跳过该批且无兜底 → 永久丢(hub.rs apply-then-advance
///   注释要防的不变量)。
///
/// 纯函数无副作用,便于单测(run_loop 无假流夹具)。
fn cursor_after_subscribe_ack(resync_required: bool, replayed_to_seq: u64) -> Option<u64> {
    if resync_required {
        Some(replayed_to_seq)
    } else {
        None
    }
}
```

- [ ] **Step 4: 跑单测确认通过**

Run: `cd backends && cargo test -p chathub-net ack_cursor_advances_only_when_resync_required`
Expected: PASS。

- [ ] **Step 5: 在 run_loop 的 resync 分支接线推进游标**

在 `run_loop` 里 `Some(Body::SubscribeAck(ack)) if ack.resync_required => { ... }` 分支(约 L1180–1192)内,把现有 `broadcast_resync_to_all_topics()` 调用之后追加游标推进。把:

```rust
                                Some(Body::SubscribeAck(ack)) if ack.resync_required => {
                                    tracing::info!(
                                        target: "chathub_net::hub",
                                        reason = %ack.resync_reason,
                                        resumed_from_seq = ack.resumed_from_seq,
                                        replayed_to_seq = ack.replayed_to_seq,
                                        "SubscribeAck.resync_required=true; broadcasting ResyncSignal"
                                    );
                                    let _ = self.resync_tx.send(ResyncSignal {
                                        reason: ack.resync_reason.clone(),
                                    });
                                    self.broadcast_resync_to_all_topics();
                                }
```

替换为:

```rust
                                Some(Body::SubscribeAck(ack)) if ack.resync_required => {
                                    tracing::info!(
                                        target: "chathub_net::hub",
                                        reason = %ack.resync_reason,
                                        resumed_from_seq = ack.resumed_from_seq,
                                        replayed_to_seq = ack.replayed_to_seq,
                                        "SubscribeAck.resync_required=true; broadcasting ResyncSignal"
                                    );
                                    let _ = self.resync_tx.send(ResyncSignal {
                                        reason: ack.resync_reason.clone(),
                                    });
                                    self.broadcast_resync_to_all_topics();
                                    // B1(spec §6.1):仅 resync 路径从 ack 推进游标到 head/水位。
                                    // 该路径 B2 不发重放帧、已广播 ResyncSignal 走 REST 全量兜底,
                                    // 提前推进安全。false 路径不进此分支,游标仍靠 PushBatch
                                    // 落库后推进(apply-then-advance,见下方 L1233)。
                                    if let Some(advance) =
                                        cursor_after_subscribe_ack(true, ack.replayed_to_seq)
                                    {
                                        if let Err(e) =
                                            self.notify_seq_store.upsert_if_greater(advance).await
                                        {
                                            tracing::warn!(
                                                target: "chathub_net::hub",
                                                ?e,
                                                advance,
                                                "resync ack cursor advance upsert failed, ignored"
                                            );
                                        } else {
                                            tracing::info!(
                                                target: "chathub_net::hub",
                                                advance,
                                                "resync ack: notify_seq cursor advanced to head"
                                            );
                                        }
                                    }
                                }
```

> 说明:`upsert_if_greater` 单调,advance 不大于已记录值时是 no-op,与"重连后 relay 从 since 重放再 ack 同值幂等"语义一致。`false` 路径不在此 `match` 分支(只有 `if ack.resync_required` 才进),天然不从 ack 推,无需改 `false` 分支。

- [ ] **Step 6: 编译 + 跑 chathub-net 全测,确认无回归**

Run: `cd backends && cargo test -p chathub-net`
Expected: PASS（既有单测 + 新增 `ack_cursor_advances_only_when_resync_required` 全绿）。

- [ ] **Step 7: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-net/src/hub.rs
git commit -m "fix(client): B1 仅 resync 路径从 ack 推进 notify_seq 游标(保 apply-then-advance)"
```

---

## Task 2: 安全网 #1(后端)—— prefill `force` 穿透 local_count>=200 短路

**Files:**

- Modify: `backends/src/lib.rs`(`prefill_to_watermark` L870–966、`prefill_recent_friends` 命令 L846–867)

**背景**:resync 的 recents 对齐当前经 `prefill_to_watermark`,在 `local_count >= RECENT_FRIENDS_WATERMARK_TARGET`(=200,L881)直接短路返回 0 行,活跃用户(本地≥200)resync 时**根本不重拉首页** → LWW 漏的首页消息补不回。改:`force=true` 时跳过该短路,做一次首页 LWW 重拉(仍受 `RECENT_FRIENDS_PREFILL_MAX_ITERS` / 远端耗尽 / 达 TARGET 兜底,不会无限拉)。

- [ ] **Step 1: 写失败单测 —— force=true 跳过 local_count 短路的判定**

`prefill_to_watermark` 依赖真 `HubClient` / `RecentSessionsStore`,在单测里全量起一套夹具成本高。本短路判定是纯布尔逻辑(`!force && local_count >= TARGET → 短路`),抽成纯函数单测。在 `backends/src/lib.rs` 文件末尾的 `#[cfg(test)] mod tests`(若不存在则新建一个;先确认)中加入:

> **先确认**:`grep -n "#\[cfg(test)\]" backends/src/lib.rs`。若 lib.rs 无测试模块,在文件末尾新增 `#[cfg(test)] mod tests { use super::*; ... }`。

```rust
    #[test]
    fn prefill_watermark_skips_short_circuit_when_forced() {
        // 非 force + 本地达水位 → 短路(零远端)。
        assert!(prefill_short_circuit(false, 200, RECENT_FRIENDS_WATERMARK_TARGET));
        // force=true + 本地达水位 → 不短路(resync 首页 LWW 重拉)。
        assert!(!prefill_short_circuit(true, 200, RECENT_FRIENDS_WATERMARK_TARGET));
        // 非 force + 本地未达水位 → 不短路(常态冷启动续拉)。
        assert!(!prefill_short_circuit(false, 50, RECENT_FRIENDS_WATERMARK_TARGET));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backends && cargo test -p chathub prefill_watermark_skips_short_circuit_when_forced`

> crate 名已确认 = `chathub`(`backends/Cargo.toml [package].name`),本计划所有后端 bin crate 测试均用 `-p chathub`。
> Expected: FAIL —— 编译错误 `cannot find function 'prefill_short_circuit'`。

- [ ] **Step 3: 实现纯函数 + 改 prefill_to_watermark 签名与短路点**

在 `lib.rs` `prefill_to_watermark` 上方加入纯函数:

```rust
/// 水位预填短路判定(安全网 #1,spec §6.4-1):非 force 且本地已达目标水位 → 跳过远端拉取。
/// `force=true`(resync / 手动刷新)时恒不短路,强制一次首页 LWW 重拉。
fn prefill_short_circuit(force: bool, local_count: usize, target: usize) -> bool {
    !force && local_count >= target
}
```

把 `prefill_to_watermark` 签名(L870)加 `force: bool` 形参:

```rust
async fn prefill_to_watermark(
    hub: &HubClient,
    store: &RecentSessionsStore,
    change_tx: &tokio_broadcast::Sender<ChangeNotice>,
    employee_id: &str,
    filter: Option<String>,
    force: bool,
) -> Result<PrefillResult, AuthError> {
```

把短路点(L881–888)从:

```rust
    if local_count >= RECENT_FRIENDS_WATERMARK_TARGET {
        return Ok(PrefillResult {
            filled: false,
            local_count,
            iters: 0,
            exhausted: false,
        });
    }
```

改为:

```rust
    if prefill_short_circuit(force, local_count, RECENT_FRIENDS_WATERMARK_TARGET) {
        return Ok(PrefillResult {
            filled: false,
            local_count,
            iters: 0,
            exhausted: false,
        });
    }
```

> **TODO(主工程师确认)**:循环内还有一处 `if local_count >= RECENT_FRIENDS_WATERMARK_TARGET { break; }`(L935)。force 路径下首页 LWW 重拉的目标是"拉满一页对齐首页",不应被这个 break 提前掐断到只拉 0 页。但本地已≥200 时 `need = TARGET.saturating_sub(local_count) = 0` → `size=0`,远端 size=0 行为未定义(可能返回空 → exhausted=true 退出,等于没拉)。**需确认**:force 重拉应至少请求一个固定首页大小(如 `RECENT_FRIENDS_REMOTE_MAX_SIZE`=100)而非 `need`,否则 force 形同空转。建议 force 路径把 `size` 钳到 `RECENT_FRIENDS_REMOTE_MAX_SIZE` 并在拉满首页后即 break(只对齐首页,不续深)。此处实现细节待定,先以 TODO 标注,Step 3 仅落地"跳过外层短路"这一确定项。

- [ ] **Step 4: 改命令 `prefill_recent_friends` 透传 force**

`prefill_recent_friends` 命令签名(L846–853)加 `force: Option<bool>`,默认 false,透传给 `prefill_to_watermark`:

```rust
#[tauri::command]
async fn prefill_recent_friends(
    hub: State<'_, HubClient>,
    store: State<'_, RecentSessionsStore>,
    auth_api: State<'_, Arc<AuthApi>>,
    change_tx: State<'_, tokio_broadcast::Sender<ChangeNotice>>,
    account_filter: Option<String>,
    force: Option<bool>,
) -> Result<PrefillResult, AuthError> {
```

函数体里把末尾的:

```rust
    prefill_to_watermark(&hub, &store, &change_tx, &employee_id, filter).await
```

改为:

```rust
    prefill_to_watermark(&hub, &store, &change_tx, &employee_id, filter, force.unwrap_or(false)).await
```

> 同步检查:`prefill_to_watermark` 的另一处调用方(若有)。Step 5 编译会暴露所有未传 `force` 的调用点。`gitnexus_impact` 显示 `prefill_to_watermark` 仅被 `prefill_recent_friends` 调用(upstream=1, LOW),故只此一处。

- [ ] **Step 5: 跑单测 + 编译确认通过**

Run: `cd backends && cargo test -p chathub prefill_watermark_skips_short_circuit_when_forced && cargo build -p chathub`
Expected: PASS + 编译通过（`prefill_to_watermark` 唯一调用点已传 force）。

- [ ] **Step 6: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/src/lib.rs
git commit -m "feat(recents): resync 预填 force 跳过 local_count>=200 短路做首页 LWW 重拉"
```

---

## Task 3: 安全网 #1(前端)—— prefillRecentFriends 透传 force + resync 路径置 true

**Files:**

- Modify: `frontends/lib/api/recentFriends.ts`(`prefillRecentFriends` L226–230)
- Modify: `frontends/lib/api/useRecentFriends.ts`(resync effect L356–364 + `prefillWatermark` 调用链)
- Modify: `frontends/lib/api/useRecentFriends.test.ts`(更新现有 resync 用例断言)

- [ ] **Step 1: 更新失败测试 —— resync 用例断言 force 参为 true**

把 `useRecentFriends.test.ts` 现有 resync 用例(L184–198)的断言收紧到验证传了 `force=true`。把:

```rust
  it("resync 跃迁(false→true):触发 force 水位预填(绕过已填标记)", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50), { resyncing: false }));
    prefillMock.mockResolvedValue(okPrefill);

    const { rerender } = renderHook(() => useRecentFriends({ accountFilter: "acc-resync" }));
    await act(async () => {});
    expect(prefillMock).not.toHaveBeenCalled(); // 温缓存 mount 不预填

    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50), { resyncing: true }));
    await act(async () => {
      rerender();
    });

    expect(prefillMock).toHaveBeenCalledTimes(1);
  });
```

替换为(末行断言改为带 force=true 调用):

```rust
  it("resync 跃迁(false→true):触发 force 水位预填(透传 force=true 跳后端短路)", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50), { resyncing: false }));
    prefillMock.mockResolvedValue(okPrefill);

    const { rerender } = renderHook(() => useRecentFriends({ accountFilter: "acc-resync" }));
    await act(async () => {});
    expect(prefillMock).not.toHaveBeenCalled(); // 温缓存 mount 不预填

    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50), { resyncing: true }));
    await act(async () => {
      rerender();
    });

    expect(prefillMock).toHaveBeenCalledTimes(1);
    // 安全网 #1:resync 必须透传 force=true,后端据此跳过 local_count>=200 短路重拉首页。
    expect(prefillMock).toHaveBeenCalledWith("acc-resync", true);
  });
```

> 同步检查:冷启动用例(L125–135)断言 `prefillMock` 以 `"acc-cold"` 调用 —— 改 `prefillRecentFriends` 签名加第二参后,冷启动走 `prefillWatermark(false)` → `prefillRecentFriends(accountFilter, false)`,旧断言 `toHaveBeenCalledWith("acc-cold")` 会因多了第二参 `false` 而失败。Step 1 一并把该断言改为 `toHaveBeenCalledWith("acc-cold", false)`(切账号用例 L239 `toHaveBeenCalledWith("acc-sw2")` 同理改 `("acc-sw2", false)`)。

- [ ] **Step 2: 跑测试确认失败**

Run(仓库根目录):`pnpm vitest run frontends/lib/api/useRecentFriends.test.ts`
Expected: FAIL —— resync / 冷启动 / 切账号用例断言不匹配(当前 `prefillRecentFriends` 只接受一个参,`prefillWatermark` 也只传一个)。

- [ ] **Step 3: `prefillRecentFriends` 加 force 第二参透传命令**

`recentFriends.ts` 把(L226–230):

```rust
export async function prefillRecentFriends(accountFilter?: string | null): Promise<PrefillResult> {
  return invoke<PrefillResult>("prefill_recent_friends", {
    accountFilter: accountFilter || null,
  });
}
```

改为:

```rust
export async function prefillRecentFriends(
  accountFilter?: string | null,
  force = false,
): Promise<PrefillResult> {
  return invoke<PrefillResult>("prefill_recent_friends", {
    accountFilter: accountFilter || null,
    force,
  });
}
```

- [ ] **Step 4: `prefillWatermark` 把 force 透传给 API**

`useRecentFriends.ts` 的 `prefillWatermark`(L295–320)内,把 `await prefillRecentFriends(accountFilter);`(L306)改为透传 force:

```rust
        await prefillRecentFriends(accountFilter, force);
```

> `prefillWatermark(force)` 的 `force` 形参既控制"绕过 filledScopes 标记"(已有语义),现在同时透传到后端控制"跳过短路重拉"。两层语义统一:resync → `prefillWatermark(true)` → `prefillRecentFriends(accountFilter, true)`;冷启动 → `prefillWatermark(false)` → `prefillRecentFriends(accountFilter, false)`。无需改 resync effect(L356–364)本身,它已调 `prefillWatermark(true)`。

- [ ] **Step 5: 跑测试确认通过 + 类型校验**

Run(仓库根目录):`pnpm vitest run frontends/lib/api/useRecentFriends.test.ts && pnpm tsc --noEmit`
Expected: PASS + 无类型错误。

- [ ] **Step 6: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/lib/api/recentFriends.ts frontends/lib/api/useRecentFriends.ts frontends/lib/api/useRecentFriends.test.ts
git commit -m "feat(recents): 前端 resync 预填透传 force=true 触发后端首页重拉"
```

---

## Task 4: 安全网 #2 —— accounts resync 路径置 force=true(拉 listMine)

**Files:**

- Modify: `frontends/lib/api/useAccounts.ts`(queryFn / resyncing 监听)

**背景**:resync 走 `useResource` 内 `doFetch → queryFn`,而 `useAccounts` 的 queryFn 读 `forceNextRef.current`(只被显式 `refetch({force:true})` 置位),故 resync 触发的 `doFetch` 跑 `force=false` → 只读 cache(`accounts.ts` L29-31),漏的账号事件补不回。改:在 resync(`useResource` 暴露的 `resyncing` false→true 跃迁)时把 `forceNextRef.current=true`,让紧随的 resync `doFetch` 拉 listMine。

> **TODO(主工程师确认时序)**:`useResource` 的 resync 分支(`useResource.ts` L193-195)是"先 `setResyncing(true)` 再立即 `void doFetch()`"。`useAccounts` 若用 effect 监听 `resyncing` 跃迁再置 `forceNextRef`,effect 跑在 `doFetch` **之后**,会慢一拍(该次 doFetch 仍 force=false,下一次才 force)。**两种落点,需主工程师定**:
> (a) 在 `useAccounts` 用 effect 监听 `result.resyncing` false→true 置 `forceNextRef.current=true` —— 简单但慢一拍(resync 的首次 refetch 仍读 cache,要等 silentProbe/下次事件才 force,对"立即对齐"打折)。
> (b) 改 `useResource` API:`queryFn` 增加一个 `{ reason: "resync" | "normal" }` 入参,resync 的 `doFetch` 传 `reason:"resync"`,`useAccounts` 的 queryFn 据此置 force。彻底但要动 `useResource` 公共签名(影响所有 useResource 消费者,需回归)。
> 本 Task 先按 **(a)** 落地(最小改动、不动公共 API);若验收发现"resync 后账号仍旧"则升级到 (b)。下方 Step 以 (a) 为准。

- [ ] **Step 1: 写失败测试 —— resync 跃迁置 forceNextRef**

> **先确认夹具**:`ls frontends/lib/api/useAccounts.test.ts`。若不存在,参照 `useRecentFriends.test.ts` 的 `vi.mock("@/lib/data/useResource")` + `vi.mock("./accounts")` 模式新建。本测 mock `useResource` 返回可控 `resyncing`,mock `fetchAccounts`,断言 resyncing false→true 跃迁后下一次 queryFn 调用带 `{force:true}`。

新建 `frontends/lib/api/useAccounts.test.ts`:

```rust
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UseResourceResult } from "@/lib/data/useResource";
import { useResource } from "@/lib/data/useResource";

import { useAccounts } from "./useAccounts";
import { fetchAccounts } from "./accounts";

vi.mock("@/lib/data/useCurrentEmployeeId", () => ({
  useCurrentEmployeeId: () => "emp-1",
}));
vi.mock("@/lib/data/useResource", () => ({ useResource: vi.fn() }));
vi.mock("./accounts", () => ({ fetchAccounts: vi.fn().mockResolvedValue([]) }));

const useResourceMock = vi.mocked(useResource);
const fetchMock = vi.mocked(fetchAccounts);

// 捕获传给 useResource 的 queryFn,以便测试里手动调它观察 force 透传。
function setup(resyncing: boolean): () => Promise<unknown> {
  let captured: () => Promise<unknown> = async () => [];
  useResourceMock.mockImplementation((opts) => {
    captured = () => opts.queryFn({ employeeId: "emp-1" } as never);
    return {
      data: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      lastEventAt: null,
      lastRefreshAt: null,
      resyncing,
      connectionState: null,
      initialFetched: true,
      isStale: false,
    } as UseResourceResult<unknown[]>;
  });
  return () => captured();
}

afterEach(() => vi.clearAllMocks());

describe("useAccounts resync 强制拉 listMine", () => {
  it("resyncing false→true 跃迁后,下一次 queryFn 以 force=true 拉 listMine", async () => {
    const callQuery = setup(false);
    const { rerender } = renderHook(() => useAccounts());
    await act(async () => {});

    // 跃迁到 resyncing=true:effect 置 forceNextRef=true。
    setup(true);
    await act(async () => {
      rerender();
    });

    // 模拟 resync 的 doFetch 调 queryFn 一次。
    await act(async () => {
      await callQuery();
    });

    expect(fetchMock).toHaveBeenLastCalledWith({ force: true });
  });
});
```

> **TODO(主工程师确认测试可行性)**:上面用 `setup(true)` 二次替换 `useResourceMock.mockImplementation` 来模拟 resyncing 跃迁,`captured` 闭包引用可能在 rerender 后指向旧实例。**若本测因 mock 捕获时序难以稳定复现"跃迁→effect→queryFn force"**,退化为更朴素的断言:直接验证 `useAccounts` 暴露的 `refetch({force:true})` 把下一次 queryFn 置 force(这是 forceNextRef 既有机制),resync 复用同一 ref。该测试可行性待主工程师在落地时确认;若 (a) 方案时序无法稳定测,改为手动验收(见 Step 5)。

- [ ] **Step 2: 跑测试确认失败**

Run(仓库根目录):`pnpm vitest run frontends/lib/api/useAccounts.test.ts`
Expected: FAIL —— 当前 resync 不置 force,queryFn 以 `{force:false}` 调 `fetchAccounts`。

- [ ] **Step 3: 实现 —— effect 监听 resyncing 跃迁置 forceNextRef**

`useAccounts.ts` 在 `useResource(...)` 返回 `result` 之后、`refetch` 定义之前,加入 effect。先在文件顶部把 `useEffect` 加入 React import:

```rust
import { useCallback, useEffect, useMemo, useRef } from "react";
```

在 `const result = useResource<Account[]>({...})` 之后加:

```rust
  // 安全网 #2(spec §6.4-2):resync 路径强制拉 listMine 而非读 cache。useResource 的 resync
  // 分支会 setResyncing(true) 后立即 doFetch();这里在 resyncing false→true 跃迁时置
  // forceNextRef,使紧随(及后续直到下次成功)的 queryFn 透传 force=true 绕 cache。
  const prevResyncingRef = useRef(false);
  useEffect(() => {
    const was = prevResyncingRef.current;
    prevResyncingRef.current = result.resyncing;
    if (!was && result.resyncing) {
      forceNextRef.current = true;
    }
  }, [result.resyncing]);
```

> 注:`forceNextRef.current` 在 queryFn 内被读后立即置回 false(既有 L37-38 逻辑),故 force 仅作用于"置位后的下一次 queryFn"。若 (a) 的慢一拍问题在验收暴露,按 Step TODO 升级到 (b)。

- [ ] **Step 4: 跑测试确认通过 + 类型校验**

Run(仓库根目录):`pnpm vitest run frontends/lib/api/useAccounts.test.ts && pnpm tsc --noEmit`
Expected: PASS + 无类型错误。（若 Step 1 测因时序不稳被降级为手动验收,则此步只跑 `pnpm tsc --noEmit` + 既有 useAccounts 相关测试不破。）

- [ ] **Step 5: 手动验收(联调)**

活跃用户(有账号)断网→漏一条 ACCOUNT\_\* 事件→重连触发 resync,确认 accounts 列表对齐到漏的账号变更(而非停留旧 cache)。

- [ ] **Step 6: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/lib/api/useAccounts.ts frontends/lib/api/useAccounts.test.ts
git commit -m "feat(accounts): resync 跃迁置 force 拉 listMine,补漏掉的账号事件"
```

---

## Task 5: 安全网 #3+#4(后端)—— resync 补发 ConversationMessages topic + 强制绕水位门 reconcile 入口

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(`broadcast_resync_to_all_topics` L1072–1088)
- Modify: `backends/src/lib.rs`(`load_conversation_messages` L410–555 加 `force` 形参)
- Modify: `frontends/lib/api/messageHistory.ts`(`loadConversationMessages` 透传 force)

**背景**:

- #4:`broadcast_resync_to_all_topics`(L1078-1082)只对 `Accounts / Friends / RecentSessions` 三 topic 发 resync ChangeNotice,**漏了 `ConversationMessages`**。B2 跳重放后,`reconcile_newest` 的触发恰依赖被跳的 MESSAGE_UPSERT push,故打开会话气泡不触发对齐。补发 `ConversationMessages` resync notice,让前端打开会话的 hook 据此主动 reconcile。
- #3:温缓存会话漏消息从未落本地 → 重启后水位 `c>=r` 命中"水位门 fresh"(`lib.rs:466-470`)零网络不 reconcile。需要一个"忽略 fresh 一次、强制绕水位门 `reconcile_newest`"的入口 —— 给 `load_conversation_messages` 加 `force: Option<bool>`,`force=true` 时无视 `fresh` 直接同步 `reconcile_newest`。

- [ ] **Step 1: 写失败单测 —— broadcast 含 ConversationMessages topic**

`broadcast_resync_to_all_topics` 依赖 `self`(token_store + change_notice_tx),直接单测需起 Inner。改为把"resync 要广播哪些 topic"抽成模块级常量数组 + 纯函数,单测该数组含四 topic。在 `hub.rs` 测试模块加入:

```rust
    #[test]
    fn resync_broadcast_covers_conversation_messages() {
        // 安全网 #4(spec §6.4-4):resync 必须覆盖 ConversationMessages,否则 B2 跳重放后
        // 打开会话气泡不触发 reconcile。
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::ConversationMessages));
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::Accounts));
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::Friends));
        assert!(RESYNC_BROADCAST_TOPICS.contains(&ChangeTopic::RecentSessions));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backends && cargo test -p chathub-net resync_broadcast_covers_conversation_messages`
Expected: FAIL —— 编译错误 `cannot find value 'RESYNC_BROADCAST_TOPICS'`。

- [ ] **Step 3: 抽常量数组 + 改 broadcast_resync_to_all_topics**

在 `hub.rs` `impl Inner { fn broadcast_resync_to_all_topics ... }`(L1069)上方加模块级常量:

```rust
/// resync 全量对齐时需广播 BulkInvalidate 的 topic 集合(安全网 §6.4)。
/// 含 ConversationMessages:B2 跳重放后,打开会话气泡的 reconcile 触发恰依赖被跳的
/// MESSAGE_UPSERT push,故 resync 必须显式覆盖此 topic 让前端主动 reconcile。
const RESYNC_BROADCAST_TOPICS: [ChangeTopic; 4] = [
    ChangeTopic::Accounts,
    ChangeTopic::Friends,
    ChangeTopic::RecentSessions,
    ChangeTopic::ConversationMessages,
];
```

把 `broadcast_resync_to_all_topics`(L1072-1088)的 `for topic in [...]` 内联数组替换为引用该常量:

```rust
    fn broadcast_resync_to_all_topics(&self) {
        let employee_id = match self.token_store.current_user_id() {
            Some(uid) if !uid.is_empty() => uid,
            _ => return,
        };
        let scope = ChangeScope::employee(employee_id);
        for topic in RESYNC_BROADCAST_TOPICS {
            let _ = self
                .change_notice_tx
                .send(ChangeNotice::resync(topic, scope.clone()));
        }
    }
```

> 注:`ChangeNotice::resync(ConversationMessages, ChangeScope::employee(uid))` 的 scope 只带 employee_id(无 conversation_id),前端按 employee 宽匹配收到 —— 打开会话的 hook 据此对**当前打开的会话**触发一次 reconcile(安全网 #4)。

- [ ] **Step 4: 跑单测确认通过**

Run: `cd backends && cargo test -p chathub-net resync_broadcast_covers_conversation_messages`
Expected: PASS。

- [ ] **Step 5: 写失败单测 —— load_conversation_messages 的 fresh 门 force 旁路判定**

`load_conversation_messages` 是重 IPC 命令,不易单测。其"是否要 reconcile"是布尔逻辑,抽纯函数:`force → 必 reconcile;否则按 fresh/cold 原逻辑`。在 `lib.rs` 测试模块加入:

```rust
    #[test]
    fn conv_messages_force_bypasses_fresh_gate() {
        // 安全网 #3(spec §6.4-3):force=true 无视 fresh,恒需(同步)reconcile。
        assert!(should_reconcile_conv_messages(true, /*fresh=*/ true, /*is_cold=*/ false));
        // 非 force + fresh → 零网络命中,不 reconcile。
        assert!(!should_reconcile_conv_messages(false, true, false));
        // 非 force + 非 fresh → 需 reconcile(冷/温分流另判,本函数只答"要不要")。
        assert!(should_reconcile_conv_messages(false, false, true));
        assert!(should_reconcile_conv_messages(false, false, false));
    }
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd backends && cargo test -p chathub conv_messages_force_bypasses_fresh_gate`
Expected: FAIL —— 编译错误 `cannot find function 'should_reconcile_conv_messages'`。

- [ ] **Step 7: 实现纯函数 + 改 load_conversation_messages 签名与门逻辑**

在 `lib.rs` `load_conversation_messages` 上方加纯函数:

```rust
/// 会话历史是否需要 reconcile(安全网 #3,spec §6.4-3)。
/// `force=true`(resync 对当前打开会话)无视水位门 fresh 恒返 true(强制同步绕门对齐);
/// 否则维持原水位门语义(fresh → 不 reconcile,否则需 reconcile,冷/温由调用方另行分流)。
fn should_reconcile_conv_messages(force: bool, fresh: bool, _is_cold: bool) -> bool {
    force || !fresh
}
```

`load_conversation_messages` 命令签名(L412-422)加 `force: Option<bool>`:

```rust
async fn load_conversation_messages(
    messages_store: State<'_, MessagesStore>,
    recents_store: State<'_, RecentSessionsStore>,
    message_sync: State<'_, MessageSync>,
    auth_api: State<'_, Arc<AuthApi>>,
    image_prefetcher: State<'_, image_prefetch::ImagePrefetcher>,
    conversation_id: String,
    wecom_account_id: String,
    external_user_id: String,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<CachedMessagesResp, AuthError> {
```

在 `let limit = ...` 之后(L432 后)加:

```rust
    let force = force.unwrap_or(false);
```

把水位门分流(L476-555)的判定从直接读 `fresh` 改为经 `should_reconcile_conv_messages`。具体:把 `if !fresh && is_cold { 同步reconcile } else if !fresh { 后台reconcile }` 改为——force 时走**同步** reconcile(对齐冷路径的"等一次再返回",保证 resync 后打开会话拿到对齐数据),非 force 维持原冷/温分流。把:

```rust
    if !fresh && is_cold {
        // ... 同步 reconcile（冷会话）...
    } else if !fresh {
        // ... 后台 spawn reconcile（温缓存）...
    }
```

改为:

```rust
    let need_reconcile = should_reconcile_conv_messages(force, fresh, is_cold);
    // force(resync)或冷会话:同步等一次 reconcile 再返回(force 强制绕水位门一次性对齐打开会话)。
    // 温缓存(非 force 且非冷且 not-fresh):后台 spawn(stale-while-revalidate)。
    if need_reconcile && (force || is_cold) {
        // gRPC forward 隧道无 per-call deadline,必须超时包裹,避免远端慢/挂时卡死命令。
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            message_sync.reconcile_newest(
                &conversation_id,
                &wecom_account_id,
                &external_user_id,
                &employee_id,
                limit,
            ),
        )
        .await;
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(target: "chathub::messages", error = %e, "reconcile_newest failed (sync await)");
            }
            Err(_) => {
                tracing::warn!(target: "chathub::messages", "reconcile_newest timed out (sync await)");
            }
        }
        let rows = messages_store
            .list_conversation_asc(&employee_id, &conversation_id)
            .await
            .map_err(messages_err)?;
        records = rows.iter().map(row_to_history).collect();
        has_more_older = messages_store
            .get_window(&employee_id, &conversation_id)
            .await
            .map_err(messages_err)?
            .map(|w| w.has_more_older)
            .unwrap_or(false);
        tracing::debug!(
            target: "chathub::messages",
            conversation_id = %conversation_id,
            rows_after = records.len(),
            has_more_older,
            force,
            "同步 reconcile 完成(force 或冷会话),已重读本地缓存返回首屏",
        );
    } else if need_reconcile {
        tracing::debug!(
            target: "chathub::messages",
            conversation_id = %conversation_id,
            "温缓存水位落后,后台 spawn reconcile_newest(stale-while-revalidate)",
        );
        let sync = message_sync.inner().clone();
        let conv = conversation_id.clone();
        let wa = wecom_account_id.clone();
        let ext = external_user_id.clone();
        let emp = employee_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = sync.reconcile_newest(&conv, &wa, &ext, &emp, limit).await {
                tracing::warn!(target: "chathub::messages", error = %e, "reconcile_newest failed");
            }
        });
    }
```

> **TODO(主工程师确认)**:`reconcile_newest` 内部 `classify_reconcile` 对"首页与缓存一致"判 `NoOp` 直接 return,`Stitch` 未推进则 `should_notify=false` 不广播(`message_sync.rs:256-302`)。即 force 同步 reconcile 后若确无新消息,**不会**重复发 ChangeNotice,无自激循环风险。但 force 路径必然多打一次 `fetch_message_history`(对每个 resync 时打开的会话一次),属可接受的对齐成本。**需确认**:`reconcile_newest` 的 page_size 用 `limit`(默认 20),force 对齐首页足够;若 resync 漏的是更早的整窗缺口,force 只补首页(残余按用户上滚 loadMore 惰性补)—— 与 spec §6.4-5"未打开会话惰性自愈"的有界风险一致,无需在 force 路径全量回灌。

- [ ] **Step 8: messageHistory.ts 透传 force**

`loadConversationMessages`(`messageHistory.ts` L118-134)是单对象入参、走 `invokeWithTimeout(..., HISTORY_TIMEOUT_MS)`。加可选 `force` 字段透传(默认 false,既有调用零改动)。把:

```rust
export async function loadConversationMessages(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  limit?: number;
}): Promise<CachedMessagesResp> {
  return invokeWithTimeout<CachedMessagesResp>(
    "load_conversation_messages",
    {
      conversationId: params.conversationId,
      wecomAccountId: params.wecomAccountId,
      externalUserId: params.externalUserId,
      limit: params.limit,
    },
    HISTORY_TIMEOUT_MS,
  );
}
```

改为:

```rust
export async function loadConversationMessages(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  limit?: number;
  /** 安全网 #3/#4:resync 对当前打开会话强制绕水位门同步 reconcile;默认 false 走常规水位门。 */
  force?: boolean;
}): Promise<CachedMessagesResp> {
  return invokeWithTimeout<CachedMessagesResp>(
    "load_conversation_messages",
    {
      conversationId: params.conversationId,
      wecomAccountId: params.wecomAccountId,
      externalUserId: params.externalUserId,
      limit: params.limit,
      force: params.force ?? false,
    },
    HISTORY_TIMEOUT_MS,
  );
}
```

> 注:既有调用方 `useMessageHistory.ts:145` 按对象传 `{ conversationId, wecomAccountId, externalUserId, limit: pageSize }`,新增可选 `force` 不传 = false,该调用零改动;Task 6 Step 3 才在 `readCache` 内补传 `force`。

- [ ] **Step 9: 跑后端单测 + 编译 + 前端类型校验**

Run: `cd backends && cargo test -p chathub-net resync_broadcast_covers_conversation_messages && cargo test -p chathub conv_messages_force_bypasses_fresh_gate && cargo build -p chathub`
Run(仓库根目录):`pnpm tsc --noEmit`
Expected: 全 PASS。

- [ ] **Step 10: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/crates/chathub-net/src/hub.rs backends/src/lib.rs frontends/lib/api/messageHistory.ts
git commit -m "feat(messages): resync 补发 ConversationMessages topic + 命令加 force 绕水位门同步对齐"
```

---

## Task 6: 安全网 #3+#4(前端)—— 打开会话消费 resync notice 强制 reconcile

**Files:**

- Modify: `frontends/lib/api/useMessageHistory.ts`(`readCache` 加 force 形参 + 新增 resync 订阅)

**背景**:`useMessageHistory` 现订阅 `conversation-messages`(L184-199,reconcile 落库后重读)与 `recent-sessions`(L204-215,按 `source==="server-event"` 收窄,**忽略 resync notice**)。Task 5 让后端 resync 对 `ConversationMessages` 发 `source==="resync"` 的 notice;但现有 `conversation-messages` 订阅的 cb 只 `readCache(false)`(不带 force),走的是普通水位门(温缓存 fresh 时零网络,不对齐)。需让 resync notice 触发 `readCache(force=true)` 强制绕门 reconcile。

- [ ] **Step 1: 写失败测试 —— resync notice 触发 force 重读**

`useMessageHistory.test.ts` 现把 `changeBus` mock 成 `{ subscribe: vi.fn(() => () => undefined) }`(L15-17),cb 从不被调。为测 resync force,改用可触发的 fake bus:捕获注册的 cb 并在测试里手动以一条 resync notice 调它,断言 `loadConversationMessages` 以 `force:true` 被调。在 `useMessageHistory.test.ts` 新增 describe:

```rust
describe("useMessageHistory resync 强制绕水位门 reconcile", () => {
  it("conversation-messages 的 resync notice → readCache(force=true)", async () => {
    loadMock.mockResolvedValue({ records: [], hasMoreOlder: false });

    // 捕获 conversation-messages 订阅的 cb(本测专用 fake bus)。
    let convCb: ((n: { source: string }) => void) | undefined;
    const { changeBus } = await import("@/lib/data/changeBus");
    vi.mocked(changeBus.subscribe).mockImplementation((topic, _scope, cb) => {
      if (topic === "conversation-messages") convCb = cb as never;
      return () => undefined;
    });

    renderHook(() => useMessageHistory({ ...READY, conversationId: "c-resync" }));
    await flush();
    loadMock.mockClear();

    // 投递一条 resync notice。
    await act(async () => {
      convCb?.({ source: "resync" });
      await new Promise((r) => setTimeout(r, 0));
    });

    // 强制绕水位门:loadConversationMessages 必须带 force=true。
    const lastCall = loadMock.mock.calls[loadMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual(expect.objectContaining({ force: true }));
  });
});
```

> **TODO(主工程师确认)**:上面 `vi.mocked(changeBus.subscribe).mockImplementation` 依赖把顶部 `vi.mock("@/lib/data/changeBus", ...)` 的 `subscribe` 改成可重定义的 mock(当前是固定 `vi.fn(() => () => undefined)`,可直接 `.mockImplementation` 覆盖)。若该 mock 改写影响同文件其他用例(它们假设 subscribe 是 no-op),把本 describe 放在独立 `beforeEach` 里 set/`afterEach` 里 reset `subscribe` 实现。测试细节可行性待落地确认;若难稳定,降级为手动验收。

- [ ] **Step 2: 跑测试确认失败**

Run(仓库根目录):`pnpm vitest run frontends/lib/api/useMessageHistory.test.ts`
Expected: FAIL —— 当前 `readCache` 不接受 force,resync notice 仍走普通重读(无 force 字段)。

- [ ] **Step 3: `readCache` 加 force 形参,透传到 loadConversationMessages**

`useMessageHistory.ts` 把 `readCache` 的签名(L135-165)从 `async (showLoading: boolean)` 改为接受可选 opts:

```rust
  const readCache = useCallback(
    async (showLoading: boolean, opts?: { force?: boolean }) => {
      if (!ready) return;
      if (readingRef.current || loadingOlderRef.current) return;
      readingRef.current = true;
      const requestKey = activeTargetKey;
      if (showLoading) useChatStore.getState().setLoading(requestKey, true);
      try {
        const resp = await loadConversationMessages({
          conversationId,
          wecomAccountId,
          externalUserId,
          limit: pageSize,
          force: opts?.force ?? false,
        });
        if (targetKeyRef.current !== requestKey) return;
        const page = adaptHistoryRecords(resp.records, conversationId);
        useChatStore
          .getState()
          .replaceAuthoritative(requestKey, page, { hasMore: resp.hasMoreOlder, error: null });
      } catch (e) {
        if (targetKeyRef.current !== requestKey) return;
        useChatStore.getState().setError(requestKey, errorMessage(e));
      } finally {
        if (showLoading) useChatStore.getState().setLoading(requestKey, false);
        readingRef.current = false;
      }
    },
    [ready, activeTargetKey, conversationId, wecomAccountId, externalUserId, pageSize],
  );
```

- [ ] **Step 4: conversation-messages 订阅区分 resync source**

把现有 `conversation-messages` 订阅(L184-199)的 cb 改为按 source 决定是否 force。把:

```rust
    const unsubscribe = changeBus.subscribe(
      "conversation-messages",
      { employeeId, conversationId },
      () => {
        void readCache(false);
      },
    );
```

改为:

```rust
    const unsubscribe = changeBus.subscribe(
      "conversation-messages",
      { employeeId, conversationId },
      (notice) => {
        // 安全网 #3/#4(spec §6.4):resync notice 强制绕水位门一次性 reconcile 当前打开会话;
        // 普通 reconcile 落库通知走常规重读(后端已对齐,前端只重读本地)。
        void readCache(false, { force: notice.source === "resync" });
      },
    );
```

> 其余 `readCache(false)` 调用点(L180 mount、L197 补读、L213 recents 实时、L244 retry)保持不传 force(默认 false),行为不变。

- [ ] **Step 5: 跑测试确认通过 + 类型校验**

Run(仓库根目录):`pnpm vitest run frontends/lib/api/useMessageHistory.test.ts && pnpm tsc --noEmit`
Expected: PASS + 无类型错误。

- [ ] **Step 6: 手动验收(联调)**

打开一个温缓存会话(本地有行、水位 fresh),断网漏一条该会话的 MESSAGE_UPSERT,重连触发 resync;确认该打开会话气泡补齐漏的消息(force 同步 reconcile 生效),而非停留旧缓存。

- [ ] **Step 7: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/lib/api/useMessageHistory.ts frontends/lib/api/useMessageHistory.test.ts
git commit -m "feat(messages): 打开会话消费 resync notice 强制绕水位门 reconcile 补齐气泡"
```

---

## 自检

### spec 覆盖逐条

- **§6.1 B1**(仅 resync 路径从 ack 推 `upsert_if_greater(replayed_to_seq)`;false 维持 apply-then-advance;与 `hub.rs:1207` 不变量关系)→ Task 1(纯函数 `cursor_after_subscribe_ack` + run_loop resync 分支接线;false 不进该分支天然不推)。
- **§6.4-1 recents**(resync 对齐 force 透传后端跳 `local_count>=200` 短路做首页 LWW 重拉)→ Task 2(后端 `prefill_to_watermark` + `prefill_recent_friends` 加 force / `prefill_short_circuit`)+ Task 3(前端 `prefillRecentFriends` 透传 + `useRecentFriends` resync 调 `prefillWatermark(true)`)。
- **§6.4-2 账号**(resync 对 accounts 置 `force=true` 拉 listMine)→ Task 4(`useAccounts` resync 跃迁置 `forceNextRef`)。
- **§6.4-3 温缓存会话**(resync 后忽略水位门 fresh 一次,强制绕门 `reconcile_newest`)→ Task 5(后端 `load_conversation_messages` 加 force / `should_reconcile_conv_messages`)+ Task 6(前端 resync notice → `readCache(force=true)`)。
- **§6.4-4 已打开会话气泡**(resync 信号额外对当前打开会话主动触发一次 `reconcile_newest`)→ Task 5(`broadcast_resync_to_all_topics` 补 `ConversationMessages` topic / `RESYNC_BROADCAST_TOPICS`)+ Task 6(打开会话 hook 消费该 notice force reconcile)。
- **§6.4-5 残余有界风险**(未打开会话惰性自愈;最坏丢 `head−old`)→ 不实现,Task 5 Step 7 TODO 与 spec 一致点名承认。

### 占位符扫描

- 无 TBD/"类似上文"。所有代码块基于读到的真实签名:`NotifySeqStore::upsert_if_greater(u64)`、`SubscribeAck{resumed_from_seq,replayed_to_seq,resync_required,resync_reason}`、`ChangeTopic::{Accounts,Friends,RecentSessions,ConversationMessages}`、`ChangeNotice::resync(topic,scope)`、`ChangeScope::employee`、`prefill_to_watermark(hub,store,change_tx,employee_id,filter)` + `RECENT_FRIENDS_WATERMARK_TARGET=200`、`load_conversation_messages` 现有形参、`message_sync.reconcile_newest(conv,wa,ext,emp,limit)`、`useResource` 的 `resyncing`/`queryFn`、`forceNextRef`、`changeBus.subscribe(topic,scope,cb)`、`ChangeSource="resync"`、既有测试夹具(`resourceResult`/`mkEntries`/`useResourceMock`/`prefillMock`/`loadMock`/`flush`)。
- 5 处 **TODO(主工程师确认)** 显式标注(Task 2 force 重拉 size 钳制、Task 4 resync→force 时序落点 (a)/(b)、Task 4 测试可行性、Task 5 force reconcile page_size、Task 6 changeBus mock 可重定义性),均为读码后无法独断的设计/夹具/时序细节。

### 类型/签名一致性

- Rust:`cursor_after_subscribe_ack(bool,u64)->Option<u64>`、`prefill_short_circuit(bool,usize,usize)->bool`、`should_reconcile_conv_messages(bool,bool,bool)->bool` 均为新增纯函数,无签名冲突;`prefill_to_watermark` / `prefill_recent_friends` / `load_conversation_messages` 加形参后唯一/全部调用点同 commit 内更新(编译兜底)。
- TS:`prefillRecentFriends(accountFilter?, force=false)`、`loadConversationMessages({...,force?})`、`readCache(showLoading, opts?)` 均为**加可选参/默认值**,既有调用零改动;`useResource` 公共签名**不动**(Task 4 走 effect 方案 (a))。
- crate 名:后端 bin crate `-p chathub` 已确认(`backends/Cargo.toml [package].name = "chathub"`);客户端 crate `-p chathub-net`。

---

## 备注:部署序与门槛

P3 客户端独立可上线,**兼容旧 relay**:旧 relay `resync_required=false` 的小回放 ack 不进 B1 推进分支(`if ack.resync_required`),游标仍 apply-then-advance,无行为变化;`resync_required=true` 的大回放/缺口 ack 下 B1 推进 + 安全网硬化生效。P4(B2 relay 跳重放)以"B1 客户端覆盖率达阈值"为硬门槛(spec §6.5),故 P3 必须先于 P4 全量铺开。本阶段四项安全网均为"resync 时多打一次远端对齐"的有界成本,无自激循环(`reconcile_newest` 的 `should_notify` 短路 + `prefill` 的 iters/耗尽兜底已验证)。
