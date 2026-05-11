# ChatHub Plan 4 — Chat Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端通过 `Hub.Recall` 撤回消息、通过 `Hub.AckRead` 上报已读、通过 `Hub.FetchHistory` 拉取历史(opaque cursor 分页);通过 `Subscribe` 透传 `MessageRecalled / ReadReceipt / MessageStatusChange` 三种业务事件;`AuthError::AccountDisabled` 翻译 PermissionDenied,classify 归 Terminate。在 stub Relay 上跑通 5 个新 e2e,Plan 2/3 已有 17 个 e2e 不破。

**Architecture:** 全部增量演化:HubClient 加 3 个 unary 方法(与 send 同模式),`AuthError` 加 1 个 variant + 改 `From<Status>` 1 个分支,classify 加 1 个 match arm,backends 加 3 个 Tauri 命令。**完全不动 ConnectionManager / SeqStore / SessionStore / KeyringTokenStore / Plan 3 桥接 task**。

**Tech Stack:** tonic 0.12 + prost 0.13 + tokio 1.x + uuid 1。无新依赖。

**Spec:** `docs/superpowers/specs/2026-05-11-chat-protocol-chat-actions-design.md`(已 commit `6886baf`)。本计划严格按 spec §10 / §11 落地。

**Plan 1/2/3 状态:** 全部合入 main(`6ddcc9c..4483679`)。Plan 4 在新 feature 分支 `feature/0511/chat-actions` 上开发。

---

## File Structure

### 修改

```
proto/chathub/v1/
├── hub.proto         ← +3 rpc + 7 message
└── event.proto       ← ServerEvent.body +3 variant + 3 message

backends/crates/chathub-proto/
├── build.rs          ← +7 type_attribute
└── src/lib.rs        ← +2 JSON roundtrip smoke test

backends/crates/chathub-net/
├── src/error.rs      ← +AccountDisabled variant + PermissionDenied translation + 1 unit test
├── src/hub.rs        ← HubClient::{recall, ack_read, fetch_history} + classify::AccountDisabled arm + 1 unit test
├── tests/common/stub_relay.rs ← StubHubState +recalls/ack_reads/fetch_history_reqs + 3 outcome enums + 3 impl Hub methods
└── tests/hub_e2e.rs  ← +5 e2e scenarios

backends/src/
└── lib.rs            ← +3 Tauri commands + invoke_handler register
```

### 不动(承诺)

- `proto/chathub/v1/{auth,common,error,message}.proto`
- `chathub-state` 全部(SeqStore / SessionStore / KeyringTokenStore)
- `chathub-net/src/{auth,channel,interceptor,token}.rs`
- `chathub-net/src/hub.rs` 中 ConnectionManager / Inner / run_loop / ExponentialBackoff / BackoffConfig / ConnectionState / HubClient::{new,send,subscribe}
- `backends/Cargo.toml` / `Cargo.toml`(repo root)
- `backends/src/lib.rs` 中:setup / try_resume / login / logout / current_session / send_message / hub_state / 2 个桥接 task / RunEvent
- `frontends/` / CI workflows

---

## Task 1: proto 加 Plan 4 RPC + messages

**Files:**

- Modify: `proto/chathub/v1/hub.proto`
- Modify: `proto/chathub/v1/event.proto`

为什么:Plan 4 后续所有代码都依赖这些 proto 类型。proto 改动是 wire-compat 的(只新增 RPC + tag 11/12/13 + 新 message)。

- [ ] **Step 1.1: 把 `proto/chathub/v1/hub.proto` 整体替换**

```proto
// proto/chathub/v1/hub.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/event.proto";
import "chathub/v1/message.proto";

// Hub service:Plan 3 起 Subscribe + Send;Plan 4 起 Recall + AckRead + FetchHistory。
// 后续 Plan 5 加 ListWecomAccounts / EnableAccount / DisableAccount。
service Hub {
  rpc Subscribe   (SubscribeRequest)    returns (stream ServerEvent);
  rpc Send        (SendRequest)         returns (SendResponse);
  rpc Recall      (RecallRequest)       returns (RecallResponse);
  rpc AckRead     (AckReadRequest)      returns (AckReadResponse);
  rpc FetchHistory(FetchHistoryRequest) returns (FetchHistoryResponse);
}

message SubscribeRequest {
  map<string, int64> since_seqs = 1;
}

message SendRequest {
  string wecom_account_id = 1;
  string conversation_id  = 2;
  string client_msg_id    = 3;
  MessageBody body        = 4;
}
message SendResponse {
  string server_msg_id = 1;
  int64  sent_at_ms    = 2;
}

// Plan 4 — 撤回:by server_msg_id,无 reason
message RecallRequest {
  string wecom_account_id = 1;
  string conversation_id  = 2;
  string server_msg_id    = 3;
}
message RecallResponse {
  int64 recalled_at_ms = 1;
}

// Plan 4 — 读回执:batched 语义("已读到这条及之前的全部")
message AckReadRequest {
  string wecom_account_id        = 1;
  string conversation_id         = 2;
  string last_read_server_msg_id = 3;
}
message AckReadResponse {
  int64 acked_at_ms = 1;
}

// Plan 4 — 历史拉取:opaque cursor 分页
message FetchHistoryRequest {
  string wecom_account_id = 1;
  string conversation_id  = 2;
  uint32 limit            = 3;   // 客户端 ≤ 100;0 视为默认(由服务端决定)
  string cursor           = 4;   // 空 = 从最新开始;服务端 echo next_cursor
}
message FetchHistoryResponse {
  repeated HistoryMessage messages = 1;   // 升序按 sent_at_ms
  string next_cursor               = 2;   // 空 = 无更早历史
}
message HistoryMessage {
  string conversation_id = 1;
  string from_user_id    = 2;
  MessageBody body       = 3;
  int64  sent_at_ms      = 4;
  string server_msg_id   = 5;
  bool   recalled        = 6;   // 已撤回的也返回,客户端展示占位"消息已撤回"
}
```

- [ ] **Step 1.2: 把 `proto/chathub/v1/event.proto` 整体替换**

```proto
// proto/chathub/v1/event.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/common.proto";
import "chathub/v1/message.proto";

// ServerEvent 由 Hub.Subscribe 推送。Plan 3 有 IncomingMsg + SystemSignal;
// Plan 4 加 MessageRecalled / ReadReceipt / MessageStatusChange;
// Plan 5 起加 AccountStatus / PresenceChange(tag 14/15)。
message ServerEvent {
  string wecom_account_id = 1;
  int64  seq              = 2;
  // 3-9 reserved for envelope-level fields

  oneof body {
    IncomingMsg          incoming      = 10;
    MessageRecalled      recalled      = 11;
    ReadReceipt          read_receipt  = 12;
    MessageStatusChange  status_change = 13;
    SystemSignal         system        = 90;
    // 14-89 reserved for business events (Plan 5+)
    // 91-99 reserved for system signals (Plan 5+)
  }
}

message IncomingMsg {
  string conversation_id = 1;
  string from_user_id    = 2;
  MessageBody body       = 3;
  int64  sent_at_ms      = 4;
  string server_msg_id   = 5;
  optional RemoteId remote = 6;
}

// Plan 4 — 对端 / 自己的撤回通知
message MessageRecalled {
  string conversation_id = 1;
  string server_msg_id   = 2;
  int64  recalled_at_ms  = 3;
  string by_user_id      = 4;
}

// Plan 4 — 对端已读
message ReadReceipt {
  string conversation_id         = 1;
  string by_user_id              = 2;
  string last_read_server_msg_id = 3;
  int64  read_at_ms              = 4;
}

// Plan 4 — 自己发出消息的状态变化
message MessageStatusChange {
  enum Status {
    STATUS_UNSPECIFIED = 0;
    STATUS_SENT        = 1;
    STATUS_DELIVERED   = 2;
    STATUS_FAILED      = 3;
  }
  string conversation_id = 1;
  string client_msg_id   = 2;
  string server_msg_id   = 3;
  Status status          = 4;
}

message SystemSignal {
  enum Kind {
    KIND_UNSPECIFIED  = 0;
    KIND_KICKED       = 1;
    KIND_SERVER_DRAIN = 2;
  }
  Kind   kind   = 1;
  string detail = 2;
}
```

- [ ] **Step 1.3: 验证 proto 编译**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-proto
```

Expected: 成功。此时 build.rs 还没给新 message 加 type_attribute,但 build 仍能过(Task 2 加)。

- [ ] **Step 1.4: 提交**

```bash
git add proto/chathub/v1/hub.proto proto/chathub/v1/event.proto
git commit -m "$(cat <<'EOF'
feat(proto): Plan 4 — Recall + AckRead + FetchHistory + 3 业务 event

hub.proto:
- 加 3 RPC: Recall(by server_msg_id, 无 reason) / AckRead(batched last_read) / FetchHistory(opaque cursor)
- 加 7 message: RecallReq/Resp / AckReadReq/Resp / FetchHistoryReq/Resp / HistoryMessage(含 recalled bool)

event.proto:
- ServerEvent.body 加 3 oneof variant: MessageRecalled=11 / ReadReceipt=12 / MessageStatusChange=13
- MessageStatusChange.Status enum: STATUS_SENT/DELIVERED/FAILED
- tag 14-89 / 91-99 留给 Plan 5+
EOF
)"
```

---

## Task 2: chathub-proto build.rs 加 type_attribute + smoke test

**Files:**

- Modify: `backends/crates/chathub-proto/build.rs`
- Modify: `backends/crates/chathub-proto/src/lib.rs`(mod tests 加 2 个 JSON 往返)

为什么:Plan 4 的新跨边界类型(RecallResponse / AckReadResponse / FetchHistoryResponse / HistoryMessage / MessageRecalled / ReadReceipt / MessageStatusChange)需要 serde derive 给 backends Tauri 命令返回 / `hub:event` payload 用。`MessageStatusChange.Status` nested enum 由父 message attribute cascade(同 Plan 3 SystemSignal.Kind 经验)。

- [ ] **Step 2.1: 在 `backends/crates/chathub-proto/build.rs` 的 `.compile_protos(...)` 之前追加 7 条 type_attribute**

把现有 `tonic_build::configure()...` 链中,在 Plan 3 的 "Plan 3 新增 5 条" 注释块之后,`.compile_protos(...)` 之前添加:

```rust
        // ↓↓↓ Plan 4 新增 7 条 ↓↓↓
        .type_attribute(".chathub.v1.RecallResponse",        "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.AckReadResponse",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.FetchHistoryResponse",  "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.HistoryMessage",        "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageRecalled",       "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.ReadReceipt",           "#[derive(serde::Serialize, serde::Deserialize)]")
        .type_attribute(".chathub.v1.MessageStatusChange",   "#[derive(serde::Serialize, serde::Deserialize)]")
```

不加 `.chathub.v1.MessageStatusChange.Status`,与 Plan 3 SystemSignal.Kind 同处理(nested regular enum cascade)。

- [ ] **Step 2.2: 在 `backends/crates/chathub-proto/src/lib.rs` 的 `mod tests { ... }` 内追加 2 个 JSON 往返测试**

```rust
    #[test]
    fn server_event_with_recalled_serializes_round_trip() {
        use super::v1::{server_event, MessageRecalled, ServerEvent};

        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 50,
            body: Some(server_event::Body::Recalled(MessageRecalled {
                conversation_id: "conv-1".into(),
                server_msg_id: "sm-1".into(),
                recalled_at_ms: 1_700_000_000_000,
                by_user_id: "peer-1".into(),
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }

    #[test]
    fn message_status_change_delivered_serializes_round_trip() {
        use super::v1::{message_status_change, server_event, MessageStatusChange, ServerEvent};

        let evt = ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 60,
            body: Some(server_event::Body::StatusChange(MessageStatusChange {
                conversation_id: "conv-1".into(),
                client_msg_id: "client-uuid".into(),
                server_msg_id: "sm-2".into(),
                status: message_status_change::Status::Delivered as i32,
            })),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        let back: ServerEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, evt);
    }
```

- [ ] **Step 2.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-proto
```

Expected: 8 个测试全过(原 6 + 新 2)。

- [ ] **Step 2.4: clippy**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 2.5: 提交**

```bash
git add backends/crates/chathub-proto/build.rs backends/crates/chathub-proto/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(chathub-proto): serde derive for Plan 4 cross-Tauri-boundary types

build.rs:
- 7 条新 type_attribute:RecallResponse / AckReadResponse / FetchHistoryResponse /
  HistoryMessage / MessageRecalled / ReadReceipt / MessageStatusChange
- MessageStatusChange.Status nested enum cascade,不显式加

src/lib.rs:
- 2 个 JSON 往返测试覆盖 server_event::Body::Recalled / StatusChange
EOF
)"
```

---

## Task 3: AuthError 加 AccountDisabled variant + PermissionDenied 翻译

**Files:**

- Modify: `backends/crates/chathub-net/src/error.rs`

为什么:Plan 3 spec §6.3 / §7.5 显式留给 Plan 4 的债 — PermissionDenied 在 Plan 3 走 fallback Internal → Backoff(无限重连),Plan 4 改 AccountDisabled → Terminate。

- [ ] **Step 3.1: 在 `backends/crates/chathub-net/src/error.rs` 的 AuthError enum 末尾追加 AccountDisabled variant**

把现有 enum 改成:

```rust
#[derive(thiserror::Error, Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthError {
    #[error("invalid credentials")]
    Unauthenticated,

    #[error("upgrade required (min={min_version})")]
    UpgradeRequired {
        min_version: String,
        download_url: String,
    },

    #[error("network error: {message}")]
    Network { message: String },

    #[error("storage error: {message}")]
    Storage { message: String },

    #[error("internal: {message}")]
    Internal { message: String },

    #[error("account disabled: {message}")]
    AccountDisabled { message: String },
}
```

- [ ] **Step 3.2: 修改 `impl From<tonic::Status> for AuthError`,加 PermissionDenied 翻译**

把现有 impl 改成:

```rust
impl From<tonic::Status> for AuthError {
    fn from(s: tonic::Status) -> Self {
        use tonic::Code::*;
        // 优先解析 details 里的 ErrorDetail.UpgradeRequired
        if matches!(s.code(), FailedPrecondition) {
            if let Some(upgrade) = parse_upgrade_required(&s) {
                return upgrade;
            }
        }
        match s.code() {
            Unauthenticated => AuthError::Unauthenticated,
            Unavailable | DeadlineExceeded => AuthError::Network {
                message: s.message().to_string(),
            },
            PermissionDenied => AuthError::AccountDisabled {
                message: s.message().to_string(),
            },
            FailedPrecondition => AuthError::Internal {
                message: format!("precondition: {}", s.message()),
            },
            _ => AuthError::Internal {
                message: s.message().to_string(),
            },
        }
    }
}
```

- [ ] **Step 3.3: 在 `#[cfg(test)] mod tests` 内追加 1 个单元测试**

```rust
    #[test]
    fn permission_denied_translates_to_account_disabled() {
        let err: AuthError = Status::permission_denied("forbidden").into();
        match err {
            AuthError::AccountDisabled { message } => assert_eq!(message, "forbidden"),
            other => panic!("wrong variant: {other:?}"),
        }
    }
```

- [ ] **Step 3.4: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --lib error::
```

Expected: 6 个测试全过(原 5 + 新 1)。

- [ ] **Step 3.5: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning。Note: classify 函数在 hub.rs 还未处理 AccountDisabled,会报 match 不完整 error。需要在 Task 4 一起搞,或本 task 先加临时 `AuthError::AccountDisabled { .. } => Action::Backoff` 占位再下个 task 替换。**选择前者** — 把 Task 3 + 4 当一个 commit 做(下一 step 直接进 Task 4 内容,合一 commit)。

- [ ] **Step 3.6: 暂不提交 — Task 4 一起 commit**

Task 4 与本 task 在 hub.rs 里是连锁修改(enum 加新 variant → match 不完整),合到一个 commit 更干净。

---

## Task 4: classify 加 AccountDisabled → Terminate

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(classify 加分支 + 1 单元测试)

为什么:Plan 3 spec §6.3 显式留给 Plan 4 的债。AccountDisabled 与 UpgradeRequired 同语义:本地无法自愈,task 退出,前端处理。

- [ ] **Step 4.1: 修改 `backends/crates/chathub-net/src/hub.rs` 中 classify 函数**

找到现有 `pub(crate) fn classify(err: &AuthError) -> Action { ... }`,改为:

```rust
pub(crate) fn classify(err: &AuthError) -> Action {
    match err {
        AuthError::Unauthenticated         => Action::ReactiveRefresh,
        AuthError::UpgradeRequired { .. }  => Action::Terminate,
        AuthError::Network { .. }          => Action::Backoff,
        AuthError::Storage { .. }          => Action::Terminate,
        AuthError::Internal { .. }         => Action::Backoff,
        AuthError::AccountDisabled { .. }  => Action::Terminate,
    }
}
```

- [ ] **Step 4.2: 在 `#[cfg(test)] mod tests` 内追加 1 个 classify 测试**

```rust
    #[test]
    fn classify_account_disabled_returns_terminate() {
        let a = classify(&AuthError::AccountDisabled { message: "no perms".into() });
        assert_eq!(a, Action::Terminate);
    }
```

- [ ] **Step 4.3: 跑测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --lib
```

Expected: 24 + 1 (Task 3) + 1 (本 task) = 26 个 lib 测试全过。

- [ ] **Step 4.4: clippy 全 workspace**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 4.5: 一起提交 Task 3 + Task 4**

```bash
git add backends/crates/chathub-net/src/error.rs backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): AccountDisabled variant + PermissionDenied → Terminate

error.rs:
- AuthError 加 AccountDisabled { message: String } variant
- From<tonic::Status> 把 PermissionDenied 翻译为 AccountDisabled(原走 fallback Internal)
- 1 单元测试 permission_denied_translates_to_account_disabled

hub.rs:
- classify 加 AccountDisabled → Action::Terminate 分支
- 1 单元测试 classify_account_disabled_returns_terminate
- Plan 3 spec §6.3 / §7.5 留给 Plan 4 的债清掉
EOF
)"
```

---

## Task 5: stub Hub 扩展 Plan 4 三个新方法 + outcomes

**Files:**

- Modify: `backends/crates/chathub-net/tests/common/stub_relay.rs`

为什么:Plan 4 e2e 需要 stub 能 (a) 记录收到的 RecallRequest / AckReadRequest / FetchHistoryRequest;(b) 控制每个方法的返回(Ok 或 Status);(c) 不破 Plan 2/3 用法。

- [ ] **Step 5.1: 在 `backends/crates/chathub-net/tests/common/stub_relay.rs` 文件末尾追加 Plan 4 增量**

在文件末尾(`impl Hub for StubHub { ... }` 块的**外面**,作为新 section)追加:

```rust
// ============================ Plan 4:Recall / AckRead / FetchHistory ============================

use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, FetchHistoryRequest, FetchHistoryResponse,
    RecallRequest, RecallResponse,
};

#[derive(Clone)]
pub enum RecallStubOutcome {
    Ok(RecallResponse),
    Status(Status),
}
impl Default for RecallStubOutcome {
    fn default() -> Self {
        Self::Ok(RecallResponse { recalled_at_ms: 0 })
    }
}

#[derive(Clone)]
pub enum AckReadStubOutcome {
    Ok(AckReadResponse),
    Status(Status),
}
impl Default for AckReadStubOutcome {
    fn default() -> Self {
        Self::Ok(AckReadResponse { acked_at_ms: 0 })
    }
}

#[derive(Clone)]
pub enum FetchHistoryStubOutcome {
    Ok(FetchHistoryResponse),
    Status(Status),
}
impl Default for FetchHistoryStubOutcome {
    fn default() -> Self {
        Self::Ok(FetchHistoryResponse {
            messages: vec![],
            next_cursor: String::new(),
        })
    }
}
```

- [ ] **Step 5.2: 修改 `StubHubState`,加 Plan 4 字段**

把现有 `StubHubState` 结构体改为:

```rust
#[derive(Default)]
pub struct StubHubState {
    pub subscribes: Vec<HashMap<String, i64>>,
    pub event_tx: Option<mpsc::Sender<Result<ServerEvent, Status>>>,
    pub subscribe_outcome: SubscribeOutcome,
    pub send_outcome: SendStubOutcome,
    pub sends: Vec<SendRequest>,

    // Plan 4 新增
    pub recalls: Vec<RecallRequest>,
    pub recall_outcome: RecallStubOutcome,
    pub ack_reads: Vec<AckReadRequest>,
    pub ack_read_outcome: AckReadStubOutcome,
    pub fetch_history_reqs: Vec<FetchHistoryRequest>,
    pub fetch_history_outcome: FetchHistoryStubOutcome,
}
```

- [ ] **Step 5.3: 在 `impl Hub for StubHub { ... }` 块内,`send` 方法之后追加 3 个新方法**

```rust
    async fn recall(
        &self,
        req: Request<RecallRequest>,
    ) -> Result<Response<RecallResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.recalls.push(req.into_inner());
        match s.recall_outcome.clone() {
            RecallStubOutcome::Ok(r) => Ok(Response::new(r)),
            RecallStubOutcome::Status(st) => Err(st),
        }
    }

    async fn ack_read(
        &self,
        req: Request<AckReadRequest>,
    ) -> Result<Response<AckReadResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.ack_reads.push(req.into_inner());
        match s.ack_read_outcome.clone() {
            AckReadStubOutcome::Ok(r) => Ok(Response::new(r)),
            AckReadStubOutcome::Status(st) => Err(st),
        }
    }

    async fn fetch_history(
        &self,
        req: Request<FetchHistoryRequest>,
    ) -> Result<Response<FetchHistoryResponse>, Status> {
        let mut s = self.state.lock().unwrap();
        s.fetch_history_reqs.push(req.into_inner());
        match s.fetch_history_outcome.clone() {
            FetchHistoryStubOutcome::Ok(r) => Ok(Response::new(r)),
            FetchHistoryStubOutcome::Status(st) => Err(st),
        }
    }
```

- [ ] **Step 5.4: 编译 + 跑 Plan 2/3 e2e 不破**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net --tests
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected:

- auth_e2e 7/7 (Plan 2)
- hub_e2e 10/10 (Plan 3,Plan 4 e2e 还没加)

- [ ] **Step 5.5: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 5.6: 提交**

```bash
git add backends/crates/chathub-net/tests/common/stub_relay.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): stub Hub fixture 加 Recall / AckRead / FetchHistory

- StubHubState: + recalls/ack_reads/fetch_history_reqs Vec
                + recall_outcome/ack_read_outcome/fetch_history_outcome 三 enum(Ok / Status)
- impl Hub for StubHub: + recall/ack_read/fetch_history 三方法
- 与 send 同模式(state.lock + push 请求 + match outcome)
- 验证 Plan 2 7 + Plan 3 10 个 e2e 不破
EOF
)"
```

---

## Task 6: HubClient::recall

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(HubClient impl 加 recall 方法)

为什么:撤回是 Plan 4 第一个新 RPC。与 send 同模式 — pub async fn,unary,失败映射到 AuthError。

- [ ] **Step 6.1: 修改 `backends/crates/chathub-net/src/hub.rs` 顶部 imports**

在 `use chathub_proto::v1::{...}` 中添加(如果尚未存在):

- `RecallRequest, RecallResponse`

整行可能改为:

```rust
use chathub_proto::v1::{
    RecallRequest, RecallResponse, SendRequest, SendResponse, ServerEvent, SubscribeRequest,
};
```

- [ ] **Step 6.2: 在 `impl HubClient { ... }` 块内,`send` 之后(或 `subscribe` 之前)追加 recall 方法**

```rust
    /// Plan 4 — 撤回单条消息(by server_msg_id)。
    /// 失败:PermissionDenied → AuthError::AccountDisabled;Unavailable → Network 等。
    pub async fn recall(&self, req: RecallRequest) -> Result<RecallResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.recall(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
```

- [ ] **Step 6.3: 编译 + 跑 lib tests**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net
cargo test -p chathub-net --lib
```

Expected: 编译过;现有 lib 单元测试全过(暂无 e2e,Task 9 加)。

- [ ] **Step 6.4: clippy**

```bash
cargo clippy -p chathub-net -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 6.5: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "$(cat <<'EOF'
feat(chathub-net): HubClient::recall (unary)

- HubClient::recall(RecallRequest) → Result<RecallResponse, AuthError>
- 与 send 同模式:self.inner.clone() + Request::new + ? on Status
- 暂无 e2e,Task 9 加场景验证
EOF
)"
```

---

## Task 7: HubClient::ack_read

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(加 ack_read 方法)

为什么:读回执上报。batched 语义(last_read_server_msg_id)。

- [ ] **Step 7.1: 修改 `backends/crates/chathub-net/src/hub.rs` 顶部 imports**

在 `use chathub_proto::v1::{...}` 中添加 `AckReadRequest, AckReadResponse`。

- [ ] **Step 7.2: 在 `impl HubClient { ... }` 块内追加 ack_read 方法**

```rust
    /// Plan 4 — 上报已读(batched:last_read_server_msg_id 及之前全部已读)。
    pub async fn ack_read(
        &self,
        req: AckReadRequest,
    ) -> Result<AckReadResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.ack_read(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
```

- [ ] **Step 7.3: 编译 + lib tests + clippy**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net
cargo test -p chathub-net --lib
cargo clippy -p chathub-net -- -D warnings
```

Expected: 全过 + 0 warning。

- [ ] **Step 7.4: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "feat(chathub-net): HubClient::ack_read (unary, batched last_read)"
```

---

## Task 8: HubClient::fetch_history

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs`(加 fetch_history 方法)

为什么:历史拉取。opaque cursor 分页。

- [ ] **Step 8.1: 修改 `backends/crates/chathub-net/src/hub.rs` 顶部 imports**

在 `use chathub_proto::v1::{...}` 中添加 `FetchHistoryRequest, FetchHistoryResponse`。

- [ ] **Step 8.2: 在 `impl HubClient { ... }` 块内追加 fetch_history 方法**

```rust
    /// Plan 4 — 拉取历史消息(opaque cursor 分页;空 cursor = 从最新开始)。
    pub async fn fetch_history(
        &self,
        req: FetchHistoryRequest,
    ) -> Result<FetchHistoryResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.fetch_history(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
```

- [ ] **Step 8.3: 编译 + lib tests + clippy**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-net
cargo test -p chathub-net --lib
cargo clippy -p chathub-net -- -D warnings
```

Expected: 全过 + 0 warning。

- [ ] **Step 8.4: 提交**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "feat(chathub-net): HubClient::fetch_history (unary, opaque cursor)"
```

---

## Task 9: e2e Recall — success + permission_denied

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 2 个 e2e)

为什么:验证 HubClient::recall 调用路径 + PermissionDenied → AccountDisabled 翻译。

- [ ] **Step 9.1: 在 `tests/hub_e2e.rs` imports 段补缺(检查后追加)**

确保以下都已 import(其中 SubscribeOutcome / Status / SendStubOutcome / SendResponse 等 Plan 3 已有):

```rust
use chathub_proto::v1::{
    AckReadRequest, AckReadResponse, FetchHistoryRequest, FetchHistoryResponse, HistoryMessage,
    RecallRequest, RecallResponse,
};
use common::stub_relay::{
    AckReadStubOutcome, FetchHistoryStubOutcome, RecallStubOutcome,
};
```

- [ ] **Step 9.2: 在文件末尾追加 2 个 e2e**

```rust
/// Plan 4 Task 9 helper:从 stub 装配 HubClient(不经 ConnectionManager,unary 路径)
async fn make_hub_only(addr: std::net::SocketAddr) -> HubClient {
    let url = format!("http://{}", addr);
    let endpoint = build_endpoint(&url).expect("endpoint");
    let channel = endpoint.connect_lazy();
    let keyring = KeyringTokenStore::new(common::unique_keyring_service());
    let token_store = Arc::new(TokenStore::new(endpoint, keyring).expect("ts"));
    force_login(&token_store).await;
    token_store.force_refresh().await.expect("force_refresh");
    let interceptor = AuthInterceptor::new(token_store.clone());
    HubClient::new(channel, interceptor)
}

#[tokio::test]
async fn recall_success_returns_recalled_at_ms() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.recall_outcome = RecallStubOutcome::Ok(RecallResponse {
            recalled_at_ms: 1_700_000_000_000,
        });
    }
    let hub = make_hub_only(addr).await;

    let resp = hub
        .recall(RecallRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            server_msg_id: "sm-1".into(),
        })
        .await
        .expect("recall ok");

    assert_eq!(resp.recalled_at_ms, 1_700_000_000_000);

    let recalls = hub_state.lock().unwrap().recalls.clone();
    assert_eq!(recalls.len(), 1);
    assert_eq!(recalls[0].server_msg_id, "sm-1");
    assert_eq!(recalls[0].wecom_account_id, "wxa1");
}

#[tokio::test]
async fn recall_permission_denied_returns_account_disabled() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.recall_outcome =
            RecallStubOutcome::Status(Status::permission_denied("no recall permission"));
    }
    let hub = make_hub_only(addr).await;

    let err = hub
        .recall(RecallRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            server_msg_id: "sm-1".into(),
        })
        .await
        .expect_err("should fail");

    match err {
        AuthError::AccountDisabled { message } => {
            assert!(message.contains("no recall permission"), "got {message}");
        }
        other => panic!("wrong variant: {other:?}"),
    }
}
```

- [ ] **Step 9.3: 跑 e2e**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 12 个测试全过(原 10 + 新 2)。

- [ ] **Step 9.4: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 9.5: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e Recall — success + permission_denied → AccountDisabled

- recall_success_returns_recalled_at_ms:stub Ok(recalled_at_ms=1700...) → 客户端拿到 + 断言 stub.recalls
- recall_permission_denied_returns_account_disabled:Status::permission_denied("...") → AuthError::AccountDisabled{message}
- make_hub_only 辅助:不经 ConnectionManager,直接造 HubClient + token_store.force_refresh
EOF
)"
```

---

## Task 10: e2e AckRead

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 1 个 e2e)

为什么:验证 ack_read 调用,断言 stub 收到的 last_read_server_msg_id 字段。

- [ ] **Step 10.1: 在 `tests/hub_e2e.rs` 末尾追加 e2e**

```rust
#[tokio::test]
async fn ack_read_success_records_last_read_msg() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    {
        let mut s = hub_state.lock().unwrap();
        s.ack_read_outcome = AckReadStubOutcome::Ok(AckReadResponse {
            acked_at_ms: 1_700_000_000_500,
        });
    }
    let hub = make_hub_only(addr).await;

    let resp = hub
        .ack_read(AckReadRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            last_read_server_msg_id: "sm-50".into(),
        })
        .await
        .expect("ack_read ok");

    assert_eq!(resp.acked_at_ms, 1_700_000_000_500);

    let acks = hub_state.lock().unwrap().ack_reads.clone();
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0].last_read_server_msg_id, "sm-50");
    assert_eq!(acks[0].conversation_id, "conv-1");
}
```

- [ ] **Step 10.2: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 13 个测试全过。

- [ ] **Step 10.3: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 10.4: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e AckRead — success records last_read_server_msg_id

- stub AckReadStubOutcome::Ok(acked_at_ms=...) → 客户端 hub.ack_read 拿到
- 断言 stub.ack_reads 有 1 条,字段(last_read_server_msg_id / conversation_id) 与请求一致
EOF
)"
```

---

## Task 11: e2e FetchHistory — first page + paginate with cursor

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 1 个 e2e,2 次调用)

为什么:验证 cursor 分页:第一次空 cursor → 拿 page1 + next_cursor;第二次回传 next_cursor → 拿 page2 + empty next_cursor。

- [ ] **Step 11.1: 在 `tests/hub_e2e.rs` 末尾追加 e2e**

```rust
fn make_history_msg(server_msg_id: &str, text: &str, sent_at: i64, recalled: bool) -> HistoryMessage {
    HistoryMessage {
        conversation_id: "conv-1".into(),
        from_user_id: "peer-1".into(),
        body: Some(MessageBody {
            kind: Some(message_body::Kind::Text(TextBody { text: text.into() })),
            reply_to: None,
            mentions: vec![],
        }),
        sent_at_ms: sent_at,
        server_msg_id: server_msg_id.into(),
        recalled,
    }
}

#[tokio::test]
async fn fetch_history_returns_messages_and_paginates_with_cursor() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;

    // 第一次:cursor 空,stub 返回 3 条 + next_cursor="page2"
    {
        let mut s = hub_state.lock().unwrap();
        s.fetch_history_outcome = FetchHistoryStubOutcome::Ok(FetchHistoryResponse {
            messages: vec![
                make_history_msg("sm-10", "msg 10", 1_700_000_000_010, false),
                make_history_msg("sm-11", "msg 11", 1_700_000_000_011, true), // 已撤回
                make_history_msg("sm-12", "msg 12", 1_700_000_000_012, false),
            ],
            next_cursor: "page2".into(),
        });
    }
    let hub = make_hub_only(addr).await;

    let page1 = hub
        .fetch_history(FetchHistoryRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            limit: 3,
            cursor: String::new(),
        })
        .await
        .expect("page1");
    assert_eq!(page1.messages.len(), 3);
    assert_eq!(page1.messages[1].recalled, true);
    assert_eq!(page1.next_cursor, "page2");

    // 第二次:cursor="page2",stub 改 outcome 返回 2 条 + 空 next_cursor
    {
        let mut s = hub_state.lock().unwrap();
        s.fetch_history_outcome = FetchHistoryStubOutcome::Ok(FetchHistoryResponse {
            messages: vec![
                make_history_msg("sm-08", "msg 8", 1_700_000_000_008, false),
                make_history_msg("sm-09", "msg 9", 1_700_000_000_009, false),
            ],
            next_cursor: String::new(),
        });
    }

    let page2 = hub
        .fetch_history(FetchHistoryRequest {
            wecom_account_id: "wxa1".into(),
            conversation_id: "conv-1".into(),
            limit: 3,
            cursor: "page2".into(),
        })
        .await
        .expect("page2");
    assert_eq!(page2.messages.len(), 2);
    assert_eq!(page2.next_cursor, "");

    // 断言两次请求的 cursor 字段被正确传给 stub
    let reqs = hub_state.lock().unwrap().fetch_history_reqs.clone();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].cursor, "");
    assert_eq!(reqs[1].cursor, "page2");
}
```

- [ ] **Step 11.2: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 14 个测试全过。

- [ ] **Step 11.3: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 11.4: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e FetchHistory — 2-page cursor pagination

- 第一次 cursor="" → page1 (3 条,含 recalled=true 1 条) + next_cursor="page2"
- 第二次 cursor="page2" → page2 (2 条) + next_cursor=""
- 断言 stub.fetch_history_reqs 两次 cursor 字段正确传递
- 验证 HistoryMessage.recalled bool 字段透传
EOF
)"
```

---

## Task 12: e2e 业务 ServerEvent kind 透传(MessageRecalled / ReadReceipt / MessageStatusChange)

**Files:**

- Modify: `backends/crates/chathub-net/tests/hub_e2e.rs`(加 1 个 e2e)

为什么:验证 Plan 4 三个新 ServerEvent kind 在 run_loop 路径上正确透传到 broadcast(无需识别,与 IncomingMsg 同模式)。

- [ ] **Step 12.1: 在 `tests/hub_e2e.rs` 末尾追加 imports + e2e**

确保以下 imports 存在(可能 Plan 3 已加):

```rust
use chathub_proto::v1::{
    message_status_change, MessageRecalled, MessageStatusChange, ReadReceipt,
};
```

末尾追加测试:

```rust
#[tokio::test]
async fn server_event_business_kinds_are_forwarded() {
    let (addr, _auth, hub_state, _h) = start_stub_full().await;
    let (cm, token_store, _ss) = make_cm(addr).await;
    force_login(&token_store).await;

    cm.start().await;

    let mut state_rx = cm.state_subscribe();
    wait_for_state(
        &mut state_rx,
        |s| matches!(s, ConnectionState::Subscribed),
        Duration::from_secs(2),
    )
    .await;

    let mut event_rx = cm.event_subscribe();

    // 推 MessageRecalled
    push_event(
        &hub_state,
        ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 200,
            body: Some(server_event::Body::Recalled(MessageRecalled {
                conversation_id: "conv-1".into(),
                server_msg_id: "sm-10".into(),
                recalled_at_ms: 1_700_000_000_100,
                by_user_id: "peer-1".into(),
            })),
        },
    )
    .await;

    // 推 ReadReceipt
    push_event(
        &hub_state,
        ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 201,
            body: Some(server_event::Body::ReadReceipt(ReadReceipt {
                conversation_id: "conv-1".into(),
                by_user_id: "peer-1".into(),
                last_read_server_msg_id: "sm-9".into(),
                read_at_ms: 1_700_000_000_200,
            })),
        },
    )
    .await;

    // 推 MessageStatusChange
    push_event(
        &hub_state,
        ServerEvent {
            wecom_account_id: "wxa1".into(),
            seq: 202,
            body: Some(server_event::Body::StatusChange(MessageStatusChange {
                conversation_id: "conv-1".into(),
                client_msg_id: "client-uuid-fake".into(),
                server_msg_id: "sm-11".into(),
                status: message_status_change::Status::Delivered as i32,
            })),
        },
    )
    .await;

    // 收 3 个 event,断言 kind
    let e1 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await.expect("recv1 timeout").expect("recv1");
    assert!(matches!(&e1.body, Some(server_event::Body::Recalled(_))), "got {:?}", e1.body);
    assert_eq!(e1.seq, 200);

    let e2 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await.expect("recv2 timeout").expect("recv2");
    assert!(matches!(&e2.body, Some(server_event::Body::ReadReceipt(_))), "got {:?}", e2.body);
    assert_eq!(e2.seq, 201);

    let e3 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await.expect("recv3 timeout").expect("recv3");
    assert!(matches!(&e3.body, Some(server_event::Body::StatusChange(_))), "got {:?}", e3.body);
    assert_eq!(e3.seq, 202);

    cm.stop().await;
}
```

- [ ] **Step 12.2: 跑 e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 15 个测试全过(原 14 + 新 1)。

- [ ] **Step 12.3: clippy**

```bash
cargo clippy -p chathub-net --tests -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 12.4: 提交**

```bash
git add backends/crates/chathub-net/tests/hub_e2e.rs
git commit -m "$(cat <<'EOF'
test(chathub-net): e2e — 3 业务 ServerEvent kind 透传到 broadcast

- 通过 ConnectionManager 启动 + 推 MessageRecalled / ReadReceipt / MessageStatusChange
- broadcast 收到 3 个 event,oneof body 类型匹配 Recalled / ReadReceipt / StatusChange
- 验证 run_loop 不识别新 kind,纯透传(与 IncomingMsg 同路径)
EOF
)"
```

---

## Task 13: backends 加 recall_message / ack_read / fetch_history Tauri 命令

**Files:**

- Modify: `backends/src/lib.rs`(imports + 3 个新命令)

为什么:把 HubClient 的三个新方法暴露给前端。与 send_message 同模式。

- [ ] **Step 13.1: 修改 `backends/src/lib.rs` 顶部 imports**

在 `use chathub_proto::v1::{...}` 中追加(保留现有):

- `AckReadRequest, AckReadResponse`
- `FetchHistoryRequest, FetchHistoryResponse`
- `RecallRequest, RecallResponse`

完整 use chathub_proto 行(参考):

```rust
use chathub_proto::v1::{
    message_body, server_event, system_signal, AckReadRequest, AckReadResponse,
    FetchHistoryRequest, FetchHistoryResponse, MessageBody, RecallRequest, RecallResponse,
    SendRequest, SendResponse, TextBody, UserProfile,
};
```

- [ ] **Step 13.2: 在 `send_message` 命令之后追加 3 个新命令**

```rust
#[tauri::command]
async fn recall_message(
    hub: State<'_, HubClient>,
    wecom_account_id: String,
    conversation_id: String,
    server_msg_id: String,
) -> Result<RecallResponse, AuthError> {
    let req = RecallRequest {
        wecom_account_id,
        conversation_id,
        server_msg_id,
    };
    hub.recall(req).await
}

#[tauri::command]
async fn ack_read(
    hub: State<'_, HubClient>,
    wecom_account_id: String,
    conversation_id: String,
    last_read_server_msg_id: String,
) -> Result<AckReadResponse, AuthError> {
    let req = AckReadRequest {
        wecom_account_id,
        conversation_id,
        last_read_server_msg_id,
    };
    hub.ack_read(req).await
}

#[tauri::command]
async fn fetch_history(
    hub: State<'_, HubClient>,
    wecom_account_id: String,
    conversation_id: String,
    limit: u32,
    cursor: String,
) -> Result<FetchHistoryResponse, AuthError> {
    let req = FetchHistoryRequest {
        wecom_account_id,
        conversation_id,
        limit,
        cursor,
    };
    hub.fetch_history(req).await
}
```

- [ ] **Step 13.3: 编译验证**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub
```

Expected: 编译过。

- [ ] **Step 13.4: 跑 workspace test**

```bash
cargo test --workspace
```

Expected: 全部过(64 测试 = 8 proto + 12 state + 26 net lib + 7 auth_e2e + 15 hub_e2e — Tauri 命令不在 cargo test 跑)。

- [ ] **Step 13.5: clippy**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: 0 warning。

- [ ] **Step 13.6: 提交**

```bash
git add backends/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(backends): + recall_message / ack_read / fetch_history Tauri 命令

- 3 个命令都走 State<'_, HubClient>,与 send_message 同模式
- 命令签名展开 RecallRequest / AckReadRequest / FetchHistoryRequest 字段(便于前端 invoke)
- 返回 Result<Response, AuthError> 跨 Tauri 边界 — Response/AuthError 都有 serde derive
EOF
)"
```

---

## Task 14: invoke_handler 注册 3 个新命令

**Files:**

- Modify: `backends/src/lib.rs`(invoke_handler 末尾追加)

为什么:让前端能通过 `invoke('recall_message', ...)` 等调用。

- [ ] **Step 14.1: 修改 `backends/src/lib.rs` 末尾 `invoke_handler` 调用**

找到现有:

```rust
        .invoke_handler(tauri::generate_handler![
            greet, take_screenshot,
            login, logout, current_session,
            send_message, hub_state,
        ])
```

改为:

```rust
        .invoke_handler(tauri::generate_handler![
            greet, take_screenshot,
            login, logout, current_session,
            send_message, hub_state,
            recall_message, ack_read, fetch_history,
        ])
```

- [ ] **Step 14.2: 编译 + workspace test + clippy**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: 全过 + 0 warning。

- [ ] **Step 14.3: 提交**

```bash
git add backends/src/lib.rs
git commit -m "feat(backends): register recall_message / ack_read / fetch_history in invoke_handler"
```

---

## Task 15: 全套 DOD 验收

**Files:** 无修改,只跑命令验证。

- [ ] **Step 15.1: cargo build --workspace**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build --workspace
```

Expected: Finished,无 error。**DOD #1。**

- [ ] **Step 15.2: chathub-proto 测试**

```bash
cargo test -p chathub-proto
```

Expected: 8/8(原 6 + Plan 4 加 2)。**DOD #2。**

- [ ] **Step 15.3: chathub-state 测试**

```bash
cargo test -p chathub-state
```

Expected: 12/12(Plan 4 不动 chathub-state)。

- [ ] **Step 15.4: chathub-net lib 测试**

```bash
cargo test -p chathub-net --lib
```

Expected: 26/26(原 24 + Plan 4 error::1 + classify::1)。**DOD #3/#4。**

- [ ] **Step 15.5: hub_e2e**

```bash
cargo test -p chathub-net --test hub_e2e -- --test-threads=1
```

Expected: 15/15(原 10 + Plan 4 新 5)。**DOD #7。**

- [ ] **Step 15.6: Plan 2 auth_e2e 不破**

```bash
cargo test -p chathub-net --test auth_e2e -- --test-threads=1
```

Expected: 7/7。**DOD #8。**

- [ ] **Step 15.7: backends 编译**

```bash
cargo build -p chathub
```

Expected: Finished。**DOD #9。**

- [ ] **Step 15.8: clippy 严格**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: 0 warning。**DOD #10。**

- [ ] **Step 15.9: 列 hub_e2e 全部测试名,与 plan 一致**

```bash
grep -nE '^async fn ' backends/crates/chathub-net/tests/hub_e2e.rs | grep 'test'
# 或
grep -nB1 '^async fn ' backends/crates/chathub-net/tests/hub_e2e.rs | grep '#\[tokio::test\]' | wc -l
```

Expected: 15。

人工核对名字与 spec §10.1 一一对应:

| Plan 3 (原 10)                                   | Plan 4 (新 5)                                            |
| ------------------------------------------------ | -------------------------------------------------------- |
| connection_state_initial_is_disconnected         | recall_success_returns_recalled_at_ms                    |
| subscribe_success_streams_event                  | recall_permission_denied_returns_account_disabled        |
| subscribe_unavailable_backoffs_and_reconnects    | ack_read_success_records_last_read_msg                   |
| subscribe_unauthenticated_triggers_force_refresh | fetch_history_returns_messages_and_paginates_with_cursor |
| subscribe_upgrade_required_terminates            | server_event_business_kinds_are_forwarded                |
| logged_out_during_subscribe_terminates_task      |                                                          |
| subscribe_resumes_with_since_seqs                |                                                          |
| subscribe_kicked_emits_event_then_terminates     |                                                          |
| send_success_returns_server_msg_id               |                                                          |
| send_unavailable_returns_network_error           |                                                          |

- [ ] **Step 15.10: Cargo.lock diff 检查**

```bash
git diff main -- Cargo.lock | grep -E '^[+-]name = ' | sort -u
```

Expected: 空或仅含 patch 浮动(Plan 4 无新顶层 crate)。**DOD #11。**

- [ ] **Step 15.11: 检查工作树干净**

```bash
git status
```

Expected: `nothing to commit, working tree clean`。

- [ ] **Step 15.12: 列本 plan 全部 commit**

```bash
git log --oneline main..HEAD
```

Expected: 看到 14-15 个 commit(Task 1-14;Task 3+4 合 1 commit;Task 15 不 commit)。

---

## Task 16: optional cushion

留作 review 阶段加 nit fix(比如 reviewer 发现 spec compliance / code quality 小问题需要补 commit)。如无需要,跳过。

---

## Self-Review Checklist(plan 完整性)

对照 spec §11 DOD 逐项打勾:

- [ ] **DOD #1** proto 加 3 RPC + 7 message + 3 ServerEvent body variant + 3 event message — Task 1
- [ ] **DOD #2** chathub-proto build.rs + 2 smoke test — Task 2
- [ ] **DOD #3** AuthError AccountDisabled + From<Status> PermissionDenied + 1 unit test — Task 3 (合 Task 4)
- [ ] **DOD #4** classify AccountDisabled → Terminate + 1 unit test — Task 4
- [ ] **DOD #5** HubClient::{recall, ack_read, fetch_history} — Task 6/7/8
- [ ] **DOD #6** stub Hub 加 3 impl + 3 outcome enum — Task 5
- [ ] **DOD #7** 5 个新 e2e 全绿 — Task 9 (2) + 10 (1) + 11 (1) + 12 (1)
- [ ] **DOD #8** Plan 2+3 e2e 不破 — Task 5 + Task 15
- [ ] **DOD #9** backends 加 3 Tauri 命令 + invoke_handler 注册 — Task 13 + 14
- [ ] **DOD #10** clippy 0 warning — 每 task 末尾 + Task 15
- [ ] **DOD #11** Cargo.lock 一致 — Task 15

---

## 与 Plan 5+ 的连接点

落地后(参考 spec §13):

- `HubClient::{recall, ack_read, fetch_history}` 签名稳定;Plan 5 加 `list_wecom_accounts / enable_account / disable_account` 用同模式
- `ServerEvent.body` oneof tag 10-13/90 永久占用;Plan 5 用 14/15 加 AccountStatus / PresenceChange
- `AuthError::AccountDisabled` variant 稳定
- backends 命令 `recall_message / ack_read / fetch_history` 签名稳定;前端可依赖
- proto `HistoryMessage.recalled` 字段稳定;Plan 5 加媒体扩展时仅在 `MessageBody.kind` 加 oneof variant

---

End of plan.
