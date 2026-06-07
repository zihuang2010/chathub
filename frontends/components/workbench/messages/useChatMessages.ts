import type { MutableRefObject } from "react";

import { useMessageHistory } from "@/lib/api/useMessageHistory";

import type { Message } from "./data";

// ─── Chat messages fetch hook ───────────────────────────────────────────────
//
// 当前对接 `fetch_message_history` Tauri 命令。`useMessageHistory` 内部按
// (wecomAccountId, externalUserId) 启用;两者任一缺省时,enabled=false,本 hook
// 返回空状态。调用方拿到 conversation 时若没有真实 (wecomAccountId,externalUserId)
// (例如空态/未对接路径),应避免渲染 ChatArea。
//
// 设计说明:原版 useChatMessages 双路径(real + mock source) — mock 路径在
// MOCK_MESSAGES_BY_CONVERSATION 删除后已无消费者,本 hook 简化为单一真实路径。

export interface UseChatMessagesResult {
  messages: Message[];
  loading: boolean;
  error: Error | null;
  retry: () => void;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Stage C:窗口顶是否=缓存最旧且服务端无更旧;更旧门控据 !atCacheTop 放行 loadMore。 */
  atCacheTop: boolean;
  storeKey: string;
}

export interface UseChatMessagesOptions {
  /** 当前会话 ID(用于 Message.conversationId 字段填充)。 */
  conversationId: string;
  /** 当前会话归属的企微账号 ID。跟 externalUserId 同时非空时本 hook 启用。 */
  wecomAccountId?: string;
  /** 当前会话对方的 external_user_id;跟 wecomAccountId 一起决定是否启用。 */
  externalUserId?: string;
  /** Stage C:用户贴底实时 ref,透传给 useMessageHistory 供 readCache 判塌缩/缝合。 */
  atBottomRef?: MutableRefObject<boolean>;
}

export function useChatMessages({
  conversationId,
  wecomAccountId,
  externalUserId,
  atBottomRef,
}: UseChatMessagesOptions): UseChatMessagesResult {
  const enabled = !!wecomAccountId && !!externalUserId;
  const real = useMessageHistory({
    wecomAccountId: wecomAccountId ?? "",
    externalUserId: externalUserId ?? "",
    conversationId,
    enabled,
    atBottomRef,
  });
  return {
    messages: real.messages,
    loading: real.loading,
    error: real.error ? new Error(real.error) : null,
    retry: real.retry,
    hasMore: real.hasMore,
    loadMore: real.loadMore,
    atCacheTop: real.atCacheTop,
    storeKey: real.storeKey,
  };
}
