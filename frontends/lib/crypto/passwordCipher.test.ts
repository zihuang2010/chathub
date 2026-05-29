import { describe, expect, it } from "vitest";

import { encryptPassword } from "./passwordCipher";

// 固定向量锁住算法,防止 key/iv/mode/padding 任何一项被误改后还能通过 typecheck 上线。
// 期望值来自业务后台口径:@jdd/crypto.encrypt("123456") === "YehdBPev"。
describe("encryptPassword", () => {
  it("对 '123456' 输出业务后台约定的 'YehdBPev'", () => {
    expect(encryptPassword("123456")).toBe("YehdBPev");
  });

  it("空串输出空串(CFB 流密码 + NoPadding 时合理结果)", () => {
    expect(encryptPassword("")).toBe("");
  });

  it("同一明文多次加密结果一致(IV 固定 → 确定性)", () => {
    const a = encryptPassword("hello world");
    const b = encryptPassword("hello world");
    expect(a).toBe(b);
  });
});
