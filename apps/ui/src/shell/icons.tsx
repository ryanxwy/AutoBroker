/**
 * icons — the app's small monoline glyph set (the only inline SVGs). Each is
 * `currentColor`, `aria-hidden` + `focusable="false"` (decorative; the
 * accessible name lives on the surrounding control). Stroke ~1.6px to match the
 * quiet ledger iconography. Dependency wall: app/ui layer (react only).
 */

/** Brand mark — the BrokerClaw mascot (the product's logo), served as a static
 *  asset from public/logo/ (the artwork is a raster sticker, so it is an <img>,
 *  not an inline glyph like the rest of this set). Same asset the rest of the
 *  product uses; decorative, so the accessible name lives on the brand link. */
export function BrandMark({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <img
      className="brand-mark"
      src="/logo/mark.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** Settings gear — monoline cog. */
export function GearIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.7 5.3l-1.7 1.7M7 17l-1.7 1.7M18.7 18.7 17 17M7 7 5.3 5.3" />
    </svg>
  );
}

/** Pin toggle glyph — a pushpin. Filled (accent) when pinned, hollow when not. */
export function PinIcon({ filled, size = 15 }: { filled: boolean; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
      <path d="M12 13v8" />
    </svg>
  );
}

/** History — a clock (recent sessions). */
export function HistoryIcon({ size = 17 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** Send — an up arrow inside the round composer button. */
export function SendIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}
