---
name: chathub-repo-map
description: Use when locating a file, choosing a working directory, or running a shell/build/test command in the ChatHub repo. Provides the directory map, where package.json and Cargo.toml live, the package manager, and the correct cwd for each command. Consult BEFORE running path-dependent commands (sed/cat/ls on package.json, pnpm, cargo) to avoid "No such file or directory" errors.
---

# ChatHub 仓库地图

Monorepo：TypeScript 前端（Vite + React 19 + Tauri 2）+ Rust 后端（Tauri 桌面端 + Cargo workspace 中继服务）。
仓库根目录：`/Users/pis0sion/Pis0sion/RustCode/ChatHub`。

## 最重要的一条（避免报错）

**整个仓库只有一个 `package.json`，且只在仓库根目录。`frontends/` 下没有 `package.json`。**

所有 `pnpm`、`vitest`、`eslint` 命令的 cwd 都是**仓库根目录**，不是 `frontends/`。
执行任何引用 `package.json`、`tsconfig.json`、`vite.config.ts` 的命令前，先 `cd` 回根目录。

包管理器是 **pnpm**（存在 `pnpm-lock.yaml`，无 `package-lock.json`）。

## 关键文件位置（全部在根目录）

| 文件                                       | 用途                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `package.json`                             | npm scripts（唯一一份，见下表）                |
| `pnpm-lock.yaml`                           | 锁文件（pnpm）                                 |
| `tsconfig.json` / `tsconfig.node.json`     | TS 配置，路径别名 `@/* → ./frontends/*`        |
| `vite.config.ts`                           | 前端构建，dev 端口 1420                        |
| `vitest.config.ts`                         | 单测配置                                       |
| `tailwind.config.js` / `postcss.config.js` | 样式                                           |
| `eslint.config.js`                         | Lint（flat config）                            |
| `components.json`                          | shadcn/ui 组件配置                             |
| `Cargo.toml`                               | Rust workspace 根                              |
| `AGENTS.md`                                | AI 工程规范（强制中文、impact 分析、最小修改） |
| `AGENTS.md`                                | GitNexus 集成说明                              |
| `README.md` / `CHANGELOG.md`               | 文档                                           |

`backends/tauri.conf.json` 是 Tauri 应用配置（注意它在 `backends/` 下，不在根目录）。

## 目录结构

```
ChatHub/
├── frontends/            # 前端源码（无 package.json）
│   ├── main.tsx          # React 入口
│   ├── App.tsx           # 主组件
│   ├── components/
│   │   ├── ui/           # shadcn/Radix 基础组件
│   │   ├── workbench/    # 工作区主组件（customers/ 等业务模块）
│   │   └── illustrations/
│   └── lib/
│       ├── api/          # HTTP/RPC 调用层
│       ├── data/         # 数据 hooks（useResource 等）
│       ├── types/        # TS 类型
│       └── crypto/       # 加密工具
├── backends/             # Rust（cd 到这里跑直接的 cargo 命令）
│   ├── src/              # Tauri 桌面应用（lib.rs / main.rs / image_cache.rs）
│   ├── crates/           # workspace 成员（见下表）
│   ├── Cargo.toml        # backends 包定义（package 名 chathub）
│   └── tauri.conf.json
├── proto/                # Protobuf 定义
├── scripts/              # 辅助脚本（见下表）
├── docs/
└── (根配置文件，见上表)
```

## Cargo workspace 成员

根 `Cargo.toml` 的 members（路径均相对仓库根）：

| Crate           | 路径                             | 职责                                   |
| --------------- | -------------------------------- | -------------------------------------- |
| `chathub`       | `backends/`                      | Tauri 桌面应用（lib + bin）            |
| `chathub-proto` | `backends/crates/chathub-proto/` | gRPC/Protobuf 生成代码                 |
| `chathub-state` | `backends/crates/chathub-state/` | 本地持久化（SQLite + deadpool）        |
| `chathub-net`   | `backends/crates/chathub-net/`   | gRPC 客户端、认证/token（含 `hub.rs`） |
| `chathub-relay` | `backends/crates/chathub-relay/` | 中继服务（Axum + Tokio），含多个 bin   |

## 命令速查（cwd 与命令一一对应）

前端 / 通用命令——**cwd = 仓库根目录**：

| 任务            | 命令                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| 前端 dev 服务器 | `pnpm dev`                                                                |
| 前端构建        | `pnpm build`（= `tsc && vite build`）                                     |
| 单元测试        | `pnpm test`（watch：`pnpm test:watch`）                                   |
| Lint            | `pnpm lint`（修复：`pnpm lint:fix`）                                      |
| 格式化          | `pnpm format` / `pnpm format:check`                                       |
| Tauri 开发/构建 | `pnpm tauri` / `pnpm tauri:build` / `pnpm tauri:build:debug`              |
| Rust 格式化     | `pnpm rs:fmt`（包装 `cargo fmt --manifest-path backends/Cargo.toml`）     |
| Rust lint       | `pnpm rs:lint`（包装 `cargo clippy --manifest-path backends/Cargo.toml`） |

直接的 Rust 命令——**cwd = `backends/`**（或在根目录加 `--manifest-path backends/Cargo.toml`）：

| 任务         | 命令                                                              |
| ------------ | ----------------------------------------------------------------- |
| 跑中继服务   | `cargo run -p chathub-relay`（或 `./scripts/run-relay-local.sh`） |
| 跑 mock 下游 | `./scripts/run-mock-downstream.sh`                                |
| 编译某 crate | `cargo build -p chathub-net`                                      |

`scripts/`：`run-relay-local.sh`、`run-tauri-local.sh`、`run-mock-downstream.sh`、`push-message.sh`、`test-hub-subscribe.sh`、`release-upload.sh`、`bump-version.mjs`、`make-latest-json.mjs`。

## 常见错误

- **`sed/cat package.json: No such file or directory`** → cwd 不在根目录（多半在 `frontends/`）。先回根目录；`frontends/` 没有 package.json。
- **用 `npm`/`yarn`** → 本仓库用 pnpm，认 `pnpm-lock.yaml`。
- **在根目录直接 `cargo run`** → 默认会对整个 workspace 报错或行为不符预期；跑单个服务用 `-p <crate>`，或 cd 进 `backends/`。
- **找 Tauri 配置在根目录** → 它在 `backends/tauri.conf.json`。
