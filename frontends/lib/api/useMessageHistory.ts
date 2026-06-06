// useMessageHistory — 历史消息「缓存优先 + 后台重对齐」hook(Stage 4b:store 支撑)。
//
// 数据真相在 chatStore(按 conversationId 分片);本 hook 只负责「拉取 → 写 store」与
// 「订阅 ChangeNotice 触发重读」,返回值从 store 读 selectTimeline。乐观气泡由 ChatArea
// 写入同一 store,replaceAuthoritative 会保留尚未被权威收敛的在飞气泡。
//
// 数据流:
//   - 切会话 / mount → loadConversationMessages 立即拿本地缓存整窗(升序,秒开)→ replaceAuthoritative。
//     后端会话水位门判定缓存落后 → 后台 reconcile,完成后发 conversation-messages
//     ChangeNotice → 本 hook 重读缓存(stale-while-revalidate)。
//   - 双订阅(employeeId 来自 useCurrentEmployeeId):
//       · conversation-messages{employeeId, conversationId} → reconcile 落库后重读。
//       · recent-sessions{employeeId, wecomAccountId} → 打开着的会话收到 recents 事件
//         (新消息已更新 recents 行)→ 再读一次踢水位门 → 落后则后台 reconcile →
//         经 conversation-messages 通知重读 → 新气泡实时追加。
//   - loadMore() → loadOlderMessages 走网络拉更旧页,prependOlder 升序到头部。
//
// 形状契约:UseMessageHistoryResult 与既有消费者(useChatMessages)保持不变。

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";

import { OLDER_PAGE_SIZE } from "@/components/workbench/messages/constants";
import type { Message } from "@/components/workbench/messages/data";
import { clearImageDimsCache } from "@/components/workbench/messages/imageDimsCache";
import { clearLoadedImageSrcs } from "@/components/workbench/messages/loadedImageSrcs";
import { selectTimeline, useChatStore } from "@/components/workbench/messages/store/chatStore";
import { changeBus } from "@/lib/data/changeBus";
import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";

import {
  adaptHistoryRecords,
  loadCachedWindow,
  loadConversationMessages,
  loadOlderMessages,
} from "./messageHistory";

const DEFAULT_PAGE_SIZE = 20;

// Stage C 数据窗口化:JS store 只保留围绕锚点的有界窗口(约 3 屏),单会话上万条时对象数恒定。
// 窗口翻页(loadNewer/loadMore)以小页 OLDER_PAGE_SIZE(=10)推进,撑到超此预算即从远端裁剪
// (dropFromTop/dropFromBottom)。budget 留足滞回(裁到 budget 而非 budget-1),避免临界值反复
// 抖动 drop/rehydrate。
const WINDOW_BUDGET = 240;

export interface UseMessageHistoryOptions {
  wecomAccountId: string;
  externalUserId: string;
  /** 用于 Message.conversationId 字段填充(UI 渲染 reply / 引用时用)。 */
  conversationId: string;
  /** false 时不拉数据(用于空账号/未登录场景);默认 true。 */
  enabled?: boolean;
  pageSize?: number;
  /**
   * Stage C:用户是否贴底的实时 ref(由 useScrollController 经 ChatArea/MessagesPage 镜像写入)。
   * readCache 据它 + slice.atCacheBottom 决定 replaceAuthoritative 是整窗塌缩还是缝合 UPSERT。
   * 未传时按「恒贴底」(true)处理 —— 退化为现状整窗塌缩,向后兼容。
   */
  atBottomRef?: MutableRefObject<boolean>;
}

export interface UseMessageHistoryResult {
  messages: Message[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Stage C:往更新方向翻一页(纯本地读窗口,不走网络/不触发 reconcile)。 */
  loadNewer: () => Promise<void>;
  /** Stage C:窗口底是否=缓存最新(无更新可翻);滚动控制器据 !atCacheBottom 决定是否 loadNewer。 */
  atCacheBottom: boolean;
  /** Stage C:窗口顶是否=缓存最旧且服务端无更旧(真正到顶);更旧方向门控据 !atCacheTop 放行 loadMore。 */
  atCacheTop: boolean;
  retry: () => void;
  storeKey: string;
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

export function messageHistoryStoreKey({
  conversationId,
  wecomAccountId,
  externalUserId,
}: {
  conversationId: string;
  wecomAccountId: string;
  externalUserId: string;
}): string {
  return `${wecomAccountId}\u001f${externalUserId}\u001f${conversationId}`;
}

export function useMessageHistory(opts: UseMessageHistoryOptions): UseMessageHistoryResult {
  const {
    wecomAccountId,
    externalUserId,
    conversationId,
    enabled = true,
    pageSize = DEFAULT_PAGE_SIZE,
    atBottomRef,
  } = opts;

  const employeeId = useCurrentEmployeeId();

  const ready = Boolean(enabled && wecomAccountId && externalUserId && conversationId);
  // 前端 store 必须按账号+客户+会话隔离。仅 conversationId 不够:切用户/账号后同 ID
  // 会复用上一上下文切片,首帧出现消息跑边/头像串台,随后重读才纠正。
  const activeTargetKey = ready
    ? messageHistoryStoreKey({ conversationId, wecomAccountId, externalUserId })
    : "";

  // 单一真相:消息 / hasMore / error / loading 全来自 store 的本会话分片(loading 走 store 而非
  // React useState,使 effect 里的读取只触达外部 store、不触发 react-hooks/set-state-in-effect)。
  // 选 slice(引用稳定,仅本会话变更时变)再 useMemo 出 timeline,避免别的会话变更触发本 hook 重渲染。
  const slice = useChatStore((s) => s.conversations[activeTargetKey]);
  const messages = useMemo(() => selectTimeline(slice), [slice]);
  const hasMore = slice?.hasMore ?? false;
  // 空窗默认贴底(emptySlice 同义);窗口底=本地缓存最新,无更新可翻 → 滚动控制器据此停 loadNewer。
  const atCacheBottom = slice?.atCacheBottom ?? true;
  // 窗口顶=缓存最旧且服务端无更旧(真正到顶)。默认 false(未知/有更旧):更旧门控宁可多放行一次本地
  // 空读、也不漏掉「被 dropFromTop 裁走但仍在 SQLite 的更旧行」;首屏塌缩路径会据 !hasMore 校正它。
  const atCacheTop = slice?.atCacheTop ?? false;
  const error = slice?.error ?? null;
  // 冷会话首帧:slice 尚未建立(下面的 readCache effect 还没跑、loading 还没置位),
  // 此时若如实返回 loading=false,ChatArea 会按"非加载且 0 条"先画一帧居中「暂无消息」
  // 空态,readCache 再翻 loading=true 转顶部骨架,数据到达后气泡又贴底 —— 三段不同布局
  // 位置在打开瞬间连跳,正是"气泡加载抖动"。故 ready 但 slice 未建立时一并视为加载中,
  // 让首帧直接落在骨架,杜绝空态闪帧。ready=false(账号/用户缺失,不会发起拉取)时不计入,
  // 空态如实展示。setLoading 一旦建立 slice,storeLoading 接力维持,无空窗。
  const loading = (slice?.loading ?? false) || (ready && slice === undefined);

  // 切员工(A→B):清空 store,防上一员工消息驻留内存或串台。首次 null→A 的 settle 不清,
  // 否则会误清 readCache 已填充的消息(readCache 不依赖 employeeId,可能先于它就绪)。
  // reset() 是外部 store 更新而非 React setState,故不触发 set-state-in-effect。
  const prevEmployeeRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevEmployeeRef.current && employeeId && prevEmployeeRef.current !== employeeId) {
      useChatStore.getState().reset();
      // 数据真相 reset 的同时,清掉图片渲染相关的模块级辅助缓存,使其与数据真相生命
      // 周期一致,避免跨员工残留影响下一员工同 URL 图片首帧渲染态(详见各 clear 注释)。
      clearImageDimsCache();
      clearLoadedImageSrcs();
    }
    if (employeeId) prevEmployeeRef.current = employeeId;
  }, [employeeId]);

  // 丢弃过期响应:切会话后旧请求若回来晚了,不要写进 store。
  const targetKeyRef = useRef<string>("");
  // 防重入三锁,互斥:首屏读 / 重读(readingRef)、翻更旧页(loadingOlderRef)、翻更新页
  // (loadingNewerRef)。三者互斥防整窗 REPLACE 覆盖 prepend/append 的窗口操作。
  const readingRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);

  // 缓存优先读整窗(首屏 / 重读)。同时踢一次后端会话水位门:落后则后台 reconcile,
  // reconcile 完成后会发 conversation-messages ChangeNotice → 再触发本函数重读。
  // opts.force=true:安全网 #3/#4(spec §6.4),resync 路径绕水位门一次性强制 reconcile。
  const readCache = useCallback(
    async (showLoading: boolean, opts?: { force?: boolean }) => {
      if (!ready) return;
      // 与窗口翻页互斥:loadMore/loadNewer in-flight 时跳过后台重读,
      // 否则重读的整窗 REPLACE 会覆盖掉刚 prepend/append 的窗口页。
      if (readingRef.current || loadingOlderRef.current || loadingNewerRef.current) return;
      readingRef.current = true;
      const requestKey = activeTargetKey;
      // Stage C 塌缩 vs 缝合判定:贴底**且**窗口在缓存底 → 整窗塌缩到最新尾窗(现状);否则(用户
      // 上滚 / 窗口已 drop 出缓存底)→ 缝合 UPSERT,只更新窗口内条目、不丢上滚位置。未传 atBottomRef
      // 退化为恒贴底(向后兼容)。整窗读路径 load_conversation_messages 返回的恒是缓存最新尾窗。
      const sliceNow = useChatStore.getState().conversations[requestKey];
      const collapseToLatest = (atBottomRef?.current ?? true) && (sliceNow?.atCacheBottom ?? true);
      if (showLoading) useChatStore.getState().setLoading(requestKey, true);
      try {
        const resp = await loadConversationMessages({
          conversationId,
          wecomAccountId,
          externalUserId,
          limit: pageSize,
          force: opts?.force ?? false,
        });
        if (targetKeyRef.current !== requestKey) return;
        const page = adaptHistoryRecords(resp.records, conversationId);
        useChatStore.getState().replaceAuthoritative(requestKey, page, {
          hasMore: resp.hasMoreOlder,
          error: null,
          collapseToLatest,
        });
      } catch (e) {
        if (targetKeyRef.current !== requestKey) return;
        useChatStore.getState().setError(requestKey, errorMessage(e));
      } finally {
        if (showLoading) useChatStore.getState().setLoading(requestKey, false);
        readingRef.current = false;
      }
    },
    [ready, activeTargetKey, conversationId, wecomAccountId, externalUserId, pageSize, atBottomRef],
  );

  // 切会话 / mount:重置过期守卫 + 缓存优先读首屏(秒开)。store 按 conversationId 分片,
  // 故切会话天然返回新会话分片(秒开命中缓存或空态),无需渲染期重置。
  useEffect(() => {
    if (!ready) {
      targetKeyRef.current = "";
      return;
    }
    targetKeyRef.current = activeTargetKey;
    // 热会话(store 已有该分片缓存)直接秒开复用旧分片,不再 showLoading —— 否则每次切换都
    // 把 loading 翻 true→false,既触发 ChatArea 重渲染,也 invalidate useScrollController 里
    // 以 loading 为依赖的 layout effect(切换路径平白多跑滚动重算),切换显钝。仅冷会话(无缓存)
    // 才显 loading 等 IPC;热会话走 stale-while-revalidate,后台读到新数据再平滑替换。
    const cached = (useChatStore.getState().conversations[activeTargetKey]?.order.length ?? 0) > 0;
    void readCache(!cached);
  }, [ready, activeTargetKey, readCache]);

  // 订阅 conversation-messages:后台 reconcile 落库 → 重读缓存(不显 loading,stale-while-revalidate)。
  // 安全网 #3/#4(spec §6.4):resync notice(source==="resync")强制绕水位门一次性同步 reconcile;
  // 普通 reconcile 落库通知(source!=="resync")走常规重读,后端已对齐,前端只重读本地缓存。
  useEffect(() => {
    if (!ready || !employeeId) return;
    const unsubscribe = changeBus.subscribe(
      "conversation-messages",
      { employeeId, conversationId },
      (notice) => {
        void readCache(false, { force: notice.source === "resync" });
      },
    );
    // 补读一次:employeeId 由 useCurrentEmployeeId 异步解析(初值 null),在它 settle 前本
    // 订阅不注册;这期间后台 reconcile 发出的 ChangeNotice 因广播无重放而丢失,导致"切会话
    // 空、需切走再切回/发送才出历史"。监听器一上线即补读,捞回这段窗口内已落库未重读的历史。
    // 受 readingRef 互斥 + targetKeyRef 防过期保护,不会与挂载时的 readCache(true) 重入。
    void readCache(false);
    return unsubscribe;
  }, [ready, employeeId, conversationId, readCache]);

  // 订阅 recent-sessions:打开着的会话收到 recents 事件(新消息已更新 recents 行)→ 再读踢水位门
  //  → 落后则后台 reconcile → 经 conversation-messages 通知重读 → 新气泡实时追加。
  // recents ChangeNotice scope 只带 account,故按 account 订阅;门会对没变的会话 no-op(零网络)。
  useEffect(() => {
    if (!ready || !employeeId) return;
    return changeBus.subscribe("recent-sessions", { employeeId, wecomAccountId }, (notice) => {
      // 只对 server-event(新消息更新了 recents 行)重读。markRead / pin / mute / draft /
      // remove 走 command_upsert(source=local-command),不带新消息却也命中本订阅
      // (scope 未指定 conversationId,scopeMatches 宽匹配)—— 放行会让打开着的会话每次
      // 标已读都整窗重读 + 重渲染,表现为切会话「闪一下」。本订阅只为实时追加新气泡,
      // 故按 source 收窄,本地命令一律忽略。
      if (notice.source !== "server-event") return;
      void readCache(false);
    });
  }, [ready, employeeId, wecomAccountId, readCache]);

  // 往更旧翻一页:本地优先 + 触底网络扩缓存。Stage C 窗口化下不再「到 500 即停」,改为
  // 「本地命中先 prependOlderWindow;本地空且服务端 has_more_older 才网络扩缓存」+ 超预算
  // dropFromBottom(仅裁远离视口的较新真实尾、不裁未收敛乐观)。
  const loadMore = useCallback(async () => {
    if (
      !ready ||
      loading ||
      loadingOlderRef.current ||
      loadingNewerRef.current ||
      readingRef.current
    ) {
      return;
    }
    loadingOlderRef.current = true;
    const requestKey = activeTargetKey;
    useChatStore.getState().setLoading(requestKey, true);
    try {
      const sliceNow = useChatStore.getState().conversations[requestKey];
      const anchor = sliceNow?.windowOldestSortKey ?? "";
      // 先本地读更旧一页(纯本地、不走网络)。锚点空串(全乐观窗 / 空窗)交由后端视为尾窗语义,
      // 但此处只在有锚点时本地翻;无锚点直接走网络兜底(冷开极端态)。
      let older: Message[] = [];
      let atCacheTop = false;
      if (anchor) {
        const local = await loadCachedWindow({
          conversationId,
          anchorSortKey: anchor,
          before: OLDER_PAGE_SIZE,
        });
        if (targetKeyRef.current !== requestKey) return;
        older = adaptHistoryRecords(local.records, conversationId);
        atCacheTop = !local.hasMoreOlder;
      }
      // 本地空(已到 SQLite 最旧)且服务端仍有更旧(slice.hasMore) → 网络扩缓存,用其 records
      // 直接 prependOlderWindow(等价且少一次 IPC)。
      if (older.length === 0 && (sliceNow?.hasMore ?? false)) {
        const net = await loadOlderMessages({ conversationId, pageSize: OLDER_PAGE_SIZE });
        if (targetKeyRef.current !== requestKey) return;
        older = adaptHistoryRecords(net.records, conversationId);
        atCacheTop = !net.hasMoreOlder;
        // 网络页落库后,服务端 has_more_older 决定 slice.hasMore(loadMore 门控仍读它)。
        useChatStore.getState().prependOlder(requestKey, [], net.hasMoreOlder);
      }
      if (older.length > 0) {
        useChatStore.getState().prependOlderWindow(requestKey, older, { atCacheTop });
        // 超预算:从尾部裁较新真实行(不裁未收敛乐观尾部)。
        const len = useChatStore.getState().conversations[requestKey]?.order.length ?? 0;
        if (len > WINDOW_BUDGET) {
          useChatStore.getState().dropFromBottom(requestKey, len - WINDOW_BUDGET);
        }
      } else if (atCacheTop) {
        // 本地 + 服务端均已到顶(无行可 prepend),仍把 atCacheTop 锁存进 slice ——
        // 否则更旧门控 !atCacheTop 恒 true,用户停在顶部时每次预取都重复发 no-op
        // loadCachedWindow IPC(虽 in-flight 守卫防叠加、order 不变零重渲,但属无谓 IPC)。
        // prependOlderWindow 空页 + meta 变化会写回边界标志、不动 order(引用按内容等价复用)。
        useChatStore.getState().prependOlderWindow(requestKey, [], { atCacheTop: true });
      }
    } catch (e) {
      if (targetKeyRef.current !== requestKey) return;
      useChatStore.getState().setError(requestKey, errorMessage(e));
    } finally {
      useChatStore.getState().setLoading(requestKey, false);
      loadingOlderRef.current = false;
    }
    // pageSize 仅首屏 readCache 用,loadMore 走 OLDER_PAGE_SIZE,故不入本 deps。
  }, [ready, loading, activeTargetKey, conversationId]);

  // 往更新翻一页(Stage C):纯本地读窗口,不走网络、不触发 reconcile。窗口已 drop 出缓存底时
  // 用于把较新行重新拉回。超预算从头部裁最旧行(dropFromTop)。
  const loadNewer = useCallback(async () => {
    if (
      !ready ||
      loading ||
      loadingNewerRef.current ||
      loadingOlderRef.current ||
      readingRef.current
    ) {
      return;
    }
    const sliceNow = useChatStore.getState().conversations[activeTargetKey];
    // 已在缓存底:无更新可翻。锚点空串(全乐观窗 / 空窗):无有效锚点,后端会取尾窗,语义不符
    // 「往更新翻」,直接跳过。
    if (!sliceNow || sliceNow.atCacheBottom || !sliceNow.windowNewestSortKey) return;
    loadingNewerRef.current = true;
    const requestKey = activeTargetKey;
    try {
      const resp = await loadCachedWindow({
        conversationId,
        anchorSortKey: sliceNow.windowNewestSortKey,
        after: OLDER_PAGE_SIZE,
      });
      if (targetKeyRef.current !== requestKey) return;
      const newer = adaptHistoryRecords(resp.records, conversationId);
      useChatStore
        .getState()
        .appendNewerWindow(requestKey, newer, { atCacheBottom: !resp.hasMoreNewer });
      const len = useChatStore.getState().conversations[requestKey]?.order.length ?? 0;
      if (len > WINDOW_BUDGET) {
        useChatStore.getState().dropFromTop(requestKey, len - WINDOW_BUDGET);
      }
    } catch (e) {
      if (targetKeyRef.current !== requestKey) return;
      useChatStore.getState().setError(requestKey, errorMessage(e));
    } finally {
      loadingNewerRef.current = false;
    }
  }, [ready, loading, activeTargetKey, conversationId]);

  const retry = useCallback(() => {
    useChatStore.getState().setError(activeTargetKey, null);
    void readCache(true);
  }, [activeTargetKey, readCache]);

  return {
    messages,
    loading,
    error,
    hasMore,
    loadMore,
    loadNewer,
    atCacheBottom,
    atCacheTop,
    retry,
    storeKey: activeTargetKey,
  };
}
