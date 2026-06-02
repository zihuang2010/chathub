# AI 润色功能 设计文档

- 日期：2026-06-02
- 状态：已评审，待实施
- 范围：聊天区域消息输入框的「AI 润色」功能，从 mock 占位升级为真实流式 AI 润色

---

## 1. 背景与现状

「AI 润色」UI 与接入**已存在但核心是假的**：

- UI：`frontends/components/workbench/messages/composer/AiPolishPopover.tsx` —— Radix Popover，含 4 种语气（正式 / 亲切 / 幽默 / 简洁）、原文区、润色预览区、取消 / 「替换草稿」按钮。
- 接入：`MessageComposer.tsx:702` 已挂载；`onApply` 将润色结果替换文本块、保留图片块顺序（`docToBlocks` → `[text, ...images]` → `editor.setContent`）。
- 字符串：`strings.ts` 的 `composer.polish*` 已就位。
- 唯一假实现：`AiPolishPopover.tsx` 的 `mockPolish()` 只给原文加 `[语气]` 前缀，预览为**即时本地计算**，无真实 AI 调用、无 loading / 报错 / 重试态。

通信架构：前端（React/TS）↔ Rust 后端走 Tauri `invoke`；后端 crate 有 `chathub-net`(gRPC)、`chathub-relay`(独立 axum 服务)、`chathub-proto`、`chathub-state`。**当前后端无任何 LLM/AI 集成**。

本次实质工作：**把 mock 换成真实流式 AI 润色**，并补齐真实调用必需的交互态（生成 / 加载 / 失败 / 重试 / 取消）。

## 2. 关键决策（评审确认）

| #   | 决策点   | 选择                                                    | 理由                                                |
| --- | -------- | ------------------------------------------------------- | --------------------------------------------------- |
| 1   | 接入层   | 新增 Rust Tauri 命令直连厂商（reqwest）                 | 密钥不进 JS 包；改动中等                            |
| 2   | 协议     | OpenAI 兼容 `/chat/completions`                         | 一套代码可切 DeepSeek / 通义 / Kimi / 智谱          |
| 3   | 配置来源 | 构建期环境变量（build.rs 注入，沿用 `*_RESOLVED` 约定） | 改动最小，与现有 `CHATHUB_ATTACHMENT_BASE_URL` 同构 |
| 4   | 返回方式 | 流式（Tauri v2 `Channel` 推流）                         | 打字机体验                                          |
| 5   | 触发方式 | 显式「生成」按钮，可换语气 / 取消 / 重新生成            | 不每次点语气都发请求，最可控、不浪费 token          |

## 3. 技术前提（已核对）

- 主 crate `chathub`（`backends/Cargo.toml`）已依赖 tauri v2、reqwest、tokio、serde/serde_json、anyhow。
- workspace 根 `./Cargo.toml` 定义 `reqwest = { version = "0.12", default-features = false, features = ["json","rustls-tls","http2"] }` —— **无 `stream` feature**。流式改用 `reqwest::Response::chunk()` 增量读 SSE，**无需改 Cargo**。
- env 注入约定：`backends/build.rs` 把 env 解析为 `*_RESOLVED` 常量，运行时 `env!("..._RESOLVED")` 读取（如 `CHATHUB_ATTACHMENT_BASE_URL_RESOLVED`、`CHATHUB_RELAY_URL_RESOLVED`）。
- 现有 `MessageComposer.switch.test.tsx` / `MessageComposer.attachments.test.tsx` 已 `vi.mock("./composer/AiPolishPopover", () => ({ AiPolishPopover: () => null }))`，**改 Popover 内部不影响它们**。

## 4. 后端设计（Rust）

### 4.1 配置注入（`backends/build.rs`）

沿用现有写法，新增 3 个常量（缺失回落 + release 缺失 `cargo:warning` 告警）：

- `CHATHUB_AI_BASE_URL_RESOLVED` —— 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`（通义千问 OpenAI 兼容端点）
- `CHATHUB_AI_MODEL_RESOLVED` —— 默认 `qwen-flash`
- `CHATHUB_AI_API_KEY_RESOLVED` —— **缺失回落空串占位**（不让构建失败；构建期由 CI/脚本注入真实 key；运行时空串 → 命令返回「AI 未配置」）

`rerun-if-env-changed` 同时声明对应 3 个 env。

**安全权衡（明示）**：api_key 经 `env!` 在编译期固化进**原生二进制**（可被有心人提取，但不进 JS 包）—— 这是选择「构建期环境变量 / 密钥在客户端」时接受的取舍。

### 4.2 新增模块 `backends/src/ai_polish.rs`

**事件类型**（serde 标签枚举，序列化为 `{ "type": "delta", "text": "..." }`）：

```rust
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PolishEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}
```

**取消状态**（app 全局单条在途流，零新增依赖）：

```rust
#[derive(Default)]
pub struct PolishState(pub std::sync::Mutex<Option<tokio::task::AbortHandle>>);
```

> 机制：`ai_polish` 把"建连 + 流式读 + 发事件"整段 `tokio::spawn` 成任务，把 `AbortHandle` 存入 `PolishState`；开始新流或 `cancel_ai_polish` 时，取出旧 handle 调 `.abort()` 中断旧任务（reqwest 连接随任务 drop 关闭）。命令本身 `await` 该任务的 `JoinHandle`，被 abort 时安静返回、不发 `Done`。

**命令 1：`ai_polish`**

```rust
#[tauri::command]
async fn ai_polish(
    text: String,
    tone: String,
    on_event: tauri::ipc::Channel<PolishEvent>,
    state: tauri::State<'_, PolishState>,
) -> Result<(), String>
```

流程：

1. 校验配置：base_url / key 为空 → `on_event.send(Error{"AI 未配置"})` 后返回 `Ok(())`。
2. 取消上一条在途流（取出旧 token/handle 并取消），登记本次取消令牌。
3. reqwest `Client` POST `{base_url}/chat/completions`：
   - header `Authorization: Bearer {key}`、`Content-Type: application/json`
   - body：`{ model, stream: true, messages: [ {role:"system", content: system_prompt_for(tone)}, {role:"user", content: text} ] }`
   - 设连接超时与整体超时（如 connect 10s、total 60s）。
4. 非 2xx → `Error{含状态码与简短 body}`。
5. `loop { resp.chunk().await }` 增量读字节，按行缓冲解析 SSE：
   - 形如 `data: {json}`；`data: [DONE]` → 结束。
   - 提取 `choices[0].delta.content`，非空 → `on_event.send(Delta{text})`。
   - 坏行 / 心跳行跳过。
6. 取消令牌命中（`tokio::select!` 或每轮检查）→ 中断、丢弃连接、直接返回（不发 Done）。
7. 正常收尾 → `on_event.send(Done)`。

**命令 2：`cancel_ai_polish`**

```rust
#[tauri::command]
fn cancel_ai_polish(state: tauri::State<'_, PolishState>)
```

取出并触发当前取消令牌 / abort handle。

**提示词 `system_prompt_for(tone) -> &'static str`**：按 4 种 tone 返回不同中文 system prompt，统一约束「只输出润色后的正文，不解释、不加引号、保持原意与语言」。`parse_sse_delta` 等解析逻辑抽成纯函数以便单测。

### 4.3 注册（`backends/src/lib.rs`）

- `mod ai_polish;`
- `.manage(ai_polish::PolishState::default())`
- `tauri::generate_handler![ ... , ai_polish::ai_polish, ai_polish::cancel_ai_polish ]`

## 5. 前端设计

### 5.1 新增 `composer/aiPolishClient.ts`

```ts
export type PolishTone = "formal" | "warm" | "humor" | "concise";
type PolishEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function streamPolish(
  text: string,
  tone: PolishTone,
  cb: { onDelta(t: string): void; onDone(): void; onError(msg: string): void },
): { cancel(): void };
```

- `isTauri()` 真 → `new Channel<PolishEvent>()`，`channel.onmessage` 分发到回调；`invoke("ai_polish", { text, tone, onEvent: channel })`；`cancel()` → `invoke("cancel_ai_polish")`。
- `isTauri()` 假（web/dev/test）→ 回落本地 mock：复用原 `mockPolish` 逻辑，用定时器逐字 `onDelta` 模拟流式，`cancel()` 清定时器。

### 5.2 改造 `composer/AiPolishPopover.tsx`

- 删除即时 `mockPolish` 预览；引入状态机 `idle | streaming | done | error`，加 `preview` / `errorMsg` / `streamRef`。
- 语气选择条保留。预览区按状态渲染：`idle` 占位 / `streaming` 实时累加（打字机）/ `done` 完整结果 / `error` 错误文案。
- 底部按钮按状态：
  - `idle` → 「生成」（无文本禁用，沿用现 `disabled`）
  - `streaming` → 「停止」
  - `done` / `error` → 「重新生成」
  - 常驻「替换草稿」（仅 `done` 且有结果可点）+「取消」（关闭 Popover）
- 切语气：若 `streaming`，先 `cancel()` 再重置 `idle`（保留新 tone），不自动重发。
- 关闭 Popover / 组件卸载：`cancel()` 清理在途流。
- `onApply(preview)` **完全沿用**，不动 `MessageComposer.tsx` 图片保序逻辑。

### 5.3 `strings.ts`

`composer` 下新增：`polishGenerate`(生成) / `polishRegenerate`(重新生成) / `polishStop`(停止) / `polishGenerating`(生成中…) / `polishErrorPrefix`(润色失败：)。复用现有 `polishTitle` / `polishTones` / `polishOriginal` / `polishPreview` / `polishApply` / `polishCancel` / `aiPolishEmptyHint`。

## 6. 数据流

```
输入框打字 → 点「AI 润色」开 Popover → 选语气(默认 formal) → 点「生成」
  前端: new Channel + invoke("ai_polish", {text, tone, onEvent})
    → Rust: 取消旧流 → 登记取消令牌 → reqwest POST (stream:true)
           → 循环 chunk() 解析 SSE delta → on_event.send(Delta) ──┐
           → 收尾 send(Done) / 异常 send(Error)                    │
  前端: channel.onmessage 累加 preview (打字机) ◀───────────────────┘
  → done → 「替换草稿」可点 → onApply(preview)
    → docToBlocks 取现有图片块 → [text, ...images] → editor.setContent
```

## 7. 错误处理与边界

- **未配置**（key/base_url 空）：命令即发 `Error{"AI 未配置"}`，前端预览区显示，按钮变「重新生成」。
- **网络 / 非 2xx / 超时**：`Error` 事件，前端可重试；reqwest 设连接与整体超时。
- **取消**：切语气 / 关闭 Popover / 点「停止」→ `cancel_ai_polish` → 后端中断丢弃连接；前端停在已累加文本并回到可重生成态。
- **空文本**：现有 `disabled={!textJoined.trim()}` 已覆盖。
- **并发**：全局单条在途流，新流自动废弃旧流（后端令牌 + 前端 `streamRef` 双保险）。
- **非 Tauri 环境**：mock 回落，逐字模拟，行为一致。
- **安全**：`base_url` 仅来自构建期 env、固定可信；**绝不接受前端传 URL**，无 SSRF 面。

## 8. 测试方案

**前端（vitest）**

- 新增 `composer/AiPolishPopover.test.tsx`：`vi.mock` 掉 `aiPolishClient.streamPolish`，验证 ① 点「生成」触发调用、delta 累加、done 后「替换草稿」可点并回传完整文本；② error → 显示错误 + 「重新生成」；③「停止」/切语气 → 调 `cancel()` 并回到可重生成态。
- 新增 `composer/aiPolishClient.test.ts`：非 Tauri 分支 mock 逐字回放断言。
- 现有 `MessageComposer.switch.test.tsx` / `attachments.test.tsx` 不受影响、不改。

**后端（cargo test）**

- `parse_sse_delta` 纯函数单测：样例 SSE 行 → 增量拼接、`[DONE]` 终止、坏行跳过。
- `system_prompt_for(tone)`：4 种 tone 各返回非空且含约束语。
- 网络部分不做真实联网测试（依赖外部 key）。

**验证命令**（pnpm 在仓库根；cargo 在 `backends/`）

- `pnpm test -- AiPolishPopover aiPolishClient`
- `cargo build -p chathub` + `cargo clippy -p chathub`
- `cargo test -p chathub`

## 9. 改动文件清单

| 文件                                                                   | 改动                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `backends/build.rs`                                                    | 注入 3 个 AI env 常量                                                               |
| `backends/src/ai_polish.rs`                                            | **新增**：`ai_polish` / `cancel_ai_polish` 命令 + SSE 解析 + 提示词 + `PolishState` |
| `backends/src/lib.rs`                                                  | `mod ai_polish`、注册 2 命令、`manage` 取消状态                                     |
| （Cargo 无需改动）                                                     | 取消用 `tokio::task::AbortHandle`，零新增依赖                                       |
| `frontends/.../composer/aiPolishClient.ts`                             | **新增**：流式客户端 + 非 Tauri mock 回落                                           |
| `frontends/.../composer/AiPolishPopover.tsx`                           | 改造：状态机 + 生成/停止/重生成                                                     |
| `frontends/.../messages/strings.ts`                                    | 补润色相关字符串                                                                    |
| `composer/AiPolishPopover.test.tsx`、`composer/aiPolishClient.test.ts` | **新增**单测                                                                        |

## 10. 已定参数

- 厂商 / 模型：**通义千问 qwen-flash**，OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
- `CHATHUB_AI_API_KEY`：构建期 env 注入；当前回落空串占位，真实 key 后续在 CI/构建脚本填充。
- 取消机制：用 `tokio::task::AbortHandle`（零新增依赖）—— spawn 流任务存其 handle，`cancel_ai_polish` / 新流开始时 abort。

## 11. 非目标（YAGNI）

- 不做设置界面 / 运行时改 key（本次走构建期 env）。
- 不做多家厂商专属适配（只走 OpenAI 兼容协议）。
- 不做 request_id 维度的多流并发管理（只有一个输入框，单流足矣）。
- 不改动 `MessageComposer.tsx` 既有图片保序与发送逻辑。
- 撤回/历史/多语言等无关项不在范围内。
