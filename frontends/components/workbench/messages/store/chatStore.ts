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

import { attachmentPreviewUrl } from "@/lib/api/messageHistory";

import type { Message, MessagePart } from "../data";

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

function buildEchoLookup(slice: ConversationSlice): Map<string, ChatMessageEntity> {
  const out = new Map<string, ChatMessageEntity>();
  for (const id of slice.order) {
    const entity = slice.byId[id];
    if (!entity) continue;
    out.set(entity.id, entity);
    if (entity.serverId) out.set(entity.serverId, entity);
  }
  return out;
}

function mergeImagePresentation(
  authoritative: MessagePart,
  local: MessagePart | undefined,
): MessagePart {
  if (authoritative.kind !== "image" || local?.kind !== "image") return authoritative;
  if (!local.width || !local.height) {
    return {
      ...authoritative,
      width: undefined,
      height: undefined,
    };
  }
  return {
    ...authoritative,
    width: local.width,
    height: local.height,
  };
}

function preserveOptimisticImageDimensions(message: Message, local?: ChatMessageEntity): Message {
  if (!local || !message.parts.some((part) => part.kind === "image")) return message;
  const localImageParts = local.parts.filter((part) => part.kind === "image");
  if (localImageParts.length === 0) return message;
  let imageIndex = 0;
  return {
    ...message,
    parts: message.parts.map((part, index) => {
      const localPart =
        part.kind === "image"
          ? (localImageParts[imageIndex++] ?? local.parts[index])
          : local.parts[index];
      return mergeImagePresentation(part, localPart);
    }),
  };
}

// ─── 纯收敛 reducer(导出供单测) ─────────────────────────────────────────────

// 乐观附件气泡的 filePath = 上传得到的 objectName(deliverAttachmentUnit 在 send IPC 前 patch 写入);
// 权威附件条目 part.url = attachmentPreviewUrl(objectName)。据此做乐观↔权威的确定性等值匹配——
// objectName 是唯一 OSS key,无碰撞,且早于收敛竞态窗口就已就位。
function authAttachmentMatchesOptimistic(authMsg: Message, optimistic: ChatMessageEntity): boolean {
  const objectName = optimistic.filePath;
  if (!objectName) return false;
  const expectedUrl = attachmentPreviewUrl(objectName);
  return authMsg.parts.some(
    (p) =>
      (p.kind === "image" || p.kind === "file" || p.kind === "voice" || p.kind === "video") &&
      p.url === expectedUrl,
  );
}

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
  const echoLookup = buildEchoLookup(slice);
  const priorIds = new Set(slice.order);
  const pendingOptimistic = slice.order
    .map((id) => slice.byId[id])
    .filter(
      (e): e is ChatMessageEntity =>
        !!e &&
        e.clientMsgId != null &&
        !(e.serverId != null && authIds.has(e.serverId)) &&
        !authIds.has(e.id),
    );

  // 收敛双行竞态根治:权威重读(读本地缓存,极快)可能抢在 markSent 钉 serverId 之前落地,
  // 此时新出现的权威出站附件回显与乐观气泡无 id/serverId 可对 → 乐观被当 in-flight 追加 = 瞬时双行
  // (图片行高,整列跳一下尤其扎眼)。这里按 objectName 把「本次新出现、未经 serverId 关联的权威
  // 出站附件」与「仍待收敛的乐观出站气泡」确定性配对:提前把 clientMsgId 带到权威条目、收敛掉乐观
  // 副本,使行 key 不变、MessageImage 实例存活,彻底消除与 markSent 谁先谁后的时序竞争。仅作用于
  // 附件(文字双行不可见且按内容匹配易碰撞,不碰)。
  const matchedEcho = new Map<string, ChatMessageEntity>();
  const convergedByMatch = new Set<ChatMessageEntity>();
  for (const m of messages) {
    if (m.direction !== "out" || priorIds.has(m.id) || echoLookup.has(m.id)) continue;
    const optimistic = pendingOptimistic.find(
      (cand) => !convergedByMatch.has(cand) && authAttachmentMatchesOptimistic(m, cand),
    );
    if (optimistic) {
      matchedEcho.set(m.id, optimistic);
      convergedByMatch.add(optimistic);
    }
  }

  const byId: Record<string, ChatMessageEntity> = {};
  const order: string[] = [];
  for (const m of messages) {
    const echo = echoLookup.get(m.id) ?? matchedEcho.get(m.id);
    const merged: ChatMessageEntity = { ...preserveOptimisticImageDimensions(m, echo) };
    // 收敛时把乐观气泡的 clientMsgId 带到权威条目:权威条目 id=serverId,若行 key 跟随 id
    // 由 clientMsgId 变 serverId,React 会 remount 整行 → MessageImage 重建、走骨架态闪一下。
    // 上层据此 clientMsgId 给消息行一个跨「乐观→权威」稳定的 key,收敛零 remount、首帧不闪。
    // 历史消息无乐观来源(echo 无 clientMsgId)→ 不附加,行 key 回退到 id。
    if (echo?.clientMsgId) merged.clientMsgId = echo.clientMsgId;
    byId[m.id] = merged;
    order.push(m.id);
  }
  for (const e of pendingOptimistic) {
    if (convergedByMatch.has(e)) continue;
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
  // 竞态收敛:后端 conversation-messages 重读(replaceAuthoritative)可能抢在本 markSent 之前
  // 落地,使权威回显条目(id === serverId)已在切片内,而乐观气泡(id === clientMsgId、serverId
  // 尚未钉上)无键可与之对上 → 被当作 in-flight 追加在末尾,同一条消息瞬时变两行(发送成功瞬间
  // +82px 又 -82px 的整列「上顶再回落」抖动)。拿到 serverId 的此刻即可精确按 id === serverId 命中
  // 权威回显:就地塌缩成一行 —— 保留权威条目、带上 clientMsgId 稳住跨「乐观→权威」行 key、沿用
  // preserveOptimisticImageDimensions 防图尺寸回跳、删掉乐观条目。把双行窗口从「等下一次重读」
  // (~230ms)压到 markSent 当帧(~4ms,浏览器基本无机会绘出双行),消除抖动。无回显时退化为原逻辑。
  const echo = serverId !== id ? slice.byId[serverId] : undefined;
  if (echo) {
    const merged: ChatMessageEntity = {
      ...preserveOptimisticImageDimensions(echo, e),
      clientMsgId,
      serverId,
      status: "sent",
    };
    const byId = { ...slice.byId, [serverId]: merged };
    delete byId[id];
    return { ...slice, byId, order: slice.order.filter((x) => x !== id) };
  }
  const patched: ChatMessageEntity = { ...e, ...patch, serverId, status: "sent" };
  return {
    ...slice,
    byId: { ...slice.byId, [id]: patched },
  };
}

/** 发送失败:status→failed(供 context menu resend 复用同 clientMsgId 重发)。 */
export function markFailed(slice: ConversationSlice, clientMsgId: string): ConversationSlice {
  const id = findIdByClientMsgId(slice, clientMsgId);
  if (!id) return slice;
  const e = slice.byId[id];
  return { ...slice, byId: { ...slice.byId, [id]: { ...e, status: "failed" } } };
}

/** 就地 patch 一条(如撤回置 isRecalled、重发补钉 clientMsgId)。不存在则 no-op。 */
export function patchEntity(
  slice: ConversationSlice,
  id: string,
  patch: Partial<ChatMessageEntity>,
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

// 单员工会话期内的热会话切片上限:超出按 LRU 淘汰最久未访问的非活跃会话切片(重开时
// useMessageHistory 会 refetch 重填,store 本就是缓存)。防长会话(一班坐席访问大量会话)
// 内存无界增长。
export const MAX_HOT_CONVERSATIONS = 30;

interface ChatStoreState {
  conversations: Record<string, ConversationSlice>;
  /** @internal LRU 访问顺序,最近使用在尾;仅用于切片淘汰,渲染不消费。 */
  touchOrder: string[];
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
  patchMessage(conversationId: string, id: string, patch: Partial<ChatMessageEntity>): void;
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
      const conversations = { ...state.conversations, [conversationId]: fn(slice) };
      // 该会话标记为最近使用(移到尾);超上限时淘汰最久未访问的非活跃切片。
      const touchOrder = [
        ...state.touchOrder.filter((id) => id !== conversationId),
        conversationId,
      ];
      while (touchOrder.length > MAX_HOT_CONVERSATIONS) {
        const evicted = touchOrder.shift();
        if (evicted) delete conversations[evicted];
      }
      return { conversations, touchOrder };
    });

  return {
    conversations: {},
    touchOrder: [],
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
        return {
          conversations,
          touchOrder: state.touchOrder.filter((id) => id !== conversationId),
        };
      }),
    reset: () => set({ conversations: {}, touchOrder: [] }),
  };
});
