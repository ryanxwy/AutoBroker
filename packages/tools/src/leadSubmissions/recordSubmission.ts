/**
 * recordSubmission — the INSERT-only writer for a lead-submission outcome row,
 * plus the duplicate-skip / force-retry precondition that guards a re-submit.
 *
 * THE XOR INVARIANT (load-bearing): `lead_submissions` carries a DB CHECK
 * (`ck_lead_submissions_xor`) that admits exactly three terminal shapes. This
 * writer is a typed union over those three so a caller cannot assemble an
 * illegal column combination — the type system mirrors the CHECK:
 *   - web_form : outcome='submitted', channel='web_form', no fail/fallback reason.
 *   - email    : outcome='submitted', channel='email', email_fallback_reason set,
 *                no fail reason (the email-fallback after a form could not submit).
 *   - failed   : outcome='failed', channel NULL, fail_reason set, no fallback.
 * The two submitted shapes stamp `submitted_at = new Date().toISOString()` so the
 * inbox window anchor (`readFirstLeadSubmitAtMs`) can parse a real timestamp.
 * INSERT-only — there is no UPDATE path; a re-submit is a fresh row, gated by the
 * precondition below.
 *
 * THE PRECONDITION (duplicate-skip / force-retry): a `(search_profile_id,
 * dealer_id)` that already has any prior row is, by default, a NO-OP skip — the
 * normal idempotent path, returned as a typed result (NOT an exception). Only an
 * explicit `force_retry` re-fires, and even then it is REFUSED unless the latest
 * non-pending row failed (a successful submit must never be re-fired) — the sole
 * exception is an orphan-pending recovery, where no terminal row exists yet.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle only — no drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (getDb + the Db type) only.
 */

import { getDb, type Db } from "@autobroker/db";

/** Legal email-fallback reasons (CHECK: submitted + channel='email'). */
export type EmailFallbackReason = "no_form" | "captcha_fallback" | "user_override";

/** Legal failure reasons (CHECK: outcome='failed'). */
export type FailReason =
  | "captcha_blocked"
  | "form_not_found"
  | "site_unreachable"
  | "form_rejected"
  | "user_skipped"
  | "unknown";

/** Fields shared by every terminal row (identity + provenance, all optional but
 *  the profile/dealer pair). */
interface RecordBase {
  submissionId: string;
  dealerId: string;
  searchProfileId: string;
  formUrl?: string | null;
  submittedEmail?: string | null;
  commentText?: string | null;
  screenshotPath?: string | null;
  sourceListingId?: string | null;
}

/** The three legal outcome shapes — a discriminated union mirroring the CHECK. */
export type SubmissionOutcome =
  | (RecordBase & { kind: "web_form" })
  | (RecordBase & { kind: "email"; emailFallbackReason: EmailFallbackReason })
  | (RecordBase & { kind: "failed"; failReason: FailReason });

/** Thrown when a `force_retry` is refused: the latest terminal row succeeded, so
 *  re-firing would risk a duplicate live submission. */
export class ForceRetryRefusedError extends Error {
  readonly latestOutcome: string;
  constructor(latestOutcome: string) {
    super(
      `force_retry refused: latest non-pending lead submission is '${latestOutcome}', ` +
        "not 'failed' — a prior success must not be re-fired",
    );
    this.name = "ForceRetryRefusedError";
    this.latestOutcome = latestOutcome;
  }
}

/** The precondition verdict — a typed union, NOT an exception for the normal
 *  skip path. `proceed` => the caller may insert; `skip` => a prior row exists
 *  and force_retry was not requested (idempotent no-op). A refused force_retry
 *  throws `ForceRetryRefusedError` instead of returning here. */
export type SubmissionPrecondition =
  | { kind: "proceed" }
  | { kind: "skip"; existingSubmissionId: string };

/** A prior-row summary for the precondition: the most recent row (by rowid) and
 *  the most recent non-pending (terminal) row's outcome, if any. */
interface PriorSummary {
  latestSubmissionId: string;
  latestTerminalOutcome: string | null;
}

const SELECT_LATEST_PRIOR =
  "SELECT submission_id FROM lead_submissions " +
  "WHERE search_profile_id = ? AND dealer_id = ? " +
  "ORDER BY rowid DESC LIMIT 1";

const SELECT_LATEST_TERMINAL =
  "SELECT outcome FROM lead_submissions " +
  "WHERE search_profile_id = ? AND dealer_id = ? AND outcome != 'pending' " +
  "ORDER BY rowid DESC LIMIT 1";

/** Read the prior-row summary for a (profile, dealer) pair, or null when none. */
function readPriorSummary(db: Db, searchProfileId: string, dealerId: string): PriorSummary | null {
  const latest = db.$client
    .prepare(SELECT_LATEST_PRIOR)
    .get(searchProfileId, dealerId) as { submission_id: string } | undefined;
  if (latest === undefined) return null;
  const terminal = db.$client
    .prepare(SELECT_LATEST_TERMINAL)
    .get(searchProfileId, dealerId) as { outcome: string } | undefined;
  return {
    latestSubmissionId: latest.submission_id,
    latestTerminalOutcome: terminal?.outcome ?? null,
  };
}

/**
 * Resolve whether a (profile, dealer) submission may proceed.
 *  - No prior row              => proceed.
 *  - Prior row, force_retry off => skip (idempotent no-op).
 *  - Prior row, force_retry on:
 *      latest terminal = 'failed'   => proceed (retry a failure).
 *      no terminal row (all pending) => proceed (orphan-pending recovery).
 *      latest terminal = anything else (a success) => REFUSED (throws).
 */
export function checkSubmissionPrecondition(args: {
  searchProfileId: string;
  dealerId: string;
  forceRetry?: boolean;
  db?: Db;
}): SubmissionPrecondition {
  const db = args.db ?? getDb();
  const prior = readPriorSummary(db, args.searchProfileId, args.dealerId);
  if (prior === null) return { kind: "proceed" };

  if (!args.forceRetry) {
    return { kind: "skip", existingSubmissionId: prior.latestSubmissionId };
  }

  // force_retry: only a prior failure (or an orphan-pending with no terminal
  // row yet) may re-fire; a prior success is refused.
  if (prior.latestTerminalOutcome === null || prior.latestTerminalOutcome === "failed") {
    return { kind: "proceed" };
  }
  throw new ForceRetryRefusedError(prior.latestTerminalOutcome);
}

const INSERT_SUBMITTED =
  "INSERT INTO lead_submissions " +
  "(submission_id, dealer_id, form_url, submitted_email, comment_text, screenshot_path, " +
  "search_profile_id, source_listing_id, submitted_at, outcome, submission_channel, " +
  "fail_reason, email_fallback_reason) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, NULL, ?)";

const INSERT_FAILED =
  "INSERT INTO lead_submissions " +
  "(submission_id, dealer_id, form_url, submitted_email, comment_text, screenshot_path, " +
  "search_profile_id, source_listing_id, submitted_at, outcome, submission_channel, " +
  "fail_reason, email_fallback_reason) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'failed', NULL, ?, NULL)";

/**
 * INSERT one terminal lead-submission row. The shape's `kind` selects the column
 * combination that satisfies the XOR CHECK; the two submitted kinds stamp
 * `submitted_at` with a fresh ISO timestamp. Returns the inserted submission_id.
 *
 * This is INSERT-only and does NOT run the precondition — a caller that wants the
 * duplicate-skip guard runs `checkSubmissionPrecondition` first.
 */
export function recordSubmission(outcome: SubmissionOutcome, db?: Db): string {
  const conn = (db ?? getDb()).$client;
  const formUrl = outcome.formUrl ?? null;
  const submittedEmail = outcome.submittedEmail ?? null;
  const commentText = outcome.commentText ?? null;
  const screenshotPath = outcome.screenshotPath ?? null;
  const sourceListingId = outcome.sourceListingId ?? null;

  if (outcome.kind === "failed") {
    conn
      .prepare(INSERT_FAILED)
      .run(
        outcome.submissionId,
        outcome.dealerId,
        formUrl,
        submittedEmail,
        commentText,
        screenshotPath,
        outcome.searchProfileId,
        sourceListingId,
        outcome.failReason,
      );
    return outcome.submissionId;
  }

  const channel = outcome.kind === "web_form" ? "web_form" : "email";
  const emailFallbackReason = outcome.kind === "email" ? outcome.emailFallbackReason : null;
  conn
    .prepare(INSERT_SUBMITTED)
    .run(
      outcome.submissionId,
      outcome.dealerId,
      formUrl,
      submittedEmail,
      commentText,
      screenshotPath,
      outcome.searchProfileId,
      sourceListingId,
      new Date().toISOString(),
      channel,
      emailFallbackReason,
    );
  return outcome.submissionId;
}
