/**
 * layout — chat-rail WIDTH helpers. The workbench is ONE layout: the canvas on
 * the left, the chat rail fixed at `--rail-width` on the right, and the
 * RailResizer always draggable to rebalance them. (There is no canvas-vs-
 * conversation MODE — the rail is always present; the drag seam is the single
 * way to widen/narrow it.) Width is device-local VIEW state (px), persisted to
 * localStorage so the split survives a refresh.
 *
 * The RailResizer writes the `--rail-width` CSS variable on the `.app-body`
 * container directly during a drag (no React re-render per frame); these helpers
 * own the default/clamp/persist contract both it and App share.
 *
 * Dependency wall: app/ui layer. localStorage only.
 */

/** The default rail width — the long-standing fixed value, now the reset target. */
export const RAIL_DEFAULT_PX = 400;
/** Below this the composer + gate cards wrap badly; never narrower. */
export const RAIL_MIN_PX = 320;
const RAIL_WIDTH_KEY = "autobroker:rail-width";

/** The widest the rail may get without starving the canvas: 560px, or 48% of the
 *  container, whichever is smaller (never below the min). */
export function railMaxPx(containerWidth: number): number {
  return Math.max(RAIL_MIN_PX, Math.min(560, Math.round(containerWidth * 0.48)));
}

/** Clamp a desired width to [MIN, max(container)] — applied on every drag,
 *  keyboard step, AND restore (a value saved on a wide window can't eat the
 *  canvas on a narrow one). */
export function clampRailWidth(px: number, containerWidth: number): number {
  return Math.min(railMaxPx(containerWidth), Math.max(RAIL_MIN_PX, px));
}

/** The persisted width, or the default (never the unclamped raw value — callers
 *  re-clamp against the live container width). */
export function loadRailWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(v) && v > 0 ? v : RAIL_DEFAULT_PX;
  } catch {
    return RAIL_DEFAULT_PX;
  }
}

/** Persist the committed width (drag end / keyboard commit only — never per move). */
export function saveRailWidth(px: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* view state only — persistence is best-effort */
  }
}
