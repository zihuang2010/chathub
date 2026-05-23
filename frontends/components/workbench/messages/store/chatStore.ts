// 聊天消息单一数据真相 store(Stage 4b)。
//
// 取代 ChatArea 的 localMessages 本地副本 + props.messages 权威源「双真相」:消息列表
// 唯一存放于此,按 conversationId 分片。乐观气泡(本地发送中/失败)与服务端权威列表在
// store 内合并去重,渲染端只订阅 store。
//
// 收敛/去重(replaceAuthoritative)是本模块最易错的逻辑,故抽成纯函数并单测:
//   - 权威列表按 sortKey 升序;每条 id = 后端 localMessageId。
//   - 本地乐观实体带 clientMsgId(= 前端生成的 local id);markSent 后再钉上 serverId。
//   - 合并:权威条目优先;尚未被权威收敛(按 id / serverId 判定)的本地乐观气泡保留并
//     追加在末尾(它们是 in-flight 的最新消息),避免「整窗 REPLACE 把发送中气泡抹掉重闪」。

import { create } from "zustand";

import type { Message } from "../data";

export interface ChatMessageEntity extends Message {
  /** 乐观气泡幂等键(= 前端生成的 local id);权威收敛按它 / serverId 匹配。 */
  clientMsgId?: string;
  /** 后端权威 localMessageId(markSent 钉上)。 */
  serverId?: string;
}

export interface ConversationSlice {
  /** entity id 顺序,升序(旧→新)。 */
  order: string[];
  byId: Record<string, ChatMessageEntity>;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export function emptySlice(): ConversationSlice {
  return { order: [], byId: {}, hasMore: false, loading: false, error: null };
}

function findIdByClientMsgId(slice: ConversationSlice, clientMsgId: string): string | undefined {
  for (const id of slice.order) {
    if (slice.byId[id]?.clientMsgId === clientMsgId) return id;
  }
  return undefined;
}

// ─── 纯收敛 reducer(导出供单测) ─────────────────────────────────────────────

/**
 * 用服务端权威列表替换 store 内容,但保留尚未被收敛的本地乐观气泡。
 * 一条乐观气泡被认为「已收敛」当且仅当其 serverId 或 id 命中权威列表 → 此时由权威版本取代
 * (杜绝重复气泡);否则保留并追加在末尾(in-flight 最新消息)。
 */
export function replaceAuthoritative(
  slice: ConversationSlice,
  messages: Message[],
): ConversationSlice {
  const authIds = new Set(messages.map((m) => m.id));
  const pendingLocal = slice.order
    .map((id) => slice.byId[id])
    .filter(
      (e): e is ChatMessageEntity =>
        !!e &&
        e.clientMsgId != null &&
        !(e.serverId != null && authIds.has(e.serverId)) &&
        !authIds.has(e.id),
    );

  const byId: Record<string, ChatMessageEntity> = {};
  const order: string[] = [];
  for (const m of messages) {
    byId[m.id] = { ...m };
    order.push(m.id);
  }
  for (const e of pendingLocal) {
    byId[e.id] = e;
    order.push(e.id);
  }
  return { ...slice, byId, order };
}

/** 往头部 prepend 更旧一页(按 id 去重,已存在的不重复插入)。 */
export function prependOlder(slice: ConversationSlice, older: Message[]): ConversationSlice {
  if (older.length === 0) return slice;
  const existing = new Set(slice.order);
  const fresh = older.filter((m) => !existing.has(m.id));
  if (fresh.length === 0) return slice;
  const byId = { ...slice.byId };
  for (const m of fresh) byId[m.id] = { ...m };
  return { ...slice, byId, order: [...fresh.map((m) => m.id), ...slice.order] };
}

/** 追加一条乐观气泡(发送中)。entity.id 即 clientMsgId。 */
export function enqueueOptimistic(
  slice: ConversationSlice,
  entity: ChatMessageEntity,
): ConversationSlice {
  return {
    ...slice,
    byId: { ...slice.byId, [entity.id]: entity },
    order: [...slice.order, entity.id],
  };
}

/** 发送成功:钉上后端 serverId,status→sent。可带 patch 覆盖服务端回填字段(如 sentAt)。 */
export function markSent(
  slice: ConversationSlice,
  clientMsgId: string,
  serverId: string,
  patch: Partial<Message> = {},
): ConversationSlice {
  const id = findIdByClientMsgId(slice, clientMsgId);
  if (!id) return slice;
  const e = slice.byId[id];
  return {
    ...slice,
    byId: { ...slice.byId, [id]: { ...e, ...patch, serverId, status: "sent" } },
  };
}

/** 发送失败:status→failed(供 context menu resend 复用同 clientMsgId 重发)。 */
export function markFailed(slice: ConversationSlice, clientMsgId: string): ConversationSlice {
  const id = findIdByClientMsgId(slice, clientMsgId);
  if (!id) return slice;
  const e = slice.byId[id];
  return { ...slice, byId: { ...slice.byId, [id]: { ...e, status: "failed" } } };
}

/** 就地 patch 一条(如撤回置 isRecalled)。不存在则 no-op。 */
export function patchEntity(
  slice: ConversationSlice,
  id: string,
  patch: Partial<Message>,
): ConversationSlice {
  const e = slice.byId[id];
  if (!e) return slice;
  return { ...slice, byId: { ...slice.byId, [id]: { ...e, ...patch } } };
}

/** 移除一条(撤回 / 删除)。 */
export function removeEntity(slice: ConversationSlice, id: string): ConversationSlice {
  if (!slice.byId[id]) return slice;
  const byId = { ...slice.byId };
  delete byId[id];
  return { ...slice, byId, order: slice.order.filter((x) => x !== id) };
}

/** 取渲染用的有序列表。 */
export function selectTimeline(slice: ConversationSlice | undefined): ChatMessageEntity[] {
  if (!slice) return [];
  return slice.order.map((id) => slice.byId[id]).filter((e): e is ChatMessageEntity => !!e);
}

// ─── Zustand store(薄壳:取/建分片 + 调纯 reducer) ──────────────────────────

interface ChatStoreState {
  conversations: Record<string, ConversationSlice>;
  replaceAuthoritative(
    conversationId: string,
    messages: Message[],
    meta?: { hasMore?: boolean; error?: string | null },
  ): void;
  prependOlder(conversationId: string, older: Message[], hasMore?: boolean): void;
  enqueueOptimistic(conversationId: string, entity: ChatMessageEntity): void;
  markSent(
    conversationId: string,
    clientMsgId: string,
    serverId: string,
    patch?: Partial<Message>,
  ): void;
  markFailed(conversationId: string, clientMsgId: string): void;
  patchMessage(conversationId: string, id: string, patch: Partial<Message>): void;
  removeMessage(conversationId: string, id: string): void;
  setLoading(conversationId: string, loading: boolean): void;
  setError(conversationId: string, error: string | null): void;
  /** 丢弃单会话切片(遇洞丢旧 / 会话被删)。 */
  clearConversation(conversationId: string): void;
  /** 清空全部(登出 / 切员工:防上一员工消息驻留内存或串台)。 */
  reset(): void;
}

export const useChatStore = create<ChatStoreState>((set) => {
  const update = (conversationId: string, fn: (slice: ConversationSlice) => ConversationSlice) =>
    set((state) => {
      const slice = state.conversations[conversationId] ?? emptySlice();
      return {
        conversations: { ...state.conversations, [conversationId]: fn(slice) },
      };
    });

  return {
    conversations: {},
    replaceAuthoritative: (conversationId, messages, meta) =>
      update(conversationId, (slice) => {
        const next = replaceAuthoritative(slice, messages);
        return {
          ...next,
          hasMore: meta?.hasMore ?? next.hasMore,
          error: meta?.error ?? null,
        };
      }),
    prependOlder: (conversationId, older, hasMore) =>
      update(conversationId, (slice) => {
        const next = prependOlder(slice, older);
        return hasMore === undefined ? next : { ...next, hasMore };
      }),
    enqueueOptimistic: (conversationId, entity) =>
      update(conversationId, (slice) => enqueueOptimistic(slice, entity)),
    markSent: (conversationId, clientMsgId, serverId, patch) =>
      update(conversationId, (slice) => markSent(slice, clientMsgId, serverId, patch)),
    markFailed: (conversationId, clientMsgId) =>
      update(conversationId, (slice) => markFailed(slice, clientMsgId)),
    patchMessage: (conversationId, id, patch) =>
      update(conversationId, (slice) => patchEntity(slice, id, patch)),
    removeMessage: (conversationId, id) =>
      update(conversationId, (slice) => removeEntity(slice, id)),
    setLoading: (conversationId, loading) =>
      update(conversationId, (slice) => ({ ...slice, loading })),
    setError: (conversationId, error) => update(conversationId, (slice) => ({ ...slice, error })),
    clearConversation: (conversationId) =>
      set((state) => {
        if (!state.conversations[conversationId]) return state;
        const conversations = { ...state.conversations };
        delete conversations[conversationId];
        return { conversations };
      }),
    reset: () => set({ conversations: {} }),
  };
});
