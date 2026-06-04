# 出站失败气泡持久化 — 前端 IPC 接线（Plan B）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端任一 markFailed 接到 Plan A 的 `persist_outbox_failure` IPC，端到端打通「失败气泡重启不丢」；never-uploaded 失败行拦截重发；重发前 `clear_outbox_row`。

**Architecture:** useChatActions 在所有失败点经统一 choke point `failBubble` 既 markFailed 又调 IPC 落库（用前端已渲染好的气泡数据构造 attachments_json，绕开重建）。身份 `wecomAccountId/externalUserId` 经 ChatArea 从 MessagesPage 的 `selectedEntry` 透传进 useChatActions；IPC 包装加在 messageHistory.ts（同 `uploadAttachment` 范式）。**依赖 Plan A**（命令已落地）。

**Tech Stack:** TypeScript / React / Zustand / Tauri invoke / Vitest。设计依据：`docs/superpowers/specs/2026-06-05-outbox-failed-bubble-design.md`（§0/§1/§2）。

**前置约定：**

- 分支 `feat/outbox-failed-bubble`，Plan A 已实现（`persist_outbox_failure`/`clear_outbox_row` 命令已注册）。
- `pnpm`/`vitest` cwd = 仓库根目录。
- 提交**只显式 `git add` 改动文件，绝禁 `git add -A`/`git add .`**。

---

## 关键事实（已核当前代码）

- markFailed 5 处（`useChatActions.ts`）：`:300`（resp send_status=4）、`:317`（deliverMessage catch）、`:344`（语音转码/超限）、`:375`（上传 catch）、`:459`（fail-stop 级联）。各处已有失败原因可复用（`STRINGS.errors.sendFailed` / `sendFailReason(err)` / `voice.reason`）。
- 乐观气泡字段（`:413-429`）：id=clientMsgId、conversationId、direction out、text、parts、sentAt(ISO)、status、messageType、fileName、fileSize；filePath 仅上传成功后 `patchMessage`（`:369`）。
- 身份 `wecomAccountId/externalUserId` 不在 useChatActions；MessagesPage `selectedEntry.wecomAccountId/externalUserId`（`:368-369` handleSendMessage 闭包）。
- `HistoryAttachment`（messageHistory.ts:73）camelCase：`mediaId/fileName/fileSize/attachmentType(1图2文件3语音4视频)/fileType/width?/height?/durationSeconds?`。`attachmentType` ≠ messageType（2图3文件4语音）→ **须映射**。
- IPC 范式：`invokeWithTimeout(cmd, camelCaseArgs, timeout)`（messageHistory.ts:222）。Tauri 自动 camel↔snake。

---

## File Structure

| 文件                                                                   | 改动                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `frontends/lib/api/messageHistory.ts`                                  | 加 `persistOutboxFailure` / `clearOutboxRow` IPC 包装                                                                   |
| `frontends/components/workbench/messages/strings.ts`                   | 加 never-uploaded toast 文案                                                                                            |
| `frontends/components/workbench/messages/hooks/useChatActions.ts`      | 身份 props + failBubble + attachments 构造 + 5 处 markFailed 改 failBubble + never-uploaded 重发拦截 + 重发 clearOutbox |
| `frontends/components/workbench/messages/ChatArea.tsx`                 | 透传 wecomAccountId/externalUserId                                                                                      |
| `frontends/components/workbench/messages/MessagesPage.tsx`             | `<ChatArea>` 传 wecomAccountId/externalUserId                                                                           |
| `frontends/components/workbench/messages/hooks/useChatActions.test.ts` | failBubble 调 IPC / never-uploaded 拦截 测试                                                                            |

---

## Task 1: messageHistory.ts — 两个 IPC 包装

**Files:** Modify `frontends/lib/api/messageHistory.ts`

- [ ] **Step 1: 加包装**（紧接 `uploadAttachment`（约 :251）之后，同 `invokeWithTimeout` 范式）

```ts
/** 前端任一发送失败时把失败气泡落本地库(send_status=4)。对齐 Rust `persist_outbox_failure`。 */
export async function persistOutboxFailure(params: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
  clientMsgId: string;
  /** 乐观气泡 sentAt 的 epoch-ms(同源,供后端 sort_key/message_time_ms)。 */
  sentAtMs: number;
  messageType: number;
  contentText: string;
  failReason: string;
  /** 由前端 parts 序列化的 HistoryAttachment[] JSON 串;纯文本传 "[]"。 */
  attachmentsJson: string;
}): Promise<void> {
  return invokeWithTimeout<void>("persist_outbox_failure", { ...params }, SEND_TIMEOUT_MS);
}

/** 重发前删本地失败行(让气泡回纯乐观 sending)。对齐 Rust `clear_outbox_row`。 */
export async function clearOutboxRow(params: {
  conversationId: string;
  clientMsgId: string;
}): Promise<void> {
  return invokeWithTimeout<void>("clear_outbox_row", { ...params }, SEND_TIMEOUT_MS);
}
```

- [ ] **Step 2: 类型检查** — `pnpm tsc --noEmit`（应无错；`SEND_TIMEOUT_MS`/`invokeWithTimeout` 已在本文件作用域）。
- [ ] **Step 3: 提交** — `git add frontends/lib/api/messageHistory.ts && git commit -m "feat(api): persistOutboxFailure + clearOutboxRow IPC 包装" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Task 2: strings.ts — never-uploaded 文案

**Files:** Modify `frontends/components/workbench/messages/strings.ts`

- [ ] **Step 1:** 在 `toast: { ... }` 块内（约 :92 附近）追加一行：

```ts
    outboxReselectFile: "该附件未上传成功，请重新选择文件后发送",
```

- [ ] **Step 2: 提交** — `git add frontends/components/workbench/messages/strings.ts && git commit -m "feat(messages): 加 never-uploaded 重发提示文案" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Task 3: useChatActions.ts — failBubble + 身份 props + 重发拦截/清行（核心）

**Files:** Modify `frontends/components/workbench/messages/hooks/useChatActions.ts`

- [ ] **Step 1: 导入 IPC 包装** — 把顶部 `import { SEND_STATUS, uploadAttachment, type SendMessageResp } from "@/lib/api/messageHistory";`（:13）改为：

```ts
import {
  clearOutboxRow,
  persistOutboxFailure,
  SEND_STATUS,
  uploadAttachment,
  type SendMessageResp,
} from "@/lib/api/messageHistory";
```

- [ ] **Step 2: 加身份 props** — `UseChatActionsParams`（:41）追加两个可选字段：

```ts
  /** 当前会话归属账号/客户;失败落库 IPC 需要(缺则降级为仅内存 markFailed)。 */
  wecomAccountId?: string;
  externalUserId?: string;
```

并在 `useChatActions({ ... })` 解构（:262-268）加 `wecomAccountId, externalUserId,`。

- [ ] **Step 3: 加 attachmentType 映射 + attachments_json 构造**（放在 `sendFailReason` 之后、`useChatActions` 之前）

```ts
// 发送 messageType(2图/3文件/4语音) → 权威 attachmentType(1图/2文件/3语音/4视频);两套编码错位,须显式映射。
function outboxAttachmentType(messageType: number): number {
  switch (messageType) {
    case MSG_TYPE_IMAGE:
      return 1;
    case MSG_TYPE_FILE:
      return 2;
    case MSG_TYPE_VOICE:
      return 3;
    default:
      return 2; // 兜底当文件
  }
}

// 由失败气泡 entity 构造 HistoryAttachment[] JSON(camelCase,与后端 row_to_history 读回对齐)。
// mediaId 取 filePath(objectName,never-uploaded 为空 → 派生不可重发);纯文本 → "[]"。
function buildOutboxAttachmentsJson(entity: Message): string {
  const mt = entity.messageType ?? MSG_TYPE_TEXT;
  if (mt === MSG_TYPE_TEXT) return "[]";
  const imagePart = entity.parts.find((p) => p.kind === "image");
  const att: Record<string, unknown> = {
    mediaId: entity.filePath ?? "",
    fileName: entity.fileName ?? "",
    fileSize: entity.fileSize ?? 0,
    attachmentType: outboxAttachmentType(mt),
    fileType: inferFileSuf(entity.fileName ?? "", imagePart?.url ?? ""),
  };
  if (imagePart && imagePart.kind === "image") {
    if (imagePart.width !== undefined) att.width = imagePart.width;
    if (imagePart.height !== undefined) att.height = imagePart.height;
  }
  if (entity.durationSeconds !== undefined) att.durationSeconds = entity.durationSeconds;
  return JSON.stringify([att]);
}
```

- [ ] **Step 4: 加 failBubble choke point**（在 `useChatActions` 体内、`deliverMessage` 之前）

```ts
// 统一失败处理:既 markFailed(内存即时态),又调 IPC 落本地库(重启不丢)。缺会话身份时降级为
// 仅 markFailed(无法构造行;排序仍由前端修保证不沉底)。IPC 失败仅 warn,绝不阻塞。
const failBubble = useCallback(
  (clientMsgId: string, failReason: string) => {
    const owningStoreKey = chatStoreKey;
    useChatStore.getState().markFailed(owningStoreKey, clientMsgId);
    if (!wecomAccountId || !externalUserId) return;
    const entity = useChatStore.getState().conversations[owningStoreKey]?.byId[clientMsgId];
    if (!entity) return;
    const sentAtMs = Date.parse(entity.sentAt);
    void persistOutboxFailure({
      conversationId: conversation.id,
      wecomAccountId,
      externalUserId,
      clientMsgId,
      sentAtMs: Number.isNaN(sentAtMs) ? Date.now() : sentAtMs,
      messageType: entity.messageType ?? MSG_TYPE_TEXT,
      contentText: entity.text,
      failReason,
      attachmentsJson: buildOutboxAttachmentsJson(entity),
    }).catch((e) => console.warn("[outbox] persist_outbox_failure 失败(不阻塞)", e));
  },
  [chatStoreKey, conversation.id, wecomAccountId, externalUserId],
);
```

- [ ] **Step 5: 5 处 markFailed 改 failBubble**

逐处把 `useChatStore.getState().markFailed(owningStoreKey, clientMsgId)` / `markFailed(chatStoreKey, ...)` 改为 `failBubble(...)`，复用各处既有失败原因：

1. `:300`（resp send_status=4，在 deliverMessage 内）→ `failBubble(clientMsgId, STRINGS.errors.sendFailed);`
2. `:317`（deliverMessage catch）→ `failBubble(clientMsgId, sendFailReason(err));`
3. `:344`（语音转码/超限，uploadAttachmentUnit 内）→ `failBubble(clientMsgId, voice.reason);`
4. `:375`（上传 catch）→ `failBubble(clientMsgId, sendFailReason(err));`
5. `:459`（fail-stop 级联，handleSend 内 for-j 循环）→ `failBubble(clientMsgIds[j], STRINGS.errors.sendFailed);`

注：`deliverMessage`/`uploadAttachmentUnit` 用 `useCallback`，须把 `failBubble` 加进它们的依赖数组（deliverMessage 依赖数组 `[chatStoreKey, onSendMessage]` → `[chatStoreKey, onSendMessage, failBubble]`；uploadAttachmentUnit `[chatStoreKey]` → `[chatStoreKey, failBubble]`；handleSend 依赖数组加 `failBubble`）。`failBubble` 自身已 useCallback 稳定。

- [ ] **Step 6: 重发 never-uploaded 拦截 + clearOutbox**

在 `handleAction` 的 `case "resend":`（:479）里，`const clientMsgId = entity?.clientMsgId ?? message.id;`（:486）之后、`patchMessage(... status sending ...)`（:487）之前，插入：

```ts
// never-uploaded 拦截:附件类(messageType 2/3/4)但无 filePath(从未上传成功,blob 重启即失效)
// → 不可重发,提示重选文件。纯文本(mt=1/缺省)不拦截。
const mtForGuard = entity?.messageType ?? message.messageType;
const filePathForGuard = entity?.filePath ?? message.filePath;
if (mtForGuard && mtForGuard !== MSG_TYPE_TEXT && !filePathForGuard) {
  showToast(STRINGS.toast.outboxReselectFile, { type: "error" });
  break;
}
// 重发前删本地失败行(避免与新 server 行重影);缺身份则跳过(无落库行可删)。
if (wecomAccountId && externalUserId) {
  void clearOutboxRow({ conversationId: conversation.id, clientMsgId }).catch((e) =>
    console.warn("[outbox] clear_outbox_row 失败(不阻塞)", e),
  );
}
```

并把 `handleAction` 的依赖数组加 `wecomAccountId, externalUserId`。

- [ ] **Step 7: 类型 + lint** — `pnpm tsc --noEmit`、`pnpm eslint frontends/components/workbench/messages/hooks/useChatActions.ts`。无错。

- [ ] **Step 8: 提交** — `git add frontends/components/workbench/messages/hooks/useChatActions.ts && git commit -m "feat(messages): failBubble 落库失败气泡 + never-uploaded 重发拦截 + 重发清行" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Task 4: ChatArea.tsx + MessagesPage.tsx — 透传身份 props

**Files:** Modify `ChatArea.tsx`、`MessagesPage.tsx`

- [ ] **Step 1: ChatArea 加 props** — 在 ChatArea 的 props 接口（约 :40，含 `chatStoreKey`/`onSendMessage` 处）加：

```ts
  wecomAccountId?: string;
  externalUserId?: string;
```

在组件解构（约 :86-103）加 `wecomAccountId, externalUserId,`；在 `useChatActions({ ... })`（:150-153）传入：

```ts
    wecomAccountId,
    externalUserId,
```

- [ ] **Step 2: MessagesPage 传值** — `<ChatArea ... />`（:629）加两个 prop，从 `selectedEntry` 取（与 handleSendMessage 同源）：

```tsx
            wecomAccountId={selectedEntry?.wecomAccountId}
            externalUserId={selectedEntry?.externalUserId}
```

- [ ] **Step 3: 类型** — `pnpm tsc --noEmit`。无错。
- [ ] **Step 4: 提交** — `git add frontends/components/workbench/messages/ChatArea.tsx frontends/components/workbench/messages/MessagesPage.tsx && git commit -m "feat(messages): 透传 wecomAccountId/externalUserId 给 useChatActions(供失败落库)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Task 5: 测试

**Files:** Modify `frontends/components/workbench/messages/hooks/useChatActions.test.ts`

- [ ] **Step 1: 先读既有测试** 确认 mock 范式（既有已 `vi.mock("@/lib/api/messageHistory")` 因为 useChatActions 导入 uploadAttachment/SEND_STATUS；既有用例 enqueueOptimistic + 断言 markSent/markFailed）。在该 mock 里补 `persistOutboxFailure: vi.fn().mockResolvedValue(undefined)`、`clearOutboxRow: vi.fn().mockResolvedValue(undefined)`，并保留 `SEND_STATUS` 真值、`uploadAttachment` 既有 mock。

- [ ] **Step 2: 加用例**（用既有 render/调用范式，传入 `wecomAccountId:"wa"`, `externalUserId:"ext"`）：
  1. **handleSend 失败 → failBubble 调 persistOutboxFailure**：mock onSendMessage 抛错 → 断言 `persistOutboxFailure` 被调用一次，参数含 `clientMsgId`、`messageType:1`、`attachmentsJson:"[]"`、`failReason` 非空。
  2. **缺身份降级**：不传 wecomAccountId → 失败时只 markFailed、`persistOutboxFailure` **不**被调用。
  3. **never-uploaded 重发拦截**：构造一条 messageType=2(图)、无 filePath 的失败 store 气泡 → `handleAction("resend", msg)` → 断言 `showToast` 被以 `outboxReselectFile` 调用、且 `onSendMessage`/`deliverMessage` 未触发。
  4. **重发清行**：可重发(有 filePath)的失败气泡 resend → 断言 `clearOutboxRow` 被调用。

- [ ] **Step 3: 跑测试** — `pnpm vitest run useChatActions`。全绿。变红贴输出。

- [ ] **Step 4: 提交** — `git add frontends/components/workbench/messages/hooks/useChatActions.test.ts && git commit -m "test(messages): failBubble 落库 / never-uploaded 拦截 / 重发清行 用例" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## 验收（Plan B 完成判定）

- [ ] `pnpm tsc --noEmit` 无错；`pnpm vitest run useChatActions chatStore` 全绿；`pnpm eslint` 改动文件无新增告警。
- [ ] e2e 真机：发送本地失败（断网/上传失败）→ 失败气泡出现 → **重启客户端** → 失败气泡仍在、位置正确（Plan C 排序）；可重发的点重发成功收敛；never-uploaded 的点重发提示重选文件。
- [ ] 接待列表对失败会话显示失败态（Plan A mark_local_failed）。

## 已知 / 不做

- requestMessageId 误配守卫（matchedEcho 第一轮加 `status==='failed' continue`，见 Plan C 补遗备注）——本计划落地后若发现重发收敛异常再补，属低概率冷启动竞态。
- 撤回持久化、引用关系(replyTo)持久化：不做（spec §8）。
