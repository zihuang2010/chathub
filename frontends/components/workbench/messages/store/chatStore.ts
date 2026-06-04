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

// 文本乐观气泡↔权威回显的确定性配对。文本无 objectName 可配,改用「方向 out + 纯文本 + 内容相等」:
// 图+文串行发送时文本最后才发(等图片上传完),其权威重读可能抢在 markSent 钉 serverId 之前落地 →
// 权威回显与乐观气泡各成一行 = 瞬时双行,条数瞬时 +1 触发贴底跟随猛挪一下(本次发图「闪」的真根因)。
// 这里在同一次收敛内按内容把它们配对,消除双行。安全性:① 候选权威回显已由外层
// !priorIds && !echoLookup 限定为「本次新出现」→ 不会回配历史里的同文本旧消息;② 只配仍在途
// (status==="sending")的乐观气泡;③ 仅纯文本(无附件 part);④ 两条相同文本同时在途时按 order
// FIFO 配对,因内容全同、配错亦等价(各自权威回显终会各自收敛),不产生持久双行。附件类(有 filePath)
// 走 objectName 配对,不进此路。
function isTextOnly(msg: Message): boolean {
  return msg.parts.length > 0 && msg.parts.every((p) => p.kind === "text");
}

function authTextMatchesOptimistic(authMsg: Message, optimistic: ChatMessageEntity): boolean {
  if (optimistic.status !== "sending" || optimistic.filePath) return false;
  if (!isTextOnly(authMsg) || !isTextOnly(optimistic)) return false;
  return authMsg.text.length > 0 && authMsg.text === optimistic.text;
}

// 乐观气泡↔权威回显的「确定性」配对:服务端把发送时的 clientMsgId 经 request_message_id 落库,
// 权威条目读回后带 requestMessageId。两者非空且相等即唯一命中,优于 objectName / 文本启发式
// (无内容碰撞、不挑消息类型)。send 改造后权威行经 push 稍后到达,这是收敛双行的根治路径;
// 启发式仅作 requestMessageId 缺失时的兜底。
function authRequestIdMatchesOptimistic(authMsg: Message, optimistic: ChatMessageEntity): boolean {
  return (
    !!authMsg.requestMessageId &&
    !!optimistic.clientMsgId &&
    authMsg.requestMessageId === optimistic.clientMsgId
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 限定结构的深相等:标量走 Object.is;数组逐元素(顺序敏感);普通对象按「键并集」递归。
// 用于 entity 内容比较 —— ChatMessageEntity 形状 = 标量 + parts/mentions 数组(元素为仅含标量的
// 浅对象),无嵌套对象 / 无环。用「键并集」而非手写字段清单:新增字段自动纳入,杜绝「漏比某字段 →
// 该刷新却没刷新」的退化;键集不一致(显式 undefined 键 vs 缺键)判不等,偏保守(宁可多渲染一次,
// 不可漏渲染)。导出供单测。
export function valueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valueEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!valueEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// 比较两切片「纯函数会改写的部分」是否等价:仅 order 序列 + byId 内容(hasMore/loading/error
// 由 `{ ...slice }` 原样透传,不在此比;meta 短路在 action 层另判)。等价 → 调用方复用原引用。
function sliceContentEqual(prev: ConversationSlice, next: ConversationSlice): boolean {
  if (prev.order.length !== next.order.length) return false;
  for (let i = 0; i < prev.order.length; i++) {
    if (prev.order[i] !== next.order[i]) return false;
  }
  for (const id of next.order) {
    if (!valueEqual(prev.byId[id], next.byId[id])) return false;
  }
  return true;
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
  // 此时新出现的权威出站回显与乐观气泡无 id/serverId 可对 → 乐观被当 in-flight 追加 = 瞬时双行
  // (条数瞬时 +1 会触发贴底跟随猛挪一下;图片行高更扎眼,但图+文串行发送时尾随文本同样会双行)。
  // 这里把「本次新出现、未经 serverId 关联的权威出站回显」与「仍待收敛的乐观出站气泡」确定性配对:
  // 附件按 objectName(authAttachmentMatchesOptimistic),纯文本按内容(authTextMatchesOptimistic);
  // 提前把 clientMsgId 带到权威条目、收敛掉乐观副本,使行 key 不变、不产生瞬时双行,彻底消除与
  // markSent 谁先谁后的时序竞争。
  const matchedEcho = new Map<string, ChatMessageEntity>();
  const convergedByMatch = new Set<ChatMessageEntity>();
  // 第一轮:requestMessageId==clientMsgId 的「确定性」配对(优先于启发式)。服务端把发送时的
  // clientMsgId 经 request_message_id 落库,权威行读回后带 requestMessageId,等值即唯一命中——
  // 无内容碰撞、不挑消息类型,是 send 改造后(权威行经 push 延后到达)收敛双行的根治路径。
  // 先于启发式跑,确保命中的乐观气泡经 convergedByMatch 自动从启发式候选中排除。
  for (const m of messages) {
    if (m.direction !== "out" || priorIds.has(m.id) || echoLookup.has(m.id)) continue;
    if (!m.requestMessageId) continue;
    const optimistic = pendingOptimistic.find(
      (cand) => !convergedByMatch.has(cand) && authRequestIdMatchesOptimistic(m, cand),
    );
    if (optimistic) {
      matchedEcho.set(m.id, optimistic);
      convergedByMatch.add(optimistic);
    }
  }
  // 第二轮:objectName / 文本启发式兜底(requestMessageId 缺失时;已被第一轮命中的不再参与)。
  for (const m of messages) {
    if (m.direction !== "out" || priorIds.has(m.id) || echoLookup.has(m.id)) continue;
    if (matchedEcho.has(m.id)) continue;
    const optimistic = pendingOptimistic.find(
      (cand) =>
        !convergedByMatch.has(cand) &&
        (authAttachmentMatchesOptimistic(m, cand) || authTextMatchesOptimistic(m, cand)),
    );
    if (optimistic) {
      matchedEcho.set(m.id, optimistic);
      convergedByMatch.add(optimistic);
    }
  }

  const byId: Record<string, ChatMessageEntity> = {};
  for (const m of messages) {
    const echo = echoLookup.get(m.id) ?? matchedEcho.get(m.id);
    const merged: ChatMessageEntity = { ...preserveOptimisticImageDimensions(m, echo) };
    // 收敛时把乐观气泡的 clientMsgId 带到权威条目:权威条目 id=serverId,若行 key 跟随 id
    // 由 clientMsgId 变 serverId,React 会 remount 整行 → MessageImage 重建、走骨架态闪一下。
    // 上层据此 clientMsgId 给消息行一个跨「乐观→权威」稳定的 key,收敛零 remount、首帧不闪。
    // 历史消息无乐观来源(echo 无 clientMsgId)→ 不附加,行 key 回退到 id。
    if (echo?.clientMsgId) merged.clientMsgId = echo.clientMsgId;
    byId[m.id] = merged;
  }
  const leftover = pendingOptimistic.filter((e) => !convergedByMatch.has(e));
  for (const e of leftover) byId[e.id] = e;

  // ── 排序:real 消息构成 spine(已显示保位 + 新消息追底);failed 按 sentAt 插入整条时间线;
  //          在途/待回显(sending/sent leftover)贴底 ────────────────────────────────────
  // 三类:① real 权威消息 = spine,已显示的(knownAuth)按先前相对位置冻结、本批新出现的(newAuth)
  // 按服务端序追加到底,real 之间不重排(保住「已显示保位/同毫秒不翻序/迟到入站追底」三测);
  // ② status==='failed' 的条目(失败行,无论 leftover 还是已落库的权威失败行)按 sentAt 插进 spine ——
  // 锚定在过去时刻的失败气泡落回正确位置,杜绝「先沉底→后发成功收敛→失败行被冻结在沉底位」竞态;
  // ③ 其余 leftover(在途 sending / 已 markSent 待回显 sent)贴底。failed 用「插在第一个 sentAt 严格
  // 大于它的 spine 元素之前」的稳定插入:同毫秒时排在 real 之后(与「失败文本不被同内容权威吞」测一致)。
  // at():memo 消除 sort 中重复 Date 解析;NaN 兜底防非法 sentAt 让失败行漏到尾部沉底。
  const atCache = new Map<string, number>();
  const at = (id: string) => {
    const cached = atCache.get(id);
    if (cached !== undefined) return cached;
    const t = new Date(byId[id]?.sentAt ?? 0).getTime();
    const v = Number.isNaN(t) ? 0 : t;
    atCache.set(id, v);
    return v;
  };
  const priorIndex = new Map<string, number>();
  slice.order.forEach((id, i) => priorIndex.set(id, i));
  const knownAuth: { id: string; idx: number }[] = [];
  const newAuthIds: string[] = [];
  for (const m of messages) {
    if (byId[m.id]?.status === "failed") continue; // 失败权威行不进 spine,稍后按 sentAt 插
    const echo = echoLookup.get(m.id) ?? matchedEcho.get(m.id);
    let idx = priorIndex.get(m.id);
    if (idx === undefined && echo) idx = priorIndex.get(echo.id);
    if (idx === undefined) newAuthIds.push(m.id);
    else knownAuth.push({ id: m.id, idx });
  }
  knownAuth.sort((a, b) => a.idx - b.idx);
  const spine = [...knownAuth.map((k) => k.id), ...newAuthIds];

  // 所有 status==='failed' 实体(权威失败行 + leftover 失败气泡;byId 键唯一,无重复),按 sentAt 升序。
  const failedIds = Object.keys(byId)
    .filter((id) => byId[id]?.status === "failed")
    .sort((a, b) => at(a) - at(b));
  // 非失败 leftover(在途 sending / 待回显 sent)贴底,保持先前相对序。
  const tailLeftover = leftover.filter((e) => e.status !== "failed").map((e) => e.id);

  // failed 稳定插入 spine:在每个 spine 元素前,先吐出所有 sentAt 严格小于它的 failed。
  const withFailed: string[] = [];
  let fi = 0;
  for (const id of spine) {
    while (fi < failedIds.length && at(failedIds[fi]) < at(id)) withFailed.push(failedIds[fi++]);
    withFailed.push(id);
  }
  while (fi < failedIds.length) withFailed.push(failedIds[fi++]);

  const order = [...withFailed, ...tailLeftover];
  const next = { ...slice, byId, order };
  // 内容等价(踢水位门 / 补读 / 多订阅者重读到一字未变的数据)→ 复用原引用,渲染端零 re-render。
  return sliceContentEqual(slice, next) ? slice : next;
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
        const hasMore = meta?.hasMore ?? next.hasMore;
        const error = meta?.error ?? null;
        // 纯函数判定内容无变化(next === slice)且 meta 未变 → 复用原引用,渲染端零 re-render。
        if (next === slice && slice.hasMore === hasMore && slice.error === error) return slice;
        return { ...next, hasMore, error };
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
