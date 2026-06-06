# CLAUDE.md

# AI 工程行为规范（生产级）

本文件用于约束 AI Agent（Claude Code / Cursor / OpenCode / GPT 等）的工程行为。

目标：

- 降低误修改
- 降低过度设计
- 降低隐式假设
- 降低大范围破坏
- 提高可维护性
- 提高可验证性
- 提高多人协作稳定性

本规范优先级高于默认模型行为。

---

# 0. 输出语言规则（最高优先级）

- 除非用户明确要求其他语言，否则必须始终使用中文回复。
- 所有分析、解释、计划、风险说明、设计讨论必须使用中文。
- 不允许默认切换英文。
- 终端输出、日志、代码标识符保持原语言即可。
- 引用英文资料时必须附带中文解释。
- Commit Message 默认使用中文。
- 新增代码注释默认使用中文。

---

# 1. 核心工程原则

## 1.1 先思考，再编码

禁止直接开始修改代码。

在编码前必须：

- 明确理解需求
- 显式说明假设
- 指出不确定点
- 给出风险分析
- 给出影响范围
- 给出验证方案

如果存在歧义：

- 必须停止并询问
- 不允许自行猜测业务逻辑

如果存在更简单方案：

- 必须明确指出
- 不允许默认采用复杂方案

---

## 1.2 简单优先（极其重要）

始终选择：

- 最简单
- 最直接
- 最小改动
- 最低风险

的方案。

禁止：

- 为未来扩展提前抽象
- 单次使用却创建复杂架构
- 添加未被要求的配置
- 添加未被要求的“灵活性”
- 添加未被要求的“通用性”
- 添加推测性的功能

必须持续思考：

“这个实现是否被高级工程师认为过度设计？”

如果答案可能是“是”，必须继续简化。

---

## 1.3 最小修改原则

只修改：

- 当前任务必须修改的代码

禁止：

- 顺手重构
- 顺手优化
- 顺手统一风格
- 顺手调整命名
- 顺手修改无关逻辑

即使发现：

- 坏代码
- 死代码
- 风格问题

也只能：

- 提醒用户
- 不允许擅自修改

---

## 1.4 保持现有风格

修改代码时：

- 必须遵循项目现有风格
- 必须遵循现有架构
- 必须遵循现有命名方式

禁止：

- 强行引入个人偏好
- 强行统一代码风格
- 强行替换框架习惯

---

# 2. 任务执行规范

## 2.1 多步骤任务必须先给计划

格式：

```txt
1. [步骤]
   - 目标：
   - 风险：
   - 验证：

2. [步骤]
   - 目标：
   - 风险：
   - 验证：
```

## 2.2 工具调用纪律（避免连环取消）

并行批次（同一条消息里发多个工具调用）中，**只要有一个调用报错，同批次的其余调用会被全部取消**（表现为 `Cancelled: parallel tool call ... errored`），即使它们本身没问题。

必须遵守：

- 操作文件前**先确认文件存在**（`ls` / `find` / Glob），不要凭记忆假设路径再去 `Read` / `sed` / `awk`。
- **不要发巨大、投机性的并行批次**；把可能失败的调用拆开单独发，或顺序执行。
- 只对**确定无依赖且确定存在**的目标做并行；有不确定性时先串行探路。

排错时：

- 看到成片 `Cancelled: parallel tool call X errored`，真正出错的是同批次里的 **X 那个调用**，先去修 X；不要把被取消的兄弟调用当成各自失败逐个重试。

---

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **chathub** (7151 symbols, 13548 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource                                 | Use for                                  |
| ---------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/chathub/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/chathub/clusters`       | All functional areas                     |
| `gitnexus://repo/chathub/processes`      | All execution flows                      |
| `gitnexus://repo/chathub/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->

---

# 3. 仓库地图与命令工作目录

跑任何引用路径的命令（`sed`/`cat`/`ls` 操作 `package.json`、`pnpm`、`cargo`）之前，先确认工作目录，避免 `No such file or directory` 报错。

## 3.1 最重要的一条

- **整个仓库只有一个 `package.json`，且只在仓库根目录；`frontends/` 下没有 `package.json`。**
- 所有 `pnpm` / `vitest` / `eslint` 命令的工作目录都是**仓库根目录**，不是 `frontends/`。
- 包管理器是 **pnpm**（认 `pnpm-lock.yaml`），不要用 `npm` / `yarn`。
- 直接的 `cargo` 命令工作目录是 `backends/`；跑单个服务用 `cargo run -p <crate>`（如 `chathub-relay`）。
- Tauri 配置在 `backends/tauri.conf.json`，不在根目录。

## 3.2 完整索引见技能

定位文件、选工作目录、查命令 ↔ cwd 对照、Cargo workspace 成员、目录结构等，查阅技能：

| 需求                                       | 查阅                                       |
| ------------------------------------------ | ------------------------------------------ |
| 仓库目录地图 / 文件在哪 / 命令在哪个目录跑 | `.claude/skills/chathub-repo-map/SKILL.md` |
