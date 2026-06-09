// 本地「已删除」墓碑:坐席在本工作台删除的消息键集合,持久化到 localStorage。
//
// 背景:删除消息当前只把它从内存 store 移除,本地消息库(state.sqlite)仍在;一旦走权威重读
// 补回(切会话 / 贴底 / 新消息 push 触发塌缩重建),那条又被加回列表底部 → 「删了又出现」。
// 治理:删除时给该消息记一条本地墓碑,权威数据写入 store 前据此过滤 —— 本地删除优先(以本地为
// 主),补回的那条被拦掉。纯本地视图,不影响企业微信对端与服务端。
//
// 键设计:删除时记一条消息的全部 id 形态(权威 id / clientMsgId / serverId / requestMessageId);
// 过滤权威 Message 时用其 id 或 requestMessageId 比对 —— 覆盖「权威落库消息」「收敛后消息」
// 「在途乐观气泡(权威回显 id 不同但 requestMessageId=原 clientMsgId)」三态。
//
// 会话维度:墓碑按 chatStoreKey(= 账号+客户+会话 隔离键)存,切账号不串台。

const STORAGE_KEY = "chathub:deleted-messages:v1";

// 每会话墓碑键上限(FIFO 淘汰最旧),防长期使用无界增长。一条消息删除占 ≤4 个键。
export const MAX_PER_CONVERSATION = 500;
// 持久化的会话数上限(超出按最早写入淘汰),防会话面无界。
const MAX_CONVERSATIONS = 200;

type Persisted = Record<string, string[]>;

// 模块级单例:convKey -> FIFO 键数组(保序,尾为最新)。懒加载自 localStorage。
let mem: Map<string, string[]> | null = null;

function readLocalStorage(): Persisted {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Persisted = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function ensureLoaded(): Map<string, string[]> {
  if (!mem) mem = new Map(Object.entries(readLocalStorage()));
  return mem;
}

function persist(m: Map<string, string[]>): void {
  try {
    const obj: Persisted = {};
    for (const [k, v] of m) obj[k] = v;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage 不可用 / 配额满:降级为仅内存,不抛错(本次会话内仍生效,重启后丢)。
  }
}

/** 记一条消息的删除墓碑;传入它的全部 id 形态,undefined / 空串自动忽略。 */
export function markMessageDeleted(convKey: string, keys: Array<string | undefined>): void {
  if (!convKey) return;
  const valid = keys.filter((k): k is string => typeof k === "string" && k.length > 0);
  if (valid.length === 0) return;
  const m = ensureLoaded();
  const arr = m.get(convKey) ?? [];
  const seen = new Set(arr);
  for (const k of valid) {
    if (!seen.has(k)) {
      arr.push(k);
      seen.add(k);
    }
  }
  // FIFO 上限:从头淘汰最旧键。
  while (arr.length > MAX_PER_CONVERSATION) arr.shift();
  m.set(convKey, arr);
  // 会话数上限:超出删除最早写入的会话(Map 保插入序)。
  while (m.size > MAX_CONVERSATIONS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
  persist(m);
}

/** 该会话下,给定 id 形态中是否有任一命中墓碑。 */
export function isMessageDeleted(convKey: string, keys: Array<string | undefined>): boolean {
  const arr = ensureLoaded().get(convKey);
  if (!arr || arr.length === 0) return false;
  const set = new Set(arr);
  return keys.some((k) => typeof k === "string" && k.length > 0 && set.has(k));
}

/** 过滤掉该会话下已被本地删除的权威条目(按 id 或 requestMessageId 命中墓碑)。 */
export function filterDeletedMessages<T extends { id: string; requestMessageId?: string }>(
  convKey: string,
  messages: T[],
): T[] {
  const arr = ensureLoaded().get(convKey);
  if (!arr || arr.length === 0) return messages;
  const set = new Set(arr);
  return messages.filter(
    (msg) => !(set.has(msg.id) || (msg.requestMessageId != null && set.has(msg.requestMessageId))),
  );
}
