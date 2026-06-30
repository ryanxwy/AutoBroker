/**
 * dealer_reply_extract persist writer — the all-or-nothing PER-MESSAGE upsert
 * into dealer_quotes plus the mark-processed state machine on messages.
 *
 * One message's extracted rows are validated + written as a unit, in ONE
 * transaction:
 *   - each row is built into the full persisted DealerQuote shape (provenance +
 *     extracted) and Zod-validated (.strict + Rule1/Rule2) BEFORE any SQL write;
 *   - if ANY row fails validation, the whole message rolls back and the message
 *     is marked `failed` (re-queued);
 *   - on success every row is UPSERTed keyed UNIQUE(source_gmail_message_id,
 *     financing_mode) — a re-extract UPDATEs in place PRESERVING the existing
 *     quote_id (a fresh quote_id is generated only on first insert);
 *   - the message is then marked terminal: `succeeded` (intent NOT NULL,
 *     processed_at stamped) — terminal even with ZERO rows — or `failed`
 *     (intent NULL, processed_at NULL, re-queued).
 *
 * The CHECK constraint on messages is the double-safety: succeeded ⇒ intent NOT
 * NULL; pending/failed ⇒ intent NULL.
 */

import { randomUUID } from "node:crypto";

import type { Db } from "@autobroker/db";
import {
  DealerQuoteSchema,
  type DealerReplyQuoteRow,
  type Intent,
} from "@autobroker/core";

import { getDb } from "../db.js";

/** The provenance the writer stamps onto every row of one message (the model
 *  cannot know these — they come from the message + its thread + the run). */
export interface MessageProvenance {
  /** The messages.message_id PK. */
  messageId: string;
  /** The message's gmail_message_id → dealer_quotes.source_gmail_message_id;
   *  part of the UNIQUE upsert key. */
  sourceGmailMessageId: string;
  /** The owning profile (NON-NULL — the orphan-row discipline). */
  searchProfileId: string;
  /** The dealer resolved from the message's thread (threads.dealer_id). */
  dealerId: string;
  /** Which provider's model extracted these rows. */
  extractorProvider: "deepseek" | "anthropic" | "openai" | null;
  /** How the source text reached the model. */
  extractionMethod: "vision" | "ocr" | "text" | null;
  /** The per-message classified intent the success state stamps onto messages
   *  (NOT NULL on success). */
  intent: Intent;
  /** The sender's job title parsed by the keystone LLM emit (null when absent).
   *  The LLM title FALLBACK: written to the message's dealer_contacts.role ONLY
   *  when the deterministic role heuristic left it NULL (COALESCE-keep — a known
   *  role is never overwritten). */
  contactRole: string | null;
}

/** The outcome of one message's persist. */
export type PersistMessageResult =
  | { ok: true; status: "succeeded"; rowsUpserted: number }
  | { ok: false; status: "failed"; reason: string };

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SELECT_EXISTING_QUOTE_ID = `
SELECT quote_id FROM dealer_quotes
WHERE source_gmail_message_id = ? AND financing_mode = ?
`;

const QUOTE_COLS = [
  "quote_id",
  "dealer_id",
  "message_id",
  "source_gmail_message_id",
  "search_profile_id",
  "vin",
  "inventory_status",
  "msrp",
  "selling_price",
  "dealer_discount",
  "rebates_json",
  "doc_fee",
  "dealer_fee",
  "sales_tax",
  "dmv_fees",
  "title_fee",
  "registration_fee",
  "license_fee",
  "other_fees_json",
  "add_ons_json",
  "taxable_rebates_json",
  "otd_total",
  "quote_format",
  "intent",
  "confidence",
  "raw_source_blob",
  "quote_received_at",
  "quote_expires_at",
  "extracted_at",
  "extractor_provider",
  "extraction_method",
  "financing_mode",
  "finance_apr",
  "finance_term_months",
  "finance_down_payment",
  "finance_monthly_payment",
  "finance_amount_financed",
  "lease_term_months",
  "lease_money_factor",
  "lease_residual_pct",
  "lease_residual_value",
  "lease_due_at_signing",
  "lease_monthly_payment",
  "lease_miles_per_year",
  "lease_acquisition_fee",
  "lease_disposition_fee",
  "lease_cap_cost_gross",
  "lease_cap_cost_adjusted",
  "lease_rent_charge",
  "source_listing_id",
] as const;

/** Columns updated on conflict — everything except the identity/key columns
 *  (quote_id is preserved; source_gmail_message_id + financing_mode are the key). */
const UPDATE_COLS = QUOTE_COLS.filter(
  (c) => c !== "quote_id" && c !== "source_gmail_message_id" && c !== "financing_mode",
);

const UPSERT_QUOTE = `
INSERT INTO dealer_quotes (${QUOTE_COLS.join(", ")})
VALUES (${QUOTE_COLS.map(() => "?").join(", ")})
ON CONFLICT (source_gmail_message_id, financing_mode) DO UPDATE SET
${UPDATE_COLS.map((c) => `  ${c} = excluded.${c}`).join(",\n")}
`;

const MARK_SUCCEEDED = `
UPDATE messages SET
  quote_extraction_status = 'succeeded',
  quote_extraction_intent = ?,
  processed_at = ?
WHERE message_id = ?
`;

const MARK_FAILED = `
UPDATE messages SET
  quote_extraction_status = 'failed',
  quote_extraction_intent = NULL,
  processed_at = NULL
WHERE message_id = ?
`;

/** The LLM title fallback: stamp the sender's job title onto the message's
 *  dealer_contacts.role, but ONLY when the deterministic role heuristic left it
 *  NULL (the `role IS NULL` guard is the COALESCE-keep — a known role is never
 *  overwritten). A null message.contact_id matches no row → no-op. */
const UPDATE_CONTACT_ROLE = `
UPDATE dealer_contacts SET role = ?
WHERE contact_id = (SELECT contact_id FROM messages WHERE message_id = ?)
  AND role IS NULL
`;

// ---------------------------------------------------------------------------
// persistMessageQuotes
// ---------------------------------------------------------------------------

/**
 * Validate + persist one message's extracted rows, all-or-nothing, and flip the
 * message's extraction state machine.
 *
 * On full success: every row UPSERTed (quote_id preserved on re-extract),
 * message → `succeeded` (intent stamped, processed_at set) — even with 0 rows.
 * On any validation failure: nothing written to dealer_quotes, message →
 * `failed` (intent NULL, processed_at NULL, re-queued). The mark-failed runs in
 * its OWN transaction after the rollback so the failure is recorded.
 */
export function persistMessageQuotes(opts: {
  provenance: MessageProvenance;
  rows: readonly DealerReplyQuoteRow[];
  db?: Db;
  now?: string;
}): PersistMessageResult {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  const p = opts.provenance;
  const c = db.$client;

  // Build + validate every row up front (BEFORE the write txn). The existing
  // quote_id is looked up so a re-extract preserves it; a first insert mints one.
  const selectExisting = c.prepare(SELECT_EXISTING_QUOTE_ID);
  const validatedRows: Array<Record<string, unknown>> = [];
  try {
    for (const row of opts.rows) {
      const existing = selectExisting.get(p.sourceGmailMessageId, row.financing_mode) as
        | { quote_id: string }
        | undefined;
      const quoteId = existing?.quote_id ?? randomUUID();

      const full = {
        quote_id: quoteId,
        dealer_id: p.dealerId,
        message_id: p.messageId,
        source_gmail_message_id: p.sourceGmailMessageId,
        search_profile_id: p.searchProfileId,
        ...row,
        // A no-fresh-number reply (a hold/payment-only/come-onsite extraction)
        // must NOT persist a $0 OTD: SQLite MIN() / nulls-last ordering rank 0 as
        // the cheapest, so a $0 row would supersede the dealer's last real OTD on
        // the board + latest-quote views. Normalize otd_total <= 0 → null so the
        // reply is still recorded (provenance/coverage) but never ranks as a
        // quote (a no-number reply stores null, never a $0 quote).
        otd_total: row.otd_total != null && row.otd_total <= 0 ? null : row.otd_total,
        extractor_provider: p.extractorProvider,
        extraction_method: p.extractionMethod,
        extracted_at: now,
        raw_source_blob: null,
      };
      // Zod authority: .strict() + Rule1/Rule2. A failure throws → message failed.
      const parsed = DealerQuoteSchema.parse(full);
      validatedRows.push(toRowValues(parsed));
    }
  } catch (err) {
    markFailed(c, p.messageId);
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, status: "failed", reason };
  }

  // All rows valid — write them + mark succeeded in ONE transaction.
  const upsert = c.prepare(UPSERT_QUOTE);
  const markSucceeded = c.prepare(MARK_SUCCEEDED);
  const updateContactRole = c.prepare(UPDATE_CONTACT_ROLE);
  const txn = c.transaction((): number => {
    for (const values of validatedRows) {
      upsert.run(...QUOTE_COLS.map((col) => values[col]));
    }
    markSucceeded.run(p.intent, now, p.messageId);
    // LLM title fallback — gated on `role IS NULL` so the heuristic always wins.
    if (p.contactRole != null) {
      updateContactRole.run(p.contactRole, p.messageId);
    }
    return validatedRows.length;
  });

  try {
    const rowsUpserted = txn();
    return { ok: true, status: "succeeded", rowsUpserted };
  } catch (err) {
    // A SQL-level failure (e.g. CHECK/FK) also rolls back and re-queues.
    markFailed(c, p.messageId);
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, status: "failed", reason };
  }
}

/** Mark a message failed (own statement; runs outside the rolled-back txn). */
function markFailed(client: Db["$client"], messageId: string): void {
  client.prepare(MARK_FAILED).run(messageId);
}

/**
 * The persist layer's mark-failed path, public for the workflow's per-message
 * catch: a message whose extraction THREW before persist ran (a #1244 abort, an
 * adapter/extract error) is marked `failed` (quote_extraction_status='failed',
 * intent NULL, processed_at NULL → re-queued), writing ZERO quotes. Keeps the
 * mark-processed state machine owned in exactly one place.
 */
export function markMessageFailed(opts: { messageId: string; db?: Db }): void {
  const db = opts.db ?? getDb();
  markFailed(db.$client, opts.messageId);
}

/** Flatten a validated DealerQuote into the column→value map the upsert binds.
 *  JSON-array fields are stringified into their TEXT columns; everything else
 *  is passed through (float dollars stay floats). */
function toRowValues(quote: ReturnType<typeof DealerQuoteSchema.parse>): Record<string, unknown> {
  const q = quote as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const col of QUOTE_COLS) {
    const v = q[col];
    if (
      col === "rebates_json" ||
      col === "other_fees_json" ||
      col === "add_ons_json" ||
      col === "taxable_rebates_json"
    ) {
      out[col] = v == null ? null : JSON.stringify(v);
    } else {
      out[col] = v ?? null;
    }
  }
  return out;
}
