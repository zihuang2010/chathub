import { memo } from "react";

import { cn } from "@/lib/utils";

interface AccountTrendChartProps {
  /** 长度 7：[6天前, …, 昨天, 今天]。 */
  values: readonly number[];
  /** 控制颜色的 Tailwind 类，例如 "text-workbench-accent"；折线/区域用 currentColor。 */
  className?: string;
}

const VB_W = 200;
const VB_H = 60;
const PAD = 3;

/**
 * 卡片顶部的迷你趋势 sparkline：纯折线 + 区域填充，无坐标轴。
 * preserveAspectRatio="none" 让折线撑满容器宽度，stroke 用 non-scaling-stroke 保持线宽一致。
 */
export const AccountTrendChart = memo(function AccountTrendChart({
  values,
  className,
}: AccountTrendChartProps) {
  if (values.length < 2) return null;

  const max = Math.max(1, ...values);
  const stepX = VB_W / (values.length - 1);
  const usableH = VB_H - 2 * PAD;

  const coords = values.map((v, i) => {
    const x = i * stepX;
    const y = PAD + (1 - v / max) * usableH;
    return [x, y] as const;
  });

  const linePath = "M" + coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" L");
  const areaPath = linePath + ` L${VB_W},${VB_H} L0,${VB_H} Z`;

  return (
    <svg
      className={cn("block h-[30px] w-full", className)}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      aria-hidden
      data-testid="account-trend-chart"
    >
      <path d={areaPath} fill="currentColor" fillOpacity={0.12} />
      <path
        d={linePath}
        stroke="currentColor"
        strokeWidth={1.5}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});
