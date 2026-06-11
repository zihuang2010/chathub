import { describe, expect, it } from "vitest";

import { secureImageUrl } from "./secureImageUrl";

describe("secureImageUrl", () => {
  it("明文 http:// 升级为 https://(qlogo /0 同时降为 /132)", () => {
    expect(secureImageUrl("http://wx.qlogo.cn/mmhead/abc/0")).toBe(
      "https://wx.qlogo.cn/mmhead/abc/132",
    );
  });

  it("qlogo 头像末段 /0(原图)降为 /132 小图", () => {
    expect(secureImageUrl("https://wx.qlogo.cn/mmhead/FwaezQHmpBHd/0")).toBe(
      "https://wx.qlogo.cn/mmhead/FwaezQHmpBHd/132",
    );
    expect(secureImageUrl("https://thirdwx.qlogo.cn/mmopen/xyz/0")).toBe(
      "https://thirdwx.qlogo.cn/mmopen/xyz/132",
    );
  });

  it("qlogo 已是小图尺寸(/132、/64)原样返回", () => {
    expect(secureImageUrl("https://wx.qlogo.cn/mmhead/abc/132")).toBe(
      "https://wx.qlogo.cn/mmhead/abc/132",
    );
    expect(secureImageUrl("https://wx.qlogo.cn/mmhead/abc/64")).toBe(
      "https://wx.qlogo.cn/mmhead/abc/64",
    );
  });

  it("非 qlogo 域的 /0 结尾路径不改写", () => {
    expect(secureImageUrl("https://filet.jdd51.com/t/dev/0")).toBe(
      "https://filet.jdd51.com/t/dev/0",
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
