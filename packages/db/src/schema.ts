/**
 * AutoBroker Drizzle schema — STUB / introspection baseline.
 *
 * PROVENANCE (DECISIONS.html "DB 驱动 + schema 迁移", ts-migration REWRITE_SPEC §7):
 *   This file is GENERATED, not hand-authored. The baseline comes from
 *   `drizzle-kit pull` introspecting the **cold-copied** legacy SQLite
 *   (see ../../scripts/cold-copy-sqlite.sh — copy-not-share, never two-way sync).
 *   All 23 Alembic revisions from AutoBroker-Python are intentionally discarded;
 *   the live introspected DB is the single source of truth. A CI `drizzle-kit
 *   generate` empty-diff gate (see package.json `db:check`) fails the build if
 *   the committed schema drifts from what introspection would emit.
 *
 * MANUAL CORRECTION REQUIRED after every `db:pull` — drizzle-kit introspection
 * does NOT faithfully round-trip the following; re-apply by hand and keep this
 * list in sync with ../../../AutoBroker-dev-plan/ts-rebuild/architecture/ARCH_PERSISTENCE.html:
 *
 *   1. THREE partial indexes — drizzle-kit drops the `WHERE` predicate on pull.
 *      Re-add the partial-index `.where(...)` clauses:
 *        - the one-active-search-per-(account,brand) uniqueness index
 *          (partial on `status = 'active'`);
 *        - the dealer-email conflict index (partial on non-excluded rows);
 *        - the inventory-link de-dup index keyed on (profile, dealer, vin)
 *          (uq_il_profile_dealer_vin, partial on non-null vin).
 *
 *   2. SEVEN CHECK-constraint tables — better-sqlite3/Drizzle introspection does
 *      not reconstruct table-level CHECK constraints. Re-add them, including:
 *        - ck_lead_submissions_xor — the XOR constraint that a lead_submissions
 *          row is reached via EXACTLY ONE of {web-form submit, email send}, never
 *          both and never neither (the load-bearing irreversible-scope invariant
 *          behind the DWL email_fallback re-confirm; see risks "DWL email_fallback").
 *        - the financing-mode discriminant CHECK on dealer_quotes;
 *        - the doc-fee-cap / state-cap CHECKs;
 *        - the profile-status enum CHECK;
 *        - the phone-opt-in CHECK (fake phone default unless opted in);
 *        - the budget-redaction CHECK on outbound rows;
 *        - the typed-YES confirmation CHECK on destructive ops.
 *
 *   3. Foreign keys — verify every FK survived the pull (introspection can drop
 *      ON DELETE / ON UPDATE actions). Re-assert FK actions explicitly.
 *
 * Until `db:pull` is run against a cold-copied DB, the tables below are
 * placeholders that document the SHAPE only — they are NOT the authoritative
 * schema. Do not build skills against these stubs.
 *
 * IMPORT RULE: this package is the ONLY layer (with packages/tools) permitted to
 * touch SQLite. core/ must never import drizzle. (ARCH_OVERVIEW.html, five-layer
 * one-way dependency rule.)
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// TODO(phase-0): replace everything below with the real `drizzle-kit pull`
// output, then re-apply the three manual corrections documented above.

/** STUB — see correction note (2): real table carries 1 CHECK + status enum. */
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gmailAddress: text("gmail_address").notNull(),
  // TODO(phase-0): full column set from introspection.
});

/**
 * STUB — search_profiles.
 * Real table needs the partial unique index (correction 1) enforcing
 * "one active search per (account, brand)" and the profile-status enum CHECK
 * (correction 2). Identity fields are editable in place only until the first
 * lead_submissions row exists (Replace-or-Cancel after first outbound).
 */
export const searchProfiles = sqliteTable("search_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull(),
  brand: text("brand").notNull(),
  status: text("status").notNull(), // TODO: enum CHECK active|superseded|closed
  // TODO(phase-0): year/make/model/trim/location + full column set.
});

/**
 * STUB — dealer_quotes.
 * Real table carries the financing-mode discriminant CHECK (correction 2):
 * a quote is exactly one of {cash, finance, lease}; cross-mode field leakage
 * (Rule 1) and per-mode required fields (Rule 2) are enforced at the Zod layer
 * in packages/core and re-asserted here as CHECKs.
 */
export const dealerQuotes = sqliteTable("dealer_quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  searchProfileId: integer("search_profile_id").notNull(),
  financingMode: text("financing_mode").notNull(), // TODO: discriminant CHECK
  // TODO(phase-0): otd/price/fees/incentive columns from introspection.
});

/**
 * STUB — lead_submissions.
 * Real table carries ck_lead_submissions_xor (correction 2) — the keystone
 * irreversible-scope invariant: reached via EXACTLY ONE of web-form submit OR
 * email send. This is the structural twin of the no_external_mutation anchor.
 */
export const leadSubmissions = sqliteTable("lead_submissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  searchProfileId: integer("search_profile_id").notNull(),
  state: text("state").notNull(), // submitted | ...
  webFormDealerId: integer("web_form_dealer_id"), // XOR with emailMessageId
  emailMessageId: text("email_message_id"), // XOR with webFormDealerId
  costUsd: real("cost_usd"),
  // TODO(phase-0): re-add ck_lead_submissions_xor as a table CHECK after pull.
});

// TODO(phase-0): inventory_links (uq_il_profile_dealer_vin partial index,
// correction 1), dealers (dealer-email conflict partial index, correction 1),
// threads, messages, audit_log, decisions (awaiting_user backing store),
// incentives, digests — all from introspection.
