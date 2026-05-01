import { memo, type CSSProperties } from "react";

/**
 * Twinkling mini-bubble that drifts around a parent bubble.
 * Coordinates are local to the parent bubble's container.
 */
export interface Satellite {
  x: number;
  y: number;
  size: number;
  color: string;
  /** Drift X (px) at the midpoint of the loop. */
  dx: number;
  /** Drift Y (px) at the midpoint of the loop. */
  dy: number;
  /** ms */
  delay: number;
  /** ms — varied per-item so satellites twinkle out of sync. */
  duration: number;
}

/**
 * Renders a ring of satellites as absolutely-positioned `<span>`s. Pure
 * presentational, animation is driven by the global `chSatellite` keyframe in
 * `index.css` plus per-item `--dx` / `--dy` CSS custom properties.
 */
export const SatelliteRing = memo(function SatelliteRing({ items }: { items: Satellite[] }) {
  return (
    <>
      {items.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute rounded-full"
          style={
            {
              left: s.x,
              top: s.y,
              width: s.size,
              height: s.size,
              background: s.color,
              animation: `chSatellite ${s.duration}ms ${s.delay}ms ease-in-out infinite`,
              "--dx": `${s.dx}px`,
              "--dy": `${s.dy}px`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
});
