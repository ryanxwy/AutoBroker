/**
 * ClickableTile — the shared whole-card clickable + keyboard-accessible `.tile`
 * primitive. Wraps a read-only canvas tile so the whole card opens its detail
 * modal on click, Enter, or Space (role=button, tabIndex 0). The card stays a
 * read-only projection — activating it only opens a double-check modal, never
 * mutates anything.
 *
 * Nested interactive children (links, buttons) MUST call e.stopPropagation() in
 * their own onClick so a click on, e.g., the inline "View listing" link does the
 * link's own thing WITHOUT also firing onActivate (opening the modal). Nested
 * controls keep their native keyboard behavior BECAUSE the onKeyDown handler
 * ignores key events that originated on a descendant (e.target !== currentTarget)
 * — so Enter/Space on a focused nested link does the link's own thing, never the
 * tile's onActivate (no keyboard double-fire). Mouse clicks still bubble, so
 * nested controls still need stopPropagation on CLICK to avoid the mouse
 * double-fire.
 */

import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export function ClickableTile({
  testid,
  onActivate,
  ariaLabel,
  className,
  children,
}: {
  testid: string;
  onActivate: () => void;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    // Ignore key events that bubbled up from a focused nested control (link,
    // button) — keyboard activation only fires when the tile itself is focused,
    // so a nested control keeps its native Enter/Space behavior (no double-fire).
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  };
  return (
    <div
      className={`tile tile-clickable${className !== undefined ? ` ${className}` : ""}`}
      role="button"
      tabIndex={0}
      data-testid={testid}
      aria-label={ariaLabel}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
