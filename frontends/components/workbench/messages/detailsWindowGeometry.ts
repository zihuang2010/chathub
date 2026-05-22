// Pure geometry for the customer-details window choreography. Kept free of
// Tauri APIs / async so the open/close size math is unit-testable in isolation;
// useDetailsWindow only feeds these the numbers it reads off the live window.

export interface WorkAreaBounds {
  /** Work-area left edge in physical px (monitor.workArea.position.x). */
  x: number;
  /** Work-area width in physical px (monitor.workArea.size.width). */
  width: number;
}

export interface ExpandInput {
  /** Current inner (content) width in physical px. */
  innerWidth: number;
  /** Current outer (window incl. decorations) width in physical px. */
  outerWidth: number;
  /** Current window left edge in physical px. */
  outerX: number;
  /** Details panel width to add, already scaled to physical px and rounded. */
  detailsWidth: number;
  /** Monitor work area, or null when it can't be read (browser preview). */
  workArea: WorkAreaBounds | null;
}

export interface ExpandTarget {
  /** False when the work area can't fit the wider window → caller squeezes instead of growing. */
  canGrow: boolean;
  /** Inner width to request via setSize when growing. */
  targetInnerWidth: number;
  /** Window left edge after any leftward shift to keep the wider window on-screen. */
  nextX: number;
}

/**
 * Compute the window growth target for opening the details panel.
 *
 * The work-area fit test uses OUTER width (the whole window competes with the
 * work area), while the size to request is the INNER width (content box). When
 * growing would push the right edge past the work area, the window shifts left
 * just enough to stay on-screen, never past the work-area left edge.
 */
export function computeExpandTarget(input: ExpandInput): ExpandTarget {
  const { innerWidth, outerWidth, outerX, detailsWidth, workArea } = input;
  const targetInnerWidth = innerWidth + detailsWidth;
  const targetOuterWidth = outerWidth + detailsWidth;

  if (workArea && targetOuterWidth > workArea.width) {
    return { canGrow: false, targetInnerWidth, nextX: outerX };
  }

  let nextX = outerX;
  if (workArea) {
    const workRight = workArea.x + workArea.width;
    const targetRight = outerX + targetOuterWidth;
    const overflow = Math.max(0, targetRight - workRight);
    if (overflow > 0) {
      nextX = Math.max(workArea.x, outerX - overflow);
    }
  }

  return { canGrow: true, targetInnerWidth, nextX };
}

/**
 * Compute the inner width to restore when closing the panel: subtract only the
 * amount the panel actually added (delta-undo), so a window the user manually
 * resized while the panel was open keeps that manual change. Floored at
 * `minWidth` so a window dragged narrow during the open period can't be shrunk
 * into an unusable sliver.
 */
export function computeRestoreTarget(
  currentInnerWidth: number,
  achievedDeltaWidth: number,
  minWidth: number,
): number {
  return Math.max(minWidth, currentInnerWidth - achievedDeltaWidth);
}
