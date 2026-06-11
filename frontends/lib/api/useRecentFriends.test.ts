import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UseResourceResult } from "@/lib/data/useResource";
import { useResource } from "@/lib/data/useResource";

import { useRecentFriends, type RecentFriendListEntry } from "./useRecentFriends";
import {
  fetchRecentFriendsPage,
  prefillRecentFriends,
  type ListRecentFriendsResp,
  type RecentFriendListRecord,
} from "./recentFriends";

// useResource(默认列表本地 cache 的来源)与 recentFriends IPC 全部 mock:
// 本测聚焦「本地单源深读 + 远端水位预填」语义,不验真实订阅 / 网络。
// 因 useResource 被 mock,真实 queryFn(读 list_top(limit))不执行 —— items 直接反映
// mock 提供的 cache 数据;故断言聚焦「是否触发远端预填 / 是否纯本地重读」。
vi.mock("@/lib/data/useCurrentEmployeeId", () => ({
  useCurrentEmployeeId: () => "emp-1",
}));
vi.mock("@/lib/data/useResource", () => ({ useResource: vi.fn() }));
vi.mock("./recentFriends", () => ({
  fetchRecentFriendsCache: vi.fn(),
  fetchRecentFriendsPage: vi.fn(),
  prefillRecentFriends: vi.fn(),
  openFriendConversation: vi.fn(),
  markConversationRead: vi.fn(),
  muteConversation: vi.fn(),
  pinConversation: vi.fn(),
  setConversationDraft: vi.fn(),
  setConversationRemoved: vi.fn(),
}));

const useResourceMock = vi.mocked(useResource);
const pageMock = vi.mocked(fetchRecentFriendsPage);
const prefillMock = vi.mocked(prefillRecentFriends);

// 对齐 useRecentFriends 内部常量:水位触发线 100、首屏渲染深度/翻页步长 200。
// mkEntries(n) 的 n 用来构造"本地低于/高于触发线"与"本地是否填满当前 limit"两类场景。
const TRIGGER = 100;
const INITIAL_LIMIT = 200;

function mkEntry(
  id: string,
  ts: number,
  over: Partial<RecentFriendListEntry> = {},
): RecentFriendListEntry {
  return {
    conversationId: id,
    wecomAccountId: "wa-1",
    wecomName: "",
    wecomAccount: "",
    wecomAlias: "",
    externalUserId: "",
    externalName: id,
    externalAvatar: "",
    externalMobile: "",
    lastLocalMessageId: "",
    lastMessageType: 1,
    lastMessageDirection: 1,
    lastSendStatus: 3,
    lastMessageSummary: "",
    lastMessageTimeMs: ts,
    unreadCount: 0,
    hasUnread: false,
    pinned: false,
    pinnedAtMs: 0,
    localDraftAtMs: 0,
    localDraftText: "",
    removed: false,
    removedAtMs: 0,
    muted: false,
    mutedAtMs: 0,
    ...over,
  };
}

function resourceResult(
  data: RecentFriendListEntry[],
  over: Partial<UseResourceResult<RecentFriendListEntry[]>> = {},
): UseResourceResult<RecentFriendListEntry[]> {
  return {
    data,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    lastEventAt: null,
    lastRefreshAt: null,
    resyncing: false,
    connectionState: null,
    initialFetched: true,
    isStale: false,
    ...over,
  };
}

/** n 条本地 cache 条目(渲染源)。用于构造"本地低于/高于触发线"与"填满 limit"场景。 */
function mkEntries(n: number): RecentFriendListEntry[] {
  return Array.from({ length: n }, (_, i) => mkEntry(`c${i}`, 1000 + i));
}

/** 远端一页响应 —— 仅搜索路径用(默认列表不再走远端翻页)。 */
function mkResp(count: number, hasMore: boolean, nextCursor: string): ListRecentFriendsResp {
  return {
    size: count,
    hasMore,
    nextCursor,
    records: Array.from(
      { length: count },
      (_, i) => ({ conversationId: `r${i}` }) as RecentFriendListRecord,
    ),
  };
}

const okPrefill = { filled: true, localCount: 200, iters: 1, exhausted: false };

afterEach(() => {
  vi.clearAllMocks();
});

// 注:filledScopes 是模块级"本会话已预填"标记,跨用例累积。每个用例用**不同 accountFilter**
// (键 = `emp-1|<account>`)规避相互污染,保证冷启动用例能观察到一次预填。
describe("useRecentFriends 本地单源深读 + 水位预填", () => {
  it("冷启动(「全部」scope,本地<100):mount 触发水位预填一次,且不走远端整页翻页", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(10)));
    prefillMock.mockResolvedValue(okPrefill);

    renderHook(() => useRecentFriends({ accountFilter: null }));
    await act(async () => {});

    expect(prefillMock).toHaveBeenCalledTimes(1);
    expect(prefillMock).toHaveBeenCalledWith(null, false);
    expect(pageMock).not.toHaveBeenCalled(); // 默认列表不再走远端 recentFriends 整页翻页
  });

  it("冷启动(账号筛选 scope,本地<100):纯本地查询,不自动预填", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(10)));
    prefillMock.mockResolvedValue(okPrefill);

    renderHook(() => useRecentFriends({ accountFilter: "acc-cold" }));
    await act(async () => {});

    expect(prefillMock).not.toHaveBeenCalled(); // 账号筛选下零远端,数据靠全部 scope 预填 + 事件保鲜
    expect(pageMock).not.toHaveBeenCalled();
  });

  it("温缓存(本地≥100):mount 不预填、零远端", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50)));

    const { result } = renderHook(() => useRecentFriends({ accountFilter: "acc-warm" }));
    await act(async () => {});

    expect(prefillMock).not.toHaveBeenCalled();
    expect(pageMock).not.toHaveBeenCalled();
    expect(result.current.items).toHaveLength(TRIGGER + 50);
  });

  it("loadMore 纯本地深读:本地填满 limit 则涨深度并重读,不打远端", async () => {
    const res = resourceResult(mkEntries(INITIAL_LIMIT)); // 本地填满首屏深度
    useResourceMock.mockReturnValue(res);

    const { result } = renderHook(() => useRecentFriends({ accountFilter: "acc-deep" }));
    await act(async () => {});
    vi.mocked(res.refresh).mockClear();

    await act(async () => {
      await result.current.loadMore();
    });

    expect(pageMock).not.toHaveBeenCalled(); // 零远端
    expect(prefillMock).not.toHaveBeenCalled();
    expect(res.refresh).toHaveBeenCalled(); // 涨 limit 后本地重读
  });

  it("loadMore 本地见底(cacheItems<limit):no-op,不重读不联网", async () => {
    const res = resourceResult(mkEntries(INITIAL_LIMIT - 50)); // 读不满当前 limit ⇒ 见底
    useResourceMock.mockReturnValue(res);

    const { result } = renderHook(() => useRecentFriends({ accountFilter: "acc-bottom" }));
    await act(async () => {});
    vi.mocked(res.refresh).mockClear();
    prefillMock.mockClear();

    await act(async () => {
      await result.current.loadMore();
    });

    expect(pageMock).not.toHaveBeenCalled();
    expect(prefillMock).not.toHaveBeenCalled();
    expect(res.refresh).not.toHaveBeenCalled(); // 见底:不重读
    expect(result.current.defaultHasMore).toBe(false);
  });

  it("resync 跃迁(false→true):触发 force 水位预填(透传 force=true 跳后端短路)", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50), { resyncing: false }));
    prefillMock.mockResolvedValue(okPrefill);

    const { rerender } = renderHook(() => useRecentFriends({ accountFilter: "acc-resync" }));
    await act(async () => {});
    expect(prefillMock).not.toHaveBeenCalled(); // 温缓存 mount 不预填

    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50), { resyncing: true }));
    await act(async () => {
      rerender();
    });

    expect(prefillMock).toHaveBeenCalledTimes(1);
    // 安全网 #1:resync 必须透传 force=true,后端据此跳过 local_count>=200 短路重拉首页。
    expect(prefillMock).toHaveBeenCalledWith("acc-resync", true);
  });

  it("搜索走临时态:size=20 且 persist=false(不写库不污染默认列表)", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50)));

    const { result } = renderHook(() => useRecentFriends({ accountFilter: "acc-search" }));
    await act(async () => {});

    pageMock.mockResolvedValueOnce({
      size: 20,
      hasMore: false,
      nextCursor: "",
      records: [{ conversationId: "match-1" } as RecentFriendListRecord],
    });
    await act(async () => {
      await result.current.searchRemote({ externalName: "foo" });
    });

    const searchCall = pageMock.mock.calls[pageMock.mock.calls.length - 1];
    expect(searchCall[0]).toEqual(expect.objectContaining({ size: 20, externalName: "foo" }));
    expect(searchCall[1]).toBe(false); // persist=false:搜索结果不写本地
    expect(result.current.filtered?.map((i) => i.conversationId)).toEqual(["match-1"]);
  });

  it("切账号:即使切到本地浅的账号也不预填(纯本地查询,零网络)", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50)));
    prefillMock.mockResolvedValue(okPrefill);

    const { rerender } = renderHook(
      (props: { accountFilter: string | null }) => useRecentFriends(props),
      { initialProps: { accountFilter: "acc-sw1" } },
    );
    await act(async () => {});
    expect(prefillMock).not.toHaveBeenCalled();

    useResourceMock.mockReturnValue(resourceResult(mkEntries(10)));
    await act(async () => {
      rerender({ accountFilter: "acc-sw2" });
    });
    await act(async () => {});

    expect(prefillMock).not.toHaveBeenCalled(); // 切账号 = 本地过滤,不远端拉取
  });

  it("账号筛选 scope 本地 0 行:兜底预填一次(空列表死路兜底)", async () => {
    useResourceMock.mockReturnValue(resourceResult([]));
    prefillMock.mockResolvedValue(okPrefill);

    renderHook(() => useRecentFriends({ accountFilter: "acc-empty" }));
    await act(async () => {});

    expect(prefillMock).toHaveBeenCalledTimes(1);
    expect(prefillMock).toHaveBeenCalledWith("acc-empty", false);
  });

  it("切 scope 窗口期(isStale):即使 0 行也不决策预填(数据还是旧 scope 的)", async () => {
    useResourceMock.mockReturnValue(resourceResult([], { isStale: true }));
    prefillMock.mockResolvedValue(okPrefill);

    renderHook(() => useRecentFriends({ accountFilter: "acc-stale" }));
    await act(async () => {});

    expect(prefillMock).not.toHaveBeenCalled(); // 等新 scope 数据落地后再判
  });

  it("手动刷新(账号筛选下):仍 force 预填(显式动作保留远端对齐入口)", async () => {
    useResourceMock.mockReturnValue(resourceResult(mkEntries(TRIGGER + 50)));
    prefillMock.mockResolvedValue(okPrefill);

    const { result } = renderHook(() => useRecentFriends({ accountFilter: "acc-refresh" }));
    await act(async () => {});
    expect(prefillMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh();
    });

    expect(prefillMock).toHaveBeenCalledTimes(1);
    expect(prefillMock).toHaveBeenCalledWith("acc-refresh", true);
  });

  it("mkResp helper 自洽(仅搜索路径构造远端响应用)", () => {
    const r = mkResp(1, false, "");
    expect(r.records).toHaveLength(1);
  });
});
