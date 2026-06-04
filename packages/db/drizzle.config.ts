import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config — STUB.
 *
 * `db:pull` introspects the COLD-COPIED legacy SQLite (copy-not-share; see
 * ../../scripts/cold-copy-sqlite.sh) to regenerate src/schema.ts as the
 * baseline. After every pull, re-apply the manual corrections documented at the
 * top of src/schema.ts (3 partial indexes, 7 CHECK tables incl.
 * ck_lead_submissions_xor, FK actions).
 *
 * `db:generate` (CI empty-diff gate, package.json `db:check`) must produce a
 * NO-OP migration against the introspected live schema — a non-empty diff fails
 * the build, catching hand-edits that drift from introspection.
 *
 * All 23 legacy Alembic revisions are discarded; this is the only migration
 * source going forward.
 */
export default defineConfig({
  dialect: "sqlite",
  // Both files form the product schema: schema.ts is the introspected oracle
  // baseline; testRunRecords.ts is the TS-owned ledger (no legacy equivalent,
  // hand-authored, migrated forward).
  schema: ["./src/schema.ts", "./src/testRunRecords.ts"],
  out: "./drizzle",
  // alembic_version is the frozen oracle's migration bookkeeping — legacy
  // machinery, not product schema. Excluded declaratively so every re-pull
  // drops it without a manual step.
  tablesFilter: ["!alembic_version"],
  dbCredentials: {
    // For `db:pull` this points at the cold-copied file produced by
    // scripts/cold-copy-sqlite.sh — NEVER the legacy ~/.autobroker/autobroker.db.
    url: process.env.AUTOBROKER_DB ?? `${process.env.HOME}/.autobroker-ts/autobroker.db`,
  },
});
