/**
 * ledger — the replayable soak run-ledger (the FROZEN cross-skill row contract).
 *
 * Every soak spawn is REPLAYABLE: each row persists the scenario id + the EXACT
 * generated text + its sha256 contentHash + the claude session id + the pipeline
 * trace + the hybrid verdict. Re-running the frozen text under the same scenario
 * must reproduce the deterministic-assertion outcome bit-for-bit — so the row is
 * the unit the freezeToCorpus minimizer shrinks and the *.toml corpus freezes
 * from. Rows append to ~/.autobroker-ts/soak-runs/<ts>/ledger.jsonl (JSONL — one
 * row per line, append-friendly, diff-friendly).
 *
 * buildSoakLedgerRow is PURE (unit-tested); appendLedgerRow does the fs write.
 *
 * Dependency wall: harness layer. node:fs only — no DB, no framework, no provider.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DeterministicResult, JudgeDimResult, SoakVerdict } from "./verdict.js";

/** The trace summary the ledger captures off the drained RunDetail (kept small +
 *  stable — the full transcript lands in the run's evidence dir, not the row). */
export interface SoakRunTrace {
  runId: string | null;
  terminalStatus: string | null;
  eventCount: number;
  sawApprovalGate: boolean;
}

export interface BuildSoakLedgerRowInput {
  scenarioId: string;
  className: string;
  surface: string;
  /** Who generated the text (buyer/dealer) + on which model. */
  role: "buyer" | "dealer" | "judge";
  model: string;
  /** The EXACT generated text (the replay seed). */
  generatedText: string;
  /** sha256(generatedText) — the stable content key. */
  contentHash: string;
  claudeSessionId: string;
  /** The notional api-equivalent cost (subscription usage is plan-covered). */
  costUsd: number | null;
  rateLimited: boolean;
  /** The pipeline trace summary (off the drained RunDetail), or null (a generate-
   *  only spawn that never started a run). */
  trace: SoakRunTrace | null;
  verdict: SoakVerdict;
  deterministicResults: DeterministicResult[];
  judgeResults: JudgeDimResult[];
}

/** One persisted soak ledger row (the JSONL line shape). FROZEN. */
export interface SoakLedgerRow extends BuildSoakLedgerRowInput {
  /** Schema version of the row shape (bumped on a breaking row change). */
  schemaVersion: 1;
  /** ISO timestamp the row was built. */
  ts: string;
}

/**
 * Build one ledger row (pure). The ts is injectable so a unit test can pin it.
 */
export function buildSoakLedgerRow(
  input: BuildSoakLedgerRowInput,
  now: () => string = () => new Date().toISOString(),
): SoakLedgerRow {
  return {
    schemaVersion: 1,
    ts: now(),
    ...input,
  };
}

/** Serialize one row to a single JSONL line (no embedded newlines — generatedText
 *  is JSON-escaped, so a multi-line prose stays on one line). */
export function serializeLedgerRow(row: SoakLedgerRow): string {
  return JSON.stringify(row) + "\n";
}

/** Append a row to the run's ledger.jsonl (creates the dir + file). */
export function appendLedgerRow(ledgerPath: string, row: SoakLedgerRow): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, serializeLedgerRow(row), "utf8");
}

/** Parse a ledger.jsonl back into rows (the replay/freeze read path). Skips blank
 *  lines; fails LOUD on a malformed row (a corrupt ledger must surface, never be
 *  silently half-read). */
export function parseLedgerJsonl(text: string): SoakLedgerRow[] {
  const rows: SoakLedgerRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let row: SoakLedgerRow;
    try {
      row = JSON.parse(line) as SoakLedgerRow;
    } catch (e) {
      throw new Error(`parseLedgerJsonl: malformed row on line ${i + 1} — ${(e as Error).message}`);
    }
    rows.push(row);
  }
  return rows;
}
