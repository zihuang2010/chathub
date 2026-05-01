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
export const DriftingWave = memo(function DriftingWave({
  d,
  fill,
  opacity = 1,
  dur,
  shift = 1280,
}: DriftingWaveProps) {
  return (
    <path d={d} fill={fill} opacity={opacity}>
      <animateTransform
        attributeName="transform"
        type="translate"
        from="0 0"
        to={`-${shift} 0`}
        dur={dur}
        repeatCount="indefinite"
      />
    </path>
  );
});
