import { describe, it, expect } from "vitest";
import { docToBlocks } from "./docToBlocks";

describe("docToBlocks", () => {
  it("空文档返回空数组", () => {
    expect(docToBlocks({ type: "doc", content: [] })).toEqual([]);
  });

  it("单段纯文本", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "你好" }],
          },
        ],
      }),
    ).toEqual([{ type: "text", value: "你好" }]);
  });

  it("两段文本之间用换行连接", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "第一行" }] },
          { type: "paragraph", content: [{ type: "text", text: "第二行" }] },
        ],
      }),
    ).toEqual([{ type: "text", value: "第一行\n第二行" }]);
  });

  it("hardBreak 在段落内插入换行", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "上半行" },
              { type: "hardBreak" },
              { type: "text", text: "下半行" },
            ],
          },
        ],
      }),
    ).toEqual([{ type: "text", value: "上半行\n下半行" }]);
  });
});
