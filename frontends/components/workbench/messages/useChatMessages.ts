import { useCallback, useMemo, useState } from "react";

import type { Message } from "./data";

// ─── Chat messages fetch hook ───────────────────────────────────────────────
//
// Mock mode resolves synchronously, so messages are derived from props during
// render — no skeleton flash on conversation switch, no flash of the previous
// conversation's messages under the new header. A per-conversationId cache
// keeps repeated visits O(1).
//
// When wiring a real backend: replace the synchronous body of `messages` with
// a useEffect-based async fetch and re-introduce a `loading` state machine.
// The cache + retry contract stays the same.

interface UseChatMessagesResult {
  messages: Message[];
  loading: boolean;
  error: Error | null;
  retry: () => void;
}

interface UseChatMessagesOptions {
  /** Map containing message arrays keyed by conversation id (mock store). */
  source: Record<string, Message[]>;
  conversationId: string;
}

export function useChatMessages({
  source,
  conversationId,
}: UseChatMessagesOptions): UseChatMessagesResult {
  const [retryNonce, setRetryNonce] = useState(0);

  const messages = useMemo(() => {
    // Keep retryNonce in the dependency graph so the public retry contract
    // remains stable when this mock hook is replaced with an async fetcher.
    void retryNonce;
    return source[conversationId] ?? [];
    // retryNonce is intentionally a dep: bumping it (after cache eviction in
    // `retry`) forces a re-read so the new fetch result lands in the cache.
  }, [conversationId, source, retryNonce]);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return { messages, loading: false, error: null, retry };
}
