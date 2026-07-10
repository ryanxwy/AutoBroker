/**
 * envDefs — PRESENTATIONAL extras the env-config API does NOT supply. The panel
 * renders the rows FROM the server's EnvVarState[] (label / tooltip /
 * classification / allowedValues / value all ride the wire), so this file holds
 * ONLY the bits the wire deliberately omits — to avoid re-declaring the
 * descriptor set in two places (which would drift):
 *
 *   - friendly display labels for enum / bool values, and
 *   - the per-id, per-value confirm-warning map for sensitive enum changes,
 *     which is a UI affordance with no server field.
 *
 * Everything else (row label, tooltip, the allowed-values list, the current
 * value, the keyword) comes straight from getEnvConfig(). Nothing here re-states
 * an id's existence, classification, or allow-list.
 *
 * Dependency wall: app/ui layer. Pure data, no imports.
 */

/** Human display labels for machine enum values, keyed by the server-owned id.
 * A value missing here falls back to the raw wire value. */
export const ENV_ENUM_OPTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  app_mode: { buyer: "Buyer mode", test: "Test mode" },
  auto_send: {
    off: "Off — ask every time",
    email: "Email only",
    web_form: "Web forms only",
    all: "Email and web forms",
  },
};

export interface EnvEnumConfirmation {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** Sensitive enum values require a deliberate confirmation before the generic
 * EnvRow writes them. Adding a future enum needs only one entry here — not a
 * custom settings card. */
export const ENV_ENUM_CONFIRMATIONS: Readonly<
  Record<string, Readonly<Record<string, EnvEnumConfirmation>>>
> = {
  app_mode: {
    buyer: {
      title: "Switch to buyer mode?",
      body: "Buyer mode really emails dealers and submits forms on your behalf. You still approve each one before it leaves your computer.",
      confirmLabel: "Use buyer mode",
      cancelLabel: "Keep test mode",
    },
  },
  auto_send: {
    email: {
      title: "Automatically approve email sends?",
      body: "New email-send approvals will proceed automatically in Buyer mode. Test mode still keeps every send internal, and email fallbacks still ask again.",
      confirmLabel: "Enable automatic email sends",
      cancelLabel: "Keep approvals manual",
    },
    web_form: {
      title: "Automatically approve web-form sends?",
      body: "New web-form send approvals will proceed automatically in Buyer mode. Test mode still keeps every send internal, and email fallbacks still ask again.",
      confirmLabel: "Enable automatic web forms",
      cancelLabel: "Keep approvals manual",
    },
    all: {
      title: "Automatically approve email and web-form sends?",
      body: "New email and web-form send approvals will proceed automatically in Buyer mode. Test mode still keeps every send internal, and email fallbacks still ask again.",
      confirmLabel: "Enable automatic sends",
      cancelLabel: "Keep approvals manual",
    },
  },
};

/** Human On/Off words for the chrome_headless toggle, framed as the user-facing
 *  "Show the browser" question (the env var is the negation — "headless" — so
 *  checked = NOT headless; EnvRow owns that flip). */
export const SHOW_BROWSER_LABELS = { on: "On", off: "Off" } as const;
