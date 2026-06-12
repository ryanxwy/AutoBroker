/**
 * Popover — the minimal popover primitive for the top bar (class-based, no
 * library; this is the app's only floating-layer need). A trigger button
 * toggles an anchored panel; outside-click and Escape close it. `onOpen` fires
 * on EVERY open so panel content can refetch — the top bar is persistent
 * (never remounts), so a list fetched once would otherwise go stale.
 *
 * Children may be a render function receiving `close`, so a row action (e.g.
 * Run) can dismiss the panel itself.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface PopoverProps {
  label: ReactNode;
  triggerTestId: string;
  panelTestId: string;
  /** Fired on every open (the refetch hook). */
  onOpen?: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
}

export function Popover({ label, triggerTestId, panelTestId, onOpen, children }: PopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const toggle = (): void => {
    if (!open) onOpen?.();
    setOpen(!open);
  };

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: Event): void => {
      if (wrapRef.current !== null && e.target instanceof Node && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover-wrap" ref={wrapRef}>
      <button type="button" data-testid={triggerTestId} aria-expanded={open} onClick={toggle}>
        {label}
      </button>
      {open && (
        <div className="popover-panel" data-testid={panelTestId} role="dialog" aria-label={typeof label === "string" ? label : undefined}>
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}
