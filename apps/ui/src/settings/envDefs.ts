/**
 * envDefs — PRESENTATIONAL extras the env-config API does NOT supply. The panel
 * renders the rows FROM the server's EnvVarState[] (label / tooltip /
 * classification / allowedValues / value all ride the wire), so this file holds
 * ONLY the bits the wire deliberately omits — to avoid re-declaring the
 * descriptor set in two places (which would drift):
 *
 *   - friendly DISPLAY labels for the enum / bool option values (the wire sends
 *     the raw "buyer"/"test" and "1"/"0"; a non-tech user needs words), and
 *   - the confirm-warning copy for the one gate-before-control switch (enum →
 *     "buyer"), which is a UI affordance with no server field.
 *
 * Everything else (row label, tooltip, the allowed-values list, the current
 * value, the keyword) comes straight from getEnvConfig(). Nothing here re-states
 * an id's existence, classification, or allow-list.
 *
 * Dependency wall: app/ui layer. Pure data, no imports.
 */

/** Human display labels for the app_mode enum option values. The wire's
 *  allowedValues are the machine values ("buyer"/"test"); these are what the
 *  dropdown shows. A value missing here falls back to the raw value. */
export const APP_MODE_OPTION_LABELS: Record<string, string> = {
  buyer: "Buyer mode",
  test: "Test mode",
};

/** The id that switching the app_mode enum TO triggers a confirm for (the
 *  sensitive direction — turning on real dealer emails + form submits). The safe
 *  direction (buyer → test) commits immediately. */
export const APP_MODE_CONFIRM_VALUE = "buyer";

/** The gate-before-control confirm copy for the enum → "buyer" switch. Plain,
 *  non-tech: it names the one consequence (real dealer emails + form submits) and
 *  reassures that each one still waits for an explicit approval. */
export const APP_MODE_CONFIRM = {
  title: "Switch to buyer mode?",
  body: "Buyer mode really emails dealers and submits forms on your behalf. You still approve each one before it leaves your computer.",
  confirmLabel: "Use buyer mode",
  cancelLabel: "Keep test mode",
} as const;

/** Human On/Off words for the chrome_headless toggle, framed as the user-facing
 *  "Show the browser" question (the env var is the negation — "headless" — so
 *  checked = NOT headless; EnvRow owns that flip). */
export const SHOW_BROWSER_LABELS = { on: "On", off: "Off" } as const;
