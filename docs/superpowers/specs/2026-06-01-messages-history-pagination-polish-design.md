# 消息历史列表：上滑翻页过渡打磨

日期：2026-06-01
模块：`frontends/components/workbench/messages`

> 本轮经多轮事实核对后**收敛为纯 UI 过渡打磨**：性能/内存项（B1、B2）评审后判定不划算，均不做（理由见下「性能评估结论」）。

## 背景与现状

气泡列表已在第四轮去虚拟化，改为全量直接渲染（`ChatArea.tsx` `timelineItems.map()`，虚拟器只剩左侧 `ConversationList`）。上滑翻页：

- 贴顶（`scrollTop ≤ HISTORY_TOP_LOAD_THRESHOLD = 1`）才触发加载；
- 加载期间 `useScrollController.handleWheelCapture` 用 `preventDefault` 冻结滚轮（兼作重入守卫）；
- prepend 后在 `useLayoutEffect` 里单次 pre-paint 锚定 `scrollTop = max(0, scrollHeight_new − scrollHeight_old + scrollTop_old)`；图片盒首帧冻高 + `object-contain` 保证插入即终值、差值精确；
- 顶部浮层 spinner `HistoryLoadingIndicator`（绝对定位、不挤布局）。

## 目标

**上滑翻页过渡更精致丝滑**——在不改触发模型（仍贴顶才加载）、不破坏现有精确差值锚定、不碰数据/滚动逻辑的前提下，只打磨手感。

## 非目标（本轮明确不做）

- 不回退虚拟化、不改翻页触发模型、不改 `MAX_MESSAGES_IN_MEMORY = 500` 上限。
- **不做 B1（`replaceAuthoritative` 结构共享）**：权威页恒为 ~20 条，全量重渲实际只波及最近窗口（~20–50 行），收益小且要碰 `chatStore` 最易错的收敛逻辑。
- **不做 B2（`content-visibility`）**：见「性能评估结论」——会裁掉浮出元素且收益边际。
- 撤回/删除接后端、AI 润色等既有功能桩，均不在本轮。
- 不做"新行淡入"：贴顶模型下新行 prepend 后被锚定推到屏外，用户滚上去时早已淡完，价值低。

## 设计：上滑翻页过渡打磨

### A1. Spinner 生命周期打磨

现状 `HistoryLoadingIndicator` 一挂即显、加载完即卸，IPC 快时一闪。改为 **最小展示时长 ~400ms + 进出淡入淡出**。保留现有 `backdrop-blur` 浮层与绝对定位（不挤布局、不引位移）。

新增小 hook `useTransientVisibility(active, { minVisibleMs, fadeMs })`：active 立即点亮；active 转 false 时先补足 `minVisibleMs`，再进入 `leaving` 持续 `fadeMs`，最后卸载。返回 `{ rendered, leaving }`，spinner 用 `data-state` 切 `animate-in`/`animate-out`。纯计时、最坏退化为立即显隐。

### A2. 柔化"撞到顶"手感 + 到顶回弹

- 到顶/加载中 wheel 仍 `preventDefault`（保留重入守卫语义，**不改** `useScrollController`）。
- **overscroll 回弹**：到顶继续上推时，给滚动内容容器一个极轻的 `transform: translateY` 回弹，**绝不触碰 `scrollTop`、不参与锚定差值**，停止上推后归零。宿主在 `WorkbenchScrollArea`（它持有 viewport 与 content 节点），新增 `overscrollBounce?: boolean` prop（**默认关**，仅 `ChatArea` 消息区开；其余 3 处用处不受影响）。
- 浮层 spinner 在消息区容器层、不在滚动内容内，回弹时 spinner 不动、内容在其下轻拽，读作"在取更早的消息"。

### A3. prepend 瞬间零位移（验收点，不改逻辑）

现有精确差值锚定 + 图片冻高已能做到。本轮把"连翻多页无累计漂移、加载中冻结后顺滑接回"列为真机验收项。

### A4. `prefers-reduced-motion` 全程尊重

spinner 已有 `motion-reduce:animate-none`；补齐 A1 淡入/淡出（`motion-reduce:animate-none`）与 A2 回弹（reduce 时整段禁用、不挂 wheel 监听）。

## 性能评估结论（记录，备将来）

这套列表的性能/内存**已处在良好状态**，本轮不加性能机制：

- **内存本就有界**：单会话 `MAX_MESSAGES_IN_MEMORY = 500`（到顶停拉）+ 新消息 `replaceAuthoritative(最近 20)` 塌缩回最近一页；跨会话 `MAX_HOT_CONVERSATIONS = 30` LRU + 图片缓存各 512 LRU + 切员工 `reset`。
- **B1 收益小**：reconcile 窗口恒 ~20 行。
- **B2 有确定回归**：`content-visibility: auto` 可见时即施加 `contain: …paint`，会裁掉浮在行盒外的**悬停时间戳**（`absolute bottom-full`）与**失败/重发行**（`absolute top-full`）——正是现有 `[contain:layout_style]` 故意不含 paint 的原因；且浏览器本就不 paint 屏外内容，有界列表的 layout 节省边际。要规避须重构 `MessageBubble` 浮出元素定位（牵动行间距与锚定高度），不划算。
- 若将来 500 行仍嫌卡，再单列"滑动窗口裁剪"为可选阶段（注释已说明：因无向下翻页，裁剪尾部会造成下滑空洞，故现选"到 500 停止增长"而非裁剪）。

## 触点

| 改动  | 文件                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A1    | 新增 `hooks/useTransientVisibility.ts` + `hooks/useTransientVisibility.test.ts`；`ChatArea.tsx`（接 `leaving`/`data-state`）       |
| A2/A4 | `WorkbenchScrollArea.tsx`（新增 `overscrollBounce` prop + 回弹逻辑 + `contentRef`）；`ChatArea.tsx`（消息区传 `overscrollBounce`） |

> GitNexus 索引已过期（停在 `ae6d0c0`）。本轮改动全在 UI 层、不动数据/滚动核心逻辑；实现前先 `npx gitnexus analyze`，对 `ChatArea`/`WorkbenchScrollArea` 跑一次 `gitnexus_impact` 确认爆炸半径（预期 LOW）。

## 验证

- 自动化：`pnpm exec tsc --noEmit` + `pnpm lint` + `pnpm test`（messages 套件 + 全量须全绿）。A1 hook 用 vitest fake timers 单测（显示后立即隐藏仍停留 minVisibleMs、退出走 leaving、重新激活取消挂起退出）。现有 `ChatArea.test.tsx`（含 spinner 存在性断言）与 `WorkbenchScrollArea.test.tsx` 保持全绿。
- 真机（不可盲信已完成）：
  1. A1 快/慢加载下 spinner 不一闪、淡入淡出顺滑；
  2. A2 到顶回弹轻盈、`prefers-reduced-motion` 下禁用；
  3. A3 连翻多页无累计漂移、加载中冻结后顺滑接回。

## 风险与回退

- A1 纯 UI 计时，不触碰数据/滚动；最坏退化为"立即显隐"（现状）。
- A2 回弹只动 `transform`，与锚定（动 `scrollTop`）正交，互不干扰；`overscrollBounce` 默认关，其它用处零影响；reduce-motion 下不挂监听。
