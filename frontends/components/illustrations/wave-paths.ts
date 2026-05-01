/**
 * Build a seamless 2× viewBox-wide wave path with period 640. Combined with a
 * `<DriftingWave>` translation of -1280 SVG units, the wave loops without any
 * visible seam.
 *
 * @param baseline The y-coordinate of the resting wave line.
 * @param amplitude The peak distance from the baseline.
 * @param bottom The y-coordinate of the path's bottom edge (where it closes
 *               to a fill).
 */
export function buildWavePath(baseline: number, amplitude: number, bottom: number): string {
  const peak = baseline - amplitude;
  return (
    `M0,${baseline} ` +
    `Q160,${peak} 320,${baseline} ` +
    `T640,${baseline} T960,${baseline} T1280,${baseline} ` +
    `T1600,${baseline} T1920,${baseline} T2240,${baseline} T2560,${baseline} ` +
    `L2560,${bottom} L0,${bottom} Z`
  );
}
