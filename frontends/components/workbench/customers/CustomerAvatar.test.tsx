// frontends/components/workbench/customers/CustomerAvatar.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { CustomerAvatar } from "./CustomerAvatar";

// 复现生产:打包后 isTauri()=true、非 Windows。回归点 —— 客户头像必须直连原始
// https URL,不得再被改写成 cachedimg:// 自定义协议:该协议的 SSRF 白名单仅放行
// OSS 域,会拒绝企微头像域(qpic.cn/qlogo.cn)→ 404 → 头像消失。dev(浏览器,
// isTauri()=false)恰好绕过该路径,故此前用例未能拦住该回归。
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@/lib/platform", () => ({ isWindows: false }));

afterEach(cleanup);

const AVATAR = "https://wework.qpic.cn/wwhead/abc/0";

describe("CustomerAvatar", () => {
  it("有 photoUrl 时 <img src> 为原始远程 URL(不经 cachedimg 代理)", () => {
    const { container } = render(<CustomerAvatar customerId="c1" name="早" photoUrl={AVATAR} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(AVATAR);
  });

  it("无 photoUrl 时回退首字母色块,不渲染 img", () => {
    const { container } = render(<CustomerAvatar customerId="c1" name="早乐" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("早");
  });
});
