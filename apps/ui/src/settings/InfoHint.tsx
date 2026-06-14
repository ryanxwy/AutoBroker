/**
 * InfoHint — an accessible inline tooltip affordance next to an env-var keyword.
 * A small ⓘ trigger that reveals a one-line explanation on BOTH hover AND
 * keyboard focus (the user's explicit requirement), with Escape to dismiss.
 *
 * CSS-FIRST, no tooltip library: the bubble shows via the wrapper's `:hover` /
 * `:focus-within` (one rule covers mouse + keyboard) and stays rendered in the
 * DOM at rest (visually hidden, not display:none) so `aria-describedby` keeps
 * resolving for assistive tech. The only JS state is `dismissed`, set true on
 * Escape so the bubble hides while focus remains, and reset on blur / mouse
 * re-entry so the next hover/focus shows it again.
 *
 * A11y: the trigger is a real <button type="button"> (tab-reachable), carries a
 * visually-hidden accessible name + aria-describedby pointing at the bubble; the
 * bubble is role="tooltip". Satisfies dismissable + hoverable + persistent
 * content-on-hover-or-focus.
 *
 * Dependency wall: app/ui layer. react only.
 */

import { useState } from "react";

export interface InfoHintProps {
  /** The explanation shown in the bubble (the env-var's plain-language usage). */
  text: string;
  /** A human accessible name for the trigger (e.g. "What does Email mode do?"). */
  label: string;
  /** Stable suffix → testids `info-hint-${idSuffix}` / `info-hint-bubble-${idSuffix}`
   *  and the bubble's id for aria-describedby. */
  idSuffix: string;
}

export function InfoHint({ text, label, idSuffix }: InfoHintProps): JSX.Element {
  const [dismissed, setDismissed] = useState(false);
  const bubbleId = `info-hint-bubble-${idSuffix}`;

  return (
    <span
      className="info-hint-wrap"
      data-dismissed={dismissed}
      // Moving the pointer back over the affordance re-arms it after an Escape.
      onMouseEnter={() => setDismissed(false)}
    >
      <button
        type="button"
        className="info-hint"
        data-testid={`info-hint-${idSuffix}`}
        aria-describedby={bubbleId}
        // Focusing the trigger re-arms it (so it reveals on the next focus too).
        onFocus={() => setDismissed(false)}
        onBlur={() => setDismissed(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDismissed(true);
        }}
      >
        <span aria-hidden="true">&#9432;</span>
        <span className="visually-hidden">{label}</span>
      </button>
      <span className="info-hint-bubble" role="tooltip" id={bubbleId} data-testid={bubbleId}>
        {text}
      </span>
    </span>
  );
}
