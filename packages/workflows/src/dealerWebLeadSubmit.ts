/**
 * dealer_web_lead_submit — the irreversible-send KEYSTONE (real send in buyer mode, fake in test mode).
 * ONE flat linear Mastra `createWorkflow`: 8 named steps chained with `.then()`,
 * no nested workflow. TWO human suspends, BOTH before any side effect; the first
 * is the batch_review card (decline = terminal, zero writes / zero sends), the
 * second is the INDEPENDENT email_fallback re-confirm (the whole point of X1: the
 * browser.submit → gmail.send scope switch is a new sensitive scope and is NEVER
 * folded into the batch approval).
 *
 * STEP MAP:
 *   0 resolveProfile — EXPLICIT-PIN REQUIRED (this skill never infers): a
 *                      pin-less full-batch input STOPs (0 active →
 *                      no_active_profile pointing at intake; ≥1 active →
 *                      pin_required listing the candidate vehicles). single-store
 *                      mode (target_listing_id) resolves the dealer via the
 *                      listing's own profile, so it is allowed without a pin.
 *   1 scout         — per bound dealer (or the single listing's dealer): the
 *                      US-only HARD GATE (one batched classify; non-US filtered
 *                      out, counted us_gate_rejected, NEVER a card row), the
 *                      browser-read capture boundary (navigate the contact path,
 *                      snapshot the form DOM, 404-probe — an INJECTABLE dep that
 *                      holds NO Approver), and the `dealers.contact_email` upsert
 *                      (THE ONLY pre-approval write — a local product-DB write,
 *                      not a gated side effect). A dealer with a usable form is
 *                      eligible; a no-form dealer with a contact email is an
 *                      email-fallback candidate.
 *   1b scoutMapCustom — the ONLY LLM step: a single emit_result field-map for
 *                      Custom-platform forms (hitlAvailable:false → a malformed
 *                      first hop is retried ONCE on the lead_form_map_retry lane
 *                      via recoverEmitWithRetry, else fail-closes as a thrown
 *                      MalformedToolCallAbort, never a prose fallthrough). Known
 *                      platforms skip it.
 *   2 buildPayloads — buildLeadPayload (fake phone LOCKED, budget redacted,
 *                      consent CHECKED, sms_optin OMITTED) + the duplicate-skip /
 *                      force_retry precondition (a prior submitted row → skip,
 *                      counted skipped_duplicate).
 *   3 batchReview   — SUSPEND ① (the only batch card). Reuses the shared
 *                      batch_review contract: approve names an explicit id list,
 *                      decline → terminal zero writes. single-store mode collapses
 *                      to the kind:"approval" single_store_confirm suspend.
 *   4 submit        — per approved dealer: the ONE Approver-holding call,
 *                      session.submitForm via the internal always-true APPROVED
 *                      approver (the human ALREADY approved at ①; the AUTOBROKER_MODE=test
 *                      brake is the test-mode floor — in test mode it throws BEFORE the click).
 *                      captcha NEVER retried → routes straight to email_fallback.
 *   5 emailFallback — SUSPEND ② (the X1 FIX POINT): the INDEPENDENT re-confirm
 *                      for each needs-fallback dealer. approve → sendAndRecord
 *                      (fake) writes one email-shape row; decline → skip THAT
 *                      dealer's fallback only (carry "declined"), run continues.
 *   6 recordConfirm — the LOCAL recordSubmission XOR writer (one row per decided
 *                      dealer, the channel-matching shape) + the zero-LLM confirm
 *                      template. recordSubmission is NOT mode-gated — it writes the
 *                      local submission row on approve regardless of send mode.
 *
 * KEYSTONE: the scout capture path holds NO Approver and imports NOTHING from the
 * gate module — the ONLY Approver-holding call is `session.submitForm` in the
 * submit step (and `sendAndRecord` in the fallback step, both reusing the single
 * internal APPROVED object). Communication never carries budget (the templates
 * redact + assertNoBudget belt in buildLeadPayload / buildRaw); the phone is the
 * fake default; consent is CHECKED, sms opt-in is OMITTED.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools
 * (resolver + dealer-row read + the scout + the gated browser session +
 * recordSubmission + sendAndRecord — the ONLY DB/side-effect paths), this
 * layer's harness facade + the skill contracts, and the recoverEmitWithRetry
 * recovery helper (which owns the @autobroker/model contact for the
 * malformed-class retry hop).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  buildLeadPayload,
  checkSubmissionPrecondition as checkSubmissionPreconditionImpl,
  claimDealer as claimDealerImpl,
  type ClaimResult,
  contactPathFor,
  ExternalMutationsBlockedError,
  getDb,
  hasCaptcha,
  listProfileDealerRows as listProfileDealerRowsImpl,
  listProfileRows as listProfileRowsImpl,
  NULL_EMITTER,
  partitionUsDealers,
  platformOf,
  readListingRowById,
  readProfileRow,
  recordSubmission as recordSubmissionImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  safeBodyTemplate,
  safeSubjectLine,
  sendAndRecord as sendAndRecordImpl,
  upsertDealerContactEmail as upsertDealerContactEmailImpl,
  withBrowserContext,
  type Approver,
  type BrowserEmitter,
  type BrowserSession,
  type DealerLeadForm,
  type EmailFallbackReason,
  type FormFieldRole,
  type LeadFieldRole,
  type LeadPayloadProfile,
  type SendRecordTarget,
} from "@autobroker/tools";

import {
  BatchReviewResumeSchema,
  BatchReviewSuspendSchema,
  buildLeadFormMapPrompt,
  DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,
  DealerWebLeadSubmitInputSchema,
  DealerWebLeadSubmitOutputSchema,
  DealerWebLeadSubmitStopError,
  LeadApprovalResumeSchema,
  LeadApprovalSuspendSchema,
  LeadFormMapSchema,
} from "./dealerWebLeadSubmitContracts.js";
import { harness, type HarnessLedgerContext } from "./harness.js";
import { runWorkerPool, envConcurrency } from "./inventorySiteScan.js";
import { resolvePinnedProfileRowOrStop } from "./profilePinShared.js";
import { recoverEmitWithRetry } from "./recoverEmitWithRetry.js";

export { DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID };

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// the internal post-suspend approver (see the brief §0 — the load-bearing call)
// ---------------------------------------------------------------------------

/**
 * The post-suspend approver. The human ALREADY approved at the batch_review ① /
 * email_fallback ② suspend; this Approver records that fact for the gate. The
 * AUTOBROKER_MODE=test brake (at the top of the approved commit) is the test-mode
 * floor — in test mode it throws BEFORE the form fill/click, so a fake submit can
 * never touch a real dealer. In an offline test the approve path runs the real
 * commit against the FAKE backend (browser stub / FakeGmailAdapter) and the row is
 * written. ONE module constant, reused by both the submit step and the
 * email_fallback send.
 */
const APPROVED: Approver = { async decide() { return true; } };

// ---------------------------------------------------------------------------
// the scout capture boundary (injectable; holds NO Approver — read faces only)
// ---------------------------------------------------------------------------

/** One scouted dealer outcome the workflow turns into a payload / fallback. The
 *  scout navigated the contact path + snapshotted the form DOM as READS — it
 *  never holds an Approver and imports nothing from the gate. */
export interface ScoutOutcome {
  dealerId: string;
  name: string;
  /** The dealer's site origin (for contact-path resolution + the form URL). */
  website: string;
  /** A usable lead-form URL + the discovered submit selector, or null when the
   *  dealer exposes no web form (→ email fallback). */
  form: { url: string; submitSelector: string } | null;
  /** The lead-form platform (custom → the LLM field-map step). */
  platform: "dealerfire" | "dealeron_v1" | "dealeron_v2" | "custom";
  /** The role→name field map for a KNOWN platform; null for custom (the LLM
   *  field-map step fills it) or a no-form dealer. */
  fieldMap: FormFieldRole[] | null;
  /** For a Custom-platform dealer with a form: the fenced form-DOM snapshot the
   *  field-map LLM step reads. null otherwise. */
  formSnapshot: string | null;
  /** A contact email discovered on the page → the email-fallback target +
   *  the dealers.contact_email upsert value. null when none found. */
  contactEmail: string | null;
  /** A captcha / human-verification widget was found on the contact form. Such a
   *  form can never be auto-submitted → the dealer is routed to email fallback
   *  with reason "captcha_fallback" (the captcha is NEVER submitted or retried).
   *  Always pairs with form:null (a captcha page is not a usable form). */
  captcha: boolean;
}

/** The scout boundary input — the US-gated dealer set + the run identity. */
export interface ScoutFormsArgs {
  runId: string;
  emitter: BrowserEmitter;
  dealers: ReadonlyArray<{ dealerId: string; name: string; website: string }>;
}

/** The lead-form-shape heuristic + the contact-email harvester (pure, snapshot
 *  text only — NO PII: a contact email published on a dealer's own contact page
 *  is the dealer's, never the buyer's). A snapshot that mentions a recognizable
 *  lead-form control reads as a usable form. */
const FORM_SHAPE_RE = /<form\b|name=["']?email|name=["']?phone|message|comment|contact us|get a quote/i;
const CONTACT_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Harvest the first plausible dealer contact email from a snapshot, or null.
 *  Filters obvious non-contact addresses (image/asset filenames that happen to
 *  contain an @). Deterministic + pure. */
function harvestContactEmail(snapshot: string): string | null {
  const m = snapshot.match(CONTACT_EMAIL_RE);
  if (m === null) return null;
  const email = m[0];
  // Drop addresses that are really asset/sentinel tokens, not a mailbox.
  if (/\.(png|jpe?g|gif|svg|css|js)$/i.test(email)) return null;
  return email;
}

/**
 * The REAL per-dealer scout LOGIC: walk the contact-path probe set with a
 * read-only browser session (navigate → snapshot — NO Approver, NO DB write,
 * imports nothing from the gate), fingerprint the platform off the live DOM, and
 * harvest a contact email. Stops at the FIRST probe that navigates cleanly and
 * looks like a lead form; if a probe is blocked/404s it falls through to the
 * next path (a transient fallback, voiced on the emitter). A dealer with no
 * usable form but a harvested email is an email-fallback candidate.
 *
 * Injectable face mirrors the inventory-scan read capture: the production wiring
 * provides the REAL session via withBrowserContext; the offline tests pass a
 * fake session that implements the same interface.
 */
export async function scoutOneWithSession(deps: {
  session: BrowserSession;
  emitter: BrowserEmitter;
  dealer: { dealerId: string; name: string; website: string };
}): Promise<ScoutOutcome> {
  const { session, emitter, dealer } = deps;
  // Probe order: the fingerprinted platform's own contact path first, then the
  // other known paths as cheap fallbacks (resolved against the dealer origin).
  const urlPlatform = platformOf(dealer.website);
  const probes = contactPathFor(urlPlatform, dealer.website);

  const base: ScoutOutcome = {
    dealerId: dealer.dealerId,
    name: dealer.name,
    website: dealer.website,
    form: null,
    platform: urlPlatform,
    fieldMap: null,
    formSnapshot: null,
    contactEmail: null,
    captcha: false,
  };

  let harvestedEmail: string | null = null;
  for (const probeUrl of probes) {
    const page = await session.newPage();
    try {
      const nav = await session.navigate(page, probeUrl);
      // A blocked probe (404/403/anti-bot) is a transient fallback — voice it and
      // fall through to the next contact path. Never fail the dealer on one path.
      if (nav.blocked !== null) {
        emitter.action("scout_probe_blocked", `${dealer.name} ${probeUrl}`);
        continue;
      }
      const snapshot = await session.snapshot(page);
      // Fingerprint off the live DOM (more reliable than the URL alone), then
      // harvest a contact email — kept from the FIRST page that yields one.
      const domPlatform = platformOf(snapshot);
      if (harvestedEmail === null) harvestedEmail = harvestContactEmail(snapshot);
      if (FORM_SHAPE_RE.test(snapshot)) {
        // A captcha-gated contact form is unreachable by auto-submit (retrying a
        // captcha never helps) → route to email fallback, never a form submit.
        // Detected at SCOUT time on the read snapshot, BEFORE the gated
        // submit (in test mode the AUTOBROKER_MODE=test brake throws before any
        // post-submit page exists, so a captcha can only be caught here). Carry the harvested
        // email so the fallback still has a target.
        if (hasCaptcha(snapshot)) {
          emitter.action("scout_captcha_form", `${dealer.name} ${probeUrl}`);
          return { ...base, form: null, captcha: true, contactEmail: harvestedEmail };
        }
        // A usable lead form on this path: the platform comes from the DOM (falls
        // back to the URL fingerprint when the DOM is ambiguous). The submit
        // selector is filled by the parity map / LLM field-map step downstream.
        const platform = domPlatform !== "custom" ? domPlatform : urlPlatform;
        return {
          ...base,
          form: { url: probeUrl, submitSelector: "" },
          platform,
          formSnapshot: platform === "custom" ? snapshot : null,
          contactEmail: harvestedEmail,
        };
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // No usable form on any probed path — an email-fallback candidate iff a
  // contact email was harvested along the way.
  return { ...base, contactEmail: harvestedEmail };
}

/** Max dealers scouted at once. The scout is pure read-only (navigate + snapshot
 *  + a benign contact_email upsert) and holds NO Approver — no submit/send face is
 *  reachable from here, so running several dealers in parallel is SAFE: there is no
 *  shared mutable state, each dealer opens its OWN isolated browser context, and the
 *  per-dealer slow-path is the 15s NAV + 4s network-idle wait. The cap bounds how
 *  many chromium contexts spawn at once (RAM/FD pressure on slow, bot-protected real
 *  dealer sites); it is env-overridable (AUTOBROKER_SCOUT_CONCURRENCY) so a capable
 *  host can MAX OUT the fan-out, cutting wall-clock to ~ceil(N/limit)·per-dealer.
 *  Host-safe default; no per-provider cap (the scout phase makes no LLM call). */
const SCOUT_CONCURRENCY = envConcurrency("AUTOBROKER_SCOUT_CONCURRENCY", 4);

/** Submit batch: each dealer opens its OWN isolated browser to navigate + (in test
 *  mode) fake-submit. The submit step is the GATED MUTATING face and stays SERIAL (one
 *  recipient at a time — inv #7; serial is also the strictest concurrency cap, so at
 *  most ONE Chromium is ever live here). The hang root cause was NOT concurrency — it
 *  was a serial loop with NO per-dealer deadline and NO per-dealer isolation: one
 *  slow/blocking dealer site awaited forever (its Chromium never torn down → FDs piled
 *  up → the listener stopped accepting), and any throw aborted the whole batch (0
 *  anchors). The fix is a HARD per-dealer deadline (below) that aborts a hung site and
 *  tears its browser down, plus per-dealer try/catch isolation so the batch proceeds and
 *  the reachable dealers still anchor. */
const SUBMIT_PER_DEALER_TIMEOUT_MS = 45_000;

/**
 * The production scout boundary: ONE isolated read-only browser PER dealer
 * (named so trace files never collide), each scouted via scoutOneWithSession,
 * now run with bounded concurrency (SCOUT_CONCURRENCY) via the shared
 * runWorkerPool — see that constant for why parallelizing the scout is safe.
 * Output order mirrors input order (runWorkerPool writes each result at its input
 * index) so the downstream batch stays deterministic. The whole browser tree
 * tears down in withBrowserContext's own finally. A throwing dealer degrades to a
 * no-form/no-email outcome — it never kills the batch. Holds NO Approver and
 * reaches NO mutating face. Offline tests inject a stub through the deps seam.
 */
async function scoutFormsImpl(args: ScoutFormsArgs): Promise<ScoutOutcome[]> {
  const outcomes = await runWorkerPool(SCOUT_CONCURRENCY, args.dealers.length, (i) => {
    const dealer = args.dealers[i]!;
    return withBrowserContext(
      `${args.runId}-leadscout-${dealer.dealerId}`,
      { emitter: args.emitter },
      (session) => scoutOneWithSession({ session, emitter: args.emitter, dealer }),
    ).catch(
      // Per-dealer isolation: a dead scout is a no-form/no-email outcome (it is
      // dropped as unreachable downstream), never a batch-killing throw.
      (): ScoutOutcome => ({
        dealerId: dealer.dealerId,
        name: dealer.name,
        website: dealer.website,
        form: null,
        platform: "custom",
        fieldMap: null,
        formSnapshot: null,
        contactEmail: null,
        captcha: false,
      }),
    );
  });
  // Progress signal: a single end-of-scout summary so the UI turn shows that the
  // (now-parallel) pre-gate scout actually ran, instead of sitting on "RUNNING".
  // Same emitter channel as scout_probe_blocked / scout_captcha_form above.
  args.emitter.action("scout_complete", `Scouted ${outcomes.length} dealers`);
  return outcomes;
}

// ---------------------------------------------------------------------------
// known-platform parity field maps (the deterministic role→name maps)
// ---------------------------------------------------------------------------

/** The canonical role→name field map per known platform (the legacy parity set).
 *  A Custom platform has no canned map — the LLM field-map step supplies it. */
const PLATFORM_FIELD_MAPS: Record<string, FormFieldRole[]> = {
  dealerfire: [
    { name: "Name", role: "name" },
    { name: "Email", role: "email" },
    { name: "Phone", role: "phone" },
    { name: "ZipCode", role: "zip" },
    { name: "Comments", role: "comment" },
    { name: "Consent", role: "consent" },
  ],
  dealeron_v1: [
    { name: "name", role: "name" },
    { name: "email", role: "email" },
    { name: "phone", role: "phone" },
    { name: "zip", role: "zip" },
    { name: "message", role: "comment" },
    { name: "consent", role: "consent" },
  ],
  dealeron_v2: [
    { name: "ctl00$Name", role: "name" },
    { name: "ctl00$Email", role: "email" },
    { name: "ctl00$Phone", role: "phone" },
    { name: "ctl00$Zip", role: "zip" },
    { name: "ctl00$Comments", role: "comment" },
    { name: "ctl00$Consent", role: "consent" },
  ],
};

/** The default submit selector for a known-platform form when the scout did not
 *  carry one (the parity maps target the canonical submit control). */
const DEFAULT_SUBMIT_SELECTOR = "button[type=submit]";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain against
 * deterministic stubs and an isolated tmp DB, WITHOUT module mocks.
 */
export interface DealerWebLeadSubmitWorkflowDeps {
  harnessGenerate: typeof harness.generate;
  /** The typed three-branch profile resolver (tools layer; PIN-required use). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** All active profile rows (the pin-less STOP candidate list). */
  listActiveProfiles: (db: ReturnType<typeof getDb>) => Record<string, unknown>[];
  /** Read one profile row by id (single-store mode resolves the listing's own
   *  profile, then loads it). */
  readProfileById: (db: ReturnType<typeof getDb>, id: string) => Record<string, unknown> | null;
  /** Read the listing row by id (single-store mode resolves a dealer + profile
   *  directly), or null when missing. */
  readListingById: (
    db: ReturnType<typeof getDb>,
    id: string,
  ) => Record<string, unknown> | null;
  /** The profile_dealers ⋈ dealers read closure (tools layer). */
  listProfileDealers: typeof listProfileDealerRowsImpl;
  /** The browser-read capture boundary (the only browser-touching collaborator;
   *  holds NO Approver). */
  scoutForms: (args: ScoutFormsArgs) => Promise<ScoutOutcome[]>;
  /** The dealers.contact_email upsert (the ONLY pre-approval write). */
  upsertDealerContactEmail: (
    db: ReturnType<typeof getDb>,
    dealerId: string,
    email: string,
  ) => void;
  /** The duplicate-skip / force-retry precondition (tools layer). */
  checkSubmissionPrecondition: typeof checkSubmissionPreconditionImpl;
  /** The dealership-exclusivity claim (tools layer): bind a dealer to THIS
   *  profile before any send. Only `'claimed'` permits a send — `'conflict'` /
   *  `'unavailable'` drop the dealer. A LOCAL DB lock, acquired mode-agnostically
   *  (whether AUTOBROKER_MODE is buyer or test) before the real-or-fake send. */
  claimDealer: typeof claimDealerImpl;
  /** The XOR lead-submission writer (tools layer, a LOCAL write — not mode-gated). */
  recordSubmission: typeof recordSubmissionImpl;
  /** The gated draft-then-promote send+record (tools layer; the email fallback). */
  sendAndRecord: typeof sendAndRecordImpl;
  /** The browser session capture boundary for the gated submit (injectable;
   *  the ONLY Approver-holding call). Returns the per-dealer submit verdict. */
  submitOne: (args: SubmitOneArgs) => Promise<SubmitVerdict>;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

/** The injectable gated-submit boundary input (one approved dealer). */
export interface SubmitOneArgs {
  runId: string;
  emitter: BrowserEmitter;
  dealerId: string;
  form: DealerLeadForm;
  approver: Approver;
}

/** The per-dealer submit verdict the router branches on. `submitted` → web_form
 *  recorded; `fuse_blocked` → the test-mode brake fired (the fake-submit, still
 *  recorded web_form); `needs_fallback` → no usable form / captcha → email
 *  fallback. (The `fuse_blocked` kind name is retained for stability; it now
 *  signals the AUTOBROKER_MODE=test brake, not an L1 fuse.) */
export type SubmitVerdict =
  | { kind: "submitted" }
  | { kind: "fuse_blocked" }
  | { kind: "needs_fallback"; reason: EmailFallbackReason };

/** The REAL per-dealer gated-submit LOGIC: open a page, navigate the form URL
 *  (read), then the ONE Approver-holding call `session.submitForm` — the only
 *  path to a real form submission. In test mode the mode brake throws an
 *  ExternalMutationsBlockedError BEFORE fill/click → caught here as fuse_blocked
 *  (the expected fake-submit). A blocked navigation resolves no form → needs the
 *  email fallback (the gated submit is NEVER attempted). In buyer mode offline:
 *  the fill+click runs against the FAKE/stubbed session → submitted. Holds the
 *  APPROVED approver (the human already approved at the batch_review suspend);
 *  the test-mode brake is the real floor. */
export async function submitOneWithSession(deps: {
  session: BrowserSession;
  runId: string;
  emitter: BrowserEmitter;
  dealerId: string;
  form: DealerLeadForm;
  approver: Approver;
}): Promise<SubmitVerdict> {
  const { session, form, approver } = deps;
  const page = await session.newPage();
  try {
    const nav = await session.navigate(page, form.url);
    if (nav.blocked !== null) {
      // The form page never loaded → no usable form → route to the email
      // fallback. No submit is attempted (the gated face is never reached).
      deps.emitter.action("submit_nav_blocked", `${deps.dealerId} ${nav.blocked}`);
      return { kind: "needs_fallback", reason: "no_form" };
    }
    try {
      // THE ONE Approver-holding call — the single structured path to a real
      // form submission. In test mode the AUTOBROKER_MODE=test brake throws BEFORE the click.
      const result = await session.submitForm(page, form, approver);
      // submitForm returns {submitted:true} | {declined:true}; the human already
      // approved at the suspend, so the internal approver returns true and the
      // declined branch cannot fire here — guard it as needs_fallback anyway.
      return "submitted" in result ? { kind: "submitted" } : { kind: "needs_fallback", reason: "no_form" };
    } catch (err) {
      // The expected fake-submit in test mode: the mode brake fails CLOSED.
      if (err instanceof ExternalMutationsBlockedError) return { kind: "fuse_blocked" };
      throw err; // any other failure is a real error — never swallowed.
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** The production gated-submit boundary: ONE isolated browser per dealer (named
 *  so trace files never collide), the per-dealer LOGIC run via
 *  submitOneWithSession with the REAL session from withBrowserContext. The whole
 *  browser tree tears down in withBrowserContext's own finally. Offline tests
 *  inject a stub through the deps seam. */
async function submitOneImpl(args: SubmitOneArgs): Promise<SubmitVerdict> {
  // A hard per-dealer deadline: on timeout the AbortController fires, withBrowserContext
  // closes the context (in-flight nav rejects), the browser tree tears down, and this
  // call rejects — caught per-dealer in submitStep so one slow site never blocks the
  // batch or the server's event loop.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SUBMIT_PER_DEALER_TIMEOUT_MS);
  try {
    return await withBrowserContext(
      `${args.runId}-leadsubmit-${args.dealerId}`,
      { emitter: args.emitter, signal: ac.signal },
      (session) => submitOneWithSession({ session, ...args }),
    );
  } finally {
    clearTimeout(timer);
  }
}

const realDeps: DealerWebLeadSubmitWorkflowDeps = {
  harnessGenerate: harness.generate,
  resolveProfile: resolveActiveProfileImpl,
  listActiveProfiles: (db) => listProfileRowsImpl(db, "active"),
  readProfileById: readProfileRow,
  readListingById: readListingRowById,
  listProfileDealers: listProfileDealerRowsImpl,
  scoutForms: scoutFormsImpl,
  upsertDealerContactEmail: upsertDealerContactEmailImpl,
  checkSubmissionPrecondition: checkSubmissionPreconditionImpl,
  claimDealer: claimDealerImpl,
  recordSubmission: recordSubmissionImpl,
  sendAndRecord: sendAndRecordImpl,
  submitOne: submitOneImpl,
  getDb,
};

let injectedDeps: DealerWebLeadSubmitWorkflowDeps | undefined;

function deps(): DealerWebLeadSubmitWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must
 *  never redirect the harness, the browser, the send path, or the DB write). */
export function __setDealerWebLeadSubmitDepsForTests(
  partial: Partial<DealerWebLeadSubmitWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setDealerWebLeadSubmitDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetDealerWebLeadSubmitDepsForTests(): void {
  injectedDeps = undefined;
  fallbackDecisionsByRun.clear();
}

// ---------------------------------------------------------------------------
// per-run browser-emitter injection (production wiring, set once at app boot)
// ---------------------------------------------------------------------------

let browserEmitterFactory: (runId: string) => BrowserEmitter = () => NULL_EMITTER;

/** Install the app-layer per-run emitter factory (idempotent; last call wins —
 *  one server per process in the production topology). */
export function setDealerWebLeadSubmitBrowserEmitterFactory(
  factory: (runId: string) => BrowserEmitter,
): void {
  browserEmitterFactory = factory;
}

// ---------------------------------------------------------------------------
// per-run email_fallback decision carry (skip/decline answers are not durable;
// the step remembers them in-process so a re-execution re-derives the same
// order — a crash mid-run simply re-asks, fail-closed, never fail-open)
// ---------------------------------------------------------------------------

const fallbackDecisionsByRun = new Map<string, Map<string, "declined">>();

function fallbackDecisionsFor(runId: string): Map<string, "declined"> {
  let m = fallbackDecisionsByRun.get(runId);
  if (m === undefined) {
    m = new Map();
    fallbackDecisionsByRun.set(runId, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// ledger identity for the (single) Custom field-map LLM call
// ---------------------------------------------------------------------------

function leadSubmitLedger(runId: string): HarnessLedgerContext {
  return {
    runId,
    skill: "dealer_web_lead_submit",
    layer: "L2",
    promptVersion: "p5-x1-v1",
    schemaVersion: "p5-x1-v1",
  };
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** One eligible dealer carried through the steps (card row + submit input). */
const EligibleDealerSchema = z.object({
  dealer_id: z.string(),
  name: z.string(),
  website: z.string(),
  /** custom → the field-map LLM step fills the map; known → the parity map. */
  platform: z.enum(["dealerfire", "dealeron_v1", "dealeron_v2", "custom"]),
  /** A usable lead-form URL + submit selector, or null (→ email fallback). */
  form_url: z.string().nullable(),
  submit_selector: z.string().nullable(),
  /** The role→name field map (parity map or LLM-filled), or null for no-form. */
  field_map: z
    .array(z.object({ name: z.string(), role: z.string() }))
    .nullable(),
  /** A Custom-platform form-DOM snapshot the LLM field-map reads, or null. */
  form_snapshot: z.string().nullable(),
  /** The email-fallback target (a discovered or seeded contact email), or null. */
  contact_email: z.string().nullable(),
  /** A captcha-gated contact form was found → route to email fallback with
   *  reason "captcha_fallback" (the captcha is NEVER submitted). Pairs with
   *  form_url:null. */
  captcha: z.boolean(),
});
type EligibleDealer = z.infer<typeof EligibleDealerSchema>;

/** One decided dealer after the submit / fallback routing (the record input). */
const SubmitDecisionSchema = z.object({
  dealer_id: z.string(),
  name: z.string(),
  /** The recorded channel (or a pre-record routing state). */
  channel: z.enum(["web_form", "email", "needs_fallback", "skipped_fallback", "failed"]),
  form_url: z.string().nullable(),
  contact_email: z.string().nullable(),
  /** email channel: why the form submit could not be used. */
  email_fallback_reason: z
    .enum(["no_form", "captcha_fallback", "user_override"])
    .nullable(),
  /** failed channel: the typed failure reason. */
  fail_reason: z
    .enum([
      "captcha_blocked",
      "form_not_found",
      "site_unreachable",
      "form_rejected",
      "user_skipped",
      "unknown",
    ])
    .nullable(),
});
type SubmitDecision = z.infer<typeof SubmitDecisionSchema>;

/**
 * The accumulating state threaded through the 8 steps. Flat plain-JSON (Mastra
 * snapshots it) and LEAN. Form snapshots are tiny here (one per Custom dealer)
 * so they ride directly; nothing heavyweight is carried.
 */
const LeadSubmitStateSchema = z.object({
  searchProfileId: z.string(),
  resolution: z.enum(["pinned", "inferred_newest"]),
  /** Single-store mode: the listing whose dealer is the only target, or null. */
  targetListingId: z.string().nullable(),
  forceRetry: z.boolean(),
  /** The buyer's reply email (form email field + the redacted body signature). */
  followUpEmail: z.string().nullable(),
  /** The minimal message-template profile (drives the redacted body/subject). */
  messageProfile: z.object({
    year: z.number().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    trim: z.string().nullable(),
    financingPreference: z.string().nullable(),
    postalCode: z.string().nullable(),
  }),
  /** Terminal-declined flag (batch_review decline): every later step passes. */
  declined: z.boolean(),
  /** Eligible US web-form/email dealers (the card targets + submit inputs). */
  eligible: z.array(EligibleDealerSchema).nullable(),
  /** Non-US dealers filtered out before the card (count only, never a row). */
  usGateRejected: z.number().int(),
  /** Prior-submitted dealers skipped by the precondition (count only). */
  skippedDuplicate: z.number().int(),
  /** The approved dealer ids from suspend ① (intersected with the card set). */
  approvedDealerIds: z.array(z.string()).nullable(),
  /** Approved dealers DROPPED by the dealership-exclusivity claim BEFORE any
   *  send (conflict = held by another search; unavailable = no live row). NEVER
   *  budget — only a human vehicle label for a conflict (inv #9). Voiced in the
   *  receipt; no lead_submissions row + no submit/send fires for these. */
  excludedClaims: z
    .array(
      z.object({
        dealer_id: z.string(),
        name: z.string(),
        kind: z.enum(["conflict", "unavailable"]),
        /** conflict only: the vehicle label of the search already engaging it. */
        held_by_vehicle: z.string().nullable(),
      }),
    )
    .nullable(),
  /** The per-dealer routing decisions (submit → fallback → record). */
  submitDecisions: z.array(SubmitDecisionSchema).nullable(),
});
type LeadSubmitState = z.infer<typeof LeadSubmitStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): LeadSubmitState {
  return LeadSubmitStateSchema.parse(inputData);
}

/** Run `fn` against the SHARED tools-layer DB connection. */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

/** The minimal LeadPayloadProfile from the threaded message profile + email. */
function payloadProfileOf(state: LeadSubmitState): LeadPayloadProfile {
  return {
    year: state.messageProfile.year,
    make: state.messageProfile.make,
    model: state.messageProfile.model,
    trim: state.messageProfile.trim,
    financingPreference: state.messageProfile.financingPreference,
    followUpEmail: state.followUpEmail,
    postalCode: state.messageProfile.postalCode,
  };
}

/** Build the gated DealerLeadForm payload for one eligible dealer. */
function leadFormFor(state: LeadSubmitState, dealer: EligibleDealer): DealerLeadForm {
  const fieldMap: FormFieldRole[] = (dealer.field_map ?? []).map((f) => ({
    name: f.name,
    role: f.role as LeadFieldRole,
  }));
  return buildLeadPayload({
    formUrl: dealer.form_url ?? dealer.website,
    profile: payloadProfileOf(state),
    fieldMap,
    submitSelector: dealer.submit_selector ?? DEFAULT_SUBMIT_SELECTOR,
  });
}

/** Build the redacted email-fallback target for one no-form dealer. */
function fallbackEmailTarget(
  state: LeadSubmitState,
  decision: SubmitDecision,
): SendRecordTarget {
  const profile = payloadProfileOf(state);
  return {
    email: {
      to: decision.contact_email ?? "",
      from: state.followUpEmail ?? "",
      subject: safeSubjectLine(profile),
      body: safeBodyTemplate(profile),
    },
    threadId: null,
    searchProfileId: state.searchProfileId,
    inReplyToGmailId: null,
  };
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (EXPLICIT-PIN REQUIRED; single-store via the listing)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: DealerWebLeadSubmitInputSchema,
  outputSchema: LeadSubmitStateSchema,
  execute: async ({ inputData }) => {
    // Single-store mode: the listing resolves a profile DIRECTLY (it carries its
    // own search_profile_id), so no pin is required — submitting a lead for a
    // specific listing the user picked is itself the explicit act.
    let profileRow: Record<string, unknown> | null = null;
    if (inputData.target_listing_id !== null) {
      const listing = withDb((db) => deps().readListingById(db, inputData.target_listing_id!));
      if (listing === null) {
        throw new DealerWebLeadSubmitStopError(
          "no_active_profile",
          "That listing was not found — dealer_web_lead_submit needs a real listing " +
            "to submit a single-store lead. Re-run /inventory_site_scan, then re-try.",
        );
      }
      const listingProfileId = String(listing["search_profile_id"] ?? "");
      profileRow = withDb((db) => deps().readProfileById(db, listingProfileId));
      if (profileRow === null) {
        throw new DealerWebLeadSubmitStopError(
          "no_active_profile",
          "The search behind that listing is gone — re-run /search_profile_intake, " +
            "then re-try.",
        );
      }
    } else {
      // Full-batch mode: EXPLICIT-PIN REQUIRED (this skill never infers, not even
      // the single-active case — that is the thin edge of "pick newest" it must
      // not take). A pin-less input STOPs by the generalized classifier.
      const d = deps();
      profileRow = resolvePinnedProfileRowOrStop({
        withDb,
        resolvers: {
          listActiveProfiles: d.listActiveProfiles,
          resolveProfile: d.resolveProfile,
          readProfileById: d.readProfileById,
        },
        pin: inputData.search_profile_id,
        skillSlash: "/dealer_web_lead_submit",
        purposeClause: "dealers to submit leads to",
        pinClause: "submits leads for a search you have explicitly pinned",
        makeError: (code, message) => new DealerWebLeadSubmitStopError(code, message),
      }).row;
    }

    const row = profileRow ?? {};
    const yearRaw = row["year"];
    return {
      searchProfileId: String(row["search_profile_id"] ?? ""),
      resolution: "pinned" as const,
      targetListingId: inputData.target_listing_id,
      forceRetry: inputData.force_retry,
      followUpEmail:
        typeof row["follow_up_email"] === "string" ? (row["follow_up_email"] as string) : null,
      messageProfile: {
        year: typeof yearRaw === "number" ? yearRaw : null,
        make: typeof row["make"] === "string" ? (row["make"] as string) : null,
        model: typeof row["model"] === "string" ? (row["model"] as string) : null,
        trim: typeof row["trim"] === "string" ? (row["trim"] as string) : null,
        financingPreference:
          typeof row["financing_preference"] === "string"
            ? (row["financing_preference"] as string)
            : null,
        postalCode:
          typeof row["postal_code"] === "string" ? (row["postal_code"] as string) : null,
      },
      declined: false,
      eligible: null,
      usGateRejected: 0,
      skippedDuplicate: 0,
      approvedDealerIds: null,
      excludedClaims: null,
      submitDecisions: null,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — scout (US gate + the browser-read capture + contact_email upsert)
// ---------------------------------------------------------------------------

/** Coerce one loosely-typed dealer join row into the scout's gate input. */
function asScoutDealer(row: Record<string, unknown>): {
  dealer_id: string;
  name: string;
  website: string | null;
  country: string | null;
  state: string | null;
  postal_code: string | null;
  city: string | null;
} {
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    dealer_id: String(row["dealer_id"] ?? ""),
    name: typeof row["name"] === "string" ? (row["name"] as string) : "(unnamed)",
    website: str(row["website"]),
    country: str(row["country"]),
    state: str(row["state"]),
    postal_code: str(row["postal_code"]),
    city: str(row["city"]),
  };
}

const scoutStep = createStep({
  id: "scout",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);

    // The dealer set: the single listing's dealer (single-store) or all bound
    // dealers (full batch). Each row carries the US-gate signals.
    let rows: Record<string, unknown>[];
    if (state.targetListingId !== null) {
      const listing = withDb((db) => deps().readListingById(db, state.targetListingId!));
      const dealerId = String(listing?.["dealer_id"] ?? "");
      rows = withDb((db) => deps().listProfileDealers(db, state.searchProfileId)).filter(
        (r) => String(r["dealer_id"] ?? "") === dealerId,
      );
    } else {
      rows = withDb((db) => deps().listProfileDealers(db, state.searchProfileId));
    }

    if (rows.length === 0) {
      throw new DealerWebLeadSubmitStopError(
        "no_us_dealers",
        "No dealers are bound to this profile yet — run /dealer_geosearch to " +
          "discover nearby dealers, then re-run /dealer_web_lead_submit.",
      );
    }

    // US-only HARD GATE: one batched classify; non-US filtered out BEFORE the
    // card, counted us_gate_rejected, NEVER an approvable target.
    const gateRows = rows.map(asScoutDealer);
    const { us, nonUs } = partitionUsDealers(gateRows);
    const usGateRejected = nonUs.length;

    // Only US dealers WITH a usable website can be scouted; the rest (no website)
    // are dropped here (they are not approvable). The browser-read scout holds
    // NO Approver — navigate + snapshot + 404-probe are reads only.
    const scoutable = us
      .filter((d) => d.website !== null && d.website.trim() !== "")
      .map((d) => ({ dealerId: d.dealer_id, name: d.name, website: d.website! }));

    if (scoutable.length === 0) {
      throw new DealerWebLeadSubmitStopError(
        "no_us_dealers",
        "No US dealers with a usable website are bound to this profile — " +
          "dealer_web_lead_submit needs a dealer site to submit a lead to.",
      );
    }

    const outcomes = await deps().scoutForms({
      runId,
      emitter: browserEmitterFactory(runId),
      dealers: scoutable,
    });

    // The ONLY pre-approval write: a discovered contact email is upserted onto
    // the dealer row (a local product-DB write, not a gated side effect).
    withDb((db) => {
      for (const o of outcomes) {
        if (o.contactEmail !== null && o.contactEmail.trim() !== "") {
          deps().upsertDealerContactEmail(db, o.dealerId, o.contactEmail.trim());
        }
      }
    });

    // An eligible target has EITHER a usable form (web-form submit) OR a contact
    // email (email fallback). A dealer with neither cannot be reached → dropped.
    const eligible: EligibleDealer[] = [];
    for (const o of outcomes) {
      const hasForm = o.form !== null;
      const hasEmail = o.contactEmail !== null && o.contactEmail.trim() !== "";
      if (!hasForm && !hasEmail) continue;
      eligible.push({
        dealer_id: o.dealerId,
        name: o.name,
        website: o.website,
        platform: o.platform,
        form_url: o.form?.url ?? null,
        submit_selector: o.form?.submitSelector ?? null,
        field_map:
          o.fieldMap ??
          (o.form !== null && o.platform !== "custom"
            ? PLATFORM_FIELD_MAPS[o.platform] ?? null
            : null),
        form_snapshot: o.formSnapshot,
        contact_email: hasEmail ? o.contactEmail!.trim() : null,
        captcha: o.captcha,
      });
    }

    return { ...state, eligible, usGateRejected };
  },
});

// ---------------------------------------------------------------------------
// step 1b — scoutMapCustom (the ONLY LLM step; #1244 fail-closed discipline)
// ---------------------------------------------------------------------------

const scoutMapCustomStep = createStep({
  id: "scoutMapCustom",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    const eligible = state.eligible ?? [];
    const mapped: EligibleDealer[] = [];
    for (const dealer of eligible) {
      // Only a Custom-platform dealer WITH a form AND a snapshot needs the LLM
      // field-map; everything else passes through untouched.
      if (
        dealer.platform !== "custom" ||
        dealer.form_url === null ||
        dealer.field_map !== null ||
        dealer.form_snapshot === null
      ) {
        mapped.push(dealer);
        continue;
      }

      const result = await recoverEmitWithRetry({
        harnessGenerate: deps().harnessGenerate,
        input: {
          useCase: "lead_form_map",
          schema: LeadFormMapSchema,
          prompt: buildLeadFormMapPrompt(dealer.form_snapshot),
          // FAIL-CLOSED: a malformed tool call retries ONCE on the strong+
          // thinking lane, else fail-closes (never a prose fallthrough, never a
          // regexed-out tool call).
          hitlAvailable: false,
        },
        retryUseCase: "lead_form_map_retry",
        ledger: leadSubmitLedger(runId),
      });
      const map = LeadFormMapSchema.parse(result.object); // Zod post-validate.
      mapped.push({
        ...dealer,
        field_map: map.fields.map((f) => ({ name: f.name, role: f.role })),
        submit_selector: map.submit_selector,
      });
    }

    return { ...state, eligible: mapped };
  },
});

// ---------------------------------------------------------------------------
// step 2 — buildPayloads (the duplicate-skip / force_retry precondition)
// ---------------------------------------------------------------------------

const buildPayloadsStep = createStep({
  id: "buildPayloads",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    const eligible = state.eligible ?? [];
    const kept: EligibleDealer[] = [];
    let skippedDuplicate = 0;

    for (const dealer of eligible) {
      // A prior submitted row → skip (idempotent no-op) unless force_retry.
      const pre = withDb((db) =>
        deps().checkSubmissionPrecondition({
          searchProfileId: state.searchProfileId,
          dealerId: dealer.dealer_id,
          forceRetry: state.forceRetry,
          db,
        }),
      );
      if (pre.kind === "skip") {
        skippedDuplicate += 1;
        continue;
      }
      // Belt: the payload assembler runs the budget-redact + unicode gate; build
      // it once here to fail LOUD before the card if any value is unsafe (the
      // assembled DealerLeadForm itself is rebuilt in the submit step from the
      // same inputs, deterministically).
      leadFormFor(state, dealer);
      kept.push(dealer);
    }

    return { ...state, eligible: kept, skippedDuplicate: state.skippedDuplicate + skippedDuplicate };
  },
});

// ---------------------------------------------------------------------------
// step 3 — batchReview (SUSPEND ①; single-store collapses to approval ②)
// ---------------------------------------------------------------------------

/** The batch_review card question (fixed copy). */
const BATCH_REVIEW_QUESTION = "Submit lead inquiries to these dealers?";

const batchReviewStep = createStep({
  id: "batchReview",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  resumeSchema: z.union([BatchReviewResumeSchema, LeadApprovalResumeSchema]),
  suspendSchema: z.union([BatchReviewSuspendSchema, LeadApprovalSuspendSchema]),
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);
    const eligible = state.eligible ?? [];

    // SINGLE-STORE: one dealer, one confirm — collapse ① to the kind:"approval"
    // single_store_confirm suspend (the same independent-approval surface as ②).
    if (state.targetListingId !== null) {
      const dealer = eligible[0];
      if (dealer === undefined) {
        // The single listing's dealer was filtered out (non-US / no form+email).
        return { ...state, approvedDealerIds: [] };
      }
      if (resumeData === undefined) {
        return (await suspend({
          kind: "approval",
          summary: `Submit a lead to ${dealer.name} for this listing?`,
          sensitive: true,
          dealerId: dealer.dealer_id,
          dealerName: dealer.name,
          reason: "single_store_confirm",
          fallbackTo: null,
          fallbackReason: null,
        })) as never;
      }
      const answer = LeadApprovalResumeSchema.parse(resumeData);
      if (answer.action === "decline") return { ...state, declined: true };
      return { ...state, approvedDealerIds: [dealer.dealer_id] };
    }

    // FULL BATCH: the batch_review card (gate before prose). Nothing has been
    // written and no mutating face has been reached.
    if (resumeData === undefined) {
      // The submission summary: the MINIMAL info each approved dealer receives,
      // shown above the dealer list so the user sees exactly what is sent before
      // approving. Phone is always a placeholder and the budget is never shared
      // (a hard redaction floor), stated explicitly here.
      const vehicleLabel =
        [
          state.messageProfile.year,
          state.messageProfile.make,
          state.messageProfile.model,
          state.messageProfile.trim,
        ]
          .filter((x) => x !== null && x !== undefined && x !== "")
          .join(" ") || "your pinned search";
      const summaryLines: Array<{ label: string; value: string }> = [
        { label: "Vehicle", value: vehicleLabel },
        { label: "Your email", value: state.followUpEmail ?? "(none on file)" },
        { label: "Phone", value: "a placeholder number — your real number is never shared" },
      ];
      return (await suspend({
        kind: "batch_review",
        question: BATCH_REVIEW_QUESTION,
        summary: {
          heading: "Each approved dealer gets one brief inquiry containing only:",
          lines: summaryLines,
        },
        targets: eligible.map((d) => ({
          dealer_id: d.dealer_id,
          name: d.name,
          website: d.website,
        })),
        skipped: [], // X1's filtered-out counts live in the confirm, never as a row.
        total_targets: eligible.length,
        total_in_radius: eligible.length,
        submit_label: "Submit leads to approved dealers",
      })) as never;
    }

    const resume = BatchReviewResumeSchema.parse(resumeData);
    if (resume.action === "decline") {
      return { ...state, declined: true };
    }
    // approve → the explicit id list intersected with the reviewed targets.
    const targetIds = new Set(eligible.map((d) => d.dealer_id));
    const approved = [...new Set(resume.approved_dealer_ids)].filter((id) => targetIds.has(id));
    if (approved.length === 0) {
      throw new Error(
        "batchReview: approved_dealer_ids resolved to zero reviewed targets — refusing to submit",
      );
    }
    return { ...state, approvedDealerIds: approved };
  },
});

// ---------------------------------------------------------------------------
// step 3b — claimDealers (DEALERSHIP-EXCLUSIVITY acquire — after approval, before
//           the first send). The claim is a LOCAL DB lock acquired mode-agnostically
//           (buyer OR test) INSIDE the already-approved action: it does NOT weaken
//           the L2 approval gate or AUTOBROKER_MODE — it only DROPS a dealer another
//           search already holds, before the real-or-fake send seam. A dealer whose
//           claim is NOT 'claimed' is removed from approvedDealerIds, so neither the
//           submit step (which filters eligible by approvedDealerIds) nor the email-
//           fallback step (which only acts on submit's decisions) ever fires for it.
// ---------------------------------------------------------------------------

const claimDealersStep = createStep({
  id: "claimDealers",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // pass-through (zero claims, zero sends).

    const approvedIds = state.approvedDealerIds ?? [];
    if (approvedIds.length === 0) {
      return { ...state, approvedDealerIds: [], excludedClaims: [] };
    }

    const nameById = new Map(
      (state.eligible ?? []).map((d) => [d.dealer_id, d.name] as const),
    );

    const claimed: string[] = [];
    const excluded: NonNullable<LeadSubmitState["excludedClaims"]> = [];
    withDb((db) => {
      for (const dealerId of approvedIds) {
        const verdict: ClaimResult = deps().claimDealer({
          searchProfileId: state.searchProfileId,
          dealerId,
          db,
        });
        if (verdict.kind === "claimed") {
          claimed.push(dealerId);
          continue;
        }
        // NOT 'claimed' → DROP the dealer (no submit, no email fallback). Collect
        // it for the receipt; a conflict carries the holder's vehicle label only.
        excluded.push({
          dealer_id: dealerId,
          name: nameById.get(dealerId) ?? dealerId,
          kind: verdict.kind,
          held_by_vehicle: verdict.kind === "conflict" ? verdict.heldByVehicle : null,
        });
      }
    });

    return { ...state, approvedDealerIds: claimed, excludedClaims: excluded };
  },
});

// ---------------------------------------------------------------------------
// step 4 — submit (THE GATED MUTATING FACE — the keystone code)
// ---------------------------------------------------------------------------

const submitStep = createStep({
  id: "submit",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state; // pass-through (zero submits, zero sends).

    const emitter = browserEmitterFactory(runId);
    const approvedIds = new Set(state.approvedDealerIds ?? []);
    const eligible = (state.eligible ?? []).filter((d) => approvedIds.has(d.dealer_id));
    const decided: SubmitDecision[] = [];

    for (const dealer of eligible) {
      const base: SubmitDecision = {
        dealer_id: dealer.dealer_id,
        name: dealer.name,
        channel: "needs_fallback",
        form_url: dealer.form_url,
        contact_email: dealer.contact_email,
        email_fallback_reason: null,
        fail_reason: null,
      };

      // A dealer with no usable form routes STRAIGHT to the email fallback (no
      // mutating browser face at all) — including a captcha dealer (captcha is
      // NEVER retried). A no-email dealer there cannot be reached → failed.
      if (dealer.form_url === null) {
        if (dealer.contact_email === null) {
          decided.push({ ...base, channel: "failed", fail_reason: "form_not_found" });
        } else {
          decided.push({
            ...base,
            channel: "needs_fallback",
            email_fallback_reason: dealer.captcha ? "captcha_fallback" : "no_form",
          });
        }
        continue;
      }

      // THE ONE Approver-holding call. In test mode the mode brake throws BEFORE
      // fill/click → fuse_blocked (the expected fake-submit). In buyer mode the
      // real fill+click runs against the FAKE/stubbed session offline → submitted.
      const form = leadFormFor(state, dealer);
      let verdict: SubmitVerdict;
      try {
        verdict = await deps().submitOne({
          runId,
          emitter,
          dealerId: dealer.dealer_id,
          form,
          approver: APPROVED,
        });
      } catch (err) {
        // Per-dealer isolation (inv #12 voiced): a timed-out (submitOneImpl deadline)
        // or otherwise-throwing dealer becomes a typed `failed` row, NOT a batch-killing
        // throw — the batch continues and the reachable dealers still anchor. This is the
        // regression that produced "0 lead_submissions" when one site hung the batch.
        try {
          emitter.error(
            `lead submit failed for ${dealer.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          // a throwing emitter must not defeat the per-dealer isolation it is voicing
        }
        decided.push({ ...base, channel: "failed", fail_reason: "site_unreachable" });
        continue;
      }

      if (verdict.kind === "submitted" || verdict.kind === "fuse_blocked") {
        // A web-form dealer RECORDS web_form submitted — the fake-submit row.
        decided.push({ ...base, channel: "web_form" });
      } else {
        // captcha / no-form-after-probe → email fallback (if reachable).
        if (dealer.contact_email === null) {
          decided.push({ ...base, channel: "failed", fail_reason: "form_not_found" });
        } else {
          decided.push({ ...base, channel: "needs_fallback", email_fallback_reason: verdict.reason });
        }
      }
    }

    return { ...state, submitDecisions: decided };
  },
});

// ---------------------------------------------------------------------------
// step 5 — emailFallback (SUSPEND ② — the X1 FIX POINT, an INDEPENDENT approval)
// ---------------------------------------------------------------------------

const emailFallbackStep = createStep({
  id: "emailFallback",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: LeadSubmitStateSchema,
  resumeSchema: LeadApprovalResumeSchema,
  suspendSchema: LeadApprovalSuspendSchema,
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    const carry = fallbackDecisionsFor(runId);
    // The single resume answers the FIRST undecided fallback the loop reaches
    // (deterministic order: declined dealers are remembered in the per-run carry,
    // so a re-execution re-derives the same order). Consumed at most once.
    let pending =
      resumeData === undefined ? undefined : LeadApprovalResumeSchema.parse(resumeData);

    const decided = (state.submitDecisions ?? []).map((d) => ({ ...d }));
    for (const d of decided) {
      if (d.channel !== "needs_fallback") continue; // only no-form/captcha route here.
      if (carry.get(d.dealer_id) === "declined") {
        d.channel = "skipped_fallback";
        continue;
      }

      // THE SCOPE SWITCH (browser.submit → gmail.send) IS A NEW SENSITIVE SCOPE.
      // It REQUIRES its OWN approval — NEVER folded into ①'s batch approval.
      if (pending === undefined) {
        return (await suspend({
          kind: "approval",
          sensitive: true,
          summary:
            `No web form for ${d.name} — send the lead by EMAIL to ` +
            `${d.contact_email ?? "the dealer"} instead? (a different action than a ` +
            "form submit)",
          dealerId: d.dealer_id,
          dealerName: d.name,
          reason: "email_fallback",
          fallbackTo: d.contact_email,
          fallbackReason: d.email_fallback_reason ?? "no_form",
        })) as never;
      }
      const answer = pending;
      pending = undefined; // consumed — at most one dealer per resume.

      if (answer.action === "decline") {
        // Skip THIS dealer's fallback only (carry it), the run continues.
        carry.set(d.dealer_id, "declined");
        d.channel = "skipped_fallback";
        continue;
      }

      // RE-CONFIRMED. Only NOW does the gmail.send scope fire. In test mode the
      // AUTOBROKER_MODE=test brake resolves the FakeGmailAdapter → sendAndRecord
      // {sent} writes one fake draft+promote (a fake sandbox row, no real
      // outbound); in buyer mode it is a real send behind the L2 gate.
      const target = fallbackEmailTarget(state, d);
      await deps().sendAndRecord(target, { approver: APPROVED, runId });
      d.channel = "email";
      d.email_fallback_reason = d.email_fallback_reason ?? "no_form";
    }

    return { ...state, submitDecisions: decided };
  },
});

// ---------------------------------------------------------------------------
// step 6 — recordConfirm (the LOCAL XOR writer + the zero-LLM confirm)
// ---------------------------------------------------------------------------

const recordConfirmStep = createStep({
  id: "recordConfirm",
  inputSchema: LeadSubmitStateSchema,
  outputSchema: DealerWebLeadSubmitOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    const decisions = state.submitDecisions ?? [];
    let submissionsSuccessful = 0;
    let emailFallbackCount = 0;
    let captchaManualCount = 0;
    let failedCount = 0;

    // THE LOCAL WRITE (NOT mode-gated): one recordSubmission per decided dealer,
    // the XOR shape mirroring the channel. recordSubmission's typed union is the
    // authority on the column combination — the INSERT is never hand-built.
    withDb((db) => {
      for (const d of decisions) {
        if (d.channel === "web_form") {
          deps().recordSubmission(
            {
              kind: "web_form",
              submissionId: randomUUID(),
              dealerId: d.dealer_id,
              searchProfileId: state.searchProfileId,
              formUrl: d.form_url,
              submittedEmail: state.followUpEmail,
              sourceListingId: state.targetListingId,
            },
            db,
          );
          submissionsSuccessful += 1;
        } else if (d.channel === "email") {
          deps().recordSubmission(
            {
              kind: "email",
              emailFallbackReason: d.email_fallback_reason ?? "no_form",
              submissionId: randomUUID(),
              dealerId: d.dealer_id,
              searchProfileId: state.searchProfileId,
              formUrl: d.form_url,
              submittedEmail: state.followUpEmail,
              sourceListingId: state.targetListingId,
            },
            db,
          );
          submissionsSuccessful += 1;
          emailFallbackCount += 1;
          if (d.email_fallback_reason === "captcha_fallback") captchaManualCount += 1;
        } else if (d.channel === "skipped_fallback") {
          // The user declined the email re-confirm → a typed failure row (the
          // dealer was reviewed but the fallback was not authorized).
          deps().recordSubmission(
            {
              kind: "failed",
              failReason: "user_skipped",
              submissionId: randomUUID(),
              dealerId: d.dealer_id,
              searchProfileId: state.searchProfileId,
              formUrl: d.form_url,
              sourceListingId: state.targetListingId,
            },
            db,
          );
        } else if (d.channel === "failed") {
          failedCount += 1;
          deps().recordSubmission(
            {
              kind: "failed",
              failReason: d.fail_reason ?? "unknown",
              submissionId: randomUUID(),
              dealerId: d.dealer_id,
              searchProfileId: state.searchProfileId,
              formUrl: d.form_url,
              sourceListingId: state.targetListingId,
            },
            db,
          );
        }
      }
    });

    // Voice the dealership-exclusivity exclusions, distinguishing the two drop
    // kinds so the count + prose stay accurate:
    //   - CONFLICT: another of the buyer's searches already holds the dealer
    //     bound → "engaged by another of your searches" (names the holder's
    //     vehicle(s); never a budget, inv #9).
    //   - UNAVAILABLE: the buyer's OWN row is closed_out/absent (NOT held by
    //     another search) → "no longer available". Folding these into the
    //     conflict sentence would mis-voice a benign own-state drop as a
    //     cross-search conflict, so they are counted + voiced separately.
    const excluded = state.excludedClaims ?? [];
    const conflicts = excluded.filter((e) => e.kind === "conflict");
    const unavailable = excluded.filter((e) => e.kind === "unavailable");
    const conflictVehicles = [
      ...new Set(
        conflicts
          .filter((e) => (e.held_by_vehicle ?? "").trim() !== "")
          .map((e) => e.held_by_vehicle!.trim()),
      ),
    ];
    const conflictSentence =
      conflicts.length > 0
        ? ` Excluded ${conflicts.length} dealer(s) already engaged by another of your ` +
          "searches" +
          (conflictVehicles.length > 0 ? `: ${conflictVehicles.join(", ")}` : "") +
          "."
        : "";
    const unavailableSentence =
      unavailable.length > 0
        ? ` Skipped ${unavailable.length} dealer(s) no longer available for this search.`
        : "";

    const summary =
      `Submitted ${submissionsSuccessful} lead(s)` +
      (emailFallbackCount > 0 ? ` (${emailFallbackCount} by email fallback)` : "") +
      (captchaManualCount > 0 ? `, ${captchaManualCount} captcha-routed` : "") +
      (state.skippedDuplicate > 0 ? `; ${state.skippedDuplicate} already-submitted skipped` : "") +
      (state.usGateRejected > 0 ? `; ${state.usGateRejected} non-US dealer(s) filtered` : "") +
      (failedCount > 0 ? `; ${failedCount} dealer(s) unreachable/failed` : "") +
      "." +
      conflictSentence +
      unavailableSentence;

    return {
      outcome: "submitted" as const,
      resolution: state.resolution,
      submissions_successful: submissionsSuccessful,
      email_fallback_count: emailFallbackCount,
      captcha_manual_count: captchaManualCount,
      us_gate_rejected: state.usGateRejected,
      skipped_duplicate: state.skippedDuplicate,
      excluded_conflict_count: conflicts.length,
      excluded_unavailable_count: unavailable.length,
      summary,
      search_profile_id: state.searchProfileId,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (8 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const dealerWebLeadSubmitWorkflow = createWorkflow({
  id: "dealer_web_lead_submit",
  inputSchema: DealerWebLeadSubmitInputSchema,
  outputSchema: DealerWebLeadSubmitOutputSchema,
})
  .then(resolveProfileStep)
  .then(scoutStep)
  .then(scoutMapCustomStep)
  .then(buildPayloadsStep)
  .then(batchReviewStep)
  .then(claimDealersStep)
  .then(submitStep)
  .then(emailFallbackStep)
  .then(recordConfirmStep)
  .commit();
