import { useEffect, useState } from "react";

/**
 * 「缩放以适配视口」的等比 scale 因子(0~1)。
 *
 * 开屏页 / 登录页是按固定像素精心排版的装饰性整页,在小屏(笔记本)或 Windows
 * 高 DPI 显示缩放(125% / 150%)下,CSS 视口会比设计基准更小,固定尺寸内容溢出、
 * 底部元素被裁。本 hook 取视口与设计基准在两个维度上的较小比值:
 *
 *   scale = min(1, innerWidth / designWidth, innerHeight / designHeight)
 *
 * 视口比设计基准小 → 返回 <1 整体等比缩小(绝不裁切、保留原有比例);视口足够大
 * → 返回 1(不放大,维持原始观感)。
 *
 * 刻意按 CSS 视口(window.innerWidth/Height)计算:Windows 显示缩放会直接缩小 CSS
 * 视口,故本 hook 对 DPI 缩放天然兼容,无需读取 devicePixelRatio。
 */
export function useFitScale(designWidth: number, designHeight: number): number {
  const [scale, setScale] = useState(() => computeScale(designWidth, designHeight));

  useEffect(() => {
    const update = () => setScale(computeScale(designWidth, designHeight));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [designWidth, designHeight]);

  return scale;
}

function computeScale(designWidth: number, designHeight: number): number {
  if (typeof window === "undefined") return 1;
  return Math.min(1, window.innerWidth / designWidth, window.innerHeight / designHeight);
}
