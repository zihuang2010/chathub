import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UseResourceResult } from "@/lib/data/useResource";
import { useResource } from "@/lib/data/useResource";

import { useRecentFriends, type RecentFriendListEntry } from "./useRecentFriends";
import {
  fetchRecentFriendsLocalPage,
  fetchRecentFriendsPage,
  type RecentFriendItem,
} from "./recentFriends";

// useResource(默认列表头部 cache 的来源)与 recentFriends IPC 全部 mock:
// 本测聚焦「滑过头部后的本地深读尾部」语义,不验真实订阅 / 网络。
vi.mock("@/lib/data/useCurrentEmployeeId", () => ({
  useCurrentEmployeeId: () => "emp-1",
}));
vi.mock("@/lib/data/useResource", () => ({ useResource: vi.fn() }));
vi.mock("./recentFriends", () => ({
  fetchRecentFriendsCache: vi.fn(),
  fetchRecentFriendsLocalPage: vi.fn(),
  fetchRecentFriendsPage: vi.fn(),
  markConversationRead: vi.fn(),
  muteConversation: vi.fn(),
  pinConversation: vi.fn(),
  setConversationDraft: vi.fn(),
  setConversationRemoved: vi.fn(),
}));

const useResourceMock = vi.mocked(useResource);
const localPageMock = vi.mocked(fetchRecentFriendsLocalPage);
const pageMock = vi.mocked(fetchRecentFriendsPage);

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

/** RecentFriendItem 与 Entry 字段同名同义(fromCacheItem 一一映射),复用 mkEntry 结构。 */
function asItems(rows: RecentFriendListEntry[]): RecentFriendItem[] {
  return rows as unknown as RecentFriendItem[];
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
    ...over,
  };
}

/** 满头部 cache(200 行,ts 递减保证排序稳定),避免触发「空缓存补远端首页」门。 */
function fullHeadCache(): RecentFriendListEntry[] {
  return Array.from({ length: 200 }, (_, i) => mkEntry(`c${i}`, 1_000_000 - i));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useRecentFriends 本地深读尾部", () => {
  it("滑到底走本地深读:offset=200 调 local_page,且不打远端 recentFriends", async () => {
    useResourceMock.mockReturnValue(resourceResult(fullHeadCache()));
    localPageMock.mockResolvedValue(asItems([mkEntry("cold-1", 100), mkEntry("cold-2", 99)]));

    const { result } = renderHook(() => useRecentFriends({ accountFilter: null }));
    await act(async () => {
      await result.current.loadMore();
    });

    expect(localPageMock).toHaveBeenCalledWith(null, 200, 200);
    expect(pageMock).not.toHaveBeenCalled(); // 零网络:不走远端业务接口
    expect(result.current.items.some((i) => i.conversationId === "cold-1")).toBe(true);
  });

  it("offset 随尾部累积递增:第二页从 400 起", async () => {
    useResourceMock.mockReturnValue(resourceResult(fullHeadCache()));
    localPageMock
      .mockResolvedValueOnce(
        asItems(Array.from({ length: 200 }, (_, i) => mkEntry(`t${i}`, 900 - i))),
      )
      .mockResolvedValueOnce(asItems([mkEntry("t200", 50)]));

    const { result } = renderHook(() => useRecentFriends({ accountFilter: null }));
    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });

    expect(localPageMock).toHaveBeenNthCalledWith(1, null, 200, 200);
    expect(localPageMock).toHaveBeenNthCalledWith(2, null, 400, 200);
  });

  it("某页返回 < 一页 → 本地到底:defaultHasMore=false 且后续 loadMore 永久 no-op", async () => {
    useResourceMock.mockReturnValue(resourceResult(fullHeadCache()));
    localPageMock.mockResolvedValue(asItems([mkEntry("cold-1", 100)])); // 1 < 200

    const { result } = renderHook(() => useRecentFriends({ accountFilter: null }));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.defaultHasMore).toBe(false);

    localPageMock.mockClear();
    await act(async () => {
      await result.current.loadMore();
    });
    expect(localPageMock).not.toHaveBeenCalled();
  });

  it("localTail 与 cache 重叠时去重,且 cache(权威)版本压过 tail 旧快照", async () => {
    const cache = [
      mkEntry("convX", 5000, { lastMessageSummary: "NEW" }),
      ...Array.from({ length: 199 }, (_, i) => mkEntry(`c${i}`, 4000 - i)),
    ];
    useResourceMock.mockReturnValue(resourceResult(cache));
    // 深读尾部捞到 convX 的旧快照(冒泡前)
    localPageMock.mockResolvedValue(
      asItems([mkEntry("convX", 300, { lastMessageSummary: "OLD" })]),
    );

    const { result } = renderHook(() => useRecentFriends({ accountFilter: null }));
    await act(async () => {
      await result.current.loadMore();
    });

    const xs = result.current.items.filter((i) => i.conversationId === "convX");
    expect(xs).toHaveLength(1);
    expect(xs[0].lastMessageSummary).toBe("NEW");
  });

  it("切账号重置 localTail:旧账号深读尾部不带入新账号", async () => {
    useResourceMock.mockReturnValue(resourceResult(fullHeadCache()));
    localPageMock.mockResolvedValue(asItems([mkEntry("cold-1", 100)]));

    const { result, rerender } = renderHook(
      (props: { accountFilter: string | null }) => useRecentFriends(props),
      { initialProps: { accountFilter: null } },
    );
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.some((i) => i.conversationId === "cold-1")).toBe(true);

    act(() => {
      rerender({ accountFilter: "wa-2" });
    });
    expect(result.current.items.some((i) => i.conversationId === "cold-1")).toBe(false);
  });
});
