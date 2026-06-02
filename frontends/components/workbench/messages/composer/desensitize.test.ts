// desensitize 纯函数单测:覆盖手机号/身份证/银行卡/邮箱遮蔽、混合、非敏感数字保留、
// 嵌入更长数字串不误伤、中文保留。
import { describe, expect, it } from "vitest";

import { desensitize } from "./desensitize";

describe("desensitize", () => {
  it("手机号 → [手机号]", () => {
    expect(desensitize("请联系13800138000")).toBe("请联系[手机号]");
  });

  it("身份证(18 位,含 X 校验位) → [身份证]", () => {
    expect(desensitize("身份证110101199003074618")).toBe("身份证[身份证]");
    expect(desensitize("尾号11010119900307461X")).toBe("尾号[身份证]");
  });

  it("银行卡(16-19 位) → [银行卡]", () => {
    expect(desensitize("卡号6222021234567890123")).toBe("卡号[银行卡]");
  });

  it("邮箱 → [邮箱]", () => {
    expect(desensitize("邮箱 test.user@example.com 收")).toBe("邮箱 [邮箱] 收");
  });

  it("一句里多个敏感项都遮蔽", () => {
    expect(desensitize("电话13912345678邮箱a@b.cn")).toBe("电话[手机号]邮箱[邮箱]");
  });

  it("非敏感短数字原样保留", () => {
    expect(desensitize("已登记123号,共2件")).toBe("已登记123号,共2件");
  });

  it("手机号嵌在更长数字串中不被误伤(无数字边界)", () => {
    // 15 位连续数字:既非 11 位手机(后接数字无边界)也非 16-19 银行卡,应原样保留。
    expect(desensitize("订单139123456780000")).toBe("订单139123456780000");
  });

  it("纯中文/无敏感信息原样返回", () => {
    expect(desensitize("师傅明天上午上门安装")).toBe("师傅明天上午上门安装");
  });
});
