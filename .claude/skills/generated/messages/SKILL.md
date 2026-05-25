---
name: messages
description: "Skill for the Messages area of chathub. 208 symbols across 50 files."
---

# Messages

208 symbols | 50 files | Cohesion: 81%

## When to Use

- Working with code in `frontends/`
- Understanding how useCustomerSelection, createMentionExtension, blocksToDoc work
- Modifying messages-related functionality

## Key Files

| File                                                              | Symbols                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `frontends/components/workbench/messages/useDraftStore.ts`        | useDraft, useFileAttachments, scheduleWrite, touchLRU, emit (+25)                                           |
| `frontends/components/workbench/messages/MessageBubble.tsx`       | DateDivider, UnreadDivider, messageAriaText, MessageBubble, RecalledLine (+8)                               |
| `frontends/components/workbench/messages/utils.ts`                | formatMessageTime, formatMessageDateTime, collectMatches, formatRichText, isSafeUrl (+8)                    |
| `frontends/components/workbench/messages/MessageComposer.tsx`     | clampComposerHeight, MessageComposer, insertImageFiles, handleImagePicker, removePendingFileAttachment (+7) |
| `frontends/components/workbench/messages/MessageContent.tsx`      | MessageContent, PartCard, ImageAttachment, FileAttachment, VoiceAttachment (+7)                             |
| `frontends/components/workbench/messages/MessagesPage.tsx`        | formatRelativeTime, clampField, adaptEntryToConversation, extractDraftPreview, extractTextFromNode (+5)     |
| `frontends/components/workbench/messages/AccountDropdown.tsx`     | AccountDropdown, handleSelect, SearchBox, Group, AllAccountsRow (+4)                                        |
| `frontends/components/workbench/messages/useDetailsWindow.ts`     | waitForLayoutFrame, closeDetailsWithWindowResize, lockCurrentChatWidth, toggleDetails, isTauriRuntime (+2)  |
| `frontends/components/workbench/messages/composer/docToBlocks.ts` | flushText, visit, blocksToDoc, currentContent, startNewParagraph (+1)                                       |
| `frontends/components/workbench/messages/useComposerPrefs.ts`     | useComposerPrefs, loadComposerPrefs, saveComposerPrefs, onStorage, setSilent (+1)                           |

## Entry Points

Start here when exploring this area:

- **`useCustomerSelection`** (Function) — `frontends/components/workbench/customers/useCustomerSelection.ts:32`
- **`createMentionExtension`** (Function) — `frontends/components/workbench/messages/composer/MentionExtension.ts:15`
- **`blocksToDoc`** (Function) — `frontends/components/workbench/messages/composer/docToBlocks.ts:65`
- **`currentContent`** (Function) — `frontends/components/workbench/messages/composer/docToBlocks.ts:71`
- **`startNewParagraph`** (Function) — `frontends/components/workbench/messages/composer/docToBlocks.ts:76`

## Key Symbols

| Symbol                        | Type     | File                                                                   | Line |
| ----------------------------- | -------- | ---------------------------------------------------------------------- | ---- |
| `useCustomerSelection`        | Function | `frontends/components/workbench/customers/useCustomerSelection.ts`     | 32   |
| `createMentionExtension`      | Function | `frontends/components/workbench/messages/composer/MentionExtension.ts` | 15   |
| `blocksToDoc`                 | Function | `frontends/components/workbench/messages/composer/docToBlocks.ts`      | 65   |
| `currentContent`              | Function | `frontends/components/workbench/messages/composer/docToBlocks.ts`      | 71   |
| `startNewParagraph`           | Function | `frontends/components/workbench/messages/composer/docToBlocks.ts`      | 76   |
| `docToBlocks`                 | Function | `frontends/components/workbench/messages/composer/docToBlocks.ts`      | 104  |
| `useDraft`                    | Function | `frontends/components/workbench/messages/useDraftStore.ts`             | 349  |
| `useFileAttachments`          | Function | `frontends/components/workbench/messages/useDraftStore.ts`             | 434  |
| `useEscKey`                   | Function | `frontends/lib/useEscKey.ts`                                           | 25   |
| `EmojiPicker`                 | Function | `frontends/components/workbench/messages/EmojiPicker.tsx`              | 70   |
| `MessageComposer`             | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 75   |
| `insertImageFiles`            | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 175  |
| `handleImagePicker`           | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 203  |
| `removePendingFileAttachment` | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 220  |
| `handleScreenshot`            | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 227  |
| `handlePointerMove`           | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 288  |
| `handleResizeKeyDown`         | Function | `frontends/components/workbench/messages/MessageComposer.tsx`          | 318  |
| `AiPolishPopover`             | Function | `frontends/components/workbench/messages/composer/AiPolishPopover.tsx` | 23   |
| `RichComposer`                | Function | `frontends/components/workbench/messages/composer/RichComposer.tsx`    | 30   |
| `useChatActions`              | Function | `frontends/components/workbench/messages/hooks/useChatActions.ts`      | 43   |

## Execution Flows

| Flow                                      | Type            | Steps |
| ----------------------------------------- | --------------- | ----- |
| `CustomersPage → ScopeMatches`            | cross_community | 6     |
| `MessagesContactSearch → ScopeMatches`    | cross_community | 6     |
| `MessagesContactSearch → PickAvatarColor` | cross_community | 6     |
| `Main → SafeWindow`                       | cross_community | 6     |
| `Main → StripNode`                        | cross_community | 6     |
| `RenderRowContent → IsSameLocalDay`       | cross_community | 6     |
| `RenderRowContent → Cn`                   | cross_community | 6     |
| `MessagesPage → ErrorMessage`             | cross_community | 5     |
| `CustomersPage → ErrorMessage`            | cross_community | 5     |
| `ChatArea → IsSameLocalDay`               | cross_community | 5     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Customers  | 25 calls    |
| Tests      | 4 calls     |
| Data       | 3 calls     |
| Api        | 2 calls     |
| Cluster_60 | 1 calls     |
| Build\_    | 1 calls     |
| Store      | 1 calls     |
| Components | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "useCustomerSelection"})` — see callers and callees
2. `gitnexus_query({query: "messages"})` — find related execution flows
3. Read key files listed above for implementation details
