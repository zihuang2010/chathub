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

import type { Message } from "@/components/workbench/messages/data";
import { selectTimeline, useChatStore } from "@/components/workbench/messages/store/chatStore";
import { changeBus } from "@/lib/data/changeBus";
import { useCurrentEmployeeId } from "@/lib/data/useCurrentEmployeeId";

import { adaptHistoryRecords, loadConversationMessages, loadOlderMessages } from "./messageHistory";

const DEFAULT_PAGE_SIZE = 20;

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
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
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
  // 缓存按 conversationId 主键,故会话切换的唯一判别键 = conversationId。
  const activeTargetKey = ready ? conversationId : "";

  // 单一真相:消息 / hasMore / error / loading 全来自 store 的本会话分片(loading 走 store 而非
  // React useState,使 effect 里的读取只触达外部 store、不触发 react-hooks/set-state-in-effect)。
  // 选 slice(引用稳定,仅本会话变更时变)再 useMemo 出 timeline,避免别的会话变更触发本 hook 重渲染。
  const slice = useChatStore((s) => s.conversations[activeTargetKey]);
  const messages = useMemo(() => selectTimeline(slice), [slice]);
  const hasMore = slice?.hasMore ?? false;
  const error = slice?.error ?? null;
  const loading = slice?.loading ?? false;

  // 切员工(A→B):清空 store,防上一员工消息驻留内存或串台。首次 null→A 的 settle 不清,
  // 否则会误清 readCache 已填充的消息(readCache 不依赖 employeeId,可能先于它就绪)。
  // reset() 是外部 store 更新而非 React setState,故不触发 set-state-in-effect。
  const prevEmployeeRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevEmployeeRef.current && employeeId && prevEmployeeRef.current !== employeeId) {
      useChatStore.getState().reset();
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
      const requestKey = conversationId;
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
    [ready, conversationId, wecomAccountId, externalUserId, pageSize],
  );

  // 切会话 / mount:重置过期守卫 + 缓存优先读首屏(秒开)。store 按 conversationId 分片,
  // 故切会话天然返回新会话分片(秒开命中缓存或空态),无需渲染期重置。
  useEffect(() => {
    if (!ready) {
      targetKeyRef.current = "";
      return;
    }
    targetKeyRef.current = conversationId;
    void readCache(true);
  }, [ready, conversationId, readCache]);

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
    loadingOlderRef.current = true;
    const requestKey = conversationId;
    useChatStore.getState().setLoading(requestKey, true);
    try {
      const resp = await loadOlderMessages({ conversationId, pageSize });
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
  }, [ready, hasMore, loading, conversationId, pageSize]);

  const retry = useCallback(() => {
    useChatStore.getState().setError(conversationId, null);
    void readCache(true);
  }, [conversationId, readCache]);

  return {
    messages,
    loading,
    error,
    hasMore,
    loadMore,
    retry,
  };
}
