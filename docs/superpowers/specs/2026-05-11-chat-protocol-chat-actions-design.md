# ChatHub Plan 4 — Chat Actions(Recall / AckRead / FetchHistory + 业务 ServerEvent kind) 设计规范

## Context

Plan 1 (Foundation) / Plan 2 (Auth E2E) / Plan 3 (Subscribe + Send + ConnectionManager) 全部合入 main。当前 HEAD `4483679`。客户端有完整的鉴权 + 单向连接 + 收发底座,但**聊天体验三件套缺失**:撤回、读回执、历史回滚。

Plan 4 的目标:**补齐 IM 主路径**(发-收-读-撤-翻)。在 Hub service 加 3 个 unary RPC,在 ServerEvent 加 3 个业务 oneof 变体,在 AuthError 补 `AccountDisabled` variant,在 backends 加 3 个 Tauri 命令。**不动 ConnectionManager / SeqStore / SessionStore / KeyringTokenStore**,wire-compat 增量演化。

**不在范围(显式)**:

- 账号增删 `ListWecomAccounts` / `EnableAccount` / `DisableAccount` + `AccountStatus` ServerEvent — Plan 5
- `PresenceChange` ServerEvent — Plan 5
- `MessageBody` 媒体扩展(image/voice/video/file/location/link/markdown) — Plan 5
- 发送可靠性增强(local queue / 持久化重发 / in-Send transient retry) — Plan 6
- 历史本地缓存(SQLite history table) — Plan 6
- 前端 React 接线 — 独立前端 plan

**预期交付**: 一个 feature branch,16 个 TDD task,DOD = workspace test / clippy 全绿 + 5 个新 e2e + Plan 2/3 e2e 不破。

**协议层依据**: Plan 3 spec `docs/superpowers/specs/2026-05-10-chat-protocol-stream-design.md` §13 显式列出 Plan 4 应加的 RPC + ServerEvent kind + `AccountDisabled` variant。本 spec 不重复 Plan 1-3 决策。

---

## 1. 架构总览

```
+-----------------------+         +-------------------------------------+
| Frontend (React)      |         | chathub-net (Rust)                  |
|                       | invoke  |                                     |
|  send_message(...)    | ------> |  HubClient (Plan 3)                 |
|  recall_message(...)  | ------> |    ├─ send                          |
|  ack_read(...)        | ------> |    ├─ recall          ← Plan 4 新   |
|  fetch_history(...)   | ------> |    ├─ ack_read        ← Plan 4 新   |
|                       |         |    ├─ fetch_history   ← Plan 4 新   |
|  on hub:event         | <-----  |    └─ subscribe (pub(crate))        |
|                       |         |                                     |
|                       |         |  ConnectionManager (Plan 3)         |
|                       |         |    └─ run_loop event 透传(不识别    |
|                       |         |        新 business kind,直接 emit) |
|                       |         |                                     |
|                       |         |  classify / AuthError(Plan 4 扩展)  |
|                       |         |    └─ PermissionDenied →            |
|                       |         |       AccountDisabled → Terminate   |
+-----------------------+         +-----+----------------+--------------+
                                        | gRPC HTTP/2    |
                                        v                v
                                  +-------------------------------------+
                                  | chathub.v1.Hub                       |
                                  |   Subscribe / Send       (Plan 3)    |
                                  |   Recall  / AckRead      (Plan 4 新) |
                                  |   FetchHistory           (Plan 4 新) |
                                  +-------------------------------------+
```

**核心模块边界**(Plan 3 已立,Plan 4 完全遵循):

- `HubClient` — thin RPC wrapper。Plan 4 加 3 个新 unary 方法,与 `send` 同模式
- `ConnectionManager` — **完全不动**。run_loop 拿到 `Ok(Some(event))` 后直接 `event_tx.send`,新 business kind 自动透传
- `AuthError + classify` — 加 1 个 variant(AccountDisabled),改 `From<Status>` 翻译规则,加 1 个 classify 分支
- `backends/src/lib.rs` — 加 3 个 Tauri 命令,invoke_handler 注册;桥接 task 不动

---

## 2. 关键设计决策(已锁定)

| #   | 决策                                                                                   | 备选与理由                                                                                   |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **Scope:Recall + AckRead + FetchHistory + 3 业务 event**                               | 账号增删 + Presence 留 Plan 5;媒体扩展独立设计                                               |
| 2   | **AckRead 用 batched `last_read_server_msg_id` 语义**                                  | 单条 ack 浪费 RPC;IM 业界标准都是"已读到这条之前的全部"                                      |
| 3   | **FetchHistory 用 opaque cursor 分页**                                                 | 服务端可演化(cursor 内可携带 seq / shard / ts);客户端只 echo,不解析                          |
| 4   | **Recall by `server_msg_id`,无 reason 字段**                                           | YAGNI;企微平台撤回也无 reason 概念                                                           |
| 5   | **加 `AuthError::AccountDisabled { message }` + `From<Status>` 翻译 PermissionDenied** | Plan 3 spec §6.3 / §7.5 显式留给 Plan 4 的债                                                 |
| 6   | **classify 中 `AccountDisabled → Action::Terminate`**                                  | 与 UpgradeRequired 同语义:本地无法自愈,不重连                                                |
| 7   | **三个新 RPC 都通过 HubClient 加 unary 方法,与 send 同模式**                           | 不动 ConnectionManager;send 已验证模式                                                       |
| 8   | **业务 event 透传:run_loop 不识别新 kind,直接 `event_tx.send`**                        | 同 IncomingMsg;Plan 3 已建立这条路径,Plan 4 完全复用                                         |
| 9   | **backends 加 `recall_message / ack_read / fetch_history` 3 个 Tauri 命令**            | 与 send_message 同模式;前端直 invoke                                                         |
| 10  | **Recall 路径上 PermissionDenied 即 `AccountDisabled`(用 e2e 验证)**                   | 撤回失败的最常见服务端语义就是"该账号无撤回权限";比 Send 路径更典型                          |
| 11  | **HistoryMessage 单独定义,而非复用 IncomingMsg**                                       | 加 `recalled: bool` 字段,语义清晰;IncomingMsg 是"刚到的实时消息",HistoryMessage 是"历史回放" |
| 12  | **proto wire-compat:tag 11/12/13 永久占用业务 event,Plan 5 用 14/15**                  | 与 Plan 3 §12 "与 Plan 4+ 的接口承诺" 一致                                                   |

---

## 3. 文件布局变更

### 3.1 新建

无新文件。所有 Plan 4 改动落在已有文件上(Plan 3 已建好骨架)。

### 3.2 修改

```
proto/chathub/v1/
  hub.proto         ← 加 3 个 RPC + 6 个 message(Recall*/AckRead*/FetchHistory* + HistoryMessage)
  event.proto       ← ServerEvent.body 加 3 个 variant + 3 个 message(MessageRecalled / ReadReceipt / MessageStatusChange)

backends/crates/chathub-proto/
  build.rs          ← 在已有 13 条 type_attribute 后追加 6 条(覆盖 SendResponse 套路)
  src/lib.rs        ← mod tests 加 2 个 JSON 往返 smoke test

backends/crates/chathub-net/
  src/error.rs      ← 加 AuthError::AccountDisabled variant + From<Status> PermissionDenied 翻译 + 1 单元测试
  src/hub.rs        ← HubClient 加 recall/ack_read/fetch_history 三方法;classify 加 AccountDisabled → Terminate + 1 单元测试
  tests/common/stub_relay.rs ← StubHubState 加 recalls/ack_reads + 3 个 outcome enum + impl Hub 三个新方法
  tests/hub_e2e.rs  ← 加 5 个新 e2e 场景

backends/src/
  lib.rs            ← 加 3 个 Tauri 命令 + invoke_handler 注册 3 个新名
```

### 3.3 不动(承诺)

- `proto/chathub/v1/{auth,common,error,message}.proto`(MessageBody 仍仅 text)
- `chathub-state` 全部
- `chathub-net/src/{auth,channel,interceptor,token}.rs`
- `chathub-net/src/hub.rs` 中 `ConnectionManager / Inner / run_loop / ExponentialBackoff / BackoffConfig / ConnectionState / HubClient::{new,send,subscribe}` — 这些 Plan 3 立的契约保持
- `backends/Cargo.toml`(无新依赖)
- `backends/src/lib.rs` 中:setup 拼装 / try_resume_session / login / logout / current_session / send_message / hub_state / 两个桥接 task / RunEvent 处理
- `Cargo.toml`(repo root,workspace.dependencies 不动)
- `.github/workflows/*.yml`
- `frontends/` 全部

---

## 4. proto 增量

### 4.1 `proto/chathub/v1/hub.proto`

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

### 4.2 `proto/chathub/v1/event.proto`

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
    MessageRecalled      recalled      = 11;   // ← Plan 4 新
    ReadReceipt          read_receipt  = 12;   // ← Plan 4 新
    MessageStatusChange  status_change = 13;   // ← Plan 4 新
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
  string by_user_id      = 4;   // 谁触发的撤回(自己 / 对方)
}

// Plan 4 — 对端已读
message ReadReceipt {
  string conversation_id         = 1;
  string by_user_id              = 2;   // 谁已读
  string last_read_server_msg_id = 3;
  int64  read_at_ms              = 4;
}

// Plan 4 — 自己发出消息的状态变化
message MessageStatusChange {
  enum Status {
    STATUS_UNSPECIFIED = 0;
    STATUS_SENT        = 1;   // Relay 落库成功
    STATUS_DELIVERED   = 2;   // 企微平台接收
    STATUS_FAILED      = 3;   // 企微平台拒绝
  }
  string conversation_id = 1;
  string client_msg_id   = 2;   // echo Send 时的 UUIDv4,前端定位本地消息
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

### 4.3 `chathub-proto/build.rs` 增量

加 7 条 type_attribute(在 Plan 3 的 13 条之后,与现有风格一致):

```rust
// ↓↓↓ Plan 4 新增 6 条 ↓↓↓
.type_attribute(".chathub.v1.RecallResponse",           "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.AckReadResponse",          "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.FetchHistoryResponse",     "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.HistoryMessage",           "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.MessageRecalled",          "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.ReadReceipt",              "#[derive(serde::Serialize, serde::Deserialize)]")
.type_attribute(".chathub.v1.MessageStatusChange",      "#[derive(serde::Serialize, serde::Deserialize)]")
// MessageStatusChange.Status 是 nested regular enum,父 message 的 attribute 已 cascade(同 SystemSignal.Kind 经验)
```

注:7 条覆盖 RecallResponse / AckReadResponse / FetchHistoryResponse / HistoryMessage / MessageRecalled / ReadReceipt / MessageStatusChange。`HistoryMessage` 加 serde derive 因为它跨 Tauri 边界(`fetch_history` 命令返回的 FetchHistoryResponse 嵌套它);`MessageStatusChange.Status` 不重复加(Plan 3 SystemSignal.Kind 经验:nested regular enum cascade,显式加触发 conflicting impl)。

`RecallRequest` / `AckReadRequest` / `FetchHistoryRequest` 不加 serde 派生 — 这些是客户端→服务端 input,backends Tauri 命令构造它们时不经过前端序列化(走 Tauri 命令参数解构 → Rust struct 字段),无需 serde。与 Plan 3 SendRequest 处理一致。

---

## 5. AuthError + classify 增量

### 5.1 `chathub-net/src/error.rs`

```rust
#[derive(thiserror::Error, Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthError {
    #[error("invalid credentials")]
    Unauthenticated,

    #[error("upgrade required (min={min_version})")]
    UpgradeRequired { min_version: String, download_url: String },

    #[error("network error: {message}")]
    Network { message: String },

    #[error("storage error: {message}")]
    Storage { message: String },

    #[error("internal: {message}")]
    Internal { message: String },

    // ← Plan 4 新增
    #[error("account disabled: {message}")]
    AccountDisabled { message: String },
}

impl From<tonic::Status> for AuthError {
    fn from(s: tonic::Status) -> Self {
        use tonic::Code::*;
        // FailedPrecondition + UpgradeRequired details(Plan 2 已有)
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
            PermissionDenied => AuthError::AccountDisabled {                // ← Plan 4 新
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

`PermissionDenied` 之前走 fallback `Internal` → `Action::Backoff`(无限重连)。Plan 4 改为 `AccountDisabled` → `Action::Terminate`(task 退出,前端处理)。

新增 1 个单元测试:`permission_denied_translates_to_account_disabled` — 验证 `Status::permission_denied("forbidden")` 译为 `AuthError::AccountDisabled { message: "forbidden" }`。

### 5.2 `chathub-net/src/hub.rs` (classify 增量)

```rust
pub(crate) fn classify(err: &AuthError) -> Action {
    match err {
        AuthError::Unauthenticated         => Action::ReactiveRefresh,
        AuthError::UpgradeRequired { .. }  => Action::Terminate,
        AuthError::Network { .. }          => Action::Backoff,
        AuthError::Storage { .. }          => Action::Terminate,
        AuthError::Internal { .. }         => Action::Backoff,
        AuthError::AccountDisabled { .. }  => Action::Terminate,    // ← Plan 4 新
    }
}
```

新增 1 个单元测试:`classify_account_disabled_returns_terminate`。

---

## 6. HubClient 增量

### 6.1 三个新 unary 方法

```rust
impl HubClient {
    // ... new / send / subscribe (Plan 3) 保持不变 ...

    /// Plan 4 — 撤回单条消息
    pub async fn recall(&self, req: RecallRequest) -> Result<RecallResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.recall(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }

    /// Plan 4 — 上报已读(batched,last_read_server_msg_id)
    pub async fn ack_read(&self, req: AckReadRequest) -> Result<AckReadResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.ack_read(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }

    /// Plan 4 — 拉取历史(opaque cursor 分页)
    pub async fn fetch_history(
        &self,
        req: FetchHistoryRequest,
    ) -> Result<FetchHistoryResponse, AuthError> {
        let mut client = self.inner.clone();
        let resp = client.fetch_history(tonic::Request::new(req)).await?;
        Ok(resp.into_inner())
    }
}
```

三方法都是 `pub async fn`(对外暴露,backends 直用),与 `send` 同模式。`subscribe` 仍是 `pub(crate)`(只供 ConnectionManager 用)。

### 6.2 imports 增量

`use chathub_proto::v1::{...}` 加:

- `RecallRequest, RecallResponse`
- `AckReadRequest, AckReadResponse`
- `FetchHistoryRequest, FetchHistoryResponse`

---

## 7. stub Relay 扩展

### 7.1 `tests/common/stub_relay.rs`

`StubHubState` 加字段(向后兼容 Plan 2/3):

```rust
#[derive(Default)]
pub struct StubHubState {
    // Plan 3 已有
    pub subscribes: Vec<HashMap<String, i64>>,
    pub event_tx: Option<mpsc::Sender<Result<ServerEvent, Status>>>,
    pub subscribe_outcome: SubscribeOutcome,
    pub send_outcome: SendStubOutcome,
    pub sends: Vec<SendRequest>,

    // Plan 4 新增
    pub recalls:               Vec<RecallRequest>,
    pub recall_outcome:        RecallStubOutcome,
    pub ack_reads:             Vec<AckReadRequest>,
    pub ack_read_outcome:      AckReadStubOutcome,
    pub fetch_history_reqs:    Vec<FetchHistoryRequest>,
    pub fetch_history_outcome: FetchHistoryStubOutcome,
}

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

`impl Hub for StubHub` 加三个方法,与 `send` 同模式:

```rust
async fn recall(&self, req: Request<RecallRequest>) -> Result<Response<RecallResponse>, Status> {
    let mut s = self.state.lock().unwrap();
    s.recalls.push(req.into_inner());
    match s.recall_outcome.clone() {
        RecallStubOutcome::Ok(r)     => Ok(Response::new(r)),
        RecallStubOutcome::Status(s) => Err(s),
    }
}

async fn ack_read(&self, req: Request<AckReadRequest>) -> Result<Response<AckReadResponse>, Status> {
    let mut s = self.state.lock().unwrap();
    s.ack_reads.push(req.into_inner());
    match s.ack_read_outcome.clone() {
        AckReadStubOutcome::Ok(r)     => Ok(Response::new(r)),
        AckReadStubOutcome::Status(s) => Err(s),
    }
}

async fn fetch_history(
    &self,
    req: Request<FetchHistoryRequest>,
) -> Result<Response<FetchHistoryResponse>, Status> {
    let mut s = self.state.lock().unwrap();
    s.fetch_history_reqs.push(req.into_inner());
    match s.fetch_history_outcome.clone() {
        FetchHistoryStubOutcome::Ok(r)     => Ok(Response::new(r)),
        FetchHistoryStubOutcome::Status(s) => Err(s),
    }
}
```

### 7.2 向后兼容

- `start_stub()` / `start_stub_full()` 签名不变 — 内部已注册 HubServer,Plan 4 在 impl 加方法,call site 无感
- Plan 2 的 7 个 auth_e2e + Plan 3 的 10 个 hub_e2e 不需要任何改动

---

## 8. backends 集成

### 8.1 Tauri 命令

`backends/src/lib.rs` 加 3 个命令(与 `send_message` 同模式):

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

### 8.2 invoke_handler 注册

```rust
.invoke_handler(tauri::generate_handler![
    greet, take_screenshot,
    login, logout, current_session,
    send_message, hub_state,
    recall_message, ack_read, fetch_history,   // ← Plan 4 新
])
```

### 8.3 imports 增量

`use chathub_proto::v1::{...}` 加:

- `RecallRequest, RecallResponse`
- `AckReadRequest, AckReadResponse`
- `FetchHistoryRequest, FetchHistoryResponse`

### 8.4 桥接 task — 完全不动

`hub:event` 桥接 task 在 Plan 3 实现时只识别 `SystemSignal::Kicked`,其它所有 ServerEvent 都透传给前端。Plan 4 新加的 `MessageRecalled / ReadReceipt / MessageStatusChange` 自动透传,backends 0 改动。

---

## 9. 异步 / 性能 / 安全考量

Plan 4 三个新 RPC 都是 unary,与 ConnectionManager 状态机无关,沿用 Plan 3 §7 的全部分析:

### 9.1 unary RPC 复用 Channel + Interceptor

`HubClient::recall/ack_read/fetch_history` 与 `send` 一样通过共享 `Channel`(内部 Arc'd)+ `AuthInterceptor` 发出。每次调用 `self.inner.clone()` 是廉价的(Arc 计数 +1),并发安全。

### 9.2 PermissionDenied 路径的语义升级

之前:`PermissionDenied → Internal → Backoff` 会让 Subscribe stream 在账号被禁用时无限重连。
Plan 4 后:`PermissionDenied → AccountDisabled → Terminate` task 退出,前端通过 `hub:connection` 看到 `Disconnected { last_error: Some(AccountDisabled { message }) }`。

**风险**:Send 路径上偶发的 PermissionDenied(如临时风控)也会被翻译为 `AccountDisabled`。这个语义是合理的 — 调用方拿到 `AccountDisabled` 后可以选择不重试或提示用户;Plan 6 加发送可靠性时如需细分,可改 `Status::permission_denied(msg)` + ErrorDetail 携带子类型。

### 9.3 fetch_history 数据量

`FetchHistoryResponse.messages` 最坏情况下携带 100 条 HistoryMessage(client 自限),每条几 KB。tonic 默认 max_decoding_message_size = 4 MB,完全够。不需调整 endpoint 配置。

### 9.4 安全

| 项                                  | 处理                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `recall` 鉴权                       | 服务端验证调用方对该 `server_msg_id` 的撤回权(撤别人消息一律 PermissionDenied → `AccountDisabled`)                             |
| `ack_read` 数据真实性               | 服务端不信任 client 上报的 last_read_server_msg_id 是否真"已读到该消息",只用于触发对端 ReadReceipt 推送                        |
| `fetch_history` 数据隔离            | 服务端按 `(wecom_account_id, conversation_id)` 做 ACL,跨账号查询 → PermissionDenied → `AccountDisabled` → task 退出 + 前端处理 |
| `MessageStatusChange.client_msg_id` | 服务端 echo Send 时收到的 UUIDv4,客户端可信任(自己发的)                                                                        |

---

## 10. 测试方案

### 10.1 e2e 场景(5 个,放在 `tests/hub_e2e.rs`)

| #   | 名称                                                       | 路径                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `recall_success_returns_recalled_at_ms`                    | stub `recall_outcome = Ok(RecallResponse { recalled_at_ms: 1700... })` → 客户端调 `hub.recall(...)` 拿到 1700;断言 stub 收到 1 个 RecallRequest with 正确 server_msg_id                                       |
| 2   | `recall_permission_denied_returns_account_disabled`        | stub `recall_outcome = Status(permission_denied("no permission"))` → 客户端 `hub.recall(...)` 返回 `AuthError::AccountDisabled { message: "no permission" }`                                                  |
| 3   | `ack_read_success_records_last_read_msg`                   | stub 默认 outcome (Ok) → 客户端 `hub.ack_read(...)` 成功;断言 stub.ack_reads 收到 1 个,字段匹配                                                                                                               |
| 4   | `fetch_history_returns_messages_and_paginates_with_cursor` | 单测试覆盖两次调用:第一次 cursor="",stub 返回 3 条 HistoryMessage + next_cursor="page2";第二次 cursor="page2",stub 返回 2 条 + next_cursor="";断言两次请求的 cursor 字段、收到的 messages 数量、recalled 字段 |
| 5   | `server_event_business_kinds_are_forwarded`                | 通过 ConnectionManager 启动后,push 3 个 ServerEvent(各含 MessageRecalled / ReadReceipt / MessageStatusChange)→ broadcast 收到 3 个 event,oneof body 类型对应                                                  |

### 10.2 单元测试

`chathub-net/src/error.rs` `#[cfg(test)] mod tests` 加 1 个:

| 名称                                               | 验证                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `permission_denied_translates_to_account_disabled` | `Status::permission_denied("forbidden")` → `AuthError::AccountDisabled { message: "forbidden" }` |

`chathub-net/src/hub.rs` `#[cfg(test)] mod tests` 加 1 个:

| 名称                                          | 验证                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `classify_account_disabled_returns_terminate` | `classify(&AuthError::AccountDisabled { message: "x".into() })` 返回 `Action::Terminate` |

`chathub-proto/src/lib.rs` `mod tests` 加 2 个:

| 名称                                               | 验证                                                       |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `server_event_with_recalled_serializes_round_trip` | ServerEvent.body = Recalled(MessageRecalled{..}) JSON 往返 |
| `message_status_change_serializes_round_trip`      | MessageStatusChange + status = STATUS_DELIVERED JSON 往返  |

### 10.3 回归

- `cargo test -p chathub-state` 12 测试(Plan 3,不变)
- `cargo test -p chathub-net --lib` Plan 3 24 + Plan 4 新 2 = 26
- `cargo test -p chathub-proto` Plan 3 6 + Plan 4 新 2 = 8
- `cargo test -p chathub-net --test auth_e2e` Plan 2 7/7
- `cargo test -p chathub-net --test hub_e2e` Plan 3 10 + Plan 4 新 5 = 15

### 10.4 测试加速

Plan 4 e2e 都是 unary RPC + 一次性 ServerEvent 推送,不涉及退避计时。无需 fast BackoffConfig — 但场景 5(server_event_business_kinds_are_forwarded)走 ConnectionManager 启动,需复用 Plan 3 的 fast BackoffConfig 加速。

---

## 11. Definition of Done

| #   | 验收项                                                                                                          | 验证                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | proto 加 3 个 RPC + 6 个 message(Req/Resp + HistoryMessage)+ 3 个 ServerEvent body variant + 3 个 event message | `cargo build --workspace` + buf lint 0 错(proto.yml CI)                |
| 2   | chathub-proto build.rs 加 7 条 type_attribute + 2 个 JSON 往返 smoke test                                       | `cargo test -p chathub-proto` 8/8                                      |
| 3   | AuthError 加 AccountDisabled variant + From<Status> PermissionDenied 翻译 + 1 单元测试                          | `cargo test -p chathub-net --lib error::` 含 6 个测试(Plan 2 5 + 新 1) |
| 4   | classify 加 AccountDisabled → Terminate + 1 单元测试                                                            | `cargo test -p chathub-net --lib hub::` 含 13 个测试(Plan 3 12 + 新 1) |
| 5   | HubClient 加 recall / ack_read / fetch_history 三方法                                                           | `cargo build -p chathub-net` 成功;e2e #1-4 涵盖                        |
| 6   | stub Hub fixture 加 3 个新方法 impl + 3 个 outcome enum                                                         | hub_e2e 跑通                                                           |
| 7   | 5 个新 e2e 全绿                                                                                                 | `cargo test -p chathub-net --test hub_e2e -- --test-threads=1` 15/15   |
| 8   | Plan 2 + 3 e2e 不破                                                                                             | `cargo test -p chathub-net --test auth_e2e -- --test-threads=1` 7/7    |
| 9   | backends 加 3 个 Tauri 命令 + invoke_handler 注册                                                               | `cargo build -p chathub` 成功                                          |
| 10  | clippy 全绿                                                                                                     | `cargo clippy --workspace --all-targets -- -D warnings` 0 warn         |
| 11  | Cargo.lock 一致                                                                                                 | `git diff main -- Cargo.lock                                           | grep '^[+-]name = '` 仅含 patch 浮动,无新 top-level crate |

---

## 12. 风险点与缓解

| #   | 风险                                                                                             | 触发                                                                          | 缓解                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `PermissionDenied → AccountDisabled` 在 Subscribe 路径上让 task 提前 terminate                   | 服务端偶发返 PermissionDenied 而非 Unauthenticated                            | classify::Terminate 是正确语义:无限重连 PermissionDenied 是 bug,Plan 4 修对了;真有"临时风控"语义服务端应该用 `ResourceExhausted` 或 `Aborted` 带 RetryInfo |
| 2   | recall_outcome / ack_read_outcome / fetch_history_outcome 三个 enum 命名风格不统一               | 容易和 SendStubOutcome 混                                                     | 加统一 `Stub` 前缀:`RecallStubOutcome / AckReadStubOutcome / FetchHistoryStubOutcome`(与 Plan 3 `SendStubOutcome` 同后缀)                                  |
| 3   | FetchHistory 返回大列表时 prost decoding 限制                                                    | 单次 100 条 × 几 KB ≈ 几百 KB                                                 | tonic 默认 max_decoding_message_size = 4 MB,远大于此,不需调整                                                                                              |
| 4   | MessageBody 仍仅 text — Plan 4 测试的 HistoryMessage / IncomingMsg.body 是空 oneof               | proto3 默认行为下 oneof 为 None                                               | 测试用 `MessageBody { kind: Some(message_body::Kind::Text(TextBody { text: "..." })) }` 显式构造                                                           |
| 5   | classify::Terminate 在 Send / Recall 等 unary path 不直接相关(只影响 Subscribe stream)           | 但 unary 调用拿到 AuthError 后,前端要 decide 行为                             | hub.recall().await? 失败时前端拿 AuthError::AccountDisabled,可显示"账号已被禁用,请联系管理员";不需要客户端层面做特殊处理                                   |
| 6   | RecallRequest/AckReadRequest/FetchHistoryRequest 不加 serde derive,如果前端要 invoke 时构造它们? | 不构造 — Tauri 命令用展开参数(wecom_account_id: String 等),Rust 端组装 struct | 同 SendRequest 模式                                                                                                                                        |

---

## 13. 与 Plan 5+ 的接口承诺

Plan 4 落地后,以下契约 **Plan 5+ 永远稳定**(改需 SemVer 决议):

- `HubClient::{recall, ack_read, fetch_history}` 签名稳定
- `ServerEvent.body` oneof tag 10/11/12/13/90 永久占用;Plan 5 加 AccountStatus / PresenceChange 用 tag 14/15
- `AuthError::AccountDisabled` variant 稳定;classify 中归 `Terminate`
- backends 命令 `recall_message / ack_read / fetch_history` 签名稳定
- proto `HistoryMessage.recalled` 字段稳定;Plan 5 加媒体扩展时仅在 `MessageBody.kind` 加 oneof variant
- `From<tonic::Status>` 翻译规则:`PermissionDenied` 始终归 `AccountDisabled`,不会再回退到 `Internal`

---

## 14. 与 Plan 4 不在范围的连接点

Plan 5 接 `ListWecomAccounts / EnableAccount / DisableAccount` 时:

- 只在 `hub.proto` 加 RPC + 在 `HubClient` 加方法,**不**触碰 ConnectionManager
- ServerEvent 加 `AccountStatus(tag=14)` + `PresenceChange(tag=15)` — wire-compat
- 桥接 task 0 改动(payload 透传)

Plan 5 接 `MessageBody` 媒体扩展时:

- 只改 `message.proto` 加 oneof variant — wire-compat
- backends `send_message` 命令需要扩展或重构(Plan 5 决策)
- 历史消息 `HistoryMessage.body` 自动支持新 kind

Plan 6 加可靠性增强时:

- Send / Recall / AckRead 可加本地排队 / 持久化重试 — 在 `HubClient` 之上加一层 SendQueue,不动 HubClient 本身
- 历史本地缓存 — chathub-state 加 `messages` 表 + Plan 4 的 `fetch_history` 调用结果落库

---

End of spec.
