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

  it("文-图-文 混排", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "你好，" },
              { type: "image", attrs: { src: "blob:abc" } },
              { type: "text", text: "结束" },
            ],
          },
        ],
      }),
    ).toEqual([
      { type: "text", value: "你好，" },
      { type: "image", url: "blob:abc" },
      { type: "text", value: "结束" },
    ]);
  });

  it("连续图片不被合并", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "image", attrs: { src: "blob:1" } },
              { type: "image", attrs: { src: "blob:2" } },
            ],
          },
        ],
      }),
    ).toEqual([
      { type: "image", url: "blob:1" },
      { type: "image", url: "blob:2" },
    ]);
  });

  it("纯图片不带任何 text block", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "image", attrs: { src: "blob:x" } }],
          },
        ],
      }),
    ).toEqual([{ type: "image", url: "blob:x" }]);
  });

  it("mention 转成 @label 文本", () => {
    expect(
      docToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { label: "小美" } },
              { type: "text", text: "处理一下" },
            ],
          },
        ],
      }),
    ).toEqual([{ type: "text", value: "@小美 处理一下" }]);
  });
});
