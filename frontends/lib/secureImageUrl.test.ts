import { describe, expect, it } from "vitest";

import { secureImageUrl } from "./secureImageUrl";

describe("secureImageUrl", () => {
  it("明文 http:// 升级为 https://", () => {
    expect(secureImageUrl("http://wx.qlogo.cn/mmhead/abc/0")).toBe(
      "https://wx.qlogo.cn/mmhead/abc/0",
    );
  });

  it("https:// 原样返回", () => {
    expect(secureImageUrl("https://filet.jdd51.com/t/dev/x.png")).toBe(
      "https://filet.jdd51.com/t/dev/x.png",
    );
  });

  it("自定义协议 / blob / data 原样返回", () => {
    expect(secureImageUrl("cachedimg://localhost/?u=x")).toBe("cachedimg://localhost/?u=x");
    expect(secureImageUrl("blob:tauri://localhost/abc")).toBe("blob:tauri://localhost/abc");
  });

  it("空值返回 undefined", () => {
    expect(secureImageUrl(undefined)).toBeUndefined();
    expect(secureImageUrl(null)).toBeUndefined();
    expect(secureImageUrl("")).toBeUndefined();
  });
});
