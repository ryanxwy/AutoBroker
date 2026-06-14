/**
 * envDefs — PRESENTATIONAL extras the env-config API does NOT supply. The panel
 * renders the rows FROM the server's EnvVarState[] (label / tooltip /
 * classification / allowedValues / value all ride the wire), so this file holds
 * ONLY the bits the wire deliberately omits — to avoid re-declaring the
 * descriptor set in two places (which would drift):
 *
 *   - friendly DISPLAY labels for the enum / bool option values (the wire sends
 *     the raw "fake"/"real" and "1"/"0"; a non-tech user needs words), and
 *   - the confirm-warning copy for the one gate-before-control switch (enum →
 *     "real"), which is a UI affordance with no server field.
 *
 * Everything else (row label, tooltip, the allowed-values list, the current
 * value, the keyword) comes straight from getEnvConfig(). Nothing here re-states
 * an id's existence, classification, or allow-list.
 *
 * Dependency wall: app/ui layer. Pure data, no imports.
 */

/** Human display labels for the gmail_backend enum option values. The wire's
 *  allowedValues are the machine values ("fake"/"real"); these are what the
 *  dropdown shows. A value missing here falls back to the raw value. */
export const GMAIL_BACKEND_OPTION_LABELS: Record<string, string> = {
  fake: "Sample inbox",
  real: "My real Gmail",
};

/** The id that switching the gmail_backend enum TO triggers a confirm for (the
 *  sensitive direction — turning on real-Gmail reads). The safe direction
 *  (real → fake) commits immediately. */
export const GMAIL_BACKEND_CONFIRM_VALUE = "real";

/** The gate-before-control confirm copy for the enum → "real" switch. Plain,
 *  non-tech: it names the one consequence (live inbox reads) and reassures that
 *  sending still always waits for an explicit approval. */
export const GMAIL_BACKEND_CONFIRM = {
  title: "Switch to your real Gmail?",
  body: "Real Gmail will read your live inbox. Sending still always waits for your explicit approval.",
  confirmLabel: "Use real Gmail",
  cancelLabel: "Keep sample inbox",
} as const;

/** Human On/Off words for the chrome_headless toggle, framed as the user-facing
 *  "Show the browser" question (the env var is the negation — "headless" — so
 *  checked = NOT headless; EnvRow owns that flip). */
export const SHOW_BROWSER_LABELS = { on: "On", off: "Off" } as const;
