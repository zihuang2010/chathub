import { memo } from "react";

interface DriftingWaveProps {
  /** SVG path data. Should be 2× viewBox-wide and tile-able with period 640. */
  d: string;
  fill: string;
  opacity?: number;
  /** SMIL animation duration, e.g. "20s". */
  dur: string;
  /** Translate distance in SVG units; defaults to one viewBox width (1280). */
  shift?: number;
}

/**
 * A single wave layer that drifts horizontally in a seamless loop using SMIL
 * animateTransform. Translation is in SVG user units, so the loop stays
 * correct at any rendered viewport width.
 */
// SMIL 的 animateTransform 不受 CSS @media (prefers-reduced-motion) 影响,只能在
// 渲染前由 JS 判断是否输出该动画节点。SSR/无 window 环境(matchMedia 不存在)按"非
// reduce"处理,保持现有动画。
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const DriftingWave = memo(function DriftingWave({
  d,
  fill,
  opacity = 1,
  dur,
  shift = 1280,
}: DriftingWaveProps) {
  // reduce 时只画静态波浪,不挂载平移动画。
  const reduceMotion = prefersReducedMotion();
  return (
    <path d={d} fill={fill} opacity={opacity}>
      {!reduceMotion && (
        <animateTransform
          attributeName="transform"
          type="translate"
          from="0 0"
          to={`-${shift} 0`}
          dur={dur}
          repeatCount="indefinite"
        />
      )}
    </path>
  );
});
