# 聊天区拖拽文件发送 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天区（消息列表 + 输入区）支持从系统文件管理器拖拽文件发送，按扩展名分流（图片内联 / 文档进托盘 / 语音独占语义），Windows/macOS 一致，设置页可关。

**Architecture:** Tauri 下 `getCurrentWebview().onDragDropEvent`（拿路径）→ 现有 `read_local_file` 命令（路径→File）→ 分流进 MessageComposer 既有三条落地管线（经 dropHandleRef 句柄）；web 预览 HTML5 drop 兜底。统一遮罩挂 ChatArea 根容器。开关存 `hub_user_settings`（`composer.dragDrop`，默认开）。

**Tech Stack:** React 19 + TipTap + Zustand + Tauri v2（前端）；Rust serde 设置 DTO（后端仅加一字段）。Vitest 单测，`pnpm vitest` 在**仓库根目录**跑；`cargo test` 在 `backends/` 跑。

**Spec:** `docs/superpowers/specs/2026-06-11-composer-drag-drop-design.md`

**全局约定：**

- 每个 Task 改动符号前按 CLAUDE.md 跑 `gitnexus_impact({target, direction: "upstream"})`，HIGH/CRITICAL 先停下报告。
- 提交一律**显式列文件**，禁止 `git add -A`（工作区有大量他人未提交改动）。
- 提交信息中文。lint-staged 钩子会自动 prettier，重新格式化属正常。

---

### Task 1: 后端 `ComposerSettings` 加 `drag_drop` 字段（默认 true）

**Files:**

- Modify: `backends/src/settings.rs:39-46`（结构体）+ `backends/src/settings.rs:476` 起的 `mod tests`（加测试）

- [ ] **Step 1: 写失败测试**

在 `backends/src/settings.rs` 文件末尾的 `mod tests` 内追加：

```rust
#[test]
fn drag_drop_default_true_and_kv_roundtrip() {
    // 默认开
    let s = UserSettings::default();
    assert!(s.composer.drag_drop);
    // KV 往返不丢
    let entries = to_entries(&s);
    let restored = from_entries(&entries);
    assert!(restored.composer.drag_drop);
    // 老账号(存量 KV 没有 composer.dragDrop 键) → 默认 true
    let legacy = from_entries(&[("composer.silent".to_string(), "true".to_string())]);
    assert!(legacy.composer.drag_drop);
    assert!(legacy.composer.silent);
    // patch 可以关掉
    let patched = merge_patch(&s, &serde_json::json!({"composer": {"dragDrop": false}})).unwrap();
    assert!(!patched.composer.drag_drop);
}
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub/backends && cargo test -p chathub drag_drop_default`
Expected: 编译错误 `no field 'drag_drop' on type ComposerSettings`

- [ ] **Step 3: 最小实现**

把 `backends/src/settings.rs:39-46` 的 `ComposerSettings` 改为（注意 derive 列表去掉 `Default`，改手写——`drag_drop` 默认 true 没法用 derive；仿照同文件 `NotifySettings` 的写法）：

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ComposerSettings {
    /// 静音发送(迁移自 useComposerPrefs)。
    pub silent: bool,
    /// 发送后跳到下一个会话(迁移自 useComposerPrefs)。
    pub jump_to_next: bool,
    /// 聊天区拖拽文件发送(设置页「消息行为」可关)。
    pub drag_drop: bool,
}

impl Default for ComposerSettings {
    fn default() -> Self {
        Self {
            silent: false,
            jump_to_next: false,
            drag_drop: true,
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量设置测试不回归**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub/backends && cargo test -p chathub settings`
Expected: 全部 PASS（含新测试）

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add backends/src/settings.rs
git commit -m "设置：composer 组新增 dragDrop 开关字段（默认开，老账号无键自动 true）"
```

---

### Task 2: 前端 settingsStore + 设置页「拖拽文件发送」开关

**Files:**

- Modify: `frontends/lib/data/settingsStore.ts:22`（类型）、`:37`（默认值）
- Modify: `frontends/components/workbench/settings/SettingsPage.tsx:256-280`（消息行为组加一行）
- Test: `frontends/lib/data/settingsStore.test.ts`、`frontends/components/workbench/settings/SettingsPage.test.tsx`

- [ ] **Step 1: 写失败测试（store 层）**

在 `settingsStore.test.ts` 的 `describe("mergeSettings 深合并")` 内追加（文件已有 `makeSettings` 帮手与 mock 设施，照用）：

```ts
it("composer.dragDrop 默认开,patch 可关且不影响兄弟字段", () => {
  expect(DEFAULT_SETTINGS.composer.dragDrop).toBe(true);
  const merged = mergeSettings(DEFAULT_SETTINGS, { composer: { dragDrop: false } });
  expect(merged.composer.dragDrop).toBe(false);
  expect(merged.composer.silent).toBe(DEFAULT_SETTINGS.composer.silent);
  expect(merged.composer.jumpToNext).toBe(DEFAULT_SETTINGS.composer.jumpToNext);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/lib/data/settingsStore.test.ts`
Expected: FAIL（类型错误/断言失败：`dragDrop` 不存在）

- [ ] **Step 3: store 实现**

`settingsStore.ts:22` 改为：

```ts
composer: {
  silent: boolean;
  jumpToNext: boolean;
  dragDrop: boolean;
}
```

`settingsStore.ts:37`（DEFAULT_SETTINGS）改为：

```ts
  composer: { silent: false, jumpToNext: false, dragDrop: true },
```

- [ ] **Step 4: 跑 store 测试确认通过**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/lib/data/settingsStore.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（设置页）**

在 `SettingsPage.test.tsx` 追加（文件已有 render/beforeEach mock 设施，`update_settings` mock 会回显合并结果；参考既有 jumpToNext/silent 开关测试的写法与查询方式——用 `getByRole("switch", { name: ... })` 或与既有 Toggle 测试一致的选择器）：

```ts
it("拖拽文件发送开关:默认开,点击发 composer.dragDrop=false 的 patch", async () => {
  render(<SettingsPage />);
  const toggle = await screen.findByRole("switch", { name: "拖拽文件发送" });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("update_settings", {
      patch: { composer: { dragDrop: false } },
    });
  });
});
```

（若文件内既有 Toggle 测试用的不是 `role="switch"`，照搬既有测试的查询方式，保持一致。）

- [ ] **Step 6: 跑测试确认失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/settings/SettingsPage.test.tsx`
Expected: FAIL（找不到「拖拽文件发送」开关）

- [ ] **Step 7: 设置页实现**

在 `SettingsPage.tsx` 「消息行为」组（`:280` 的 `</SettingGroup>` 前、「静音发送」行之后）追加：

```tsx
<SettingRow
  title="拖拽文件发送"
  desc="拖文件到聊天区即可发送：图片插入输入框，文档作为附件"
  control={
    <Toggle
      checked={settings.composer.dragDrop}
      label="拖拽文件发送"
      onChange={(next) => apply({ composer: { dragDrop: next } })}
    />
  }
/>
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/settings/ frontends/lib/data/settingsStore.test.ts`
Expected: 全 PASS

- [ ] **Step 9: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/lib/data/settingsStore.ts frontends/lib/data/settingsStore.test.ts frontends/components/workbench/settings/SettingsPage.tsx frontends/components/workbench/settings/SettingsPage.test.tsx
git commit -m "设置页：消息行为组新增「拖拽文件发送」开关（默认开）"
```

---

### Task 3: `extOf`/`MIME_BY_EXT` 上收 data.ts + 分流器纯函数 + 文案

**Files:**

- Modify: `frontends/components/workbench/messages/data.ts`（接收搬入的 `extOf`、`MIME_BY_EXT` 并导出）
- Modify: `frontends/components/workbench/messages/MessageComposer.tsx:128-133`（删本地 `extOf`）、`:150-166` 附近（删本地 `MIME_BY_EXT`），改为从 `./data` 导入
- Create: `frontends/components/workbench/messages/dropFiles.ts`
- Create: `frontends/components/workbench/messages/dropFiles.test.ts`
- Modify: `frontends/components/workbench/messages/strings.ts:119-142`（toast 组）+ composer 组（遮罩文案）

**背景**：`extOf`（`MessageComposer.tsx:128`）与 `MIME_BY_EXT`（`:150` 附近）是 MessageComposer 模块私有；分流器和 Task 5 的路径→File 组装都需要它们。`data.ts` 已是扩展名知识（`IMAGE_EXTS`/`DOC_EXTS`/`VOICE_EXTS`/`attachmentTypeFromExt`）的家，上收到此最顺。**原样搬移，不改实现。**

- [ ] **Step 1: 写失败测试**

创建 `dropFiles.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { classifyDroppedFiles, physicalToLogical, pointInRect } from "./dropFiles";

const f = (name: string) => new File(["x"], name);

describe("classifyDroppedFiles 按扩展名分流", () => {
  it("四组各归其位,大小写不敏感", () => {
    const groups = classifyDroppedFiles([
      f("a.PNG"),
      f("b.pdf"),
      f("c.amr"),
      f("d.exe"),
      f("e.jpeg"),
      f("f.zip"),
    ]);
    expect(groups.images.map((x) => x.name)).toEqual(["a.PNG", "e.jpeg"]);
    expect(groups.docs.map((x) => x.name)).toEqual(["b.pdf", "f.zip"]);
    expect(groups.voices.map((x) => x.name)).toEqual(["c.amr"]);
    expect(groups.unsupported.map((x) => x.name)).toEqual(["d.exe"]);
  });

  it("空数组与无扩展名", () => {
    expect(classifyDroppedFiles([])).toEqual({
      images: [],
      docs: [],
      voices: [],
      unsupported: [],
    });
    expect(classifyDroppedFiles([f("README")]).unsupported).toHaveLength(1);
  });
});

describe("physicalToLogical 物理→逻辑像素", () => {
  it("除以 scale;scale<=0 时原样返回兜底", () => {
    expect(physicalToLogical({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(physicalToLogical({ x: 200, y: 100 }, 0)).toEqual({ x: 200, y: 100 });
  });
});

describe("pointInRect 含边界", () => {
  const rect = { left: 10, top: 20, right: 110, bottom: 220 };
  it("界内/边界 true,界外 false", () => {
    expect(pointInRect({ x: 60, y: 120 }, rect)).toBe(true);
    expect(pointInRect({ x: 10, y: 20 }, rect)).toBe(true);
    expect(pointInRect({ x: 110, y: 220 }, rect)).toBe(true);
    expect(pointInRect({ x: 9, y: 120 }, rect)).toBe(false);
    expect(pointInRect({ x: 60, y: 221 }, rect)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/dropFiles.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 搬移 + 实现**

3a. 把 `MessageComposer.tsx:128-133` 的 `extOf` 与 `:150` 附近的 `MIME_BY_EXT` **原样剪切**到 `data.ts`，加 `export`（注释一并搬）。`MessageComposer.tsx` 顶部 `import { attachmentTypeFromExt, DOC_EXTS, IMAGE_EXTS, VOICE_EXTS } from "./data";` 改为追加 `extOf, MIME_BY_EXT`。

3b. 创建 `dropFiles.ts`：

```ts
// dropFiles.ts — 聊天区拖拽文件的分类与落点判定(纯函数,不碰 DOM/Tauri,便于单测)。
// 分类规则与发送按钮/粘贴完全同源:扩展名白名单见 data.ts。

import { DOC_EXTS, extOf, IMAGE_EXTS, VOICE_EXTS } from "./data";

export interface DroppedFileGroups {
  /** 内联进编辑器(同图片按钮/粘贴)。 */
  images: File[];
  /** 进待发送托盘(同文件按钮)。 */
  docs: File[];
  /** 语音独占语义(仅纯语音拖入时生效)。 */
  voices: File[];
  /** 白名单之外,忽略并 toast。 */
  unsupported: File[];
}

export function classifyDroppedFiles(files: File[]): DroppedFileGroups {
  const groups: DroppedFileGroups = { images: [], docs: [], voices: [], unsupported: [] };
  for (const file of files) {
    const ext = extOf(file.name);
    if ((IMAGE_EXTS as readonly string[]).includes(ext)) groups.images.push(file);
    else if ((DOC_EXTS as readonly string[]).includes(ext)) groups.docs.push(file);
    else if ((VOICE_EXTS as readonly string[]).includes(ext)) groups.voices.push(file);
    else groups.unsupported.push(file);
  }
  return groups;
}

export interface Point {
  x: number;
  y: number;
}

/** Tauri 拖拽事件坐标是物理像素;除以 devicePixelRatio 得 CSS 逻辑像素。scale<=0 兜底原样返回。 */
export function physicalToLogical(p: Point, scale: number): Point {
  return scale > 0 ? { x: p.x / scale, y: p.y / scale } : p;
}

export function pointInRect(
  p: Point,
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
): boolean {
  return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
}
```

3c. `strings.ts` 的 `toast` 组（`:141` `fileTooLarge` 之后）追加：

```ts
    dropUnsupported: "包含不支持的文件类型，已忽略",
    dropVoiceAlone: "语音文件需单独拖入发送",
    dropReadFailed: "读取拖入的文件失败",
```

`strings.ts` 的 `composer` 组追加：

```ts
    dropTitle: "松开发送文件",
    dropHint: "图片将插入输入框，文档将作为附件",
```

- [ ] **Step 4: 跑测试 + 全量回归（搬移影响 MessageComposer）**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/ && pnpm exec tsc --noEmit`
Expected: 全 PASS、tsc 干净

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/components/workbench/messages/data.ts frontends/components/workbench/messages/MessageComposer.tsx frontends/components/workbench/messages/dropFiles.ts frontends/components/workbench/messages/dropFiles.test.ts frontends/components/workbench/messages/strings.ts
git commit -m "拖拽发送：分流器纯函数 + extOf/MIME_BY_EXT 上收 data.ts + 文案"
```

---

### Task 4: MessageComposer 暴露 `acceptDroppedFiles` 句柄（含语音独占语义）

**Files:**

- Modify: `frontends/components/workbench/messages/MessageComposer.tsx`（props、句柄发布、语音确认流改造）
- Create: `frontends/components/workbench/messages/MessageComposer.dragdrop.test.tsx`

**先跑 impact**：`gitnexus_impact({target: "MessageComposer", direction: "upstream"})`，报告血爆半径再动手。

- [ ] **Step 1: 写失败测试**

创建 `MessageComposer.dragdrop.test.tsx`，**mock 设施整段照搬 `MessageComposer.attachments.test.tsx:14-70`**（Tauri/recentFriends/AiPolishPopover/toast mock、`fileNamed` 帮手、`baseProps`、afterEach cleanup）。测试体：

```tsx
describe("acceptDroppedFiles 分流", () => {
  it("文档进托盘,exe 被忽略并 toast dropUnsupported", async () => {
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("合同.pdf"), fileNamed("evil.exe")]);
    });
    // pdf chip 出现(托盘),exe 被忽略
    await waitFor(() => expect(within(container).getByText("合同.pdf")).toBeInTheDocument());
    expect(within(container).queryByText("evil.exe")).not.toBeInTheDocument();
    expect(showToastMock).toHaveBeenCalledWith(STRINGS.toast.dropUnsupported, { type: "error" });
  });

  it("混合拖入夹语音:语音被忽略并 toast dropVoiceAlone,文档照常进托盘", async () => {
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("a.pdf"), fileNamed("v.amr")]);
    });
    await waitFor(() => expect(within(container).getByText("a.pdf")).toBeInTheDocument());
    expect(within(container).queryByText("v.amr")).not.toBeInTheDocument();
    expect(showToastMock).toHaveBeenCalledWith(STRINGS.toast.dropVoiceAlone, { type: "error" });
  });

  it("纯语音拖入 + 编辑器为空:直接进语音独占态", async () => {
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("v.amr")]);
    });
    await waitFor(() => expect(within(container).getByText("v.amr")).toBeInTheDocument());
  });

  it("纯语音拖入 + 编辑器有文本:弹确认框,确认后语音落地", async () => {
    setDraft(CONV, { text: "已有文字", blocks: [], doc: EMPTY_DOC });
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container, getByText } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("v.amr")]);
    });
    // 确认框出现,此时语音尚未落地
    expect(getByText(STRINGS.composer.voiceExclusiveTitle)).toBeInTheDocument();
    expect(within(container).queryByText("v.amr")).not.toBeInTheDocument();
    fireEvent.click(getByText(STRINGS.composer.voiceExclusiveConfirm));
    await waitFor(() => expect(within(container).getByText("v.amr")).toBeInTheDocument());
  });

  it("纯语音拖入 + 有文本 + 点取消:语音不落地,文本保留", async () => {
    setDraft(CONV, { text: "已有文字", blocks: [], doc: EMPTY_DOC });
    const dropRef: { current: ComposerDropHandle | null } = { current: null };
    const { container, getByText } = render(
      <MessageComposer {...baseProps} conversationId={CONV} dropHandleRef={dropRef} />,
    );
    await waitFor(() => expect(dropRef.current).not.toBeNull());
    act(() => {
      dropRef.current!.acceptDroppedFiles([fileNamed("v.amr")]);
    });
    fireEvent.click(getByText(STRINGS.composer.voiceExclusiveCancel));
    await waitFor(() =>
      expect(
        within(container).queryByText(STRINGS.composer.voiceExclusiveTitle),
      ).not.toBeInTheDocument(),
    );
    expect(within(container).queryByText("v.amr")).not.toBeInTheDocument();
  });
});
```

注：`setDraft(CONV, ...)` 的草稿形参以 `useDraftStore.ts` 实际签名为准（参考 `MessageComposer.attachments.test.tsx` 既有用法,该文件已 import `EMPTY_DOC, setDraft`）。`STRINGS.composer.voiceExclusiveConfirm/Cancel` 键名以 `strings.ts` 实际为准（`MessageComposer.tsx:1002-1003` 在用）。图片内联路径(insertImageFiles 走 FileReader+TipTap)在 jsdom 断言成本高,且与粘贴共用同一函数已有覆盖,本文件不重复测。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/MessageComposer.dragdrop.test.tsx`
Expected: FAIL（`dropHandleRef` prop 不存在 / `ComposerDropHandle` 未导出）

- [ ] **Step 3: 实现**

3a. `MessageComposer.tsx` 导出句柄类型并加 prop（props interface 内）：

```ts
/** 拖拽落地句柄:ChatArea 的拖拽 hook 经此把文件灌进 composer 既有管线。 */
export interface ComposerDropHandle {
  acceptDroppedFiles: (files: File[]) => void;
}
```

props 加：`dropHandleRef?: { current: ComposerDropHandle | null };`

3b. 组件内（`acceptVoiceFiles` 定义之后）加拖入语音暂存 ref 与分流函数：

```ts
// 拖拽进来的语音文件:需先过「改用语音」确认框时暂存于此,确认后落地、取消即丢弃。
const pendingDroppedVoiceRef = useRef<File | null>(null);

// 拖拽文件统一入口:按扩展名分流进既有三条管线。语音仅纯语音拖入时生效(独占规则不绕过)。
const acceptDroppedFiles = useCallback(
  (raw: File[]) => {
    const groups = classifyDroppedFiles(raw);
    if (groups.unsupported.length > 0) {
      showToast(STRINGS.toast.dropUnsupported, { type: "error" });
    }
    if (groups.images.length > 0) acceptImageFiles(groups.images);
    if (groups.docs.length > 0) acceptDocFiles(groups.docs);
    if (groups.voices.length > 0) {
      if (groups.images.length > 0 || groups.docs.length > 0) {
        showToast(STRINGS.toast.dropVoiceAlone, { type: "error" });
      } else {
        const composerHasContent =
          textJoined.trim().length > 0 ||
          blocks.some((b) => b.type === "image") ||
          pendingFileAttachments.length > 0;
        if (composerHasContent) {
          pendingDroppedVoiceRef.current = groups.voices[0];
          setVoiceConfirmOpen(true);
        } else {
          acceptVoiceFiles(groups.voices);
        }
      }
    }
  },
  [acceptImageFiles, acceptDocFiles, acceptVoiceFiles, textJoined, blocks, pendingFileAttachments],
);

// 句柄发布给 ChatArea(React 19 普通 prop,无需 forwardRef)。
useEffect(() => {
  if (!dropHandleRef) return;
  dropHandleRef.current = { acceptDroppedFiles };
  return () => {
    dropHandleRef.current = null;
  };
}, [dropHandleRef, acceptDroppedFiles]);
```

顶部 import 追加 `classifyDroppedFiles`（from `./dropFiles`）。

3c. 改造 `confirmVoiceSwitch`（`MessageComposer.tsx:589-602`）：清空后**若有拖入暂存语音则直接落地，否则照旧开选择器**。原函数体内 `openVoicePicker();` 一行改为：

```ts
const dropped = pendingDroppedVoiceRef.current;
pendingDroppedVoiceRef.current = null;
if (dropped) {
  acceptVoiceFiles([dropped]);
} else {
  openVoicePicker();
}
```

（依赖数组补 `acceptVoiceFiles`。）

3d. 确认框的两个关闭出口（`MessageComposer.tsx:991` 的 `onClose` 与 `:1002` 的取消按钮，均为 `() => setVoiceConfirmOpen(false)`）统一改为 helper，丢弃暂存语音：

```ts
// 取消「改用语音」:关框并丢弃拖入暂存的语音(若有)。
const closeVoiceConfirm = useCallback(() => {
  pendingDroppedVoiceRef.current = null;
  setVoiceConfirmOpen(false);
}, []);
```

两处 JSX 改用 `closeVoiceConfirm`。

- [ ] **Step 4: 跑测试确认通过 + composer 全量回归**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/ && pnpm exec tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/components/workbench/messages/MessageComposer.tsx frontends/components/workbench/messages/MessageComposer.dragdrop.test.tsx
git commit -m "拖拽发送：MessageComposer 暴露 acceptDroppedFiles 句柄，语音确认流接拖入暂存"
```

---

### Task 5: `useFileDragDrop` hook（Tauri 订阅 + web 兜底）

**Files:**

- Create: `frontends/components/workbench/messages/useFileDragDrop.ts`
- Create: `frontends/components/workbench/messages/useFileDragDrop.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `useFileDragDrop.test.ts`：

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri mock:isTauri 可切换;onDragDropEvent 捕获回调供测试驱动。
const tauriMock = { isTauri: true };
type DragPayload =
  | { type: "enter" | "over"; position: { x: number; y: number } }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };
let dragCallback: ((event: { payload: DragPayload }) => void) | null = null;
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(new ArrayBuffer(1))),
  isTauri: () => tauriMock.isTauri,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn((cb: typeof dragCallback) => {
      dragCallback = cb;
      return Promise.resolve(unlistenMock);
    }),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { useFileDragDrop } from "./useFileDragDrop";

const invokeMock = vi.mocked(invoke);

// 聊天区矩形:逻辑像素 (10,20)-(110,220)。
function makeContainer(): { current: HTMLElement } {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 20,
      right: 110,
      bottom: 220,
      width: 100,
      height: 200,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }) as DOMRect;
  return { current: el };
}

beforeEach(() => {
  tauriMock.isTauri = true;
  dragCallback = null;
  unlistenMock.mockClear();
  invokeMock.mockClear();
  vi.stubGlobal("devicePixelRatio", 2);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useFileDragDrop / Tauri 路径", () => {
  it("enabled=false 不订阅;true 订阅;卸载退订", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useFileDragDrop({ enabled, containerRef, onFiles }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {});
    expect(dragCallback).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(dragCallback).not.toBeNull());

    unmount();
    await waitFor(() => expect(unlistenMock).toHaveBeenCalled());
  });

  it("over 在界内(物理坐标÷dpr)→ dragActive;leave → 复位", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { result } = renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    // 物理 (120, 240) ÷ dpr2 = 逻辑 (60, 120) → 界内
    act(() => dragCallback!({ payload: { type: "over", position: { x: 120, y: 240 } } }));
    expect(result.current.dragActive).toBe(true);

    // 物理 (4, 4) → 逻辑 (2, 2) → 界外
    act(() => dragCallback!({ payload: { type: "over", position: { x: 4, y: 4 } } }));
    expect(result.current.dragActive).toBe(false);

    act(() => dragCallback!({ payload: { type: "over", position: { x: 120, y: 240 } } }));
    act(() => dragCallback!({ payload: { type: "leave" } }));
    expect(result.current.dragActive).toBe(false);
  });

  it("drop 界内:read_local_file 逐路径读回,组装 File 调 onFiles;界外丢弃", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    act(() =>
      dragCallback!({
        payload: {
          type: "drop",
          position: { x: 120, y: 240 },
          paths: ["/tmp/a.pdf", "C:\\\\x\\\\b.png"],
        },
      }),
    );
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    const files = onFiles.mock.calls[0][0] as File[];
    expect(files.map((f) => f.name)).toEqual(["a.pdf", "b.png"]);
    expect(invokeMock).toHaveBeenCalledWith("read_local_file", { path: "/tmp/a.pdf" });

    onFiles.mockClear();
    act(() =>
      dragCallback!({ payload: { type: "drop", position: { x: 4, y: 4 }, paths: ["/tmp/c.pdf"] } }),
    );
    await act(async () => {});
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("单条读取失败跳过,其余照常", async () => {
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    invokeMock.mockImplementation((_cmd, args) => {
      const { path } = args as { path: string };
      return path.endsWith("bad.pdf")
        ? Promise.reject(new Error("dir"))
        : Promise.resolve(new ArrayBuffer(1));
    });
    renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    await waitFor(() => expect(dragCallback).not.toBeNull());

    act(() =>
      dragCallback!({
        payload: {
          type: "drop",
          position: { x: 120, y: 240 },
          paths: ["/tmp/bad.pdf", "/tmp/ok.pdf"],
        },
      }),
    );
    await waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect((onFiles.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(["ok.pdf"]);
  });
});

describe("useFileDragDrop / web 兜底路径", () => {
  it("非 Tauri:webHandlers 的 drop 直接把 DataTransfer.files 交给 onFiles", async () => {
    tauriMock.isTauri = false;
    const onFiles = vi.fn();
    const containerRef = makeContainer();
    const { result } = renderHook(() => useFileDragDrop({ enabled: true, containerRef, onFiles }));
    expect(dragCallback).toBeNull(); // 未走 Tauri 订阅

    const file = new File(["x"], "w.pdf");
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [file], types: ["Files"] },
    } as unknown as React.DragEvent<HTMLElement>;
    act(() => result.current.webHandlers.onDrop?.(dropEvent));
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(result.current.dragActive).toBe(false);
  });

  it("Tauri 下 webHandlers 为空对象(不挂、避免双触发)", () => {
    tauriMock.isTauri = true;
    const containerRef = makeContainer();
    const { result } = renderHook(() =>
      useFileDragDrop({ enabled: true, containerRef, onFiles: vi.fn() }),
    );
    expect(result.current.webHandlers.onDrop).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/useFileDragDrop.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 hook**

创建 `useFileDragDrop.ts`：

```ts
// useFileDragDrop — 聊天区拖拽文件 hook。
// Tauri 路径:订阅 getCurrentWebview().onDragDropEvent(OS 拖拽被 Tauri 拦截,HTML5 drop
// 在 Tauri 内拿不到文件,这是唯一可靠通道;Windows/macOS 由 Tauri 统一抽象)。事件坐标为
// 物理像素,÷devicePixelRatio 后与容器矩形求交决定遮罩显隐与落点有效性。drop 的路径经
// read_local_file 读回字节组装 File(与 pickNativeFiles 同一座桥)。
// web 预览(非 Tauri):返回 webHandlers 挂到容器上,DataTransfer.files 直取;Tauri 下返回
// 空对象避免双触发。enabled=false(设置页开关关)= 不订阅、不响应。

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { invoke, isTauri } from "@tauri-apps/api/core";

import { showToast } from "@/components/ui/toast";

import { extOf, MIME_BY_EXT } from "./data";
import { physicalToLogical, pointInRect, type Point } from "./dropFiles";
import { STRINGS } from "./strings";

interface UseFileDragDropOptions {
  /** 设置页「拖拽文件发送」开关。false = 不订阅、不响应。 */
  enabled: boolean;
  /** 聊天区根容器:落点判定与 web 事件挂载目标。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 落点有效的拖入文件(已组装 File,未分类)。 */
  onFiles: (files: File[]) => void;
}

interface WebDragHandlers {
  onDragOver?: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: React.DragEvent<HTMLElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLElement>) => void;
}

/** 路径 → File:read_local_file 逐条读回,单条失败(文件夹/无权限)跳过。 */
async function readDroppedPaths(paths: string[]): Promise<File[]> {
  const settled = await Promise.allSettled(
    paths.map(async (path) => {
      const buf = await invoke<ArrayBuffer>("read_local_file", { path });
      const name = path.split(/[/\\]/).pop() || path;
      return new File([buf], name, {
        type: MIME_BY_EXT[extOf(name)] ?? "application/octet-stream",
      });
    }),
  );
  return settled
    .filter((s): s is PromiseFulfilledResult<File> => s.status === "fulfilled")
    .map((s) => s.value);
}

export function useFileDragDrop({ enabled, containerRef, onFiles }: UseFileDragDropOptions): {
  dragActive: boolean;
  webHandlers: WebDragHandlers;
} {
  const [dragActive, setDragActive] = useState(false);
  // onFiles 走 ref 透传:避免调用方每渲染新建闭包导致订阅 effect 反复退订/重订。
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  // ── Tauri 路径 ──
  useEffect(() => {
    if (!enabled || !isTauri()) {
      setDragActive(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const inContainer = (position: Point): boolean => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const logical = physicalToLogical(position, window.devicePixelRatio || 1);
      return pointInRect(logical, rect);
    };

    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(inContainer(payload.position));
          return;
        }
        // drop:界外松手直接丢弃;界内读回文件交给 onFiles。
        setDragActive(false);
        if (!inContainer(payload.position) || payload.paths.length === 0) return;
        void readDroppedPaths(payload.paths).then((files) => {
          if (files.length === 0) {
            showToast(STRINGS.toast.dropReadFailed, { type: "error" });
          } else {
            onFilesRef.current(files);
          }
        });
      });
      // 订阅落定前组件已卸载/开关已关:立即退订,不留悬挂监听。
      if (disposed) un();
      else unlisten = un;
    })();

    return () => {
      disposed = true;
      unlisten?.();
      setDragActive(false);
    };
  }, [enabled, containerRef]);

  // ── web 兜底路径(非 Tauri)──
  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!enabled) return;
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      setDragActive(true);
    },
    [enabled],
  );
  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    // 只在真正离开容器(而非进入子元素)时复位,避免遮罩闪烁。
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }, []);
  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!enabled) return;
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFilesRef.current(files);
    },
    [enabled],
  );

  const webHandlers: WebDragHandlers = isTauri() ? {} : { onDragOver, onDragLeave, onDrop };

  return { dragActive, webHandlers };
}
```

注：`onDragDropEvent` 回调参数的 TS 类型以 `@tauri-apps/api/webview` 实际导出为准（`DragDropEvent` 联合类型,`enter/over` 带 `position`、`drop` 带 `position`+`paths`、`leave` 无载荷）；若类型名不同按编译器提示对齐,不改运行时逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/useFileDragDrop.test.ts && pnpm exec tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/components/workbench/messages/useFileDragDrop.ts frontends/components/workbench/messages/useFileDragDrop.test.ts
git commit -m "拖拽发送：useFileDragDrop hook（Tauri onDragDropEvent + web 兜底，设置开关门控）"
```

---

### Task 6: ChatArea 集成：ref + 遮罩 + 设置门控

**Files:**

- Modify: `frontends/components/workbench/messages/ChatArea.tsx:671-767`（根容器与组件体）
- Test: `frontends/components/workbench/messages/ChatArea.test.tsx`（追加用例）

**先跑 impact**：`gitnexus_impact({target: "ChatArea", direction: "upstream"})`，报告血爆半径再动手。

- [ ] **Step 1: 写失败测试**

在 `ChatArea.test.tsx` 追加（render 设施照搬该文件既有用例；jsdom 非 Tauri,走 web 路径,正好驱动遮罩）：

```tsx
it("拖文件悬停聊天区:出现统一「松开发送」遮罩;设置关闭则不响应", async () => {
  // 默认设置 dragDrop=true
  const { container } = renderChatArea(); // ← 用本文件既有的 render 帮手
  const root = container.firstElementChild as HTMLElement;
  fireEvent.dragOver(root, { dataTransfer: { types: ["Files"], files: [] } });
  expect(await screen.findByText(STRINGS.composer.dropTitle)).toBeInTheDocument();
  expect(screen.getByText(STRINGS.composer.dropHint)).toBeInTheDocument();

  fireEvent.dragLeave(root, { relatedTarget: document.body });
  await waitFor(() =>
    expect(screen.queryByText(STRINGS.composer.dropTitle)).not.toBeInTheDocument(),
  );

  // 关掉设置开关 → 不再出遮罩
  act(() => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, composer: { ...s.settings.composer, dragDrop: false } },
    }));
  });
  fireEvent.dragOver(root, { dataTransfer: { types: ["Files"], files: [] } });
  expect(screen.queryByText(STRINGS.composer.dropTitle)).not.toBeInTheDocument();
});
```

（`renderChatArea` 为示意：用 `ChatArea.test.tsx` 既有的渲染帮手/最小 props 组装方式，文件里已有可运行的先例；需要 import `useSettingsStore`。若该文件 beforeEach 未重置设置 store，在本用例开头 `useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), loaded: true })`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/ChatArea.test.tsx`
Expected: 新用例 FAIL（无遮罩文案）

- [ ] **Step 3: 实现**

3a. `ChatArea.tsx` 顶部 import 追加：

```ts
import { useSettingsStore } from "@/lib/data/settingsStore";

import { type ComposerDropHandle } from "./MessageComposer";
import { useFileDragDrop } from "./useFileDragDrop";
```

（`MessageComposer` 已有 import,合并即可。）

3b. 组件体内（`offline` state 之后、`return` 之前）：

```ts
// ── 拖拽文件发送(设置页开关门控;遮罩覆盖消息列表+输入区整片,统一一套视觉) ──
const dragDropEnabled = useSettingsStore((s) => s.settings.composer.dragDrop);
const chatAreaRef = useRef<HTMLDivElement | null>(null);
const composerDropRef = useRef<ComposerDropHandle | null>(null);
const { dragActive, webHandlers } = useFileDragDrop({
  enabled: dragDropEnabled,
  containerRef: chatAreaRef,
  onFiles: (files) => composerDropRef.current?.acceptDroppedFiles(files),
});
```

3c. 根容器（`:672`）挂 ref 与 web 事件：

```tsx
    <div
      ref={chatAreaRef}
      {...webHandlers}
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-workbench-surface"
    >
```

3d. `MessageComposer`（`:738`）加 prop：`dropHandleRef={composerDropRef}`。

3e. 遮罩 JSX（`ForwardDialog` 之后、根容器闭合前）：

```tsx
{
  dragActive && (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-workbench-surface/80 backdrop-blur-sm duration-150 animate-in fade-in motion-reduce:animate-none">
      <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-workbench-accent bg-workbench-surface px-10 py-8 shadow-wb-popover">
        <p className="text-wb-sm font-semibold text-workbench-text">{STRINGS.composer.dropTitle}</p>
        <p className="text-wb-2xs text-workbench-text-secondary">{STRINGS.composer.dropHint}</p>
      </div>
    </div>
  );
}
```

（`workbench-accent`/`shadow-wb-popover`/`animate-in fade-in` 均为项目在用的 token/工具类,见 `ChatArea.tsx:972-973`。）

- [ ] **Step 4: 跑测试确认通过 + 消息模块全量回归**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub && pnpm vitest run frontends/components/workbench/messages/ && pnpm exec tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
git add frontends/components/workbench/messages/ChatArea.tsx frontends/components/workbench/messages/ChatArea.test.tsx
git commit -m "拖拽发送：ChatArea 集成统一遮罩与落点判定，设置开关门控"
```

---

### Task 7: 全量验证 + 影响面核对

- [ ] **Step 1: 全量前端测试 + 类型 + lint（改动文件范围）**

Run（仓库根目录）:

```bash
cd /Users/pis0sion/Pis0sion/RustCode/ChatHub
pnpm vitest run
pnpm exec tsc --noEmit
pnpm exec eslint frontends/components/workbench/messages/dropFiles.ts frontends/components/workbench/messages/useFileDragDrop.ts frontends/components/workbench/messages/MessageComposer.tsx frontends/components/workbench/messages/ChatArea.tsx frontends/components/workbench/settings/SettingsPage.tsx frontends/lib/data/settingsStore.ts
```

Expected: 测试全绿、tsc 干净、lint 无新告警（全量 lint 有构建产物噪声,只 lint 改动文件）。

- [ ] **Step 2: 后端测试**

Run: `cd /Users/pis0sion/Pis0sion/RustCode/ChatHub/backends && cargo test -p chathub settings`
Expected: 全 PASS

- [ ] **Step 3: GitNexus 影响面核对**

跑 `gitnexus_detect_changes()`，确认受影响符号/流程仅限：settings（前后端）、MessageComposer、ChatArea、新增 dropFiles/useFileDragDrop。有意外波及即停下报告。

- [ ] **Step 4: 真机验证清单（人工,标记到任务说明里,不阻塞合并提交）**

- macOS：拖单图/多图/混合/exe/文件夹/超大文件；遮罩出现与消失；界外松手不发送。
- Windows：同上,重点 125%/150% DPI 缩放下遮罩触发区域与落点判定准确。
- 设置页关掉开关后拖拽完全不响应,打开即恢复（无需重启）。
- 语音文件拖入：空输入框直接进独占态；有文字弹确认框,确认/取消两路。

---

## 自审记录

- spec 每条决策均有对应 Task：落点范围/遮罩（T6）、类型分流（T3/T4）、语音语义（T4）、设置开关（T1/T2/T5 门控/T6 接线）、错误处理（T5 读失败、T3/T4 toast）、坐标换算（T3/T5）、web 兜底（T5/T6 测试即走此路径）。
- 类型一致性：`ComposerDropHandle` 在 T4 定义、T6 引用；`classifyDroppedFiles`/`physicalToLogical`/`pointInRect` 在 T3 定义、T4/T5 引用；`extOf`/`MIME_BY_EXT` T3 上收、T5 引用；`dragDrop` 命名前后端一致（serde camelCase）。
- 两处刻意留给执行者对齐现场的点（非占位符,均给了取证位置）：`STRINGS.composer.voiceExclusive*` 确切键名（`MessageComposer.tsx:1002-1003` 在用）、`ChatArea.test.tsx` 渲染帮手名。
