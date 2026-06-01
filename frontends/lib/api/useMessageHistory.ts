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

import { useCallback, useEffect, useMemo, useRef } from "react";

import { OLDER_PAGE_SIZE } from "@/components/workbench/messages/constants";
import type { Message } from "@/components/workbench/messages/data";
import { clearImageDimsCache } from "@/components/workbench/messages/imageDimsCache";
import { clearLoadedImageSrcs } from "@/components/workbench/messages/loadedImageSrcs";
import { selectTimeline, useChatStore } from "@/components/workbench/messages/store/chatStore";
import { changeBus } from "@/lib/data/changeBus";
import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";

import { adaptHistoryRecords, loadConversationMessages, loadOlderMessages } from "./messageHistory";

const DEFAULT_PAGE_SIZE = 20;

// 单会话在内存中保留的消息条数上限。新消息到达时 readCache 的整窗 replaceAuthoritative 会把
// 切片塌缩回最近一页,但「安静会话 + 持续上滚翻历史」不会触发塌缩,切片 order/byId 只增不减。
// 故为「向上翻更旧页」封顶:到顶即停止继续拉取——既不丢已展示数据,也不破坏滚动锚定(本 hook
// 无向下翻页,裁剪尾部会造成下滑空洞,因此选择停止增长而非裁剪)。
const MAX_MESSAGES_IN_MEMORY = 500;

export interface UseMessageHistoryOptions {
  wecomAccountId: string;
  externalUserId: string;
  /** 用于 Message.conversationId 字段填充(UI 渲染 reply / 引用时用)。 */
  conversationId: string;
  /** false 时不拉数据(用于空账号/未登录场景);默认 true。 */
  enabled?: boolean;
  pageSize?: number;
}

export interface UseMessageHistoryResult {
  messages: Message[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
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
  // 防重入:首屏读 / 重读 不并发;翻更旧页不并发。
  const readingRef = useRef(false);
  const loadingOlderRef = useRef(false);

  // 缓存优先读整窗(首屏 / 重读)。同时踢一次后端会话水位门:落后则后台 reconcile,
  // reconcile 完成后会发 conversation-messages ChangeNotice → 再触发本函数重读。
  const readCache = useCallback(
    async (showLoading: boolean) => {
      if (!ready) return;
      // 与 loadMore 互斥:翻更旧页 in-flight 时跳过后台重读,
      // 否则重读的「整窗 REPLACE」会覆盖掉 loadMore 刚 prepend 的更旧页。
      if (readingRef.current || loadingOlderRef.current) return;
      readingRef.current = true;
      const requestKey = activeTargetKey;
      if (showLoading) useChatStore.getState().setLoading(requestKey, true);
      try {
        const resp = await loadConversationMessages({
          conversationId,
          wecomAccountId,
          externalUserId,
          limit: pageSize,
        });
        if (targetKeyRef.current !== requestKey) return;
        const page = adaptHistoryRecords(resp.records, conversationId);
        useChatStore
          .getState()
          .replaceAuthoritative(requestKey, page, { hasMore: resp.hasMoreOlder, error: null });
      } catch (e) {
        if (targetKeyRef.current !== requestKey) return;
        useChatStore.getState().setError(requestKey, errorMessage(e));
      } finally {
        if (showLoading) useChatStore.getState().setLoading(requestKey, false);
        readingRef.current = false;
      }
    },
    [ready, activeTargetKey, conversationId, wecomAccountId, externalUserId, pageSize],
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
  useEffect(() => {
    if (!ready || !employeeId) return;
    const unsubscribe = changeBus.subscribe(
      "conversation-messages",
      { employeeId, conversationId },
      () => {
        void readCache(false);
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

  const loadMore = useCallback(async () => {
    if (!ready || !hasMore || loading || loadingOlderRef.current || readingRef.current) return;
    // 已达单会话内存上限:停止继续向上加载更旧页,防止安静会话被无限上滚撑爆内存。
    const loadedCount = useChatStore.getState().conversations[activeTargetKey]?.order.length ?? 0;
    if (loadedCount >= MAX_MESSAGES_IN_MEMORY) return;
    loadingOlderRef.current = true;
    const requestKey = activeTargetKey;
    useChatStore.getState().setLoading(requestKey, true);
    try {
      // 翻更旧页固定用 OLDER_PAGE_SIZE(小页);pageSize(=20)只服务首屏 readCache,二者解耦:
      // 首屏要撑满视口可滚,翻页要小步、低撑高以减小惯性下的锚点跳动。
      const resp = await loadOlderMessages({ conversationId, pageSize: OLDER_PAGE_SIZE });
      if (targetKeyRef.current !== requestKey) return;
      const older = adaptHistoryRecords(resp.records, conversationId);
      useChatStore.getState().prependOlder(requestKey, older, resp.hasMoreOlder);
    } catch (e) {
      if (targetKeyRef.current !== requestKey) return;
      useChatStore.getState().setError(requestKey, errorMessage(e));
    } finally {
      useChatStore.getState().setLoading(requestKey, false);
      loadingOlderRef.current = false;
    }
    // pageSize 仅首屏 readCache 用,loadMore 走 OLDER_PAGE_SIZE,故不入本 deps。
  }, [ready, hasMore, loading, activeTargetKey, conversationId]);

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
    retry,
    storeKey: activeTargetKey,
  };
}
