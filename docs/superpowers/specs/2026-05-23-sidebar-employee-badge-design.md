# 左侧栏顶部员工区:重新设计布局 + 对接账号信息

- 日期:2026-05-23
- 范围:`frontends/components/workbench/Sidebar.tsx` 顶部员工区(UserBadge)
- 类型:UI 布局重设计 + 真实数据对接

## 1. 背景与目标

左侧栏顶部当前是一块**硬编码**的身份卡片(`Sidebar.tsx` 的 `UserBadge`):

- 姓名写死字符串 "匠多多";
- 头像写死字母 "M";
- 头像右下角写死绿色"在线"小点;
- 右下保留 `SyncStatusBadge`(图里的 "● 1m" = 1 分钟前刷新)。

目标:

1. **对接账号信息** —— 用真实的"登录员工本人"数据替换硬编码。
2. **重新设计布局** —— 在 144px 窄列里清晰呈现头像 + 姓名 + 角色 + 同步状态。

身份语义已确认为**登录员工本人**(`UserProfile`),不是企微客服账号,**不涉及账号切换**。

## 2. 非目标(明确排除)

- 不做账号切换器、不展示企业/租户名(`UserProfile` 只有 `tenant_id`,无企业名文本)。
- 不改导航项(`NAV_ITEMS`)、不改 `EdgeHandle`(收起/展开)、不改"更多"按钮。
- 不改 `Workbench.tsx` / `App.tsx`(数据通过组件内部 hook 自取,无 prop 钻取)。
- 不保留头像在线小点(经确认去除,见 §6 决策)。

## 3. 数据来源

| 字段           | 来源                       | 说明                                 |
| -------------- | -------------------------- | ------------------------------------ |
| `display_name` | `UserProfile.display_name` | 来自 `current_session`(Tauri invoke) |
| `avatar_url`   | `UserProfile.avatar_url`   | 可能为空字符串                       |
| `role`         | `UserProfile.role`         | 自由字符串,实测取值如 `"operator"`   |
| 同步状态       | `useHubSyncStatus()`       | `UserBadge` 已在使用,沿用            |

`UserProfile` 定义在 `frontends/App.tsx`:`{ user_id, display_name, avatar_url, role, tenant_id }`。

## 4. 组件与改动单元

### 4.1 新增 `useCurrentProfile()`(数据 hook)

- 新文件 `frontends/lib/data/useCurrentProfile.ts`,镜像现有 `useCurrentEmployeeId.ts` 的写法:
  - mount 时 `invoke<UserProfile | null>("current_session")` 取初态;
  - `listen("auth:logged_out")` 时清空为 `null`;
  - 不缓存(与现有 `useCurrentEmployeeId` 同philosophy:`current_session` 是极快的本地 SQLite 读)。
- 返回 `UserProfile | null`。
- 选择独立文件而非塞进 `useCurrentEmployeeId.ts`:遵循 `lib/data/` 现有"一个 hook 一个文件"约定。

### 4.2 `UserBadge`(布局 + 渲染)

`UserBadge` 内部新增 `const profile = useCurrentProfile();`(组件已自取 `useHubSyncStatus()`,再取一个 hook 与现有风格一致)。

**展开态(144px)布局 —— 横向卡片:**

```
┌────────────────┐
│ ┏━┓ 匠多多        │   ← 头像 40px 在左;右侧第一行 display_name(truncate)
│ ┗━┛ 客服坐席      │   ← 右侧第二行 role 副标题(role 空则不渲染此行)
│                  │
│ ● 1m 已连接       │   ← 整行 SyncStatusBadge(沿用现有组件/props)
└────────────────┘
```

**折叠态(64px):** 仅头像居中(同现状结构;不显示同步状态行 —— 已确认接受折叠态无连接状态指示)。

### 4.3 `AvatarMark`(头像 + 回退)

- 入参改为接收 `avatarUrl?: string` 与 `displayName?: string`。
- `avatar_url` 非空 → 渲染 `<img>`;`onError` 或为空 → 回退到 `display_name` 首字符(沿用现有字母块样式 `#FCE7B8` 底)。
- **移除**现有的绿色在线小点 `<span>`(见 §6 决策)。

### 4.4 role → 中文副标题映射

在 `Sidebar.tsx` 内一个小的纯函数/常量映射:

```
operator → "客服坐席"
admin    → "管理员"
其它      → 原样显示 role 字符串
空字符串  → 不渲染副标题行
```

映射表可随后端出现更多 role 取值时扩充。

## 5. 兜底与边界

- `profile === null`(尚未就绪 / 已登出):头像回退为占位首字符,姓名行显示空/占位,副标题不渲染。实际上 `Workbench` 仅在已登录时挂载,`profile` 几乎总有值;null 兜底用于防止首帧闪烁。
- `avatar_url` 加载失败:`<img onError>` 切回首字符,不留破图。
- `display_name` 为空:首字符回退用 "·" 之类占位,不抛错。

## 6. 关键决策记录

- **身份语义 = 登录员工本人**(非客服账号、无切换)。
- **展示字段** = 头像 + 姓名 + 角色副标题 + 同步状态行。
- **布局** = 横向卡片(头像左,文字右,同步行在下);折叠态仅头像。
- **去除头像在线小点**:在线小点与同步状态行都派生自 `connectionState`,语义重叠;经确认**只保留同步状态行**,去掉小点。代价:折叠态下无任何连接状态指示,已确认接受。

## 7. 测试(扩 `Sidebar.test.tsx`)

- 渲染真实 `display_name` / `role`(mock `useCurrentProfile`)。
- `avatar_url` 缺失 → 显示 `display_name` 首字符。
- role 映射:`operator`→"客服坐席"、`admin`→"管理员"、空 role → 不渲染副标题行。
- 折叠态:仅头像,不渲染姓名/副标题/同步行。
