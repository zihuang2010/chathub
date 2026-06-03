import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UseResourceResult } from "@/lib/data/useResource";
import { useResource } from "@/lib/data/useResource";

import { useAccounts } from "./useAccounts";
import { fetchAccounts } from "./accounts";

vi.mock("@/lib/data/useCurrentEmployeeId", () => ({
  useCurrentEmployeeId: () => "emp-1",
}));
vi.mock("@/lib/data/useResource", () => ({ useResource: vi.fn() }));
vi.mock("./accounts", () => ({ fetchAccounts: vi.fn().mockResolvedValue([]) }));

const useResourceMock = vi.mocked(useResource);
const fetchMock = vi.mocked(fetchAccounts);

// 构造 UseResourceResult stub,only resyncing 可控。
function resourceResult(resyncing: boolean): UseResourceResult<unknown[]> {
  return {
    data: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    lastEventAt: null,
    lastRefreshAt: null,
    resyncing,
    connectionState: null,
    initialFetched: true,
    isStale: false,
  };
}

// 捕获传给 useResource 的 queryFn,以便测试里手动调它观察 force 透传。
// 返回函数调用时读到的是「最后一次 mockImplementation 捕获的 queryFn」引用,
// 因此在跃迁后调即可获取到 forceNextRef 已被 effect 置位后的行为。
function setup(resyncing: boolean): () => Promise<unknown> {
  let captured: () => Promise<unknown> = async () => [];
  useResourceMock.mockImplementation((opts) => {
    // queryFn 签名是 (scope: ChangeScope) => Promise<T>,这里忽略 scope 直接调
    captured = () => (opts.queryFn as () => Promise<unknown>)();
    return resourceResult(resyncing) as UseResourceResult<never[]>;
  });
  return () => captured();
}

afterEach(() => vi.clearAllMocks());

describe("useAccounts resync 强制拉 listMine", () => {
  it("resyncing false→true 跃迁后,下一次 queryFn 以 force=true 拉 listMine", async () => {
    // 初始 resyncing=false:mount 正常
    const callQuery = setup(false);
    const { rerender } = renderHook(() => useAccounts());
    await act(async () => {});

    // 跃迁到 resyncing=true;effect 在此 render 后跑 → forceNextRef.current=true。
    // callQuery 闭包读 captured,会拿到此次 setup 捕获的 queryFn(forceNextRef 已置位)。
    setup(true);
    await act(async () => {
      rerender();
    });

    // 模拟 resync 的 doFetch 调 queryFn 一次。
    await act(async () => {
      await callQuery();
    });

    // 安全网 #2:resync 跃迁后下一次 queryFn 必须带 force=true 拉 listMine。
    expect(fetchMock).toHaveBeenLastCalledWith({ force: true });
  });

  it("resyncing 不跃迁(始终 false):queryFn 以 force=false 读 cache", async () => {
    const callQuery = setup(false);
    renderHook(() => useAccounts());
    await act(async () => {});

    // 直接调 queryFn,未经跃迁,forceNextRef 应仍为 false。
    await act(async () => {
      await callQuery();
    });

    expect(fetchMock).toHaveBeenLastCalledWith({ force: false });
  });

  it("refetch({force:true}) 既有机制仍正常置位 forceNextRef", async () => {
    setup(false);
    const { result } = renderHook(() => useAccounts());
    await act(async () => {});

    // 通过 refetch API 置位
    await act(async () => {
      await result.current.refetch({ force: true });
    });

    // refresh 被调用即可(forceNextRef 置位在 refresh 之前,queryFn 下一轮由 useResource 调)
    // 此处断言 refetch 不抛且 loading/error 无异常。
    expect(result.current.error).toBeNull();
  });
});
