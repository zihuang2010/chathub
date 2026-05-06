# MessageComposer 富内容改造设计

- **日期**：2026-05-06
- **状态**：待实施
- **影响范围**：消息页（messages）输入区与气泡渲染

## 1. 背景

当前 `MessageComposer` 的输入区是纯 `<textarea>`，图片/文件以独立 chip 显示在文本框上方，发送时打包为 `text + attachments[]`。气泡渲染端 `MessageContent` 也是「文本在上、附件卡片在下」的两段式布局。

业务侧反馈：

1. **数据形态不符合直觉**——客服希望像微信一样「文字+图片+文字」混排，例如「你好，[图片]，请确认」。
2. **样式与图标问题**——`FolderOpen`/`Scissors`/`MoreHorizontal` 选型语义不准、stroke 太细、风格不统一。
3. **功能单一**——AI 润色按钮的语气下拉打不开，发送按钮的下拉是装饰；缺少字数和快捷键提示。

## 2. 目标 / 非目标

### 目标

- 输入区支持文字与图片真·内联混排，可拖拽重排、悬浮删除、点击选中
- 气泡渲染端同步支持 `blocks[]`，与现有 `text + attachments[]` 的老消息共存
- 工具栏图标重新选型并统一描边/容器风格
- AI 润色升级为带语气选择 + 预览的 Popover
- 发送按钮下拉接通：立即/定时/静默/发送后跳下一条
- 实时字数与快捷键提示

### 非目标

- 不引入完整富文本能力（粗体/斜体/列表/标题/代码块等）
- 不在工具栏新增语音、红包、转账、商品卡等业务入口
- 不实现真实 AI 润色 / 定时发送后端，仅留接口与 mock
- 不动语音、视频、文件类型附件的渲染（仍走 attachments[] 通道）

## 3. 架构概览

```
                +--- TipTap Editor (paragraph + text + image + mention)
                |
MessageComposer-+--- ToolBar (icons revamped)
                |
                +--- ActionBar
                       +--- QuickReplies popover (existing)
                       +--- AiPolishPopover (NEW)
                       +--- CharCount + Shortcut hint (NEW)
                       +--- SendButtonGroup (split, with menu)

ChatArea.handleSend(text, blocks?, attachments?)
                ↓
Message { text, blocks?, attachments? }
                ↓
MessageBubble → MessageContent
                  ├─ blocks ? render inline runs
                  └─ else   ? legacy text + attachment cards
```

## 4. 数据模型

### 4.1 新增类型（`messages/data.ts`）

```ts
export type MessageBlock =
  | { type: "text"; value: string }
  | {
      type: "image";
      url: string;
      name?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
    };

export interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  text: string; // 兜底纯文本（自动派生自 blocks）
  blocks?: MessageBlock[]; // 新增；存在时优先渲染
  attachments?: MessageAttachment[]; // 仍承载 file / voice / video（image 移入 blocks）
  // 其余字段保持不变
}
```

### 4.2 兼容性

- `blocks` 可选；老 mock 与历史数据无需迁移
- 新发出的消息：图片 → blocks，文件/语音/视频 → attachments，二者并存
- `text` 字段始终存在：纯文本消息直接用，混排消息由 blocks 中所有 text 段拼接（段间 `\n`），保证 aria-label / 通知摘要 / 引用回复 / 复制等场景仍可读

## 5. 编辑器：TipTap 替换 textarea

### 5.1 依赖

新增到 `package.json` dependencies：

```
@tiptap/react              ^3
@tiptap/pm                 ^3
@tiptap/starter-kit        ^3
@tiptap/extension-image    ^3
@tiptap/extension-mention  ^3
@tiptap/extension-placeholder ^3
```

> 实施时锁定到当时的最新次版本号；上面 `^3` 仅为占位。

### 5.2 编辑器配置

- `StarterKit`：保留 Document/Paragraph/Text/History/HardBreak；关闭 heading、bulletList、orderedList、blockquote、codeBlock、horizontalRule（不需要）
- `Image`：作为 inline 节点（`inline: true, group: 'inline'`），通过自定义 NodeView 渲染
- `Mention`：用 Suggestion 接通现有 `MentionList`，trigger = `@`
- `Placeholder`：占位文本来自 `STRINGS.composer.placeholder`

### 5.3 自定义 ImageNodeView（`composer/ImageNodeView.tsx`）

- React 组件，包裹 `<NodeViewWrapper as="span">`
- 渲染 `<img>` + 选中态描边（依赖 `selected` prop）
- 悬浮（hover/focus）右上角显示 `×`，点击调 `editor.commands.deleteSelection()` 之前先把当前节点选中
- 拖拽：直接用 ProseMirror 内置的节点拖拽（`draggable: true`），无需自定义
- 双击预览不在本期实现，留 TODO

### 5.4 关键交互移植

| 现有逻辑                      | 新实现位置                         | 备注                                                                                                 |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Enter 发送 / Shift+Enter 换行 | `editorProps.handleKeyDown`        | 检测 isComposing 跳过                                                                                |
| 粘贴图片                      | `editorProps.handlePaste`          | 拦截 image/\* clipboard，调 `commands.insertContent({ type: 'image', attrs: { src: blobUrl, ... }})` |
| 截图（Tauri）                 | 工具栏按钮 onClick                 | 仍走 `invoke('take_screenshot')`，结果转 blob URL，通过 `commands.insertContent` 插入                |
| 文件选择器（image）           | 工具栏按钮 onClick                 | 选完 → 转 blobUrl → `commands.insertContent({ type: 'image', ... })`                                 |
| 文件选择器（file）            | 工具栏按钮 onClick                 | 仍走 attachments 通道（不进 editor）                                                                 |
| @ 提及                        | TipTap Mention extension           | 删除现有的手写 mentionState 逻辑                                                                     |
| Emoji                         | EmojiPicker 选择回调               | `editor.commands.insertContent(emoji)`                                                               |
| 草稿持久化                    | `useDraftStore` 改存 `JSONContent` | 见 §10                                                                                               |

### 5.5 序列化：doc ↔ blocks（`composer/docToBlocks.ts`）

```ts
export function docToBlocks(doc: JSONContent): MessageBlock[] {
  // 遍历顶层 paragraph 节点，段落间用 "\n" 连接
  // 每个 paragraph 内：
  //   text node       → 累积进当前 text block
  //   hardBreak       → 当前 text block += "\n"
  //   image node      → flush 当前 text block，push image block，开新 text block
  //   mention node    → 当前 text block += "@" + label + " "
  // 末尾合并相邻 text block；丢弃空 text block
}

export function blocksToDoc(blocks: MessageBlock[]): JSONContent {
  // 反向操作：text 段按 \n 拆段，image 块嵌入对应位置
  // 用于草稿恢复
}
```

`docToBlocks` 必须是纯函数，独立可测（见 §11）。

## 6. 气泡渲染：`MessageContent`

```tsx
function MessageContent({ blocks, text, attachments }: Props) {
  if (blocks?.length) {
    return (
      <>
        {blocks.map((b, i) =>
          b.type === "text" ? (
            <TextRun key={i} value={b.value} /> // 复用 formatRichText
          ) : (
            <InlineImage key={i} block={b} />
          ),
        )}
        {attachments?.length ? <AttachmentList items={attachments} /> : null}
      </>
    );
  }
  // legacy 路径保持不变
}
```

### 6.1 图片渲染规则

**判定「图片独占消息」的明确规则**：`blocks` 长度 = 1，且唯一一项为 image。命中此规则时直接走旧 `ImageAttachment` 大卡样式（`max-h-72`、可点开新窗口），与历史消息观感一致。

**否则一律内联（InlineImage）**：

- `display: inline-block; vertical-align: middle`
- `max-h: 200px; max-w: 260px; rounded-lg; border-workbench-line`
- 与文字间 `mx-1`
- 多图相邻时由浏览器自然换行，不做特殊排版

### 6.2 AttachmentList

- 仅渲染 file / voice / video（image 不再走这里）
- 复用现有 `FileAttachment / VoiceAttachment / VideoAttachment`

## 7. 工具栏图标重选

| 用途 | 现               | 改为        | 说明                              |
| ---- | ---------------- | ----------- | --------------------------------- |
| 表情 | `Smile`          | `Smile`     | 保留                              |
| 截图 | `Scissors`       | `Camera`    | lucide 风格更圆润；与企业微信一致 |
| 图片 | `Image`          | `ImagePlus` | 强调「添加」                      |
| 文件 | `FolderOpen`     | `Paperclip` | 语义正确                          |
| 更多 | `MoreHorizontal` | 删除        | 不加新入口                        |

### 7.1 风格统一

- 全部 `size={18}`、`strokeWidth={1.6}`
- 容器 `h-9 w-9 rounded-lg`，hover 背景 `bg-workbench-surface-subtle`，hover 文字 `text-workbench-text`（不再变 accent）
- 焦点 `focus-ring` 保留
- Emoji / Image 这两个有 popover 的，hover 时右下角显示 `2×2` 微小指示点（CSS 实现，不用 chevron 图标）
- 右栏切换按钮（`PanelRightOpen` / `PanelRightClose`）保持现状

## 8. 发送面板

### 8.1 排版（自左至右）

```
[ 快捷语 ]  [ ✨ AI 润色 ▾ ]  [ 字数 · 快捷键 ]……右对齐……  [ 发送 | ▾ ]
```

### 8.2 AI 润色 Popover（`composer/AiPolishPopover.tsx`）

- 单按钮 + 下拉
- Popover 内：语气 radio（正式 / 亲切 / 幽默 / 简洁）+ 原文预览（灰）+ 润色预览（高亮，可滚动）+ 取消 / 替换草稿
- 替换草稿：`editor.commands.setContent(blocksToDoc(newBlocks))`，保留已插入图片
- 润色实现：mock 函数 `polish(text, tone) → string`，先返回 `[${tone}] ${text}`，留接口给后端

### 8.3 字数 + 快捷键提示

- 字数 = `Array.from(textJoined).length`，textJoined 即所有 text block 拼接后字符串
- 上限 `COMPOSER_MAX_CHARS = 5000`：≥4500 字号变橙；≥5000 变红 + 禁用发送
- 文案：`<count> 字 · Enter 发送 / Shift+Enter 换行`
- `< sm` 屏隐藏快捷键文案

### 8.4 发送按钮组（`composer/SendButtonGroup.tsx`）

- 保留分裂按钮视觉
- 左半：执行当前默认动作（立即发送或静默发送，取决于偏好）
- 右半 ▾：菜单
  - 立即发送（默认）
  - 定时发送…（mock：toast，留 `onScheduleSend?: (date: Date) => void`）
  - 静默发送（toggle，持久化）
  - 发送后跳到下一条（toggle，持久化）
- 主按钮文案：默认「发送」；静默偏好开启时「静默发送」

### 8.5 偏好持久化（`messages/useComposerPrefs.ts`）

- 字段：`{ silent: boolean; jumpToNext: boolean }`
- localStorage key：`workbench.composer.prefs.v1`
- 读写都用 hook，跨会话生效

## 9. 草稿存储升级（`useDraftStore.ts`）

- 旧：`Map<conversationId, string>`
- 新：`Map<conversationId, JSONContent>`（TipTap 文档）
- 序列化：JSON.stringify；体积大时（>500KB）截断并 warn
- `clearDraft(id)` 行为不变
- 迁移：旧 string 草稿读到时直接转成 `{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: <string> }] }] }`

## 10. ChatArea 发送链路

```ts
const handleSend = (
  text: string,
  blocks?: MessageBlock[],
  attachments?: MessageAttachment[],
) => {
  const id = `local-${Date.now()}-${rand}`;
  const newMessage: Message = {
    id,
    conversationId: conversation.id,
    direction: "out",
    text,
    blocks: blocks?.length ? blocks : undefined,
    attachments: attachments?.length ? attachments : undefined,
    sentAt: new Date().toISOString(),
    status: "sending",
  };
  setLocalMessages(c => [...c, newMessage]);
  ...
};
```

`MessageComposer.onSend` 的签名同步：`onSend(text: string, blocks?: MessageBlock[], attachments?: MessageAttachment[])`。

## 11. 测试与验证

### 11.1 单元测试

- `docToBlocks` / `blocksToDoc`：纯文 / 纯图 / 文-图-文 / 连续图片 / hardBreak / mention / 空段
- `useComposerPrefs`：默认值 / 写入 / 跨实例读取 / localStorage 异常容错

### 11.2 手动验证（含 Tauri）

1. 输入「你好，」+ 选择图片 + 输入「请确认」 → 内联混排发送 → 气泡按相同顺序渲染
2. 粘贴剪贴板图片 → 出现在 caret 位置
3. macOS Tauri 内调用截图 → 内联插入
4. 拖拽图片调整顺序 → blocks[] 顺序对应变化
5. @ 提及 → 候选列表正常，提交后是 mention 节点
6. 中文输入法 Enter 不误发
7. 字数变色与禁用阈值
8. AI 润色 popover：选语气 → 预览刷新 → 替换草稿（图片保留）
9. 发送菜单：静默偏好持久化跨刷新
10. 5000 字上限触发禁用

### 11.3 自动化检查

- `pnpm run lint` 0 报错
- `npx tsc --noEmit` 0 报错
- 无控制台警告

## 12. 文件清单

### 改动

- `frontends/components/workbench/messages/data.ts`
- `frontends/components/workbench/messages/MessageComposer.tsx`（大改）
- `frontends/components/workbench/messages/MessageContent.tsx`
- `frontends/components/workbench/messages/MessageBubble.tsx`
- `frontends/components/workbench/messages/ChatArea.tsx`
- `frontends/components/workbench/messages/useDraftStore.ts`
- `frontends/components/workbench/messages/strings.ts`
- `frontends/components/workbench/messages/constants.ts`
- `package.json` / `pnpm-lock.yaml`

### 新增

- `frontends/components/workbench/messages/composer/RichComposer.tsx`
- `frontends/components/workbench/messages/composer/ImageNodeView.tsx`
- `frontends/components/workbench/messages/composer/MentionExtension.ts`
- `frontends/components/workbench/messages/composer/AiPolishPopover.tsx`
- `frontends/components/workbench/messages/composer/SendButtonGroup.tsx`
- `frontends/components/workbench/messages/composer/docToBlocks.ts`
- `frontends/components/workbench/messages/useComposerPrefs.ts`

## 13. 风险与回滚

- **包体增加 ~80–100KB gzipped**：可接受，TipTap + ProseMirror 是行业标杆
- **TipTap 学习曲线**：通过把编辑器逻辑全部封装到 `composer/RichComposer` 收口
- **回滚策略**：data 模型向后兼容，气泡降级路径存在；如发现严重问题可保留新增文件、仅回退 `MessageComposer.tsx` 到旧版本
