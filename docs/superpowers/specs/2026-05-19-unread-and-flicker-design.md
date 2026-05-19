# 未读样式 + 首屏闪烁修复

**日期**：2026-05-19
**范围**：`frontends/components/workbench/messages/ConversationList.tsx`、`strings.ts`、`MessagesPage.tsx`、`frontends/lib/api/useRecentFriends.ts`、`frontends/lib/data/useResource.ts`、`frontends/components/TitleBar.tsx`
**动机**：UI 复查发现 (1) 未读视觉层级偏弱，需要"未读"语义标签强化文本流；(2) 开屏 → 消息页过渡有可见跳变，根因是 MOCK 假数据先渲染再被真数据覆盖。

---

## 1. 未读样式：preview 加「[未读]」+ 红圈缩小

### 现状

- `ConversationList.tsx:289` preview 行直接渲染 `{preview}`，无任何未读语义文字（上一次提交删掉了 `[N条]` 前缀）。
- `ConversationList.tsx:313-315` 右下红色徽标 `h-[16px] min-w-[16px] px-1 text-[10px]`。
- `strings.ts:37` 已有 `draftPrefix: "[草稿]"`，渲染为 `text-rose-500` 红色文字前缀（`ConversationList.tsx:282-284`）。

### 目标

| 项           | 现                       | 新                                      |
| ------------ | ------------------------ | --------------------------------------- |
| preview 前缀 | 无                       | `[未读]`（`text-rose-500`，同草稿样式） |
| 红圈尺寸     | 16×16 / `px-1`           | 14×14 / `px-1` / 字号 `text-[9px]`      |
| 显示条件     | 仅有未读时               | 同：仅 `unread > 0` 时才出现            |
| 与草稿互斥   | 草稿胜出（替换 preview） | 同：草稿存在时不显示未读前缀            |

### 代码改动

- `strings.ts`：新增 `unreadPrefix: "[未读]"`（同位于 `conversationList`）。
- `ConversationList.tsx:289` preview 渲染分支：

  ```tsx
  {
    draftText ? (
      <>
        <span className="mr-1 font-medium text-rose-500">
          {STRINGS.conversationList.draftPrefix}
        </span>
        <span className="text-workbench-text-secondary">{draftText}</span>
      </>
    ) : (
      <>
        {unread > 0 && (
          <span className="mr-1 font-medium text-rose-500">
            {STRINGS.conversationList.unreadPrefix}
          </span>
        )}
        {preview}
      </>
    );
  }
  ```

- `ConversationList.tsx:315`：徽标尺寸 `h-[16px] min-w-[16px]` → `h-[14px] min-w-[14px]`；字号 `text-[10px]` → `text-[9px]`。

---

## 2. 首屏闪烁：MessagesPage 加「首屏数据门」+ 骨架占位

### 现状

`MessagesPage.tsx` 启动顺序：

1. mount → `useRecentFriends` 返回 `items=[]`（resource.data 还是 null）
2. line 184 兜底：`conversations[0] ?? MOCK_CONVERSATIONS[0]` → 取假会话"林若 @微信"
3. line 195 `useChatMessages` 接到 MOCK conversation.id → fallback 到 `MOCK_MESSAGES_BY_CONVERSATION`
4. line 208 `MOCK_CUSTOMERS_BY_CONVERSATION[conversation.id] ?? MOCK_CUSTOMERS_BY_CONVERSATION.c1`
5. ConversationList / ChatArea / CustomerDetails 全部用 MOCK 数据完成第一帧渲染
6. 约 50-200ms 后真实 cache 命中 → `recentEntries` 非空 → `useEffect` 选第一项 → 三大组件 props 整体换值 → 内容大幅跳变

**结果**：肉眼可见的"先看到假联系人/假消息/假客户详情，再被真数据覆盖"。

### 目标

- 首次挂载时不渲染假数据；以"首屏骨架"占位，等真实 cache 命中后一次性切到真组件树。
- 切账号、删除会话等导致的 `recentEntries` 重新计算不引入额外 ready 门（不需要每次切都骨架闪一下）。

### 数据流改动

#### `useResource.ts` 暴露 `initialFetched` 信号

`useResource` 内部已经在首次 `runQuery()` 完成后 `setLastRefreshAt(Date.now())`，但消费方只能拿到 `lastRefreshAt` 间接判断。直接在 `UseResourceResult` 加：

```ts
/** 首次 queryFn 是否已经返回(无论 data 是否为空)。用于消费方判断"是否已经知道列表的真实状态"。 */
initialFetched: boolean;
```

实现：

```ts
const [initialFetched, setInitialFetched] = useState(false);
// 在 runQuery 的 finally 中 setInitialFetched(true)（仅首次有效，幂等）
```

理由：用 `data !== null` 不行——cache 命中且空列表时 setData([]) 同样是 null 之外的值；但 `null vs []` 在消费方读起来仍然 fragile。`initialFetched` 是**只前进**的布尔信号，语义明确："本地 cache 已读，可以信任 items 的状态了。"

#### `useRecentFriends.ts` 透传

`UseRecentFriendsResult` 增加 `initialFetched: boolean`，从 `resource.initialFetched` 透传。

#### `MessagesPage.tsx` 顶层守卫

```tsx
const {
  items: recentEntries,
  initialFetched,
  pin: pinRecent,
  remove: removeRecent,
} = useRecentFriends({ accountFilter: selectedAccountId });

if (!initialFetched) {
  return <MessagesSkeleton />; // 与 Workbench 同色背景 + 列表/聊天区轮廓
}
```

切账号场景（accountFilter 变化）：useResource 会触发 `seq` 重新执行 queryFn，但 `initialFetched` 已经是 true 不会回退——切账号瞬间 items 可能短暂为空，但骨架不会再出现。可接受（用户切账号期望即时响应，不闪是次要）。

#### 删除 MOCK fallback

- 删 `MessagesPage.tsx:186` 的 `?? MOCK_CONVERSATIONS[0]`
- 删 `MessagesPage.tsx:203` 的 `source: MOCK_MESSAGES_BY_CONVERSATION` 参数（看 `useChatMessages` 是否能接受 source 为 undefined；若不能，传一个空字典 `{}`）
- 删 `MessagesPage.tsx:209` 的 `?? MOCK_CUSTOMERS_BY_CONVERSATION.c1` —— 但需要确保 `initialFetched && conversations.length > 0` 时 `MOCK_CUSTOMERS_BY_CONVERSATION[id]` 不一定有数据。短期保留 `?? MOCK_CUSTOMERS_BY_CONVERSATION.c1` 作为开发期 placeholder，但加 TODO 注释说明等客户详情真实接口落地后删除。

注：`conversations.length === 0 && initialFetched` 是合法状态（员工真的没接待）。此时不应该挂 ChatArea，而是渲染一个"暂无会话"空态。复用现有的 `STRINGS.conversationList.noConversation` 文案。

#### 骨架组件 `MessagesSkeleton`

新建轻量组件，结构：

- 左侧 320px 列：5 行 `<div class="h-14 animate-pulse rounded-xl bg-workbench-surface-subtle">` 模拟会话行
- 右侧 flex-1：居中显示一段灰色"加载中…"字（避免过度装饰）
- 整体 `bg-[#F1F5F9]`（与 Workbench outer 同色，无背景跳变）

约 30 行 JSX，复用 tailwind utility，不引新组件库。

---

## 3. TitleBar tone 跳变：加 200ms color transition

### 现状

`App.tsx:105`：`titleBarBlue = loggedIn && splashHidden`。Splash 完全淡出（180ms fade 结束）瞬间 splashHidden flip 为 true，TitleBar 从 transparent 切到 blue 是 CSS 离散切换。

### 修法

`TitleBar.tsx` 的根容器 className 加 `transition-colors duration-200 ease-out`。无 JS 改动，只让 CSS color 切换走过渡。

不改 `titleBarBlue` 的触发时机（保留 splash fade 期间 transparent → 不与 splash 装饰产生色差堆叠的原设计意图）。

---

## 不在范围

- Sidebar 内的 collapse 动画、SectionLayer opacity 切换（既有 motion，未观察到闪问题）
- Login → Workbench 切换（首次登录路径稀少，下次报告再修）
- 切账号过程中的瞬间空列表（已说明：可接受）

---

## 测试矩阵

| 层                 | 测试                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useResource`      | `initialFetched` 在首次 queryFn 完成后变 true 并不再回退（mock queryFn + advance time）                                                                                    |
| `useRecentFriends` | 透传 `initialFetched`                                                                                                                                                      |
| `MessagesPage`     | `initialFetched=false` 时渲染 `MessagesSkeleton`；`initialFetched=true && conversations.length===0` 时渲染空态；`initialFetched=true && conversations.length>0` 时挂真组件 |
| `ConversationList` | 渲染 unread > 0 时 preview 前出现 `[未读]` 文字 + 14×14 红圈；draftText 存在时草稿胜出，无 `[未读]`                                                                        |
| 手工回归           | 启动 app → 不出现假联系人；切账号 → 已有数据态不闪骨架；TitleBar 从透明渐变到蓝色                                                                                          |

---

## YAGNI 检查

- **不**做 Skeleton 的 shimmer 动画（仅 `animate-pulse`），不引入 framer-motion 额外动画 prop。
- **不**做 ChatArea/CustomerDetails 内部 props 改 nullable —— 顶层守卫已经保证它们拿到的永远是有效数据。
- **不**给 `useResource` 加 `useInitialData` 等额外接口；只暴露最小的 `initialFetched`。
