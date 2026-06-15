/**
 * messageTemplates — the byte-stable dealer-facing message bodies and subject
 * lines. Every string that can reach a dealer is routed through `redactBudget`
 * (the single shared redactor) so a budget figure can never slip into outbound
 * text, regardless of what the profile carries.
 *
 * The rendered body/subject are pinned with byte snapshots in the test file —
 * any drift in wording, spacing, or line breaks is a deliberate change that must
 * re-pin, never an accident.
 *
 * Pure functions — no I/O, no DB.
 */

import { redactBudget } from "../gmail.js";

import { SUBJECT_PREFIX_FIRST_TOUCH } from "./constants.js";

/** The minimal profile shape the templates read. Flat + optional/nullable so a
 *  caller can pass a partially-filled intake row without reshaping it. */
export interface MessageProfile {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  financingPreference?: string | null;
  tradeInDescription?: string | null;
  militaryFirstResponder?: number | null;
  currentBrandOwner?: number | null;
  followUpEmail?: string | null;
}

/** Render the vehicle phrase `"{year} {make} {model} {trim}"`, dropping the trim
 *  when it is missing or the placeholder "any" (case-insensitive). Empty parts
 *  are skipped so a partial profile still yields a clean phrase. */
function vehiclePhrase(profile: MessageProfile): string {
  const trim = (profile.trim ?? "").trim();
  const trimOmitted = trim === "" || trim.toLowerCase() === "any";
  const parts = [
    profile.year ?? "",
    profile.make ?? "",
    profile.model ?? "",
    trimOmitted ? "" : trim,
  ]
    .map((p) => String(p).trim())
    .filter((p) => p !== "");
  return parts.join(" ");
}

/** The mutually-exclusive financing ask — exactly one line, chosen by the
 *  buyer's preference. Anything unrecognized (or "undecided"/empty) asks for
 *  both worlds. */
function financingLine(pref: string | null | undefined): string {
  switch ((pref ?? "").trim().toLowerCase()) {
    case "cash":
      return "I plan to pay cash.";
    case "finance":
      return "I'm interested in financing this vehicle. Please include your best financing rate (APR + term).";
    case "lease":
      return "I'm interested in leasing this vehicle. Please include your best lease offer (money factor + residual + 36 months / 10k miles per year).";
    default:
      return "I'd like to compare both options. Please include both your best financing rate (APR + term) and your best lease offer (money factor + residual + 36 months / 10k miles per year).";
  }
}

/** Extract a signature first name from an email local part. Splits on the
 *  separators an address local part uses (dots/underscores/hyphens/plus/digits)
 *  and capitalizes the first token. Returns "" when there is no usable email. */
function signatureName(email: string | null | undefined): string {
  const addr = (email ?? "").trim();
  if (addr === "") return "";
  const local = addr.split("@")[0] ?? "";
  const first = local.split(/[._\-+0-9]+/).find((t) => t !== "");
  if (first === undefined || first === "") return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Render the first-touch / lead-only body. Every dynamic fragment is redacted
 * before inclusion, so the body cannot carry a budget figure even if the
 * profile's free-text fields do. The output ends with exactly one trailing
 * newline.
 */
export function safeBodyTemplate(profile: MessageProfile): string {
  const vehicle = redactBudget(vehiclePhrase(profile)) || "vehicle";

  const lines: string[] = [];
  lines.push("Hi,");
  lines.push("");
  lines.push(
    redactBudget(
      `I'm interested in purchasing a new ${vehicle}. Could you please provide me with a detailed out-the-door (OTD) quote including all fees, taxes, and dealer charges?`,
    ),
  );
  lines.push("");

  lines.push(redactBudget(financingLine(profile.financingPreference)));

  const tradeIn = (profile.tradeInDescription ?? "").trim();
  if (tradeIn !== "") {
    lines.push(redactBudget(`I have a ${tradeIn} I may trade in.`));
  }
  if ((profile.militaryFirstResponder ?? 0) !== 0) {
    lines.push("I'm eligible for military/first responder incentives.");
  }
  if ((profile.currentBrandOwner ?? 0) !== 0) {
    const make = (profile.make ?? "").trim() || "brand";
    lines.push(redactBudget(`I'm a current ${make} owner.`));
  }

  // Separate the conditional block from the closing paragraph with one blank
  // line, but only when the previous line was not already blank.
  if (lines[lines.length - 1] !== "") {
    lines.push("");
  }

  lines.push(
    "I prefer to handle everything via email for now and will reach out by phone once we've agreed on pricing.",
  );
  lines.push("");
  lines.push("Thank you,");

  const signature = redactBudget(signatureName(profile.followUpEmail));
  lines.push(signature);

  return `${lines.join("\n")}\n`;
}

/** Render the first-touch subject line: the request prefix plus the vehicle
 *  phrase (redacted). Falls back to the bare prefix when no vehicle is known. */
export function safeSubjectLine(profile: MessageProfile): string {
  const vehicle = redactBudget(vehiclePhrase(profile));
  if (vehicle === "") return SUBJECT_PREFIX_FIRST_TOUCH;
  return `${SUBJECT_PREFIX_FIRST_TOUCH} ${vehicle}`;
}

/**
 * Build a reply subject from a prior subject: prefix with "Re: " unless it is
 * already a reply. An empty/whitespace prior subject yields a stable
 * placeholder so a thread reply never goes out with a blank subject.
 */
export function subjectForFollowup(priorSubject: string | null | undefined): string {
  const cleaned = (priorSubject ?? "").trim();
  if (cleaned === "") return "Re: (no subject)";
  if (cleaned.toLowerCase().startsWith("re:")) return cleaned;
  return `Re: ${cleaned}`;
}
