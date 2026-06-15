/**
 * leadSubmit/scout — the DETERMINISTIC scout for dealer_web_lead_submit. Pure:
 * no browser navigation, no LLM, no DB, no network here. The browser-touching
 * verbs (navigate the contact path, 404-probe, snapshot the form DOM) and the
 * Custom-platform field-map LLM step live in the workflow's capture boundary;
 * this module supplies only the offline decisions those steps lean on:
 *
 *   1. platform-ID by URL/HTML fingerprint + the contact-path probe set —
 *      `LeadPlatform`, `platformOf`, `contactPathFor`;
 *   2. the dealer-facing form payload assembler — `buildLeadPayload`
 *      (fake phone LOCKED, budget redacted, consent CHECKED, SMS opt-in OMITTED);
 *   3. the US-only HARD GATE — `partitionUsDealers` (non-US filtered out BEFORE
 *      the approval banner, never an approvable target).
 *
 * Side effects (the gated `submitForm`, the email fallback `sendAndRecord`,
 * the `recordSubmission` write) all live downstream; the scout never reaches
 * them — it only shapes the inputs.
 */

import type { DealerLeadForm } from "../browser.js";
import { FAKE_PHONE_DEFAULT } from "../dealerComm/constants.js";
import {
  safeBodyTemplate,
  safeSubjectLine,
  type MessageProfile,
} from "../dealerComm/messageTemplates.js";
import { isUsDealerBatch } from "../inventory/pure.js";
import type { IsUsDealerOptions } from "../geo.js";
import { assertNoBudget, assertUnicodeSafe } from "../validators.js";

// ---------------------------------------------------------------------------
// 1. Platform-ID by URL-pattern table.
// ---------------------------------------------------------------------------

/**
 * The lead-form platform a dealer site runs on. The three known platforms each
 * expose a canonical contact path; anything unrecognised is "custom" and routes
 * to the LLM field-map step in the workflow (this module emits no map for it).
 */
export type LeadPlatform = "dealerfire" | "dealeron_v1" | "dealeron_v2" | "custom";

/** The canonical contact path each known platform serves its lead form at. The
 *  "custom" entry is empty — a custom site has no canned path, so the workflow
 *  falls through to the LLM field-map step. */
export const CONTACT_PATHS: Record<LeadPlatform, string> = {
  dealerfire: "/contact.htm",
  dealeron_v1: "/contact-us/",
  dealeron_v2: "/contactus.aspx",
  custom: "",
};

/**
 * Fingerprint table: [platform, marker]. Checked in order, first match wins.
 * The marker matches either a homepage-HTML platform signature OR the
 * platform's own contact-path token in a URL — so `platformOf` accepts both a
 * rendered HTML blob and a bare contact URL.
 *
 * The contact-path tokens are anchored on the distinctive filename/segment so a
 * plain `/contact-us/` (DealerOn v1) is not also caught by a substring of
 * `/contactus.aspx` (DealerOn v2). v2 is checked before v1 because `.aspx` is
 * the more specific token.
 */
const PLATFORM_FINGERPRINTS: ReadonlyArray<readonly [LeadPlatform, RegExp]> = [
  // DealerFire: the platform attribution string, or its `/contact.htm` path.
  ["dealerfire", /DealerFire|Powered by DealerFire|\/contact\.htm\b/i],
  // DealerOn v2: the ASP.NET `.aspx` contact endpoint (checked before v1).
  ["dealeron_v2", /DealerOn[^<]*v2|\/contactus\.aspx\b/i],
  // DealerOn v1: the platform attribution, or its `/contact-us/` path.
  ["dealeron_v1", /DealerOn|\/contact-us\/?(?:[?#]|$)/i],
];

/**
 * Fingerprint a dealer site to its lead-form platform from either its rendered
 * homepage/contact HTML or a contact URL. Returns "custom" when no known
 * platform marker hits — the caller then drives the LLM field-map step. Pure.
 */
export function platformOf(websiteHtmlOrUrl: string): LeadPlatform {
  for (const [platform, marker] of PLATFORM_FINGERPRINTS) {
    if (marker.test(websiteHtmlOrUrl)) return platform;
  }
  return "custom";
}

/**
 * The ordered set of absolute contact-path URLs to 404-probe for a dealer,
 * resolved against `origin`. The fingerprinted platform's own path comes FIRST
 * (most likely to be a fresh 200); the other two known paths follow as cheap
 * fallbacks before the workflow gives up to the Custom LLM map. A "custom"
 * platform has no canned path of its own, so the probe set is just the three
 * known paths in their declared order.
 *
 * De-duplicated and origin-resolved; the workflow walks this list in order and
 * stops at the first path that returns a usable form. Pure — no fetch here.
 */
export function contactPathFor(platform: LeadPlatform, origin: string): string[] {
  const known: LeadPlatform[] = ["dealerfire", "dealeron_v1", "dealeron_v2"];
  // The fingerprinted platform's path first, then the remaining known paths.
  const ordered = platform === "custom" ? known : [platform, ...known.filter((p) => p !== platform)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of ordered) {
    const path = CONTACT_PATHS[p];
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push(new URL(path, origin).toString());
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. buildLeadPayload — fake-phone LOCK + budget redact + unicode gate.
// ---------------------------------------------------------------------------

/**
 * The buyer-facing roles a discovered form field can play. The form's own field
 * `name` attribute is mapped to one of these by the scouted parity map (known
 * platforms) or the LLM field-map step (custom). "other" fields are never
 * filled. "sms_optin" is recognised so it can be deliberately OMITTED (left
 * unchecked) — the buyer never opts into dealer SMS by default.
 */
export type LeadFieldRole =
  | "name"
  | "email"
  | "phone"
  | "zip"
  | "comment"
  | "consent"
  | "sms_optin"
  | "other";

/** One field of a discovered form, mapped to the buyer-facing role it fills. */
export interface FormFieldRole {
  /** The form field's `name` attribute (the payload key). */
  name: string;
  role: LeadFieldRole;
}

/**
 * The minimal profile the payload reads. Extends the message-template profile
 * (which the redacted body/subject are built from) with the two identity fields
 * the form needs: the buyer's reply email and ZIP. Flat + nullable so a partial
 * intake row passes straight through.
 */
export interface LeadPayloadProfile extends MessageProfile {
  /** The buyer's reply-to email — fills the form's email field and seeds the
   *  signature line in the redacted body. */
  followUpEmail?: string | null;
  /** The buyer's ZIP — fills the form's zip field (digits only). */
  postalCode?: string | null;
}

/** The literal a checked consent box submits. */
const CONSENT_CHECKED = "on";

/**
 * Assemble the dealer-facing `DealerLeadForm` payload from a profile + a
 * role→name field map. Every value is safety-gated:
 *
 *   - phone   → ALWAYS `FAKE_PHONE_DEFAULT` (the buyer's real number never
 *               reaches a dealer through a lead form);
 *   - comment → the redacted first-touch body (`safeBodyTemplate`);
 *   - name    → the signature derived from the reply email (via the body);
 *   - email   → the buyer's reply email;
 *   - zip     → the buyer's postal code;
 *   - consent → CHECKED ("on");
 *   - sms_optin → OMITTED (the field is left out of the payload → unchecked);
 *   - other   → never filled.
 *
 * The assembled body + subject are run through `assertNoBudget` and
 * `assertUnicodeSafe` as a belt: the templates already redact, but the payload
 * is a send-path boundary, so a leak or a lone surrogate fails LOUD here rather
 * than reaching a dealer. Pure — no I/O.
 */
export function buildLeadPayload(args: {
  formUrl: string;
  profile: LeadPayloadProfile;
  /** role→name map for the target form (from the parity map or the LLM step). */
  fieldMap: readonly FormFieldRole[];
  /** CSS selector for the submit control (scouted DOM or LLM map). */
  submitSelector: string;
}): DealerLeadForm {
  const body = safeBodyTemplate(args.profile);
  const subject = safeSubjectLine(args.profile);
  // Belt: the templates redact, but this is a send-path boundary — fail loud.
  assertNoBudget(body);
  assertNoBudget(subject);
  assertUnicodeSafe(body);
  assertUnicodeSafe(subject);

  // The signature line the body ends on, reused for any name-role field so the
  // form's "name" matches the email body's sign-off.
  const signature = body.trimEnd().split("\n").pop() ?? "";

  const fields: Record<string, string> = {};
  for (const field of args.fieldMap) {
    switch (field.role) {
      case "phone":
        fields[field.name] = FAKE_PHONE_DEFAULT; // LOCKED — never the buyer's real number.
        break;
      case "email":
        fields[field.name] = (args.profile.followUpEmail ?? "").trim();
        break;
      case "zip":
        fields[field.name] = (args.profile.postalCode ?? "").trim();
        break;
      case "name":
        fields[field.name] = signature;
        break;
      case "comment":
        fields[field.name] = body;
        break;
      case "consent":
        fields[field.name] = CONSENT_CHECKED; // CHECKED.
        break;
      case "sms_optin":
        // OMITTED on purpose — leaving the field out submits it unchecked.
        break;
      case "other":
        // Never filled.
        break;
    }
  }

  return { url: args.formUrl, fields, submitSelector: args.submitSelector };
}

// ---------------------------------------------------------------------------
// 3. US-only HARD GATE.
// ---------------------------------------------------------------------------

/** The dealer fields the US gate + the lead flow need. Carries the gate signals
 *  (`IsUsDealerOptions`) plus the dealer identity/site the downstream steps use.
 *  Extra fields a caller passes through are preserved by the generic. */
export interface ScoutDealerRow extends IsUsDealerOptions {
  dealer_id: string;
}

/**
 * Split a dealer batch into US vs non-US in a SINGLE `isUsDealerBatch` call
 * (never one classify per dealer in a loop). The US-only rule is a HARD GATE:
 * the workflow filters `nonUs` out in the scout step — those dealers are counted
 * toward `us_gate_rejected` and NEVER appear as an approvable target in the
 * batch-review banner. Pure.
 */
export function partitionUsDealers<R extends ScoutDealerRow>(
  rows: readonly R[],
): { us: R[]; nonUs: R[] } {
  const verdicts = isUsDealerBatch(rows);
  const us: R[] = [];
  const nonUs: R[] = [];
  rows.forEach((row, i) => {
    (verdicts[i] ? us : nonUs).push(row);
  });
  return { us, nonUs };
}
