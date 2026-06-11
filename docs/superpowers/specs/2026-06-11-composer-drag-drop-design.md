# 聊天区拖拽文件发送 · 设计文档

日期：2026-06-11
状态：已与用户确认（落点范围 / 类型路由 / 语音语义 / 遮罩统一 / 方案 A 均已拍板）

## 1. 需求

- 聊天界面支持从系统文件管理器拖拽文件进来发送，Windows 与 macOS 行为一致。
- 按文件类型自动判定处理方式，与现有「图片 / 文件 / 语音」按钮和粘贴行为完全一致。
- 拖入时显示统一的「松开发送」遮罩，输入区与消息列表区是同一套视觉，不各画各的。

### 已确认的产品决策

| 决策点                           | 结论                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| 落点范围                         | 整个聊天区域（消息列表 + 输入区），拖入即整片显示遮罩             |
| 图片（jpg/jpeg/png/gif/webp）    | 内联插入输入框编辑器（同图片按钮 / 粘贴）                         |
| 文档（DOC_EXTS 白名单）          | 进待发送托盘，按扩展名自动分类（同文件按钮）                      |
| 语音（amr/mp3/wav）              | 复用语音按钮语义：输入框/托盘为空直接进独占态；有内容弹现有确认框 |
| 混合拖入夹语音                   | 语音忽略 + toast「语音需单独发送」                                |
| 不支持的类型（exe/dmg/文件夹等） | 忽略 + toast「不支持的文件类型」                                  |
| 无打开会话（空态页）             | 拖拽不响应                                                        |
| 超 200MiB                        | 复用现有 `keepBySize` 拦截与 toast                                |
| 离线状态                         | 不拦截拖入（与按钮行为对齐，发送时再拦）                          |

## 2. 方案选型

**采用方案 A**：保持 `dragDropEnabled` 默认开启，Tauri 下走 `getCurrentWebview().onDragDropEvent`（拿文件路径），经现有 `read_local_file` 命令读回字节组装 `File`，复用现有三条落地管线。Web 预览（非 Tauri）用 HTML5 `drop` 兜底。

否决方案 B（`dragDropEnabled: false` + 纯 HTML5 drop）：改全局窗口配置影响面超出本需求，且 Windows WebView2 在该配置下有历史兼容问题，不符合最小改动原则。

平台一致性依据：Tauri v2 默认拦截 OS 拖拽并统一抽象为 `onDragDropEvent`（Windows WebView2 / macOS WKWebView 一致），HTML5 drop 在 Tauri 内拿不到文件，故路径事件是唯一可靠通道；`read_local_file` 路径→File 的桥已被原生选文件框（`pickNativeFiles`）验证。

## 3. 架构与数据流

### 新增 / 改动文件

| 文件                                                          | 改动                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `frontends/components/workbench/messages/useFileDragDrop.ts`  | 新增 hook：事件订阅、坐标换算、dragActive 状态、drop 落地           |
| `frontends/components/workbench/messages/ChatArea.tsx`        | 根容器挂 ref + 遮罩 JSX + 使用 hook                                 |
| `frontends/components/workbench/messages/MessageComposer.tsx` | `useImperativeHandle` 暴露 `acceptDroppedFiles(files: File[])` 句柄 |
| 文案常量（strings）                                           | 新增「不支持的文件类型」「语音需单独发送」「读取文件失败」          |

后端零改动；`tauri.conf.json` 零改动；capabilities 零改动（`core:default` 已含事件监听权限）。

### 事件源（双路径，与现有 picker 双路径风格一致）

**Tauri 路径**（`isTauri()` 为真）：

1. ChatArea 挂载时订阅 `getCurrentWebview().onDragDropEvent`，卸载时退订。
2. `enter`/`over`：事件坐标为物理像素，除以 `window.devicePixelRatio` 换算为逻辑像素，与 ChatArea 根容器 `getBoundingClientRect()` 求交；界内 `dragActive=true`，界外或 `leave` 复位。
3. `drop`：先用同一套坐标换算判定落点在聊天区矩形内（界外松手直接忽略并复位遮罩），再把路径数组逐个 `invoke("read_local_file")` → `File`（MIME 查现有 `MIME_BY_EXT` 表，文件名取路径最后一段）；单条失败（文件夹、无权限）跳过，全部失败 toast「读取文件失败」。
4. 组装好的 `File[]` 交给分流器。

**Web 兜底路径**（非 Tauri）：ChatArea 根容器 `onDragOver/onDragLeave/onDrop`，`DataTransfer.files` 直接进分流器。Tauri 环境下不挂这套，避免双触发。

### 分流器（纯函数）

输入 `File[]`，按扩展名（`extOf`，大小写不敏感）一次扫描分四组：

1. **图片组** → `acceptImageFiles`（内联进编辑器；含 200MiB 拦截与格式 toast）
2. **文档组**（DOC_EXTS） → `acceptDocFiles`（进托盘，`attachmentTypeFromExt` 自动分类；含大小拦截）
3. **语音组**（amr/mp3/wav） → 仅当本次拖入**只有语音文件**时生效：取第一个，复用语音按钮语义（空→`acceptVoiceFiles` 直接进独占态；非空→弹现有 `voiceConfirmOpen` 确认框，确认后落地）。混合拖入时语音组整体忽略 + toast。
4. **其余** → toast「不支持的文件类型」（多个非法文件只 toast 一次）。

分流器只做分类与调度，落地动作全部复用 MessageComposer 既有回调，经 imperative handle 调用——避免把托盘/编辑器 state 提升到父层。

## 4. 遮罩 UI（统一一套）

- 挂在 ChatArea 根容器内：`absolute inset-0`、高 z-index，覆盖消息列表 + 输入区整片。
- 视觉：半透明 `bg-workbench-surface/80` + backdrop-blur；中央虚线圆角框 + 图标 + 主文案「松开发送文件」+ 副文案「图片将插入输入框，文档将作为附件」；颜色与圆角使用项目现有 workbench token，与聊天区卡片一致。
- `pointer-events-none`：Tauri 事件来自原生层不依赖 DOM 命中；web 路径靠容器自身 dragover 维持。
- 150ms 淡入淡出，尊重 `prefers-reduced-motion`。

## 5. 错误处理

| 场景                       | 行为                                |
| -------------------------- | ----------------------------------- |
| `read_local_file` 单条失败 | 跳过该条，其余继续                  |
| 全部读取失败               | toast「读取文件失败」               |
| 超 200MiB / 格式非法       | 复用现有 `fileTooLarge` 等 toast    |
| 拖拽中切会话 / 组件卸载    | hook cleanup 退订 + 复位 dragActive |
| 空态页（无会话）           | 不订阅 / 不响应                     |

## 6. 测试

Vitest（仓库根目录 `pnpm vitest`）：

- 分流器纯函数：四组分类、混合场景、混合夹语音忽略、纯语音取首个、空数组。
- web drop 路径：模拟 DataTransfer drop → 断言各 accept 回调正确调用。
- 坐标换算函数（物理→逻辑→rect 求交）单测，覆盖 devicePixelRatio ≠ 1。
- `onDragDropEvent` 订阅 / 退订生命周期（mock）。

真机验证项（无法自动化）：Windows + macOS 实拖；重点 Windows 高 DPI（125%/150% 缩放）下遮罩触发区域准确性；拖入文件夹、超大文件、混合多选。
