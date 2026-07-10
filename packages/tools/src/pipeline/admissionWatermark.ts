/**
 * Durable watermarks for automatic quote-pipeline admission.
 *
 * `pipeline.auto_admission.<profile>` records the input frontier observed when
 * the portfolio scheduler last admitted that profile. The six-hour floor only
 * suppresses an identical frontier; a newly ingested inbound message or a
 * changed quote set is admitted immediately.
 *
 * `pipeline.last_compared_quotes.<profile>` is deliberately separate. It is
 * advanced only after quote_compare succeeds, so detectPipelineState's compare
 * predicate self-clears without treating an attempted/failed compare as done.
 *
 * SQLITE INVARIANT: raw better-sqlite3 only; this tools module owns all DB IO.
 */

import { createHash } from "node:crypto";

import type { Db } from "@autobroker/db";

/** Default lower bound for automatically re-running an unchanged input set. */
export const PIPELINE_AUTO_ADMISSION_FLOOR_MS = 6 * 60 * 60 * 1000;

export interface QuoteInputWatermark {
  quoteCount: number;
  maxQuoteRowid: number;
  quoteSetHash: string;
}

export interface PipelineInputWatermark extends QuoteInputWatermark {
  inboundMessageCount: number;
  maxInboundMessageRowid: number;
}

export type PipelineAdmissionReason =
  | "first_admission"
  | "new_input"
  | "floor_elapsed"
  | "same_input_floor";

export interface PipelineAdmissionDecision {
  shouldAdmit: boolean;
  reason: PipelineAdmissionReason;
  observedInput: PipelineInputWatermark;
  evaluatedAtMs: number;
  lastAdmittedAtMs: number | null;
}

interface StoredAdmission {
  version: 1;
  admittedAtMs: number;
  input: PipelineInputWatermark;
}

export function pipelineAdmissionKey(profileId: string): string {
  return `pipeline.auto_admission.${profileId}`;
}

export function lastComparedQuotesKey(profileId: string): string {
  return `pipeline.last_compared_quotes.${profileId}`;
}

const SELECT_INPUT_FRONTIER = `
SELECT
  (SELECT COUNT(*) FROM messages
    WHERE search_profile_id = ? AND direction = 'inbound') AS inbound_count,
  COALESCE((SELECT MAX(rowid) FROM messages
    WHERE search_profile_id = ? AND direction = 'inbound'), 0) AS inbound_max_rowid
`;

const SELECT_QUOTE_IDS = `
SELECT quote_id, rowid AS quote_rowid
  FROM dealer_quotes
 WHERE search_profile_id = ?
 ORDER BY quote_id
`;

const SELECT_VALUE = "SELECT value FROM pipeline_state WHERE key = ?";
const UPSERT_VALUE =
  "INSERT INTO pipeline_state (key, value, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, " +
  "search_profile_id = excluded.search_profile_id, updated_at = CURRENT_TIMESTAMP";

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Read the append-oriented inbox/quote input frontier for one profile. Count +
 * max rowid makes additions visible and also avoids treating a deletion as the
 * same quote set. */
export function readPipelineInputWatermark(db: Db, profileId: string): PipelineInputWatermark {
  const row = db.$client
    .prepare(SELECT_INPUT_FRONTIER)
    .get(profileId, profileId) as
    | {
        inbound_count?: unknown;
        inbound_max_rowid?: unknown;
      }
    | undefined;
  const quoteRows = db.$client.prepare(SELECT_QUOTE_IDS).all(profileId) as Array<{
    quote_id?: unknown;
    quote_rowid?: unknown;
  }>;
  const quoteSetHash = createHash("sha256")
    .update(
      JSON.stringify(
        quoteRows.map((quote) => (typeof quote.quote_id === "string" ? quote.quote_id : null)),
      ),
      "utf8",
    )
    .digest("hex");
  return {
    inboundMessageCount: nonNegativeInt(row?.inbound_count),
    maxInboundMessageRowid: nonNegativeInt(row?.inbound_max_rowid),
    quoteCount: quoteRows.length,
    maxQuoteRowid: quoteRows.reduce(
      (max, quote) => Math.max(max, nonNegativeInt(quote.quote_rowid)),
      0,
    ),
    quoteSetHash,
  };
}

/** The quote-only slice captured before quote_compare runs. */
export function readQuoteInputWatermark(db: Db, profileId: string): QuoteInputWatermark {
  const input = readPipelineInputWatermark(db, profileId);
  return {
    quoteCount: input.quoteCount,
    maxQuoteRowid: input.maxQuoteRowid,
    quoteSetHash: input.quoteSetHash,
  };
}

function isQuoteInputWatermark(value: unknown): value is QuoteInputWatermark {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row["quoteCount"]) &&
    (row["quoteCount"] as number) >= 0 &&
    Number.isSafeInteger(row["maxQuoteRowid"]) &&
    (row["maxQuoteRowid"] as number) >= 0 &&
    typeof row["quoteSetHash"] === "string" &&
    (row["quoteSetHash"] as string).length === 64
  );
}

function isPipelineInputWatermark(value: unknown): value is PipelineInputWatermark {
  if (!isQuoteInputWatermark(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return (
    Number.isSafeInteger(row["inboundMessageCount"]) &&
    (row["inboundMessageCount"] as number) >= 0 &&
    Number.isSafeInteger(row["maxInboundMessageRowid"]) &&
    (row["maxInboundMessageRowid"] as number) >= 0
  );
}

function sameInput(a: PipelineInputWatermark, b: PipelineInputWatermark): boolean {
  return (
    a.inboundMessageCount === b.inboundMessageCount &&
    a.maxInboundMessageRowid === b.maxInboundMessageRowid &&
    a.quoteCount === b.quoteCount &&
    a.maxQuoteRowid === b.maxQuoteRowid &&
    a.quoteSetHash === b.quoteSetHash
  );
}

function readStoredAdmission(db: Db, profileId: string): StoredAdmission | null {
  const row = db.$client.prepare(SELECT_VALUE).get(pipelineAdmissionKey(profileId)) as
    | { value?: unknown }
    | undefined;
  if (typeof row?.value !== "string") return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredAdmission>;
    if (
      parsed.version !== 1 ||
      typeof parsed.admittedAtMs !== "number" ||
      !Number.isFinite(parsed.admittedAtMs) ||
      !isPipelineInputWatermark(parsed.input)
    ) {
      return null;
    }
    return parsed as StoredAdmission;
  } catch {
    // Corrupt/old state fails open: one admission repairs it through the writer.
    return null;
  }
}

/** Decide whether an automatic run may enter. This is a read-only decision;
 * callers persist the exact observed frontier only after run creation succeeds. */
export function evaluatePipelineAdmission(args: {
  db: Db;
  profileId: string;
  nowMs: number;
  floorMs?: number;
}): PipelineAdmissionDecision {
  const observedInput = readPipelineInputWatermark(args.db, args.profileId);
  const previous = readStoredAdmission(args.db, args.profileId);
  if (previous === null) {
    return {
      shouldAdmit: true,
      reason: "first_admission",
      observedInput,
      evaluatedAtMs: args.nowMs,
      lastAdmittedAtMs: null,
    };
  }
  if (!sameInput(previous.input, observedInput)) {
    return {
      shouldAdmit: true,
      reason: "new_input",
      observedInput,
      evaluatedAtMs: args.nowMs,
      lastAdmittedAtMs: previous.admittedAtMs,
    };
  }
  const floorMs = args.floorMs ?? PIPELINE_AUTO_ADMISSION_FLOOR_MS;
  if (args.nowMs - previous.admittedAtMs >= floorMs) {
    return {
      shouldAdmit: true,
      reason: "floor_elapsed",
      observedInput,
      evaluatedAtMs: args.nowMs,
      lastAdmittedAtMs: previous.admittedAtMs,
    };
  }
  return {
    shouldAdmit: false,
    reason: "same_input_floor",
    observedInput,
    evaluatedAtMs: args.nowMs,
    lastAdmittedAtMs: previous.admittedAtMs,
  };
}

/** Persist a successful automatic admission using the frontier returned by the
 * decision that led to it (never a later re-read that could swallow new input). */
export function writePipelineAdmission(args: {
  db: Db;
  profileId: string;
  admittedAtMs: number;
  observedInput: PipelineInputWatermark;
}): void {
  const value: StoredAdmission = {
    version: 1,
    admittedAtMs: args.admittedAtMs,
    input: args.observedInput,
  };
  args.db.$client
    .prepare(UPSERT_VALUE)
    .run(pipelineAdmissionKey(args.profileId), JSON.stringify(value), args.profileId);
}

/** Read the last successfully compared quote frontier, or null when never done. */
export function readLastComparedQuoteInput(db: Db, profileId: string): QuoteInputWatermark | null {
  const row = db.$client.prepare(SELECT_VALUE).get(lastComparedQuotesKey(profileId)) as
    | { value?: unknown }
    | undefined;
  if (typeof row?.value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return isQuoteInputWatermark(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Mark the exact quote frontier whose quote_compare child succeeded. */
export function writeLastComparedQuoteInput(
  db: Db,
  profileId: string,
  input: QuoteInputWatermark,
): void {
  db.$client
    .prepare(UPSERT_VALUE)
    .run(lastComparedQuotesKey(profileId), JSON.stringify(input), profileId);
}

export function sameQuoteInput(a: QuoteInputWatermark, b: QuoteInputWatermark): boolean {
  return (
    a.quoteCount === b.quoteCount &&
    a.maxQuoteRowid === b.maxQuoteRowid &&
    a.quoteSetHash === b.quoteSetHash
  );
}
