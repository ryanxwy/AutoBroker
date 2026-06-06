/**
 * PinChip — 📌 {make model} with a ✕ unpin. Renders when
 * the active session has a pinned profile. The unpin handler is the parent's (it
 * PATCHes the session pin to null); this is presentational. Stable data-testid.
 */

export function PinChip({
  label,
  title,
  onUnpin,
}: {
  label: string;
  title?: string;
  onUnpin: () => void;
}): JSX.Element {
  return (
    <span className="pin-chip" data-testid="pin-chip" title={title}>
      <span aria-hidden="true">📌</span>
      <span data-testid="pin-chip-label">{label}</span>
      <button
        type="button"
        data-testid="pin-chip-unpin"
        aria-label="Unpin profile"
        onClick={onUnpin}
        style={{ border: "none", background: "none", padding: 0 }}
      >
        ✕
      </button>
    </span>
  );
}
