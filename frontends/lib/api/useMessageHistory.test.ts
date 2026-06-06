import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/components/workbench/messages/data";
import { useChatStore } from "@/components/workbench/messages/store/chatStore";
import { changeBus } from "@/lib/data/changeBus";

import { useMessageHistory } from "./useMessageHistory";
import {
  adaptHistoryRecords,
  type HistoryMessage,
  loadCachedWindow,
  loadConversationMessages,
} from "./messageHistory";

// changeBus / employeeId / IPC 全部 mock:本测聚焦「loading 派生语义」,不验真实订阅与网络。
vi.mock("@/lib/data/changeBus", () => ({
  changeBus: { subscribe: vi.fn(() => () => undefined) },
}));
vi.mock("@/lib/data/useCurrentEmployeeId", () => ({
  useCurrentEmployeeId: () => "emp-1",
}));
vi.mock("./messageHistory", () => ({
  loadConversationMessages: vi.fn(),
  loadOlderMessages: vi.fn(),
  loadCachedWindow: vi.fn(),
  adaptHistoryRecords: vi.fn(),
}));

const loadMock = vi.mocked(loadConversationMessages);
const adaptMock = vi.mocked(adaptHistoryRecords);
const cachedWindowMock = vi.mocked(loadCachedWindow);

const READY = { wecomAccountId: "acct-1", externalUserId: "user-1" } as const;

function msg(id: string): Message {
  return {
    id,
    conversationId: "c1",
    direction: "in",
    text: id,
    sentAt: "2026-05-25T00:00:00.000Z",
    // 权威条目带 sortKey(窗口边界派生依赖);adaptMock 透传时一并带过。
    sortKey: id,
    parts: [{ kind: "text", text: id }],
  };
}

function flush() {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  adaptMock.mockImplementation((records) => records as unknown as Message[]);
});

afterEach(() => {
  useChatStore.getState().reset();
  vi.clearAllMocks();
});

describe("useMessageHistory loading 派生(防开场空态闪帧)", () => {
  it("冷会话首帧(ready 但 slice 未建立)返回 loading=true —— 否则 ChatArea 会先画一帧「暂无消息」空态", async () => {
    loadMock.mockResolvedValue({ records: [], hasMoreOlder: false });

    // 逐帧记录:renders[0] 是 effect 跑(readCache 置 loading)之前的首次渲染值。
    // 没有本次修复时,首帧 slice=undefined → loading=false → 空态闪帧。
    const renders: Array<{ loading: boolean; len: number }> = [];
    await act(async () => {
      renderHook(() => {
        const r = useMessageHistory({ ...READY, conversationId: "c-cold" });
        renders.push({ loading: r.loading, len: r.messages.length });
        return r;
      });
    });

    expect(renders[0]).toEqual({ loading: true, len: 0 });
  });

  it("账号/用户缺失(无法拉取)时首帧 loading=false —— 空态如实展示,不卡死骨架", () => {
    const renders: Array<{ loading: boolean }> = [];
    renderHook(() => {
      const r = useMessageHistory({
        wecomAccountId: "",
        externalUserId: "",
        conversationId: "c1",
      });
      renders.push({ loading: r.loading });
      return r;
    });

    expect(renders[0].loading).toBe(false);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("拉取完成且确无消息 → loading=false,messages=[] —— 空态此时才合理展示(未过度修复成永久骨架)", async () => {
    loadMock.mockResolvedValue({ records: [], hasMoreOlder: false });

    const { result } = renderHook(() => useMessageHistory({ ...READY, conversationId: "c-empty" }));
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.messages).toEqual([]);
  });

  it("拉取完成且有消息 → loading=false,messages 收敛进权威列表", async () => {
    // adaptHistoryRecords 被 mock 成原样透传(见 beforeEach),故这里直接塞 Message 作记录,
    // 仅在类型层转成 HistoryMessage[] 以满足 loadConversationMessages 的返回契约。
    loadMock.mockResolvedValue({
      records: [msg("m1"), msg("m2")] as unknown as HistoryMessage[],
      hasMoreOlder: false,
    });

    const { result } = renderHook(() => useMessageHistory({ ...READY, conversationId: "c1" }));
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("同 conversationId 在不同账号/客户上下文下隔离 store 切片，切用户首帧不串消息", async () => {
    loadMock.mockResolvedValueOnce({
      records: [msg("acct-a-msg")] as unknown as HistoryMessage[],
      hasMoreOlder: false,
    });
    loadMock.mockResolvedValueOnce({
      records: [msg("acct-b-msg")] as unknown as HistoryMessage[],
      hasMoreOlder: false,
    });

    const renders: Array<{ account: string; loading: boolean; ids: string[] }> = [];
    const { rerender } = renderHook(
      (props: { wecomAccountId: string; externalUserId: string }) => {
        const r = useMessageHistory({ ...props, conversationId: "same-conv" });
        renders.push({
          account: props.wecomAccountId,
          loading: r.loading,
          ids: r.messages.map((m) => m.id),
        });
        return r;
      },
      { initialProps: { wecomAccountId: "acct-a", externalUserId: "user-a" } },
    );
    await flush();

    rerender({ wecomAccountId: "acct-b", externalUserId: "user-b" });

    const firstBRender = renders.find((r) => r.account === "acct-b");
    expect(firstBRender).toEqual({ account: "acct-b", loading: true, ids: [] });
  });
});

describe("useMessageHistory resync 强制绕水位门 reconcile", () => {
  // 每个用例独立 fake bus:beforeEach 重置为可捕获回调的实现,afterEach 恢复 no-op。
  // 避免影响上方「loading 派生」用例(它们假设 subscribe 是 no-op 从不触发 cb)。
  let convCb: ((n: { source: string }) => void) | undefined;

  beforeEach(() => {
    convCb = undefined;
    vi.mocked(changeBus.subscribe).mockImplementation((topic, _scope, cb) => {
      if (topic === "conversation-messages") {
        convCb = cb as (n: { source: string }) => void;
      }
      return () => undefined;
    });
  });

  afterEach(() => {
    // 恢复默认 no-op 实现,不影响其他 describe。
    vi.mocked(changeBus.subscribe).mockImplementation(() => () => undefined);
  });

  it("conversation-messages 的 resync notice → readCache(force=true)", async () => {
    loadMock.mockResolvedValue({ records: [], hasMoreOlder: false });

    renderHook(() => useMessageHistory({ ...READY, conversationId: "c-resync" }));
    await flush();
    loadMock.mockClear();

    // 投递一条 resync notice。
    await act(async () => {
      convCb?.({ source: "resync" });
      await new Promise((r) => setTimeout(r, 0));
    });

    // 强制绕水位门:loadConversationMessages 必须带 force=true。
    const lastCall = loadMock.mock.calls[loadMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual(expect.objectContaining({ force: true }));
  });

  it("conversation-messages 的普通 server-event notice → readCache(force=false)", async () => {
    loadMock.mockResolvedValue({ records: [], hasMoreOlder: false });

    renderHook(() => useMessageHistory({ ...READY, conversationId: "c-normal" }));
    await flush();
    loadMock.mockClear();

    await act(async () => {
      convCb?.({ source: "server-event" });
      await new Promise((r) => setTimeout(r, 0));
    });

    // 普通重读:force 必须是 false(走常规水位门)。
    const lastCall = loadMock.mock.calls[loadMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual(expect.objectContaining({ force: false }));
  });
});

describe("useMessageHistory loadNewer(Stage C 往更新翻窗口)", () => {
  // 首屏 readCache 用空 records(slice 建立、atCacheBottom=true);随后用 store dropFromBottom
  // 造出「非缓存底」窗口态(atCacheBottom=false + windowNewestSortKey),再驱动 loadNewer。
  async function mountHook(conversationId: string) {
    loadMock.mockResolvedValue({ records: [], hasMoreOlder: false });
    const view = renderHook(() => useMessageHistory({ ...READY, conversationId }));
    await flush();
    return view;
  }

  // 直接把窗口塞成 [m1, m2, m3] 且非缓存底(模拟上滚后 dropFromBottom 过的窗口)。
  function seedNonBottomWindow(storeKey: string) {
    const store = useChatStore.getState();
    store.replaceAuthoritative(storeKey, [msg("m1"), msg("m2"), msg("m3"), msg("m4")], {
      collapseToLatest: true,
    });
    // dropFromBottom 把 m4 裁掉 → atCacheBottom=false、windowNewestSortKey=m3。
    store.dropFromBottom(storeKey, 1);
  }

  it("loadNewer 调 loadCachedWindow(after) 并 appendNewerWindow:尾部追加更新页 + 触底停", async () => {
    const { result } = await mountHook("c-newer");
    const storeKey = result.current.storeKey;
    act(() => seedNonBottomWindow(storeKey));
    expect(result.current.atCacheBottom).toBe(false);

    cachedWindowMock.mockResolvedValue({
      records: [msg("m4")] as unknown as HistoryMessage[],
      hasMoreOlder: false,
      hasMoreNewer: false,
    });

    await act(async () => {
      await result.current.loadNewer();
    });

    // 以 windowNewestSortKey(=m3)为 after 锚点纯本地读。
    expect(cachedWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-newer", anchorSortKey: "m3", after: 10 }),
    );
    // m4 追加进窗口;hasMoreNewer=false → atCacheBottom 回 true(触底停)。
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result.current.atCacheBottom).toBe(true);
  });

  it("已在缓存底(atCacheBottom=true)时 loadNewer 守卫 return,不调 loadCachedWindow", async () => {
    const { result } = await mountHook("c-bottom");
    // 首屏整窗塌缩后 atCacheBottom=true。
    expect(result.current.atCacheBottom).toBe(true);
    cachedWindowMock.mockClear();

    await act(async () => {
      await result.current.loadNewer();
    });
    expect(cachedWindowMock).not.toHaveBeenCalled();
  });

  it("三锁互斥:loadNewer 触底停后 atCacheBottom=true,后续再调直接守卫 return(幂等)", async () => {
    const { result } = await mountHook("c-mutex");
    const storeKey = result.current.storeKey;
    act(() => seedNonBottomWindow(storeKey));

    cachedWindowMock.mockResolvedValue({
      records: [msg("m4")] as unknown as HistoryMessage[],
      hasMoreOlder: false,
      hasMoreNewer: false,
    });
    await act(async () => {
      await result.current.loadNewer();
    });
    expect(result.current.atCacheBottom).toBe(true);

    // 已触底:再调 loadNewer 守卫直接 return(不再发 IPC)。
    const callsAfterFirst = cachedWindowMock.mock.calls.length;
    await act(async () => {
      await result.current.loadNewer();
    });
    expect(cachedWindowMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
