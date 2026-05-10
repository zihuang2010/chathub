# ChatHub Chat Protocol — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在仓库里建立 Protobuf 合约 + Cargo workspace + chathub-proto 代码生成 crate,作为后续所有通信工作的地基。本计划合并后,`cargo build` 与 `buf lint` 全绿,但**还没有**真正的网络通信代码。

**Architecture:** Repo 根 Cargo.toml 转 workspace,`backends/` 维持 Tauri bin crate(布局完全不动,只在 deps 里加一项),新增 `crates/chathub-proto/` 用 `tonic-build` 把 `proto/chathub/v1/*.proto` 编译成 Rust 类型并 re-export。CI 用 `buf` 校验 lint + breaking。

**Tech Stack:** Protobuf 3, `buf` CLI, `tonic` 0.12 + `prost` 0.13, Cargo workspace(resolver = "2"),GitHub Actions。

**参考 spec:** `/Users/pis0sion/.claude/plans/happy-yawning-kernighan.md`(本仓库内将随主计划首次合并时复制为 `docs/superpowers/specs/2026-05-10-chat-protocol-design.md`)。

**完整 PR 路线图(本计划是第 1 份):**

| 计划              | 范围                                                                                                            | 依赖   |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| **Plan 1 (本文)** | proto 合约 + workspace + chathub-proto 编译干净                                                                 | —      |
| Plan 2            | chathub-state(SQLite token 存储)+ chathub-net Auth 三个 RPC + Tauri `login`/`logout` 命令 + stub Relay 集成测试 | Plan 1 |
| Plan 3            | chathub-net Subscribe + ConnectionManager(状态机/退避/续传)+ Send 幂等队列                                      | Plan 2 |
| Plan 4            | chathub-blob:HTTPS multipart/chunked 上传 + 下载 + 30 天本地缓存                                                | Plan 3 |
| Plan 5            | 前端 `frontends/lib/transport/` + `useChatMessages` 切真实数据流 + Composer 接 Send                             | Plan 4 |

每份计划都自带验证方案,可独立 PR、独立合并。

---

## File Structure

### New files

```
proto/
├── buf.yaml
├── buf.gen.yaml
└── chathub/
    └── v1/
        ├── common.proto    # 公共类型(WecomAccount, UserProfile, Mention, ReplyToRef, RemoteId)
        ├── auth.proto      # service Auth + Login/Refresh/Logout 全套消息
        ├── error.proto     # ErrorDetail + RetryInfo / QuotaFailure / BadRequestViolations 等
        ├── message.proto   # MessageBody + 各 kind 占位(Plan 3 详细化)
        ├── event.proto     # ServerEvent + 子事件占位(Plan 3 详细化)
        └── hub.proto       # service Hub 占位(Plan 3 详细化)

crates/
└── chathub-proto/
    ├── Cargo.toml
    ├── build.rs            # tonic-build 入口
    └── src/
        └── lib.rs          # 模块 re-export

.github/workflows/
└── proto.yml               # buf lint + buf breaking
```

### Modified files

- `Cargo.toml`(repo 根,**新建**:workspace manifest)
- `Cargo.lock`(自动迁到根,删除 `backends/Cargo.lock`)
- `backends/Cargo.toml`(去掉 `[package]` 自带的 workspace 隐式继承,加 chathub-proto 依赖,加一行 `workspace = true` 模式;**不动** Tauri 配置)
- `backends/src/lib.rs`(末尾加 1 行编译期 smoke test 引用 chathub_proto 的 AuthClient 类型)
- `.gitignore`(确认 `target/` 在根级被忽略)

### Untouched(承诺)

- `backends/tauri.conf.json` / `tauri.macos.conf.json`
- `backends/build.rs` / `backends/icons/` / `backends/capabilities/` / `backends/gen/`
- `frontends/` 全部
- `package.json` / `pnpm-lock.yaml`
- 现有 `.github/workflows/build.yml`(版本验证逻辑保持引用 `backends/Cargo.toml` 不变)

---

## Task 1: 起 proto 合约 + buf 配置 + CI

**Files:**

- Create: `proto/buf.yaml`
- Create: `proto/buf.gen.yaml`
- Create: `proto/chathub/v1/common.proto`
- Create: `proto/chathub/v1/auth.proto`
- Create: `proto/chathub/v1/error.proto`
- Create: `proto/chathub/v1/message.proto`(占位)
- Create: `proto/chathub/v1/event.proto`(占位)
- Create: `proto/chathub/v1/hub.proto`(占位)
- Create: `.github/workflows/proto.yml`

- [ ] **Step 1.1: 创建 `proto/buf.yaml`**

```yaml
# proto/buf.yaml
version: v2
modules:
  - path: .
lint:
  use:
    - DEFAULT
  except:
    - PACKAGE_VERSION_SUFFIX # 我们用 chathub.v1 而非 chathub.v1alpha1,不需要
breaking:
  use:
    - FILE
deps: []
```

- [ ] **Step 1.2: 创建 `proto/buf.gen.yaml`**

注意:**Rust 端生成由 `tonic-build` 在 cargo build 时完成**(见 Task 3),`buf.gen.yaml` 仅为 lint/breaking 配置文件保留对称占位,目前不出码。

```yaml
# proto/buf.gen.yaml
version: v2
plugins: []
```

- [ ] **Step 1.3: 创建 `proto/chathub/v1/common.proto`**

```protobuf
// proto/chathub/v1/common.proto
syntax = "proto3";
package chathub.v1;

// 通用引用类型,在多个 message 中复用。

message UserProfile {
  string user_id      = 1;   // Relay 内部 user id
  string display_name = 2;
  string avatar_url   = 3;
  string role         = 4;   // "operator" | "admin"
  int64  tenant_id    = 5;
}

message WecomAccount {
  string wecom_account_id = 1;   // Relay 内部账号 id
  string corp_id          = 2;   // 企微 corpid
  uint32 agent_id         = 3;   // 企微 agentid
  string display_name     = 4;
  bool   enabled          = 5;
}

message Mention {
  string user_id      = 1;
  uint32 offset_chars = 2;
  uint32 length_chars = 3;
}

message ReplyToRef {
  string server_msg_id = 1;
}

message RemoteId {
  string conversation_id = 1;
  string server_msg_id   = 2;
}
```

- [ ] **Step 1.4: 创建 `proto/chathub/v1/auth.proto`**

```protobuf
// proto/chathub/v1/auth.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/common.proto";

// Auth service:三个 method 全部不要求 access_token,但要求 chathub-protocol-version
// 与 chathub-client-version metadata。
service Auth {
  rpc Login        (LoginRequest)        returns (LoginResponse);
  rpc RefreshToken (RefreshTokenRequest) returns (RefreshTokenResponse);
  rpc Logout       (LogoutRequest)       returns (LogoutResponse);
}

message LoginRequest {
  string username    = 1;
  string password    = 2;
  string device_id   = 3;   // Tauri 安装唯一 id
  string device_name = 4;   // "Bob 的 MacBook"
  string client_ver  = 5;   // 与 metadata 中 chathub-client-version 必须一致
}

message LoginResponse {
  string access_token   = 1;   // JWT (RS256), 30min
  int64  access_exp_ms  = 2;
  string refresh_token  = 3;   // opaque, 30day, rolling
  int64  refresh_exp_ms = 4;
  UserProfile user      = 5;
  repeated WecomAccount wecom_accounts = 6;
}

message RefreshTokenRequest {
  string refresh_token = 1;
  string device_id     = 2;
}

message RefreshTokenResponse {
  string access_token   = 1;
  int64  access_exp_ms  = 2;
  string refresh_token  = 3;
  int64  refresh_exp_ms = 4;
}

message LogoutRequest  { string refresh_token = 1; }
message LogoutResponse {}
```

- [ ] **Step 1.5: 创建 `proto/chathub/v1/error.proto`**

```protobuf
// proto/chathub/v1/error.proto
syntax = "proto3";
package chathub.v1;

// Rich error detail,放在 google.rpc.Status / tonic::Status 的 details 列表里。
message ErrorDetail {
  oneof body {
    RetryInfo            retry        = 1;
    QuotaFailure         quota        = 2;
    BadRequestViolations bad_request  = 3;
    PreconditionFailure  precondition = 4;
    UpgradeRequired      upgrade      = 5;
    DebugInfo            debug        = 99;
  }
}

message RetryInfo {
  int64 retry_after_ms = 1;
}

message QuotaFailure {
  string subject        = 1;
  string limit          = 2;
  int64  retry_after_ms = 3;
}

message Violation {
  string field       = 1;
  string description = 2;
}

message BadRequestViolations {
  repeated Violation violations = 1;
}

message PreconditionFailure {
  string type    = 1;   // "ACCOUNT_DISABLED" | "TOKEN_INVALID" | ...
  string subject = 2;
  string detail  = 3;
}

message UpgradeRequired {
  string min_client_version = 1;
  string download_url       = 2;
}

message DebugInfo {
  string trace_id   = 1;
  string stack_hint = 2;
}
```

- [ ] **Step 1.6: 创建 `proto/chathub/v1/message.proto`(占位)**

Plan 3 会填充 oneof 各分支,本计划只放空壳保证编译通过。

```protobuf
// proto/chathub/v1/message.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/common.proto";

// MessageBody.kind 在 Plan 3 中扩充(text/image/voice/video/file/location/link/markdown 等)。
// 现在只放一个最小的文本占位。
message MessageBody {
  oneof kind {
    TextBody text = 1;
    // 2-49 留给标准消息体
    // 50+   企微平台特有(模板卡片/小程序卡片等)
  }
  ReplyToRef reply_to        = 100;
  repeated Mention mentions  = 101;
}

message TextBody {
  string text = 1;
}
```

- [ ] **Step 1.7: 创建 `proto/chathub/v1/event.proto`(占位)**

Plan 3 填充。

```protobuf
// proto/chathub/v1/event.proto
syntax = "proto3";
package chathub.v1;

// ServerEvent 与子事件在 Plan 3 中扩充(IncomingMsg/MessageRecalled/ReadReceipt/
// AccountStatus/PresenceChange/MessageStatusChange/SystemSignal)。
// 现在只放一个空 envelope 占位。
message ServerEvent {
  string wecom_account_id = 1;
  int64  seq              = 2;
  // 3-9 reserved for envelope-level fields
  // 10-89 reserved for business events (Plan 3)
  // 90-99 reserved for system signals (Plan 3)
}
```

- [ ] **Step 1.8: 创建 `proto/chathub/v1/hub.proto`(占位)**

Plan 3 填充全部 RPC。

```protobuf
// proto/chathub/v1/hub.proto
syntax = "proto3";
package chathub.v1;

import "chathub/v1/event.proto";

// Hub service:主业务 RPC 集合。Plan 3 填充以下方法:
//   rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
//   rpc Send(SendRequest) returns (SendResponse);
//   rpc Recall(RecallRequest) returns (RecallResponse);
//   rpc AckRead(AckReadRequest) returns (AckReadResponse);
//   rpc FetchHistory(FetchHistoryRequest) returns (FetchHistoryResponse);
//   rpc ListWecomAccounts/EnableAccount/DisableAccount
//
// 现在只放一个最小 Subscribe 接口,确保 buf lint 不报"empty service"。
service Hub {
  rpc Subscribe(SubscribeRequest) returns (stream ServerEvent);
}

message SubscribeRequest {
  // Plan 3 填充 since_seqs (map<string, int64>)
  map<string, int64> since_seqs = 1;
}
```

- [ ] **Step 1.9: 创建 `.github/workflows/proto.yml`**

```yaml
# .github/workflows/proto.yml
name: proto

on:
  push:
    branches: [main]
    paths:
      - "proto/**"
      - ".github/workflows/proto.yml"
  pull_request:
    paths:
      - "proto/**"
      - ".github/workflows/proto.yml"

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bufbuild/buf-action@v1
        with:
          input: proto
          lint: true
          format: false
          breaking: false
          push: false

  breaking:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: bufbuild/buf-action@v1
        with:
          input: proto
          lint: false
          format: false
          breaking: true
          breaking_against: "https://github.com/${{ github.repository }}.git#branch=main,subdir=proto"
          push: false
```

- [ ] **Step 1.10: 本地跑 `buf lint` 验证(可选,如装了 buf CLI)**

```bash
# 装 buf:macOS = brew install bufbuild/buf/buf
cd proto
buf lint
```

Expected: 无输出(全部通过);若用户没装 buf,跳过此步,CI 会跑。

- [ ] **Step 1.11: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add proto/ .github/workflows/proto.yml
git commit -m "$(cat <<'EOF'
feat(proto): chathub.v1 contracts + buf lint/breaking CI

- 全套 .proto:auth(Login/Refresh/Logout)、common(UserProfile/WecomAccount/Mention/ReplyToRef)、error(ErrorDetail rich proto)
- message/event/hub 留占位,Plan 3 扩充
- buf.yaml v2 + DEFAULT lint(去掉 PACKAGE_VERSION_SUFFIX,我们用 chathub.v1)
- proto.yml 工作流:每 PR 跑 buf lint + buf breaking against main
EOF
)"
```

---

## Task 2: backends 转 Cargo workspace

**Files:**

- Create: `Cargo.toml`(repo 根)
- Modify: `backends/Cargo.toml`
- Move: `backends/Cargo.lock` → 删除(workspace 后由根 `Cargo.lock` 统一管理)
- Modify: `.gitignore`(确认 target/ 在根级被忽略,通常已经是)

**为什么这样做:** Tauri 的 CLI 期望 `tauri.conf.json` 与 `Cargo.toml` 同目录,所以 `backends/Cargo.toml` 必须留在原地、保持是 bin/lib 双角色 crate。把 workspace 顶层放到 repo 根,既不动 Tauri 构建路径,又能让 `crates/chathub-proto`、`crates/chathub-net`、`crates/chathub-state`(后续计划)与 backends 共享同一份 lockfile/target。

- [ ] **Step 2.1: 验证当前 build 还是绿的(基线)**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build --manifest-path backends/Cargo.toml
```

Expected: 编译成功(可能要分钟级首次拉依赖)。如果失败,**先停下** —— 现有 main 在断;需要先修。

- [ ] **Step 2.2: 在 repo 根创建 `Cargo.toml`(workspace manifest)**

注意:Task 2 阶段 `crates/chathub-proto` 目录还**不存在**,所以 members 此刻**只列 `backends`**。Task 3 创建好 chathub-proto 后再把它加进 members。

```toml
# Cargo.toml(repo root)
[workspace]
resolver = "2"
members = [
  "backends",
  # crates/chathub-proto 在 Task 3 Step 3.1 加入
]

# 所有 workspace 成员共享的依赖版本(Plan 1 只列 chathub-proto 用得着的)
[workspace.dependencies]
prost        = "0.13"
prost-types  = "0.13"
tonic        = { version = "0.12", default-features = false, features = ["transport", "tls", "tls-roots", "codegen", "prost"] }
tonic-build  = { version = "0.12", default-features = false, features = ["prost", "transport"] }

# Profile 调优(可选,但建议显式声明)
[profile.dev]
opt-level = 0
debug = true

[profile.release]
opt-level = 3
debug = false
lto = "thin"
strip = true
```

- [ ] **Step 2.3: 修改 `backends/Cargo.toml`,把版本/edition 等迁到 workspace package 共享(可选)**

为了 Plan 1 最小改动,**不**做版本统一;只在 backends/Cargo.toml 头部确认 `[package]` 之前**没有** `[workspace]` 段。当前文件已经没有,无需改动这一块。

直接跳到 Step 2.4。

- [ ] **Step 2.4: 删除 `backends/Cargo.lock`(workspace 接管)**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
rm -f backends/Cargo.lock
```

新的 `Cargo.lock` 会在根级生成。

- [ ] **Step 2.5: 验证 cargo workspace 识别**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo metadata --no-deps --format-version 1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['workspace_root']); print([p['name'] for p in d['packages']])"
```

Expected:

- 第一行: 仓库根的绝对路径
- 第二行: `['chathub']`(目前唯一 member;Task 3 会加 `chathub-proto`)

- [ ] **Step 2.6: 验证 Tauri build 仍然 OK**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build --manifest-path backends/Cargo.toml
```

Expected: 编译成功,行为与 Step 2.1 相同。增量编译应该极快(只是 lockfile 重生成)。

- [ ] **Step 2.7: 验证现有 build.yml CI 的版本检查脚本仍然走得通(必须确认!)**

`.github/workflows/build.yml` 里有这一行:

```bash
CARGO_VER=$(grep -m1 '^version = ' backends/Cargo.toml | sed 's/.*"\(.*\)"/\1/')
```

只要 `backends/Cargo.toml` 第一行 `version = "..."` 还在,这条仍然工作。在本机重跑等价命令验证:

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
grep -m1 '^version = ' backends/Cargo.toml | sed 's/.*"\(.*\)"/\1/'
```

Expected: 输出 `0.1.4`(或当前实际版本)。

- [ ] **Step 2.8: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add Cargo.toml
git rm -f backends/Cargo.lock
git commit -m "$(cat <<'EOF'
chore: convert repo root to Cargo workspace

- 新增根级 Cargo.toml,backends 变 workspace member,Cargo.lock 迁到根
- workspace.dependencies 预先声明 prost/tonic 版本以备 chathub-proto 使用
- backends/Cargo.toml + tauri.conf.json 完全未动,Tauri 构建路径保持
- build.yml 的 CARGO_VER 检查仍然 grep backends/Cargo.toml,无需调整
EOF
)"
```

---

## Task 3: chathub-proto crate 用 tonic-build 生成

**Files:**

- Create: `crates/chathub-proto/Cargo.toml`
- Create: `crates/chathub-proto/build.rs`
- Create: `crates/chathub-proto/src/lib.rs`
- Modify: `Cargo.toml`(根 workspace)— members 加回 `crates/chathub-proto`

- [ ] **Step 3.1: 把 `crates/chathub-proto` 加回 workspace members**

```toml
# Cargo.toml(repo root)— members 段更新为
members = [
  "backends",
  "crates/chathub-proto",
]
```

- [ ] **Step 3.2: 创建 `crates/chathub-proto/Cargo.toml`**

```toml
# crates/chathub-proto/Cargo.toml
[package]
name        = "chathub-proto"
version     = "0.1.0"
edition     = "2021"
description = "ChatHub gRPC contracts (chathub.v1) generated from proto/"
publish     = false

[dependencies]
prost       = { workspace = true }
prost-types = { workspace = true }
tonic       = { workspace = true }

[build-dependencies]
tonic-build = { workspace = true }
```

- [ ] **Step 3.3: 创建 `crates/chathub-proto/build.rs`**

```rust
// crates/chathub-proto/build.rs
//! tonic-build 把 ../../proto/chathub/v1/*.proto 编出 Rust 类型,
//! 输出到 OUT_DIR,在 src/lib.rs 里通过 tonic::include_proto! 引入。

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../proto");

    let proto_files = [
        proto_root.join("chathub/v1/common.proto"),
        proto_root.join("chathub/v1/auth.proto"),
        proto_root.join("chathub/v1/error.proto"),
        proto_root.join("chathub/v1/message.proto"),
        proto_root.join("chathub/v1/event.proto"),
        proto_root.join("chathub/v1/hub.proto"),
    ];

    // build.rs 改动追踪:任一 .proto 改了就重 build
    println!("cargo:rerun-if-changed=build.rs");
    for f in &proto_files {
        println!("cargo:rerun-if-changed={}", f.display());
    }

    tonic_build::configure()
        .build_client(true)
        .build_server(true) // server 端 Plan 2 stub_relay 测试要用
        .compile_well_known_types(false)
        .compile(&proto_files, &[proto_root])?;

    Ok(())
}
```

- [ ] **Step 3.4: 创建 `crates/chathub-proto/src/lib.rs`**

```rust
// crates/chathub-proto/src/lib.rs
//! ChatHub gRPC contracts(由 tonic-build 在 build.rs 中从 proto/chathub/v1/*.proto 生成)。
//!
//! 主要导出:
//!   - chathub_proto::v1::auth_client::AuthClient<Channel>
//!   - chathub_proto::v1::auth_server::{Auth, AuthServer}
//!   - chathub_proto::v1::hub_client::HubClient<Channel>
//!   - chathub_proto::v1::{LoginRequest, LoginResponse, RefreshTokenRequest, ...}
//!   - chathub_proto::v1::{ErrorDetail, RetryInfo, QuotaFailure, ...}
//!
//! 后续计划在引用时一律走 `chathub_proto::v1::...` 命名空间。

#![allow(clippy::all)]
#![allow(non_snake_case, missing_docs)]

pub mod v1 {
    tonic::include_proto!("chathub.v1");
}
```

- [ ] **Step 3.5: 在仓库根 `cargo build -p chathub-proto`,验证生成成功**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build -p chathub-proto
```

Expected:

- 首次 build 会安装 protoc(`tonic-build` 依赖系统 protoc 或 vendored 的 protobuf-src;若编译报"protoc not found",装一下:`brew install protobuf` on macOS,或在 Cargo.toml 用 `protoc-bin-vendored`)
- 终态:`cargo build` 退出码 0

⚠️ **如果 macOS 上首次报 `protoc` 未找到**,补救方案有两个,二选一:

方案 A(本机/CI 都装 protoc):

```bash
brew install protobuf
```

方案 B(改 chathub-proto/Cargo.toml,build-deps 加 vendored 二进制,仓库零外部依赖):

```toml
[build-dependencies]
tonic-build = { workspace = true }
protoc-bin-vendored = "3"
```

配套 build.rs 顶部加:

```rust
std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
```

**默认走方案 B**(仓库无外部依赖,CI 不需要额外装),把上述两处改动一并落到本任务。

- [ ] **Step 3.6: 写 smoke test 确认类型可以被引用**

```rust
// crates/chathub-proto/src/lib.rs(末尾追加)
#[cfg(test)]
mod tests {
    use super::v1::auth_client::AuthClient;
    use super::v1::{LoginRequest, LoginResponse, RefreshTokenRequest};
    use tonic::transport::Channel;

    #[test]
    fn login_request_default_compiles() {
        let req = LoginRequest::default();
        assert_eq!(req.username, "");
        assert_eq!(req.client_ver, "");
    }

    #[test]
    fn login_response_default_compiles() {
        let resp = LoginResponse::default();
        assert!(resp.access_token.is_empty());
        assert_eq!(resp.access_exp_ms, 0);
    }

    #[test]
    fn refresh_request_round_trips_via_prost() {
        // 编解码自检:防止 build.rs 配置漂了
        use prost::Message;
        let req = RefreshTokenRequest {
            refresh_token: "abc".into(),
            device_id: "dev-1".into(),
        };
        let bytes = req.encode_to_vec();
        let decoded = RefreshTokenRequest::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.refresh_token, "abc");
        assert_eq!(decoded.device_id, "dev-1");
    }

    /// 仅作类型存在性 + 函数签名检查,不真的连服务端。
    #[allow(dead_code, unused_must_use)]
    fn _auth_client_new_signature_exists() {
        let _: fn(Channel) -> AuthClient<Channel> = AuthClient::<Channel>::new;
    }
}
```

- [ ] **Step 3.7: 跑 smoke test**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub-proto
```

Expected: 3 个测试全过 ——

```
test tests::login_request_default_compiles ... ok
test tests::login_response_default_compiles ... ok
test tests::refresh_request_round_trips_via_prost ... ok
```

如果 `refresh_request_round_trips_via_prost` 失败,说明 tonic-build 配置(field tag 顺序)与 .proto 不一致 —— 检查 build.rs 与 .proto 文件路径。

- [ ] **Step 3.8: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add Cargo.toml crates/chathub-proto/
git commit -m "$(cat <<'EOF'
feat(chathub-proto): generate Rust types from chathub.v1 protos via tonic-build

- crates/chathub-proto/build.rs 编译 proto/chathub/v1/*.proto
- 用 protoc-bin-vendored 内置 protoc,CI 与本机零外部依赖
- src/lib.rs re-export v1 命名空间,后续 crate 走 chathub_proto::v1::...
- smoke tests 验证 LoginRequest/LoginResponse default 与 AuthClient 类型存在
EOF
)"
```

---

## Task 4: chathub bin 依赖 chathub-proto + 整体验证

**Files:**

- Modify: `backends/Cargo.toml`
- Modify: `backends/src/lib.rs`

- [ ] **Step 4.1: 在 `backends/Cargo.toml` 的 `[dependencies]` 末尾追加**

```toml
chathub-proto = { path = "../crates/chathub-proto" }
```

完整 deps 段会变成(末尾追加一行):

```toml
[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
tauri-plugin-opener = "2"
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt", "time", "local-time"] }
tracing-appender = "0.2"
time = { version = "0.3", features = ["macros", "formatting", "local-offset"] }
anyhow = "1"
xcap = "0.9"
base64 = "0.22"
chathub-proto = { path = "../crates/chathub-proto" }   # NEW
```

- [ ] **Step 4.2: 在 `backends/src/lib.rs` 末尾加一段编译期 smoke 引用**

读当前 lib.rs 的最后内容(应该是 `pub fn run() { ... }` 或 `mod` 声明),在末尾追加:

```rust
// 编译期烟雾测试:确保 chathub_proto 可以被解析。Plan 2 起会被实际通信代码替代。
#[cfg(test)]
#[allow(dead_code)]
fn _chathub_proto_smoke() {
    let _r = chathub_proto::v1::LoginRequest::default();
}
```

- [ ] **Step 4.3: 跑全量 build**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo build
```

Expected: workspace 内 `chathub`、`chathub-proto` 全部编译成功,退出码 0。

- [ ] **Step 4.4: 跑 backends 自身的测试**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo test -p chathub
```

Expected: 现有测试全过(若没有测试,看到 `0 passed; 0 failed; 0 ignored` 也是 OK 的)。

- [ ] **Step 4.5: 跑 clippy(如果项目里 enforce 它)**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
cargo clippy --workspace -- -D warnings
```

Expected: 无警告退出。如果有,**修掉它们,不要 allow**。生成代码的 clippy 警告已在 chathub-proto/lib.rs 顶部 allow 掉了。

- [ ] **Step 4.6: 跑 `cargo tauri build --debug`(可选,验证 Tauri 链路完整)**

如果你的开发机上 Tauri CLI 已装:

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
pnpm tauri build --debug
```

Expected: macOS 下成功打出 `.app`。本步骤可选,但合并前最好跑一次确认 workspace 改动没把 Tauri 打包链路搞坏。

- [ ] **Step 4.7: 跑 buf lint 验证 proto/ 仍然干净**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub/proto
buf lint   # 如果本机没装,跳过;CI 会跑
```

Expected: 无输出。

- [ ] **Step 4.8: 跑 buf breaking against main(本机模拟 CI)**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub/proto
buf breaking --against '../.git#branch=main,subdir=proto'
```

Expected: 无输出。**这是首次提交 proto/,不会有 breaking 可比;若 buf 报"no proto in baseline",视为正常**(CI 工作流已用 `https://github.com/...#branch=main` 形式,会处理首次没有 baseline 的情形)。

- [ ] **Step 4.9: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/Cargo.toml backends/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(backends): wire chathub-proto into Tauri bin

- 加 path 依赖 chathub-proto,编译期 smoke 引用 LoginRequest::default()
- Plan 2 起 Tauri 命令会真正使用这些类型与服务端通信

验证:cargo build / cargo clippy --workspace -D warnings / pnpm tauri build --debug 全绿
EOF
)"
```

---

## Task 5: 写后续计划路线图占位

**Files:**

- Modify: `docs/superpowers/plans/2026-05-10-chat-protocol-foundation.md`(本文件,在末尾追加 "Subsequent Plans" 章节;**已包含,见下文 14 节**)
- Create: `docs/superpowers/plans/2026-05-11-chat-protocol-auth.md`(空文件占位,待 Plan 1 合并后用 writing-plans 扩展)

- [ ] **Step 5.1: 创建 Plan 2 占位文件**

```markdown
# ChatHub Chat Protocol — Plan 2: Auth End-to-End

> **STUB — 待 Plan 1 合并后用 writing-plans skill 扩展。**

**Scope (草稿):**

- crates/chathub-state:SQLite 表(refresh_tokens、user_profile、wecom_accounts_cache)+ migrations + sqlx 接入
- crates/chathub-net 第一版:
  - mod channel:Endpoint 配置(http2*keep_alive*\*、tls_config、connect_timeout)
  - mod token:TokenStore actor(load from keyring → 内存缓存 → 5min 主动刷新)
  - mod interceptor:AuthInterceptor 注入 metadata(authorization + chathub-protocol-version + chathub-client-version + chathub-platform)
  - mod auth:login/refresh/logout 三个高层 API
- crates/stub-relay(测试用 bin 或 dev-dependency):tonic Server 实现 chathub.v1.Auth 三个 method,接受任意 user/password,返回固定 jwt-like 字符串
- backends:Tauri 命令 `login(username, password) -> Result<Profile, Err>` / `logout()` / `current_session() -> Option<Profile>`
- 集成测试:启动 stub-relay、客户端登录、kill stub、自动 refresh 触发、refresh 强制失败 → 应弹 LoggedOut 事件

**依赖:** Plan 1 已合并(workspace + chathub-proto 可用)。
```

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
mkdir -p docs/superpowers/plans
# 上面那段写入 docs/superpowers/plans/2026-05-11-chat-protocol-auth.md
```

- [ ] **Step 5.2: 提交占位**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add docs/superpowers/plans/2026-05-11-chat-protocol-auth.md
git commit -m "docs(plans): stub for Plan 2 (Auth E2E),Plan 1 合并后填充"
```

---

## Verification Checklist(合并前必走)

完成 Task 1~5 后,在干净 checkout 上跑这些命令,**全部退出码 0** 才合并:

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub

# 1. workspace 编译
cargo build --workspace

# 2. workspace 测试
cargo test --workspace

# 3. clippy 严格
cargo clippy --workspace -- -D warnings

# 4. proto lint(如有 buf CLI)
( cd proto && buf lint )

# 5. proto breaking against main(模拟 CI)
( cd proto && buf breaking --against '../.git#branch=main,subdir=proto' || echo "首次提交,允许无 baseline 报告" )

# 6. Tauri 打包仍然 OK
pnpm tauri build --debug

# 7. 现有 build.yml 版本验证脚本仍能 grep 到版本
grep -m1 '^version = ' backends/Cargo.toml | sed 's/.*"\(.*\)"/\1/'
# Expected: "0.1.4"(或当前 package.json 中的版本)
```

---

## Subsequent Plans(本计划合并后再细化)

| 计划                         | 关键交付                                                                                                                                                                                                                                                                     | 验证方式                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Plan 2: Auth End-to-End**  | chathub-state(SQLite token 持久化)、chathub-net(channel/token/interceptor/auth modules)、stub-relay 测试服务、Tauri `login`/`logout` 命令、自动刷新 interceptor                                                                                                              | 启动 stub-relay → invoke `login` → 拿到 token 写入 keyring → 等 30min 自动刷新触发 → 一键退出测试                    |
| **Plan 3: Subscribe + Send** | chathub-net 真正用上 Hub.Subscribe + Hub.Send;ConnectionManager 状态机(CONNECTING/SUBSCRIBING/CATCHING_UP/LIVE/RECONNECTING/REFRESH_TOKEN);per-account since_seqs 持久化;client_msg_id 去重 + 退避;LIVE_BOUNDARY/SYNC_REQUIRED 处理;扩充 hub.proto/event.proto/message.proto | stub-relay 注入 IncomingMsg → 客户端收到;kill stub-relay → 客户端退避重连;同 client_msg_id 重发 → server_msg_id 一致 |
| **Plan 4: Blob Pipeline**    | crates/chathub-blob:multipart 单发 + chunked 分片上传、Range 流式下载、本地 30 天 LRU(SQLite 索引 + 文件存盘);Tauri 命令 `upload_media`/`download_media`/`media_path`                                                                                                        | 上传 5MB JPEG → 拿 media_id → 下载 → SHA256 一致;上传 50MB MP4(chunked) → 同上;断网中途 → 续传                       |
| **Plan 5: Frontend Switch**  | frontends/lib/transport(Tauri invoke + listen 包装)、`useChatMessages` 移除 mock 切真实数据流、`MessageComposer` Send 走真实路径、附件先 upload 再 Send;feature flag 保留 mock fallback                                                                                      | 启动 dev → 登录 → 收发文字 + 图片 + 撤回;断网 5s → 顶部黄条;恢复 → backlog 补回;Composer 截图 → 上传 → 发送          |

---

## Out of Scope(本计划不做)

- 任何真正的 gRPC 通信代码(全部在 Plan 2+)
- 任何 SQLite/persistence 代码(Plan 2 起)
- 任何 Tauri command 修改(Plan 2 起)
- 任何前端改动(Plan 5)
- 任何附件/blob 代码(Plan 4)
- Relay 服务端正式实现(独立仓库,本系列计划不覆盖;只在测试中用 stub-relay)
