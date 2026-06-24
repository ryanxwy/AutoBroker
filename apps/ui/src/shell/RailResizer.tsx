/**
 * RailResizer — the draggable seam between the canvas and the chat rail. A
 * focusable WAI-ARIA window-splitter (role="separator") that writes the
 * `--rail-width` CSS variable on the `.app-body` container DIRECTLY (no React
 * re-render per frame — a single cheap style write), persisting only on commit.
 *
 * Pointer drag uses setPointerCapture so a fast sweep past the thin handle keeps
 * the drag. The rail is on the RIGHT, so dragging LEFT widens it (subtract dx).
 * Keyboard: ArrowLeft/Right (±16, Shift ±48), Home/End (min/max), Enter
 * (collapse↔restore). Double-click resets to the default. Every path runs the
 * same clamp → set-var → set-aria-valuenow → persist helper.
 *
 * The workbench is ONE layout (the rail is always present at a fixed
 * `--rail-width`), so this seam is always active — it is the single way to
 * rebalance the canvas against the rail.
 *
 * Dependency wall: app/ui layer. react + the layout-store helpers only.
 */

import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  RAIL_DEFAULT_PX,
  RAIL_MIN_PX,
  clampRailWidth,
  loadRailWidth,
  railMaxPx,
  saveRailWidth,
} from "../store/layout.js";

const STEP = 16;
const STEP_LARGE = 48;

export interface RailResizerProps {
  /** The `.app-body` container whose `--rail-width` this writes. */
  containerRef: RefObject<HTMLElement | null>;
}

export function RailResizer({ containerRef }: RailResizerProps): JSX.Element {
  const sepRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const collapsedFrom = useRef<number | null>(null);

  const containerWidth = (): number => containerRef.current?.clientWidth ?? window.innerWidth;

  const currentWidth = (): number => {
    const el = containerRef.current;
    if (el === null) return loadRailWidth();
    const v = parseFloat(getComputedStyle(el).getPropertyValue("--rail-width"));
    return Number.isFinite(v) && v > 0 ? v : loadRailWidth();
  };

  /** The single mutate path: clamp → write the CSS var → update aria-valuenow →
   *  (optionally) persist. */
  const apply = (px: number, persist: boolean): void => {
    const el = containerRef.current;
    if (el === null) return;
    const cw = containerWidth();
    const clamped = clampRailWidth(px, cw);
    el.style.setProperty("--rail-width", `${clamped}px`);
    sepRef.current?.setAttribute("aria-valuenow", String(Math.round((clamped / cw) * 100)));
    if (persist) saveRailWidth(clamped);
  };

  const onPointerDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    collapsedFrom.current = null; // any drag invalidates the Enter-restore point.
    sepRef.current?.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: currentWidth() };
    document.body.classList.add("resizing");
  };

  const onPointerMove = (e: ReactPointerEvent): void => {
    if (drag.current === null) return;
    // Rail on the RIGHT → dragging LEFT (clientX decreases) widens it.
    apply(drag.current.startW - (e.clientX - drag.current.startX), false);
  };

  const onPointerUp = (e: ReactPointerEvent): void => {
    if (drag.current === null) return;
    drag.current = null;
    try {
      sepRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    document.body.classList.remove("resizing");
    apply(currentWidth(), true); // commit + persist the final width once.
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const w = currentWidth();
    const step = e.shiftKey ? STEP_LARGE : STEP;
    // Any explicit sizing key (not Enter) invalidates a pending collapse-restore.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      collapsedFrom.current = null;
    }
    switch (e.key) {
      case "ArrowLeft": // toward the rail = bigger
        e.preventDefault();
        apply(w + step, true);
        break;
      case "ArrowRight":
        e.preventDefault();
        apply(w - step, true);
        break;
      case "Home":
        e.preventDefault();
        apply(RAIL_MIN_PX, true);
        break;
      case "End":
        e.preventDefault();
        apply(railMaxPx(containerWidth()), true);
        break;
      case "Enter":
        e.preventDefault();
        if (collapsedFrom.current !== null) {
          apply(collapsedFrom.current, true);
          collapsedFrom.current = null;
        } else {
          collapsedFrom.current = w;
          apply(RAIL_MIN_PX, true);
        }
        break;
      default:
        break;
    }
  };

  // The value attributes reflect the LIVE rail width as a percent of the
  // container (read from the CSS var, not the persisted value, so a re-render
  // mid-drag can't announce a stale percent). The drag also sets it imperatively.
  const cw = containerWidth();
  const pct = Math.round((clampRailWidth(currentWidth(), cw) / cw) * 100);

  return (
    <div
      ref={sepRef}
      className="rail-resizer"
      data-testid="rail-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize conversation panel"
      aria-controls="chat-rail"
      aria-valuemin={Math.round((RAIL_MIN_PX / cw) * 100)}
      aria-valuemax={Math.round((railMaxPx(cw) / cw) * 100)}
      aria-valuenow={pct}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => {
        collapsedFrom.current = null;
        apply(RAIL_DEFAULT_PX, true);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
