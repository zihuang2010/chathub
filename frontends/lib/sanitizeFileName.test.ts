// 下载附件的建议文件名清理:服务端文件名可能含 Windows 禁字符,直接塞进「另存为」
// 对话框的 defaultPath 会导致对话框异常或写盘失败。

import { describe, expect, it } from "vitest";

import { sanitizeFileName } from "./sanitizeFileName";

describe("sanitizeFileName", () => {
  it('替换 Windows 禁字符 < > : " / \\ | ? * 为下划线', () => {
    expect(sanitizeFileName('报表<2026>:a"b/c\\d|e?f*.xlsx')).toBe("报表_2026__a_b_c_d_e_f_.xlsx");
  });

  it("剔除控制字符", () => {
    expect(sanitizeFileName("a\u0007b\u001fc.txt")).toBe("abc.txt");
  });

  it("去掉结尾的点和空格(Windows 不允许)", () => {
    expect(sanitizeFileName("report. ")).toBe("report");
    expect(sanitizeFileName("archive...")).toBe("archive");
  });

  it("合法文件名原样保留(含中文/空格/点号)", () => {
    expect(sanitizeFileName("年度 报表 v2.final.xlsx")).toBe("年度 报表 v2.final.xlsx");
  });

  it("清理后为空时回退 undefined(让对话框用默认名)", () => {
    expect(sanitizeFileName("???")).toBe("___");
    expect(sanitizeFileName("...")).toBeUndefined();
    expect(sanitizeFileName("")).toBeUndefined();
    expect(sanitizeFileName(undefined)).toBeUndefined();
  });
});
