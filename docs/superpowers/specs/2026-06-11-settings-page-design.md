# 设置页面设计（Settings Page）

日期：2026-06-11
状态：已与用户逐段确认

## 1. 背景与目标

设置入口已存在（`frontends/components/workbench/nav.ts` 定义了 settings section，侧边栏有图标），但 `Workbench.tsx` 没有对应页面，当前走 `PlaceholderPage` 占位。项目中存在大量写死的配置与隐式开关，前端偏好是分散的 localStorage 手写读写（无统一框架、不分账号），后端零配置文件（编译期常量 + 环境变量）。

目标：

- 实现真实的设置页面，覆盖四个分组：通知、消息行为、应用与存储、高级
- 建立统一的设置存储机制（方案 A：后端 SQLite 单一事实源）
- 设置**跟随登录账号**：切换登录账号后各用各的设置

## 2. 已确认的关键决策

| 决策点        | 结论                                                          |
| ------------- | ------------------------------------------------------------- |
| 第一版范围    | 通知、消息行为、应用与存储、高级 四类全做                     |
| 设置归属      | 跟随登录账号（按账号键存储）                                  |
| 存储架构      | 方案 A：后端 SQLite `hub_settings` 表统一存储，前端镜像 store |
| composer 偏好 | 迁移进统一存储，顺带修掉"不分账号串台"问题                    |

## 3. 设置项清单

设置页按四个分组呈现，前三组平铺，高级组默认折叠。

### ① 通知

| 设置项                | key                   | 默认值 | 实现说明                                                                       |
| --------------------- | --------------------- | ------ | ------------------------------------------------------------------------------ |
| 新消息托盘红点/闪烁   | `notify.trayFlash`    | true   | 纯前端：`useNewMessageFlash` 判断开关，关闭则不调 `set_tray_unread`            |
| 任务栏闪烁（Windows） | `notify.taskbarFlash` | true   | 同上；macOS 隐藏此项                                                           |
| 新消息声音提醒        | `notify.sound`        | true   | 新功能：提示音打包进 `public/`，未读增加且窗口未聚焦时播放，复用单个 `<audio>` |

### ② 消息行为

| 设置项               | key                   | 默认值 | 实现说明                                                                    |
| -------------------- | --------------------- | ------ | --------------------------------------------------------------------------- |
| 发送后跳到下一个会话 | `composer.jumpToNext` | false  | 迁移自 `useComposerPrefs`，输入框原开关保留、与设置页双向同步（同一 store） |
| 静音发送             | `composer.silent`     | false  | 同上                                                                        |

### ③ 应用与存储

| 设置项       | key                       | 默认值   | 实现说明                                                                          |
| ------------ | ------------------------- | -------- | --------------------------------------------------------------------------------- |
| 点关闭按钮时 | `app.closeAction`         | `"tray"` | 枚举 `"tray"`（最小化到托盘）/ `"quit"`（退出）；后端 on-close 处理读取           |
| 图片缓存上限 | `storage.imageCacheMaxMb` | 500      | 档位：200 / 500 / 1024 / 2048 MB；另有占用展示 + 一键清理按钮（非设置项，是动作） |

### ④ 高级（默认折叠）

| 设置项       | key                      | 默认值                        | 实现说明                                                                                                      |
| ------------ | ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| AI 润色启用  | `ai.enabled`             | true                          | 开关；实际是否可用 = `ai.enabled` 且有效 Key 非空（设置 Key 优先，否则编译期 Key），与现状"无 Key 即禁用"兼容 |
| AI API Key   | `ai.apiKey`              | 空（回落编译期注入值）        | UI 脱敏显示（仅首尾）                                                                                         |
| AI 模型名    | `ai.model`               | 空（回落编译期 `qwen-flash`） | 文本输入                                                                                                      |
| AI 端点      | `ai.baseUrl`             | 空（回落编译期值）            | 文本输入                                                                                                      |
| 连接静默超时 | `net.silenceTimeoutSecs` | 45                            | 范围限 30–120，UI 标注"重连后生效"                                                                            |
| 日志级别     | `log.level`              | `"default"`                   | 枚举：`"quiet"`（warn）/ `"default"`（info + chathub debug）/ `"verbose"`（trace）；运行时热切换              |
| 打开日志目录 | —（动作）                | —                             | 按钮，调 `open_log_dir`                                                                                       |

### 有意不做（简单优先）

- 托盘闪烁周期数值调节（开关就够）
- 重连退避 base / factor / cap（仅暴露静默超时一项）
- 消息/会话保留条数（虚拟化内存模型刚改完，不碰）
- 主题/字号/语言（暗色主题未实现，不在本期）
- 虚拟列表参数、AIMD 发送节流参数、服务端约束项（性能内参/算法自适应/无权修改）
- `chathub:send-min-interval-ms` 保留为 console 调试后门，不进设置页

## 4. 后端设计

### 4.1 数据模型

`chathub-state` 新增迁移 V33。注意：`hub_settings` 表名已被 NotifySeqStore（notify_seq 水位）占用，故用 `hub_user_settings`；账号键沿用项目惯例 `employee_id`（= profile.user_id）：

```sql
CREATE TABLE hub_user_settings (
  employee_id   TEXT NOT NULL,   -- 登录账号标识，与现有按账号组织的表保持同一键
  key           TEXT NOT NULL,   -- 设置项名，如 'notify.trayFlash'
  value         TEXT NOT NULL,   -- JSON 值
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (employee_id, key)
);
```

逐 key 存而非大 JSON blob：部分更新无需读-改-写整包，加项/废项不用迁移数据。库中只存与默认值不同的项也可（实现可选），读取时统一回填默认值。

### 4.2 Tauri commands（5 个）

| 命令                     | 行为                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `get_settings`           | 读当前登录账号全部设置，缺省项回填默认值，返回完整 DTO；未登录返回纯默认值                                              |
| `update_settings(patch)` | 部分更新：写库 → 刷新后端内存设置快照 → 应用即时生效项（日志级别）→ 广播 `settings:changed` 事件 → 返回合并后的完整 DTO |
| `get_image_cache_usage`  | 返回 `img-cache/` 目录占用字节数                                                                                        |
| `clear_image_cache`      | 清空缓存目录，返回释放的字节数                                                                                          |
| `open_log_dir`           | 在系统文件管理器中打开日志目录                                                                                          |

### 4.3 读取点改造（4 处）

1. **关闭按钮行为**：on-close 处理读内存缓存的设置快照（`update_settings` 与登录/切账号时刷新），决定 hide 还是 quit；不在关闭路径查库
2. **连接静默超时**：hub 连接建立时读设置覆盖 `BackoffConfig.silence_timeout`（`backends/crates/chathub-net/src/hub.rs`），下次重连生效，不做热更
3. **日志级别**：`tracing_subscriber` 加 reload layer，`update_settings` 时热切换 EnvFilter；`CHATHUB_LOG` 环境变量优先级更高（排障后门保留）
4. **AI 润色**：`ai_polish` 读设置优先，设置为空回落编译期注入值；API Key 明文存本地 SQLite（与登录 token 同等待遇），仅 UI 层脱敏

通知类不动后端：托盘/任务栏闪烁本来就是前端驱动（`useNewMessageFlash` → `set_tray_unread`），前端不调用即等于关闭。

## 5. 前端设计

- **入口**：`Workbench.tsx` 将 settings section 从 `PlaceholderPage` 换成 `SettingsPage`，沿用现有 `SectionLayer` 模式
- **布局**：单页分组卡片（通知 / 消息行为 / 应用与存储 / 高级折叠区），复用 workbench 现有样式 token，不引入新 UI 库
- **状态**：新建 `useSettingsStore`（zustand）——登录完成后 `get_settings` 回填；改动时乐观更新 + `invoke('update_settings')`，失败回滚并 toast；监听 `settings:changed` 同步多窗口
- **切账号**：账号切换完成后重新 `get_settings`，store 整体替换
- **`useComposerPrefs` 迁移**：内部改读写 `useSettingsStore`，保留原 hook API，composer 零改动；旧 localStorage 键一次性迁移（首次登录时库里无值且 localStorage 有值则写库）
- **声音提醒**：在 `useNewMessageFlash` 同一触发点判断"开关开 + 窗口未聚焦"后播放

## 6. 生效方式

| 类型     | 项                                                            | 生效时机          |
| -------- | ------------------------------------------------------------- | ----------------- |
| 立即生效 | 通知开关、消息行为、关闭按钮行为、日志级别、AI 配置、缓存上限 | 改完即生效        |
| 重连生效 | 连接静默超时                                                  | 下次重连，UI 标注 |

## 7. 边界情况

- **未登录**：全部用默认值；登录后拉取覆盖
- **图片缓存目录整机共享**：上限按账号存，生效时取当前登录账号的值（已知妥协，UI 不提示）
- **`CHATHUB_LOG` 环境变量**：仍优先于设置项，作为排障后门
- **AI 设置留空**：回落编译期注入默认值，行为与现状完全一致

## 8. 测试策略（TDD）

- `chathub-state` 单测：settings CRUD、默认值回填、按账号隔离、迁移
- 前端 store 测试：登录回填、乐观更新失败回滚、切账号整体替换、composerPrefs 旧键迁移
- 设置页组件测试：渲染、开关交互、平台条件项（macOS 隐藏任务栏闪烁）、高级区折叠
