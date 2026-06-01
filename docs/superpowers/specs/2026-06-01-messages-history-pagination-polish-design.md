# 消息历史列表：上滑翻页过渡打磨 + 低风险性能兜底

日期：2026-06-01
模块：`frontends/components/workbench/messages`

## 背景与现状

气泡列表已在第四轮去虚拟化，改为全量直接渲染（`ChatArea.tsx` `timelineItems.map()`，虚拟器只剩左侧 `ConversationList`）。上滑翻页：

- 贴顶（`scrollTop ≤ HISTORY_TOP_LOAD_THRESHOLD = 1`）才触发加载；
- 加载期间 `useScrollController.handleWheelCapture` 用 `preventDefault` 冻结滚轮（兼作重入守卫）；
- prepend 后在 `useLayoutEffect` 里单次 pre-paint 锚定 `scrollTop = max(0, scrollHeight_new − scrollHeight_old + scrollTop_old)`；图片盒首帧冻高 + `object-contain` 保证插入即终值、差值精确；
- 顶部浮层 spinner `HistoryLoadingIndicator`（绝对定位、不挤布局）。

跨会话内存已有界：`chatStore.MAX_HOT_CONVERSATIONS = 30` LRU + 图片缓存各 512 LRU + 切员工 `reset`。翻页路径高效：`prependOlder` 保留旧消息引用，配合行级 `memo`，上翻一页只渲新增的那 20 行。

## 目标

1. **（主）上滑翻页过渡更精致丝滑**——在不改触发模型（仍贴顶才加载）、不破坏现有精确差值锚定的前提下打磨手感。
2. **（预防）低风险性能兜底**——降低渲染/重渲开销，不动架构。

## 非目标（本轮明确不做）

- 不回退虚拟化。
- 不加单会话消息上限 / 不裁剪 DOM 行（即不做"真正封顶内存"，见下"内存诚实结论"）。
- 不改翻页触发模型（不做提前预取、不做滚动中 prepend）。
- 撤回/删除接后端、AI 润色等既有功能桩，均不在本轮。

## Part A — 上滑翻页过渡打磨（主）

### A1. Spinner 生命周期打磨

现状 `HistoryLoadingIndicator` 一挂即显、加载完即卸，IPC 快时一闪。改为 **最小展示时长 ~400ms + 进出淡入淡出**。保留现有 `backdrop-blur` 浮层与绝对定位（不挤布局、不引位移）。

### A2. 柔化"撞到顶"手感

- 到顶/加载中 wheel 仍 `preventDefault`（保留重入守卫语义）。
- 加上"正在取更早消息"的视觉 affordance：spinner + 顶部一道极淡渐变发丝。
- **overscroll 回弹**：到顶继续上推时给一个极轻的回弹反馈，**纯 `transform`，绝不触碰 `scrollTop`、不参与锚定差值**，回弹结束归零。尊重 `prefers-reduced-motion`（reduce 时禁用）。

### A3. prepend 瞬间零位移（验收点，不改逻辑）

现有精确差值锚定 + 图片冻高已能做到。本轮把"连翻多页无累计漂移、加载中冻结后顺滑接回"列为真机验收项。

### A4. `prefers-reduced-motion` 全程尊重

spinner 已有 `motion-reduce:animate-none`；补齐 A1 淡入与 A2 回弹的 reduce 分支。

### 明确不做：新行淡入

"贴顶才加载"模型下新行 prepend 后被锚定推到视口上方（屏外），等用户滚上去时早已淡完，价值低，故不做。

## Part B — 性能兜底（预防，低风险）

### B1. `replaceAuthoritative` 结构共享（真正零风险，核心）

热点：实时新消息 / ChangeNotice 走整窗 REPLACE 时，`chatStore.ts:replaceAuthoritative` 给**每条**消息重建对象引用 → 所有 `memo` 行 `message === message` 失效 → 全列表重渲一次（`prependOlder` 不受影响）。会话越长越重。

改法：REPLACE 构建 `byId` 时，对内容未变的消息**复用旧 entity 引用**（按 id 命中旧 entity 且渲染相关字段相等则原样返回旧对象），使 `memo` 行只渲真正变化的行。纯函数改动 + 扩 `chatStore.test.ts`，**不碰滚动**。

"相等"判定范围：以影响渲染的字段为准（含 `preserveOptimisticImageDimensions` 合并后的 parts 与图片 width/height、status、isRecalled 等）；保守起见可对 parts 做浅层 + 图片维度比较，任一不确定则不复用（退化为现状，安全）。

### B2. `content-visibility` 屏外行跳渲染（你点名的兜底，有限风险，需真机验证）

对消息行容器加 `content-visibility: auto` + `contain-intrinsic-size: auto <估高>`，让屏外行跳过 layout/paint。

- 估高复用现成 `virtualListSizing.ts:estimateTimelineRowHeight(item)`（去虚拟化后已无人消费的死代码，本轮转为 `contain-intrinsic-size` 的尺寸源，给它正当归宿）。
- 配合 `contain-intrinsic-size: auto`（浏览器 last-remembered-size）：行被渲染过一次后记住实测尺寸，再次离屏即精确。

**诚实风险**：与"精确差值锚定 + `overflow-anchor:none`"有交互——首次上滑揭示"估高不准的文本行"时可能有轻微位移（图片行冻高精确、无此问题）。

**安全网（按真机结果择一）**：

1. 真机无感 → 全量启用；
2. 文本行有可感位移 → 降级为**仅图片行启用**（冻高精确）；
3. 仍有回退抖动 → 整体回退（移除 `content-visibility`，B1 与 Part A 不受影响）。

## 内存诚实结论

真正封顶单会话 DOM 内存的唯一手段是消息上限/裁剪，本轮按你的选择**不动架构**。故本轮在内存上做到的是**降低渲染/重渲开销**，不是"封顶 DOM 占用"；`content-visibility` 同样**不省内存**（DOM 仍在），省的是渲染成本。若将来真遇长会话内存问题，再单列"滑动窗口裁剪"为可选阶段。

## 触点

| 改动     | 文件                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| A1/A2/A4 | `ChatArea.tsx`（`HistoryLoadingIndicator`、行/视口动效），可能 `WorkbenchScrollArea.tsx`（overscroll 回弹宿主） |
| B1       | `store/chatStore.ts`（`replaceAuthoritative` 纯函数）+ `store/chatStore.test.ts`                                |
| B2       | `ChatArea.tsx`（`MessageTimelineRow` 行容器 className）+ 复用 `virtualListSizing.ts:estimateTimelineRowHeight`  |

> GitNexus 索引已过期（停在 `36190f5`，新函数未进图谱）。实现前先 `npx gitnexus analyze`，再对 `replaceAuthoritative` 跑 `gitnexus_impact`，否则爆炸半径不可信。

## 验证

- 自动化：`pnpm tsc` + `pnpm eslint` + `pnpm vitest`（messages 套件 + 全量），B1 扩单测覆盖"未变消息复用引用"。
- 真机（不可盲信已完成）：
  1. A1 快/慢加载下 spinner 不一闪、淡入淡出顺滑；
  2. A2 到顶回弹轻盈、`prefers-reduced-motion` 下禁用；
  3. A3 连翻多页无累计漂移、加载中冻结后顺滑接回；
  4. B2 全量启用下上滑揭示文本行无可感位移；若有 → 按安全网降级并复验。

## 风险与回退

- B1 触碰 `chatStore` "最易错的收敛逻辑"，以纯函数 + 单测兜底；任一字段不确定则不复用（退化为现状）。
- B2 与锚定的交互见上，三级安全网。
- A2 回弹只动 `transform`，与锚定（动 `scrollTop`）正交，互不干扰。
