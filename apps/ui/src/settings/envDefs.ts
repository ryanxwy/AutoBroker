/**
 * envDefs — PRESENTATIONAL extras the env-config API does NOT supply. The panel
 * renders the rows FROM the server's EnvVarState[] (label / tooltip /
 * classification / allowedValues / value all ride the wire), so this file holds
 * ONLY the bits the wire deliberately omits — to avoid re-declaring the
 * descriptor set in two places (which would drift):
 *
 *   - friendly display labels for enum / bool values, and
 *   - confirm-warning copy for sensitive enum values, which is a UI affordance
 *     with no server field.
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

export const APP_MODE_CONFIRM = {
  title: "Switch to buyer mode?",
  body: "Buyer mode really emails dealers and submits forms on your behalf. Approvals stay manual unless Automatic send approvals is separately enabled.",
  confirmLabel: "Use buyer mode",
  cancelLabel: "Keep test mode",
} as const;

export const ENV_ENUM_OPTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  app_mode: APP_MODE_OPTION_LABELS,
  auto_send: {
    off: "Off — ask me every time",
    email: "Email sends",
    web_form: "Web-form submits",
    all: "Email + web forms",
  },
};

export const ENV_ENUM_CONFIRMATIONS: Readonly<Record<string, Readonly<Record<string, {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}>>>> = {
  app_mode: { buyer: APP_MODE_CONFIRM },
  auto_send: {
    email: {
      title: "Enable automatic email sends?",
      body: "New first-send email approvals will proceed automatically in Buyer mode. Test mode stays internal, and email fallbacks still ask again.",
      confirmLabel: "Enable email auto-send",
      cancelLabel: "Keep approvals manual",
    },
    web_form: {
      title: "Enable automatic web-form submits?",
      body: "New first-send web-form approvals will proceed automatically in Buyer mode. Test mode stays internal, and email fallbacks still ask again.",
      confirmLabel: "Enable web-form auto-send",
      cancelLabel: "Keep approvals manual",
    },
    all: {
      title: "Enable automatic email and web sends?",
      body: "New first-send email and web-form approvals will proceed automatically in Buyer mode. Test mode stays internal, and email fallbacks still ask again.",
      confirmLabel: "Enable automatic sends",
      cancelLabel: "Keep approvals manual",
    },
  },
};

/** Bool rows can differ in polarity: Show browser checks on value "0" because
 * the backing env is headless; Auto-run checks on value "1". */
export const ENV_BOOL_PRESENTATIONS: Readonly<
  Record<string, { checkedValue: "0" | "1"; checkedLabel: string; uncheckedLabel: string }>
> = {
  chrome_headless: { checkedValue: "0", checkedLabel: "On", uncheckedLabel: "Off" },
  auto_run_searches: { checkedValue: "1", checkedLabel: "On", uncheckedLabel: "Off" },
};
