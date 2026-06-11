import { describe, expect, it } from "vitest";

import { resolveOwnerAccountName } from "./account";

describe("resolveOwnerAccountName", () => {
  it("注册表别名优先,覆盖被污染成账号名的行内别名(淑予场景)", () => {
    // recents 行被「发起会话」合成逻辑污染:wecom_alias 列存的是账号名。
    expect(
      resolveOwnerAccountName("A郑州韩振瑜02", "A郑州韩振瑜02", {
        name: "A郑州韩振瑜02",
        wecomAlias: "小管家乐乐",
      }),
    ).toBe("小管家乐乐");
  });

  it("注册表无别名时回退行内别名", () => {
    expect(
      resolveOwnerAccountName("小管家乐乐", "A郑州韩振瑜02", {
        name: "A郑州韩振瑜02",
        wecomAlias: "",
      }),
    ).toBe("小管家乐乐");
  });

  it("账号不在可管理注册表时只用行内字段:别名优先,空则回退行内名", () => {
    expect(resolveOwnerAccountName("小管家牛牛", "A郑州刘梦印02", undefined)).toBe("小管家牛牛");
    expect(resolveOwnerAccountName("", "A郑州刘梦印02", undefined)).toBe("A郑州刘梦印02");
  });

  it("注册表别名空且行内别名空时回退账号名(注册表名优先于行内名)", () => {
    expect(resolveOwnerAccountName("", "行内名", { name: "注册表名", wecomAlias: "" })).toBe(
      "注册表名",
    );
  });

  it("全部缺失返回空串", () => {
    expect(resolveOwnerAccountName("", "", undefined)).toBe("");
    expect(resolveOwnerAccountName(undefined, undefined, undefined)).toBe("");
  });

  it("纯空白视为空,逐级回退", () => {
    expect(resolveOwnerAccountName("   ", "  ", { name: "注册表名", wecomAlias: "  " })).toBe(
      "注册表名",
    );
  });
});
