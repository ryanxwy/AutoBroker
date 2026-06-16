/**
 * Modal — the app's portal dialog primitive (the first createPortal surface;
 * before this, inline gate-cards were the only "dialog" idiom). Two variants:
 *
 *   - "dialog" (default): role=dialog. Escape AND a backdrop click both close
 *     (closing an edit form destroys nothing). Used for the profile-edit modal.
 *   - "danger": role=alertdialog. Escape closes (→ the SAFE cancel branch), but
 *     a backdrop click does NOT — the irreversible path gets a single gated exit
 *     (an explicit button). Used for the hard-delete confirm.
 *
 * Behaviors (the proven ProfileRemoveControl alertdialog pattern, generalized):
 *   - focus-IN on open: the first focusable in the dialog (DOM order → put the
 *     safe action first), or `initialFocusRef` when supplied.
 *   - focus-RETURN on close: the element focused when the modal opened.
 *   - focus TRAP: Tab/Shift+Tab cycle within the dialog.
 *   - background scroll-lock (scrollbar-width compensated → no horizontal jump).
 *
 * Dependency wall: app/ui layer. react + react-dom (createPortal) only.
 */

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  /** The safe close (cancel) — Escape (both variants) and backdrop click (dialog
   *  variant only) route here. */
  onClose: () => void;
  /** id of the heading the dialog is labelled by (aria-labelledby). */
  labelId: string;
  variant?: "dialog" | "danger";
  /** id of the consequence text the danger dialog is described by. */
  describedById?: string;
  /** Focus this on open instead of the first focusable (e.g. a named field). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  labelId,
  variant = "dialog",
  describedById,
  initialFocusRef,
  children,
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus-in + focus-return + scroll-lock, keyed on `open` so the effects mount
  // and unmount cleanly with the dialog.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    // Defer initial focus one frame so the portal content has mounted.
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        dialogRef.current;
      target?.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      restoreRef.current?.focus?.();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (root === null) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onBackdropMouseDown = (e: ReactMouseEvent): void => {
    // Irreversible path: no backdrop dismiss — an explicit button is the only exit.
    if (variant === "danger") return;
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className="modal-backdrop" data-testid="modal-backdrop" onMouseDown={onBackdropMouseDown}>
      <div
        ref={dialogRef}
        data-testid="modal-dialog"
        className={`modal-dialog${variant === "danger" ? " danger" : ""}`}
        role={variant === "danger" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={labelId}
        {...(describedById !== undefined ? { "aria-describedby": describedById } : {})}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
