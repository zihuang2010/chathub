# 侧边栏 hover 折叠把手设计

- **日期**：2026-05-08
- **状态**：待实施
- **影响范围**：工作台左侧导航栏（`Sidebar.tsx`）

## 1. 背景

当前侧边栏的折叠/展开入口是顶部用户行里的一个 `<` / `>` 小按钮（`UserBadge` 内）。问题：

- 入口位置不显眼，不靠近边线，发现性差。
- 与「点击这里能改变侧栏宽度」的心智模型不一致——通常用户会去边线附近找。

期望参考钉钉：鼠标靠近侧栏右边缘时，边线上出现一颗药丸状把手，点击即折叠/展开；鼠标离开边缘时把手淡出。

## 2. 目标 / 非目标

### 目标

- 移除顶部用户行里的折叠按钮。
- 在侧栏右边线上提供 hover 触发的药丸把手，视觉骑跨边线（一半内、一半外）。
- 鼠标只有靠近右边缘时才显示把手，平时干净无干扰。
- 折叠/展开的状态、动画、宽度切换保持现有行为。

### 非目标

- 不实现拖拽改宽（仍是 `w-36` ↔ `w-16` 两态切换）。
- 不调整 `Workbench` 状态管理，仍由 `sidebarCollapsed` + `onToggleCollapsed` 控制。
- 不调整侧栏视觉风格（frosted glass、圆角、配色都保持原样）。

## 3. 架构

只改一个文件：`frontends/components/workbench/Sidebar.tsx`。

```
<aside>  (overflow-visible, z-10)
  ├── <div class="relative z-10 flex h-full flex-col overflow-hidden rounded-bl-[10px]">
  │     ├── UserBadge          (avatar + name only, no chevron)
  │     ├── nav                 (NAV_ITEMS, 不变)
  │     └── 更多 button         (不变)
  └── EdgeHandle                (新增：peer hover zone + 药丸按钮)
```

要点：

- `aside` 从 `overflow-hidden` 改为 `overflow-visible`，让药丸能外探。
- 内部内容容器加 `overflow-hidden rounded-bl-[10px]`，宽度过渡时内容仍然不溢出。
- `aside` 加 `z-10`，确保外探的药丸覆盖在右侧 `MessagesPage` 之上。

## 4. 组件改造

### 4.1 UserBadge（修改）

- 移除 `ChevronLeft` / `ChevronRight` 按钮以及整段 toggle 行为。
- 移除 `onToggleCollapsed` prop（UserBadge 不再需要）。
- 折叠态：垂直显示头像（去掉原来的展开按钮）。
- 展开态：横向显示头像 + 「匠多多」文字（去掉原来的收起按钮）。

### 4.2 EdgeHandle（新增）

新增子组件，作为 `aside` 的最后一个子节点（与内容容器同级）。

接收 props：

- `collapsed: boolean`
- `onToggle: () => void`

结构（伪代码）：

```jsx
<>
  {/* peer：透明 hover 触发区，水平骑跨边线 */}
  <div aria-hidden className="peer absolute bottom-0 right-0 top-0 w-3.5 translate-x-1/2" />

  {/* 药丸按钮 */}
  <button
    type="button"
    onClick={onToggle}
    aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
    aria-expanded={!collapsed}
    className={cn(
      "absolute right-0 top-1/2 z-20",
      "-translate-y-1/2 translate-x-1/2",
      "grid h-10 w-4 place-items-center",
      "rounded-full border border-[rgba(15,23,42,0.06)] bg-white",
      "shadow-[0_1px_2px_rgba(15,23,42,0.06)]",
      "text-[#4B6284] hover:text-[#1F2937]",
      "opacity-0 transition-opacity duration-150 ease-out",
      "hover:opacity-100 peer-hover:opacity-100",
      "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]/35",
    )}
  >
    {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
  </button>
</>
```

## 5. 视觉规格

| 项目          | 值                                                                   |
| ------------- | -------------------------------------------------------------------- |
| 药丸尺寸      | 16w × 40h（`w-4 h-10`）                                              |
| 圆角          | full（`rounded-full`）                                               |
| 背景          | 白                                                                   |
| 描边          | 1px `rgba(15,23,42,0.06)`                                            |
| 阴影          | `0 1px 2px rgba(15,23,42,0.06)`                                      |
| 图标          | 展开态 `ChevronLeft`，收起态 `ChevronRight`，size 12                 |
| 图标色        | 默认 `#4B6284`，hover `#1F2937`                                      |
| 触发区        | `top-0 bottom-0 w-3.5`，`translate-x-1/2`（跨边线、左右各 7px 感应） |
| 出现/消失动效 | opacity 0 ↔ 1，150ms ease-out（同一 transition 双向）                |
| 位置（垂直）  | 50%（绝对垂直居中）                                                  |
| 位置（水平）  | `right-0 translate-x-1/2`（边线为水平中线）                          |

## 6. 交互逻辑

- 鼠标进入「触发区」或「药丸自身」任一区域 → 药丸 opacity 升至 1。
- 离开两者 → 透明度回到 0，淡出。
- 通过 Tailwind 的 `peer` + `peer-hover` + 药丸自身的 `hover` 实现，不引入额外 React state。
- 点击药丸：调用 `onToggle()`，即原 `onToggleCollapsed`，状态翻转，宽度按现有过渡切换。
- 键盘可达：药丸是真按钮，可 Tab 聚焦；`focus-visible` 强制显示并显示蓝色 focus ring。

## 7. overflow / 层级处理

- `aside` 当前 `overflow-hidden rounded-bl-[10px] transition-[width] duration-200 ease-out` → 改为 `overflow-visible rounded-bl-[10px] transition-[width] duration-200 ease-out z-10`。
- 内部 `<div className="relative z-10 flex h-full flex-col">` → 加 `overflow-hidden rounded-bl-[10px]`，原有内容裁切语义保留。
- 圆角同时放在 aside 与内部 div：aside 的 rounded 服务于 backdrop-filter 的圆角裁切（注释里已说明 backdrop-filter 自带 stacking context），内部 div 的 rounded 服务于 overflow-hidden 时内容裁切对齐。
- 药丸 `z-20`，确保即便外探到 `MessagesPage` 之上也置于其上。

## 8. 可访问性

- `aria-label`：折叠态 "展开侧边栏"，展开态 "收起侧边栏"（与现有字串一致）。
- `aria-expanded`：折叠态 `false`，展开态 `true`。
- `focus-visible` 时强制显示药丸且显示 focus ring，避免键盘用户无法发现入口。
- 触发区是纯装饰，加 `aria-hidden`。

## 9. 测试

- 现有 vitest 工程下追加一组 `Sidebar.test.tsx` 用例（如目前没有该测试文件，则新建）：
  - 渲染折叠态 → `aria-label="展开侧边栏"` 的按钮存在，`aria-expanded="false"`。
  - 渲染展开态 → `aria-label="收起侧边栏"` 的按钮存在，`aria-expanded="true"`。
  - 点击该按钮 → `onToggleCollapsed` 被调用一次。
- 不对 hover 透明度做 RTL 测试（CSS 行为，不在 jsdom 可靠覆盖范围内）；以人工验证为准。

## 10. 风险与回退

- **风险 1：药丸覆盖到 `MessagesPage` 左边缘** —— 8px 的外探可能轻微挡住消息列表最左侧像素。视觉上是预期行为（药丸应该可见地骑跨边线）；功能上不影响点击（药丸 z-20 在最上层，`MessagesPage` 命中区域不变）。
- **风险 2：`overflow-visible` 后内容溢出** —— 通过把 `overflow-hidden` 下移到内部容器来兜底；如果发现仍有 frosted-glass 圆角异常，回退方案是再加一层 wrapper 维持双层裁切。
- **回退**：单文件改动，git revert 即可恢复。
