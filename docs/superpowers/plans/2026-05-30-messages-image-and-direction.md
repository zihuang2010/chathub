# 消息图片优化 + 方向修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复历史消息方向反转，并让消息图片按原比例显示、消除闪烁（本地化读取）、统一样式、支持单图灯箱预览。

**Architecture:** 后端把"图片派生元数据（原始宽高 + 本地缩略图路径）"与"服务端附件真相"解耦到按 URL 为键的 `hub_image_meta` 表，后台预取填充、读消息时注入前端；前端用宽高做比例盒、用本地路径走 Tauri asset 协议读本地文件。方向 bug 在历史落库路径补一次 spec→本地约定转换。

**Tech Stack:** Rust(Tauri v2, rusqlite, rusqlite_migration, deadpool, image crate, reqwest) + TypeScript/React(Vitest, @tauri-apps/api, Tailwind)。

**工作目录约定**：`cargo` 在 `backends/`；`pnpm`/`vitest` 在**仓库根目录**（仅一个 `package.json`）。

**并行分组（供 subagent 调度）：**

- **组 A = Part 1（方向）**：后端，独立。
- **组 B = Part 3（后端 image_meta）**：后端；与组 A 共享 `message_sync.rs`/`hub.rs`/`lib.rs`，**建议 A 先于 B**（串行，避免冲突）。
- **组 C = Part 2（前端样式+灯箱+比例盒）**：前端独立文件，**可与 A/B 并行**（用 mock 数据开发，不依赖后端完成）。

**纪律**：每个被改 Rust/前端符号，编辑前先 `gitnexus_impact`；每个 Task 末尾 commit 前先 `gitnexus_detect_changes` 核对影响面；HIGH/CRITICAL 先停下告警。

---

## Part 1 — 消息方向修复（组 A，后端）

### Task 1.1：历史路径补方向转换 + 修正注释

**Files:**

- Modify: `backends/crates/chathub-net/src/message_event.rs:25`（`to_local_direction` 可见性）
- Modify: `backends/crates/chathub-net/src/message_sync.rs:55-86`（`history_to_row`）
- Modify: `backends/crates/chathub-net/src/hub.rs:711`（注释）
- Test: `backends/crates/chathub-net/src/message_sync.rs`（`#[cfg(test)] mod tests`）

- [ ] **Step 1: 先跑 impact**

```
gitnexus_impact({target: "history_to_row", direction: "upstream", repo: "chathub"})
gitnexus_impact({target: "to_local_direction", direction: "upstream", repo: "chathub"})
```

预期：均 LOW（已验证）。若非 LOW，停下告警。

- [ ] **Step 2: 写失败测试（spec→本地约定转换）**

在 `message_sync.rs` 的 `mod tests` 末尾追加：

```rust
#[test]
fn history_to_row_translates_spec_direction_to_local() {
    // spec: 1=发送(out) 2=接收(in) 3=多端同步(out)；本地: 2=out 1=in
    let mk = |dir: i32| HistoryMessage {
        local_message_id: "m1".into(),
        message_direction: dir,
        message_type: 1,
        content_text: "hi".into(),
        send_status: 3,
        message_time: "2026-05-30 10:00:00".into(),
        sort_key: "1780000000000_x_m1".into(),
        attachments: vec![],
        gmt_modified_time: "".into(),
    };
    assert_eq!(history_to_row(&mk(1), "c1", "u1", "wa1").message_direction, 2, "spec1发送→本地2(out)");
    assert_eq!(history_to_row(&mk(2), "c1", "u1", "wa1").message_direction, 1, "spec2接收→本地1(in)");
    assert_eq!(history_to_row(&mk(3), "c1", "u1", "wa1").message_direction, 2, "spec3多端→本地2(out)");
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-net history_to_row_translates -- --nocapture`
Expected: FAIL（断言 spec1→2 不成立，当前原样抄返回 1）。

- [ ] **Step 4: 改 `to_local_direction` 可见性**

`message_event.rs:25`：

```rust
pub(crate) fn to_local_direction(spec_dir: i64) -> i32 {
```

- [ ] **Step 5: `history_to_row` 应用转换**

`message_sync.rs` 顶部 import：

```rust
use crate::message_event::to_local_direction;
```

`history_to_row` 内（原 `message_direction: h.message_direction,`）改为：

```rust
        message_direction: to_local_direction(h.message_direction as i64),
```

- [ ] **Step 6: 修正误导注释**

`hub.rs:711` 改为：

```rust
    /// 原始 spec（针对当前账号）：1=发送(out) / 2=接收(in) / 3=多端同步(out)。
    /// 落库时经 to_local_direction 转本地约定(1=in,2=out)。
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-net history_to_row_translates`
Expected: PASS。再跑 `cargo test -p chathub-net` 确认无回归（注意 message_sync 既有用例若硬编码方向值，按本地约定校正）。

- [ ] **Step 8: detect_changes + commit**

```
gitnexus_detect_changes()
```

```bash
git add backends/crates/chathub-net/src/message_event.rs backends/crates/chathub-net/src/message_sync.rs backends/crates/chathub-net/src/hub.rs
git commit -m "fix(messages): 历史消息方向 spec→本地约定转换，修正出/入站反转"
```

---

### Task 1.2：ON CONFLICT 自愈已缓存的反向老行

**Files:**

- Modify: `backends/crates/chathub-state/src/messages.rs:88-93`（`upsert_messages` 的 ON CONFLICT）
- Test: `backends/crates/chathub-state/src/messages.rs`（`mod tests`）

- [ ] **Step 1: 先跑 impact**

```
gitnexus_impact({target: "upsert_messages", direction: "upstream", repo: "chathub"})
```

- [ ] **Step 2: 写失败测试（自愈）**

`messages.rs` 的 `mod tests` 追加：

```rust
#[tokio::test]
async fn upsert_heals_message_direction() {
    let pool = SqlitePool::in_memory().await.unwrap();
    let store = MessagesStore::new(pool);
    // 先落一条方向错误(2)的行
    let mut bad = sample_row("c1", "m1", "sort_0001", 100);
    bad.message_direction = 2;
    store.upsert_messages(&[bad]).await.unwrap();
    // 再以正确方向(1)重 upsert 同 id
    let mut fixed = sample_row("c1", "m1", "sort_0001", 100);
    fixed.message_direction = 1;
    store.upsert_messages(&[fixed]).await.unwrap();
    let got = store.list_recent("u-1", "c1", 10).await.unwrap();
    assert_eq!(got[0].message_direction, 1, "ON CONFLICT 应纠正方向");
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-state upsert_heals_message_direction`
Expected: FAIL（方向仍为 2，因 ON CONFLICT 未更新 message_direction）。

- [ ] **Step 4: ON CONFLICT 增 message_direction**

`messages.rs::upsert_messages` 的 `DO UPDATE SET` 子句**两处**（`upsert_messages` 与 `upsert_message_and_bump_window` 各有一份）追加一行：

```sql
                       message_direction = excluded.message_direction, \
```

（放在 `content_text = excluded.content_text,` 之前，保持其它列不变。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-state`
Expected: PASS（含既有 `upsert_updates_mutable_keeps_position` 等仍绿）。

- [ ] **Step 6: detect_changes + commit**

```bash
git add backends/crates/chathub-state/src/messages.rs
git commit -m "fix(messages): upsert ON CONFLICT 纠正 message_direction，自愈反向老缓存"
```

---

## Part 2 — 前端样式 + 灯箱 + 比例盒（组 C，前端，可并行）

> 全程工作目录 = 仓库根目录。测试 `pnpm vitest run <file>`。

### Task 2.1：前端类型补 localPath + 透传

**Files:**

- Modify: `frontends/components/workbench/messages/data.ts:73-87`（`MessagePart.image`）
- Modify: `frontends/lib/api/messageHistory.ts:60-65`（`HistoryAttachment`）、`:231-248`（`historyAttachmentToMessage`）

- [ ] **Step 1: `MessagePart.image` 增 localPath**

`data.ts` 的 image 变体（已有 `width?/height?`）追加：

```ts
      localPath?: string;
```

- [ ] **Step 2: `HistoryAttachment` 增三字段**

`messageHistory.ts::HistoryAttachment` 追加：

```ts
  width?: number;
  height?: number;
  localPath?: string;
```

- [ ] **Step 3: `historyAttachmentToMessage` 透传（仅 image）**

`messageHistory.ts` 中把 image 分支的返回改为带尺寸/本地路径。`attachmentToPart`（data.ts）对 image 已只取 url/name/sizeBytes —— 改为透传 width/height/localPath。最小做法：`historyAttachmentToMessage` 返回的 `MessageAttachment` 增可选 `width/height/localPath`，并在 `data.ts::attachmentToPart` 的 image 分支透传：

`data.ts::MessageAttachment` 增：

```ts
  width?: number;
  height?: number;
  localPath?: string;
```

`data.ts::attachmentToPart` image 分支：

```ts
    case "image":
      return { kind: "image", url: a.url, name: a.name, sizeBytes: a.sizeBytes,
               width: a.width, height: a.height, localPath: a.localPath };
```

`messageHistory.ts::historyAttachmentToMessage` 末尾返回对象增：

```ts
    width: a.width,
    height: a.height,
    localPath: a.localPath,
```

- [ ] **Step 4: 类型检查**

Run: `pnpm tsc --noEmit`（或项目既有 `pnpm lint`）。Expected: 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add frontends/components/workbench/messages/data.ts frontends/lib/api/messageHistory.ts
git commit -m "feat(messages): 图片 part/附件类型补 width/height/localPath 透传"
```

---

### Task 2.2：assetImageSrc helper

**Files:**

- Create: `frontends/lib/assetImageSrc.ts`
- Test: `frontends/lib/assetImageSrc.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { assetImageSrc } from "./assetImageSrc";

describe("assetImageSrc", () => {
  it("本地路径 → asset URL", () => {
    expect(assetImageSrc("/cache/a.img")).toContain("asset://localhost/");
  });
  it("空值 → undefined", () => {
    expect(assetImageSrc(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run frontends/lib/assetImageSrc.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

/** 本地缩略图绝对路径 → Tauri asset 协议 URL；非 Tauri / 空路径 → undefined（调用方回退）。 */
export function assetImageSrc(localPath: string | undefined | null): string | undefined {
  if (!localPath) return undefined;
  if (!isTauri()) return undefined;
  return convertFileSrc(localPath);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run frontends/lib/assetImageSrc.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add frontends/lib/assetImageSrc.ts frontends/lib/assetImageSrc.test.ts
git commit -m "feat(messages): 新增 assetImageSrc helper（本地路径→asset 协议）"
```

---

### Task 2.3：MessageImage 比例盒重构（R1+R2+R4）

**Files:**

- Modify: `frontends/components/workbench/messages/MessageContent.tsx:275-357`（`MessageImage` 及 `MessageImageProps`）、`:75-93,256-273`（三处入口传 part）
- Test: `frontends/components/workbench/messages/MessageContent.test.tsx`（新增或既有）

设计要点：

- `MessageImage` 入参从 `src` 改为接收 `part`（拿 url/width/height/localPath）+ alt + 显示上限。
- 渲染源优先级：`assetImageSrc(part.localPath)`（命中即同步、不画骨架）→ 否则 `cachedImageSrc(part.url, thumbWidth(显示宽))`（过渡，保留骨架）。
- 有宽高 → 外层盒 `style={{ aspectRatio: w/h }}` + `max-w/max-h` 上限；无宽高 → 退回固定 192 方盒（向后兼容）。
- 单层 `rounded-xl ring-1 ring-workbench-line`（四边一致）+ `object-contain`（不裁切）。
- asset `onError` → 回退 `cachedImageSrc(part.url)`。

- [ ] **Step 1: 先跑 impact**

```
gitnexus_impact({target: "MessageImage", direction: "upstream", repo: "chathub"})
```

- [ ] **Step 2: 写失败测试（比例盒 + 无骨架）**

`MessageContent.test.tsx` 追加（沿用既有 render 工具）：

```tsx
import { render, screen } from "@testing-library/react";
import { MessageContent } from "./MessageContent";

it("有本地路径+宽高：按比例盒、object-contain、无骨架", () => {
  render(
    <MessageContent
      parts={[
        {
          kind: "image",
          url: "https://filet.jdd51.com/a.png",
          width: 400,
          height: 200,
          localPath: "/c/a.img",
        },
      ]}
    />,
  );
  const img = screen.getByRole("img", { hidden: true }) as HTMLImageElement;
  expect(img.className).toContain("object-contain");
  // 盒子 aspect-ratio = 2
  const box = img.parentElement!;
  expect(box.style.aspectRatio).toBe("2 / 1");
});
```

> 若 jsdom 不解析 `aspect-ratio` 简写，断言改为检查内联 style 字符串包含 `aspect-ratio`。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run frontends/components/workbench/messages/MessageContent.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 重构 MessageImage**

把 `MessageImageProps`/`MessageImage` 改为（保留既有三态注释精神，新增比例盒分支）：

```tsx
interface MessageImageProps {
  part: ImagePart;
  alt: string;
  /** 显示上限（px）。 */
  maxW?: number;
  maxH?: number;
}

function MessageImage({ part, alt, maxW = 256, maxH = 320 }: MessageImageProps) {
  const local = assetImageSrc(part.localPath);
  const fallback = cachedImageSrc(part.url, thumbWidth(maxW * 2));
  const [useFallback, setUseFallback] = useState(false);
  const src = !useFallback && local ? local : fallback;
  const hasDims = !!(part.width && part.height);
  const isLocal = !useFallback && !!local;

  const initialState = isSafeUrl(part.url, "image") ? (isLocal ? "loaded" : "loading") : "error";
  const [state, setState] = useState<"loading" | "loaded" | "error">(initialState);
  const [lastSrc, setLastSrc] = useState(src);
  if (lastSrc !== src) {
    setLastSrc(src);
    setState(isLocal ? "loaded" : isSafeUrl(part.url, "image") ? "loading" : "error");
  }

  const imgRef = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    if (state !== "loading") return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setState("loaded");
  }, [src, state]);

  if (state === "error") {
    return (
      /* 沿用既有失败卡片，但盒尺寸用比例盒或 192 */
      <span
        role="img"
        aria-label={STRINGS.attachment.imageLoadFailed}
        className="grid place-items-center rounded-xl bg-workbench-surface-soft text-wb-3xs text-workbench-text-muted ring-1 ring-workbench-line"
        style={
          hasDims
            ? {
                aspectRatio: `${part.width} / ${part.height}`,
                maxWidth: maxW,
                maxHeight: maxH,
                width: "100%",
              }
            : { width: 192, height: 192 }
        }
      >
        <span className="flex flex-col items-center gap-1.5">
          <ImageOff size={22} strokeWidth={1.5} aria-hidden />
          <span>{STRINGS.attachment.imageLoadFailed}</span>
        </span>
      </span>
    );
  }

  const boxStyle = hasDims
    ? {
        aspectRatio: `${part.width} / ${part.height}`,
        maxWidth: maxW,
        maxHeight: maxH,
        width: "100%",
      }
    : { width: 192, height: 192 };

  return (
    <span
      className="relative inline-block overflow-hidden rounded-xl ring-1 ring-workbench-line"
      style={boxStyle}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setState("loaded")}
        onError={() => {
          if (isLocal) setUseFallback(true);
          else setState("error");
        }}
        className={cn("block h-full w-full object-contain", state !== "loaded" && "opacity-0")}
      />
      {state === "loading" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-pulse bg-workbench-surface-soft"
        />
      )}
    </span>
  );
}
```

import 顶部增：`import { assetImageSrc } from "@/lib/assetImageSrc";`

更新三处调用为传 part：`<MessageImage part={part} alt={...} />`（`ImageStandalone`/`ImageAttachment` 去掉 `imgClassName`，`InlineImage` 也统一用 `MessageImage` 以消除样式分叉）。

- [ ] **Step 5: 跑测试确认通过 + 全量前端测试**

Run: `pnpm vitest run frontends/components/workbench/messages/` → PASS。

- [ ] **Step 6: detect_changes + commit**

```bash
git add frontends/components/workbench/messages/MessageContent.tsx frontends/components/workbench/messages/MessageContent.test.tsx
git commit -m "feat(messages): 图片比例盒渲染+四边一致样式+asset 源与回退（R1/R2/R4）"
```

---

### Task 2.4：ImageLightbox 单图灯箱（R5）

**Files:**

- Create: `frontends/components/workbench/messages/ImageLightbox.tsx`
- Modify: `frontends/components/workbench/messages/MessageContent.tsx`（三处入口点击打开灯箱）
- Test: `frontends/components/workbench/messages/ImageLightbox.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageLightbox } from "./ImageLightbox";

it("展示原图、Esc 关闭、有下载按钮", () => {
  const onClose = vi.fn();
  render(<ImageLightbox src="https://filet.jdd51.com/a.png" alt="a" onClose={onClose} />);
  expect((screen.getByAltText("a") as HTMLImageElement).src).toContain("a.png");
  expect(screen.getByRole("link", { name: /下载|download/i })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run frontends/components/workbench/messages/ImageLightbox.test.tsx` → FAIL。

- [ ] **Step 3: 实现 ImageLightbox**

```tsx
import { useEffect } from "react";
import { Download, X } from "lucide-react";
import { createPortal } from "react-dom";
import { STRINGS } from "./strings";

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
    >
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
      <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
        <a
          href={src}
          download
          target="_blank"
          rel="noopener noreferrer"
          aria-label={STRINGS.attachment.download}
          className="focus-ring grid size-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <Download size={18} aria-hidden />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="focus-ring grid size-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run frontends/components/workbench/messages/ImageLightbox.test.tsx` → PASS。

- [ ] **Step 5: 接线到三处入口**

`MessageContent.tsx` 顶层加 `const [preview, setPreview] = useState<string | null>(null);` 不适用（函数组件分散）。改为：在 `MessageContent` 组件内提供一个 context 或在每个图片入口本地管理。最小实现：把 `ImageStandalone`/`ImageAttachment`/`InlineImage` 各自的外层 `<a target=_blank>` 换成 `<button onClick={() => setOpen(true)}>`，组件内 `const [open, setOpen] = useState(false)`，`open && isSafeUrl(part.url,"image") && <ImageLightbox src={part.url} alt={...} onClose={() => setOpen(false)} />`。不安全 URL 不开灯箱。

- [ ] **Step 6: 跑全量 + commit**

Run: `pnpm vitest run frontends/components/workbench/messages/` → PASS。

```bash
git add frontends/components/workbench/messages/ImageLightbox.tsx frontends/components/workbench/messages/ImageLightbox.test.tsx frontends/components/workbench/messages/MessageContent.tsx
git commit -m "feat(messages): 单图灯箱预览（点击放大/Esc 关/下载）（R5）"
```

---

## Part 3 — 后端 image_meta + 预取 + asset（组 B，后端；A 之后）

### Task 3.1：V19 迁移 + ImageMetaStore

**Files:**

- Create: `backends/crates/chathub-state/migrations/V19__image_meta.sql`
- Create: `backends/crates/chathub-state/src/image_meta.rs`
- Modify: `backends/crates/chathub-state/src/pool.rs:58-64`（注册 V19）、`:115`（业务表数量断言 8→9）
- Modify: `backends/crates/chathub-state/src/lib.rs`（`pub mod image_meta;` + re-export）

- [ ] **Step 1: 迁移 SQL**

`V19__image_meta.sql`：

```sql
CREATE TABLE IF NOT EXISTS hub_image_meta (
  url           TEXT PRIMARY KEY,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  local_path    TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

- [ ] **Step 2: pool.rs 注册 + 表数量断言**

`pool.rs` 迁移 vec 在 V18 后追加：

```rust
                M::up(include_str!("../migrations/V19__image_meta.sql")),
```

`pool.rs:115` 的断言把 `hub_` 业务表数量 `8` 改 `9`，注释补 `+ V19 hub_image_meta`。

- [ ] **Step 3: 写 ImageMetaStore + 测试（TDD：先测后实现）**

`image_meta.rs`：

```rust
//! 图片派生元数据（原始宽高 + 本地缩略图路径），按图片 URL 为键。与服务端附件真相解耦。
use crate::error::StateError;
use crate::pool::SqlitePool;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub url: String,
    pub width: i64,
    pub height: i64,
    pub local_path: String,
    pub updated_at_ms: i64,
}

#[derive(Clone)]
pub struct ImageMetaStore { pool: SqlitePool }

impl ImageMetaStore {
    pub fn new(pool: SqlitePool) -> Self { Self { pool } }

    pub async fn upsert(&self, m: ImageMeta) -> Result<(), StateError> {
        let conn = self.pool.pool().get().await?;
        conn.interact(move |c| -> Result<(), StateError> {
            c.execute(
                "INSERT INTO hub_image_meta (url,width,height,local_path,updated_at_ms) \
                 VALUES (?1,?2,?3,?4,?5) ON CONFLICT(url) DO UPDATE SET \
                 width=excluded.width, height=excluded.height, \
                 local_path=excluded.local_path, updated_at_ms=excluded.updated_at_ms",
                rusqlite::params![m.url, m.width, m.height, m.local_path, m.updated_at_ms],
            )?;
            Ok(())
        }).await??;
        Ok(())
    }

    pub async fn get_many(&self, urls: Vec<String>) -> Result<HashMap<String, ImageMeta>, StateError> {
        if urls.is_empty() { return Ok(HashMap::new()); }
        let conn = self.pool.pool().get().await?;
        let out = conn.interact(move |c| -> Result<HashMap<String, ImageMeta>, StateError> {
            let mut map = HashMap::new();
            let mut stmt = c.prepare(
                "SELECT url,width,height,local_path,updated_at_ms FROM hub_image_meta WHERE url = ?1")?;
            for u in &urls {
                if let Ok(m) = stmt.query_row(rusqlite::params![u], |r| Ok(ImageMeta {
                    url: r.get(0)?, width: r.get(1)?, height: r.get(2)?,
                    local_path: r.get(3)?, updated_at_ms: r.get(4)?,
                })) { map.insert(u.clone(), m); }
            }
            Ok(map)
        }).await??;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn upsert_get_round_trip() {
        let pool = SqlitePool::in_memory().await.unwrap();
        let s = ImageMetaStore::new(pool);
        s.upsert(ImageMeta { url: "u1".into(), width: 400, height: 200,
            local_path: "/c/a.img".into(), updated_at_ms: 1 }).await.unwrap();
        let m = s.get_many(vec!["u1".into(), "u2".into()]).await.unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["u1"].width, 400);
    }
}
```

`lib.rs`（chathub-state）增 `pub mod image_meta;` 与 `pub use image_meta::{ImageMeta, ImageMetaStore};`。

- [ ] **Step 4: 跑测试**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-state image_meta && cargo test -p chathub-state in_memory_pool_applies_all_migrations`
Expected: PASS（含表数量断言 9）。

- [ ] **Step 5: Commit**

```bash
git add backends/crates/chathub-state/migrations/V19__image_meta.sql backends/crates/chathub-state/src/image_meta.rs backends/crates/chathub-state/src/pool.rs backends/crates/chathub-state/src/lib.rs
git commit -m "feat(state): 新增 hub_image_meta 表 + ImageMetaStore（V19）"
```

---

### Task 3.2：HistoryAttachment 增宽高/本地路径字段

**Files:**

- Modify: `backends/crates/chathub-net/src/hub.rs:744-757`（`HistoryAttachment`）

- [ ] **Step 1: 加字段**

`HistoryAttachment` struct 末尾追加：

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
```

- [ ] **Step 2: 编译 + 既有附件解析测试仍绿**

Run: `cd backends && env -u ALL_PROXY cargo test -p chathub-net attachments`（或 hub.rs 内既有附件用例）。Expected: PASS（新字段 default None，不破坏既有反序列化）。

- [ ] **Step 3: Commit**

```bash
git add backends/crates/chathub-net/src/hub.rs
git commit -m "feat(net): HistoryAttachment 增 width/height/localPath 可选字段"
```

---

### Task 3.3：ImageCache 捕获原始宽高 + prefetch

**Files:**

- Modify: `backends/src/image_cache.rs`（`encode_thumbnail` 返回原始宽高；新增 `prefetch`）
- Test: `backends/src/image_cache.rs`（`#[cfg(test)]`，用内嵌小 PNG 字节）

- [ ] **Step 1: 先跑 impact**

```
gitnexus_impact({target: "encode_thumbnail", direction: "upstream", repo: "chathub"})
gitnexus_impact({target: "get", direction: "upstream", repo: "chathub"})
```

- [ ] **Step 2: 写失败测试（解码原始宽高）**

`image_cache.rs` 追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // 2x1 红色 PNG（运行期用 image crate 生成，免外部文件）
    fn png_2x1() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let img = image::RgbImage::from_pixel(2, 1, image::Rgb([255, 0, 0]));
        image::DynamicImage::ImageRgb8(img).write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }
    #[test]
    fn encode_thumbnail_reports_original_dims() {
        let (out, dims) = encode_thumbnail(&png_2x1(), 64).unwrap();
        assert_eq!(dims, (2, 1), "返回原始宽高");
        assert!(!out.bytes.is_empty());
    }
}
```

- [ ] **Step 3: 跑确认失败**

Run: `cd backends && env -u ALL_PROXY cargo test image_cache::tests::encode_thumbnail_reports_original_dims`
Expected: FAIL（签名不返回 dims）。

- [ ] **Step 4: 改 encode_thumbnail 返回 dims + 新增 prefetch**

`image_cache.rs` 顶部 `use image::GenericImageView;`。
`encode_thumbnail` 改签名为 `-> Result<(CachedImage, (u32, u32)), String>`，内部：

```rust
    let img = image::load_from_memory(raw).map_err(|e| format!("decode: {e}"))?;
    let (ow, oh) = img.dimensions();
    // ...原缩略图编码逻辑不变...
    Ok((CachedImage { bytes: ..., mime: ... }, (ow, oh)))
```

`get()` 内调用点改为 `let (out, _dims) = ...encode_thumbnail(&raw, width)...?;`（serve 路径不需要 dims）。

新增方法（在 `impl ImageCache`）：

```rust
    /// 预取：确保 url 的缩略图落盘，返回 (原始宽, 原始高, 本地路径)。命中即读盘 + 解码原图取 dims。
    pub async fn prefetch(&self, url: &str, width: u32) -> Result<(u32, u32, String), String> {
        validate_url(url)?;
        let width = width.clamp(16, 1024);
        let path = self.key_path(url, width);
        let raw = self.download(url).await?; // 取原图（dims 必须从原图取）
        let path2 = path.clone();
        let dims = tauri::async_runtime::spawn_blocking(move || {
            let (out, dims) = encode_thumbnail(&raw, width)?;
            write_atomic(&path2, &out.bytes);
            Ok::<(u32, u32), String>(dims)
        }).await.map_err(|e| format!("join: {e}"))??;
        Ok((dims.0, dims.1, path.to_string_lossy().into_owned()))
    }
```

> 说明：prefetch 总是下载一次原图以取得真实 dims（缩略图文件无法反推原始比例）。命中文件仍会被覆盖写（幂等），可接受。

- [ ] **Step 5: 跑确认通过**

Run: `cd backends && env -u ALL_PROXY cargo test image_cache`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add backends/src/image_cache.rs
git commit -m "feat(image_cache): encode_thumbnail 返回原始宽高 + 新增 prefetch"
```

---

### Task 3.4：读命令注入 image_meta + 后台预取 + ChangeNotice

**Files:**

- Modify: `backends/src/lib.rs`（`load_conversation_messages` / `load_older_messages` 注入；setup manage 新 store；asset scope；命令签名加 State）
- Modify: `backends/tauri.conf.json`（assetProtocol）
- Modify: `backends/Cargo.toml` / `backends/src/lib.rs`（引 `ImageMetaStore`）

预取与注入辅助直接写在 `lib.rs`（或新 `backends/src/image_prefetch.rs`）：

- [ ] **Step 1: 先跑 impact**

```
gitnexus_impact({target: "load_conversation_messages", direction: "upstream", repo: "chathub"})
```

- [ ] **Step 2: 注入辅助 + 预取（新文件 image_prefetch.rs）**

`backends/src/image_prefetch.rs`：

```rust
//! 图片元数据注入 + 后台预取（去重）。读命令构好 records 后调用。
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use chathub_net::change_notice::ChangeNotice;
use chathub_net::hub::HistoryMessage; // 若 HistoryMessage 不在 hub pub，改从对应 path 导出
use chathub_state::ImageMetaStore;
use tauri::async_runtime;
use tokio::sync::broadcast;

const ATTACHMENT_BASE_URL: &str = "https://filet.jdd51.com";
const THUMB_W: u32 = 512;

/// media_id(objectName) → 完整 https URL（与前端 attachmentPreviewUrl 同构）。
pub fn image_url(media_id: &str) -> Option<String> {
    if media_id.is_empty() { return None; }
    if media_id.starts_with("http://") || media_id.starts_with("https://") {
        return Some(media_id.to_string());
    }
    Some(format!("{ATTACHMENT_BASE_URL}/{}", media_id.trim_start_matches('/')))
}

fn is_image(file_type: &str) -> bool {
    matches!(file_type.to_lowercase().as_str(), "jpg"|"jpeg"|"png"|"gif"|"webp")
}

#[derive(Clone)]
pub struct ImagePrefetcher {
    cache: Arc<crate::image_cache::ImageCache>,
    meta: ImageMetaStore,
    change_tx: broadcast::Sender<ChangeNotice>,
    inflight: Arc<Mutex<HashSet<String>>>,
}

impl ImagePrefetcher {
    pub fn new(cache: Arc<crate::image_cache::ImageCache>, meta: ImageMetaStore,
               change_tx: broadcast::Sender<ChangeNotice>) -> Self {
        Self { cache, meta, change_tx, inflight: Arc::new(Mutex::new(HashSet::new())) }
    }

    /// 注入命中的 meta 进 records；对缺失的图片 URL 后台预取，完成后发通知让会话重读。
    pub async fn enrich_and_prefetch(&self, records: &mut [HistoryMessage],
                                     conversation_id: &str, employee_id: &str) {
        // 1. 收集图片 URL
        let urls: Vec<String> = records.iter()
            .flat_map(|r| r.attachments.iter())
            .filter(|a| is_image(&a.file_type))
            .filter_map(|a| image_url(&a.media_id))
            .collect();
        if urls.is_empty() { return; }
        // 2. 查 meta 注入
        let metas = self.meta.get_many(urls.clone()).await.unwrap_or_default();
        for r in records.iter_mut() {
            for a in r.attachments.iter_mut() {
                if !is_image(&a.file_type) { continue; }
                if let Some(u) = image_url(&a.media_id) {
                    if let Some(m) = metas.get(&u) {
                        a.width = Some(m.width); a.height = Some(m.height);
                        a.local_path = Some(m.local_path.clone());
                    }
                }
            }
        }
        // 3. 缺失的后台预取（去重）
        let missing: Vec<String> = urls.into_iter().filter(|u| !metas.contains_key(u)).collect();
        if missing.is_empty() { return; }
        let this = self.clone();
        let conv = conversation_id.to_string();
        let emp = employee_id.to_string();
        async_runtime::spawn(async move {
            let mut did = false;
            for u in missing {
                { let mut g = this.inflight.lock().unwrap();
                  if g.contains(&u) { continue; } g.insert(u.clone()); }
                let res = this.cache.prefetch(&u, THUMB_W).await;
                this.inflight.lock().unwrap().remove(&u);
                if let Ok((w, h, path)) = res {
                    let _ = this.meta.upsert(chathub_state::ImageMeta {
                        url: u, width: w as i64, height: h as i64,
                        local_path: path, updated_at_ms: now_ms(),
                    }).await;
                    did = true;
                }
            }
            if did {
                let _ = this.change_tx.send(ChangeNotice::server_upsert(&emp, &conv));
            }
        });
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
```

> 注：`ChangeNotice::server_upsert(&emp, &conv)` 的确切签名以 `change_notice.rs` 为准（message_sync.rs:263 有调用样例，照抄参数形态）。`HistoryMessage` 的导出路径以 `chathub-net` 的 `pub use` 为准。

- [ ] **Step 3: 读命令接入**

`lib.rs::load_conversation_messages`（在 `let mut records ... = rows.iter().map(row_to_history).collect();` 之后、返回之前）：

```rust
    image_prefetcher.enrich_and_prefetch(&mut records, &conversation_id, &employee_id).await;
```

命令签名增参：`image_prefetcher: State<'_, ImagePrefetcher>,`。`load_older_messages` 同样处理（拿到 records 后注入）。

- [ ] **Step 4: setup 接线（manage + asset scope）**

`lib.rs:1373` 之后：

```rust
    let img_cache = Arc::new(image_cache::ImageCache::new(img_cache_dir.clone()));
    app.manage(img_cache.clone());
    // asset 协议授权该目录（程序化，避免配置路径变量平台差异）
    app.asset_protocol_scope().allow_directory(&img_cache_dir, true)?;
```

在 SQLite/endpoint 初始化拿到 `pool` / `change_notice_tx` 后：

```rust
    let image_meta = chathub_state::ImageMetaStore::new(pool.clone());
    app.manage(image_meta.clone());
    app.manage(crate::image_prefetch::ImagePrefetcher::new(img_cache, image_meta, change_notice_tx.clone()));
```

`lib.rs` 顶部 `mod image_prefetch;`，invoke_handler 不需改（命令已注册）。

- [ ] **Step 5: tauri.conf.json 启用 asset**

`app.security` 改为：

```json
    "security": {
      "csp": null,
      "assetProtocol": { "enable": true, "scope": [] }
    }
```

- [ ] **Step 6: 编译 + 现有命令测试**

Run: `cd backends && env -u ALL_PROXY cargo build && cargo test -p chathub-net`
Expected: 编译通过、无回归。

- [ ] **Step 7: detect_changes + commit**

```bash
git add backends/src/lib.rs backends/src/image_prefetch.rs backends/tauri.conf.json
git commit -m "feat(messages): 读命令注入 image_meta + 后台预取 + asset 协议（读本地、消闪）"
```

---

## Part 4 — 联调与真机验证

### Task 4.1：端到端手测（mac，必要时 win）

- [ ] **Step 1: 启动**

Run: `pnpm tauri dev`（或项目既有命令；Tauri 配置在 `backends/tauri.conf.json`）。

- [ ] **Step 2: 核对清单**
- [ ] 历史消息出/入站方向正确（自己发的靠右、客户的靠左）。
- [ ] 图片按原比例显示、不裁切；四边圆角/边框一致。
- [ ] 首次进会话图片下载后，**切走再切回不再闪**；长会话滚动不再闪。
- [ ] 点击图片弹灯箱看原图，Esc/点遮罩关闭，下载按钮可用。
- [ ] asset 加载失败（手动删 img-cache 某文件）能回退 `cachedimg://` 重新下载。

- [ ] **Step 3: 最终核对 + 收尾**

```
gitnexus_detect_changes()
```

确认仅命中预期符号/流程。按需 `superpowers:finishing-a-development-branch` 收尾（合并/PR）。

---

## 自查（Self-Review）

- **Spec 覆盖**：R1 比例盒(2.3) / R2 asset+无骨架(2.3+3.4) / R3 image_meta+本地路径(3.1/3.4) / R4 四边一致(2.3) / R5 灯箱(2.4) / B1 方向(1.1)+自愈(1.2)。✅ 全覆盖。
- **类型一致**：`ImageMeta`/`ImageMetaStore`/`ImagePrefetcher.enrich_and_prefetch`/`assetImageSrc`/`MessageImage(part)` 命名前后一致。
- **占位符**：无 TODO/TBD；关键代码均给出。两处以"确切签名以 X 为准"标注的（`ChangeNotice::server_upsert`、`HistoryMessage` 导出路径、`asset_protocol_scope` API）属**对照既有代码核对**，实现时照 message_sync.rs:263 / chathub-net `pub use` / Tauri v2 文档落地，非逻辑留空。
- **风险点**：asset scope 平台差异、tauri#2952 内存 → Task 4.1 真机验证。
