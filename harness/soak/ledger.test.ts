/**
 * ledger.test.ts — the replayable run-ledger row builder: a built row carries
 * the scenario id + generated text + content hash + claude session id + trace +
 * verdict, serializes to a single JSONL line (multi-line prose stays on one
 * line), and round-trips through parseLedgerJsonl bit-for-bit. A malformed row
 * fails LOUD.
 */

import { describe, expect, it } from "vitest";

import {
  buildSoakLedgerRow,
  parseLedgerJsonl,
  serializeLedgerRow,
  type BuildSoakLedgerRowInput,
} from "./ledger.js";
import type { DeterministicResult, JudgeDimResult } from "./verdict.js";

const DET: DeterministicResult[] = [
  { assertionId: "no_external_mutation", ok: true, expected: 0, observed: 0 },
  { assertionId: "l1_fuse_armed", ok: true, expected: "armed", observed: "armed" },
];
const JUDGE: JudgeDimResult[] = [
  { name: "buyer_coherence", pass: true, rationale: "reads like a real buyer" },
];

const INPUT: BuildSoakLedgerRowInput = {
  scenarioId: "cold_start_phrasing",
  className: "cold_start_phrasing",
  surface: "search_profile_intake",
  role: "buyer",
  model: "claude-opus-4-8",
  generatedText: "lookin for a tucson\nhybrid around irvine",
  contentHash: "abc123",
  claudeSessionId: "sess-xyz",
  costUsd: 0.014,
  rateLimited: false,
  trace: {
    runId: "run-1",
    terminalStatus: "done",
    eventCount: 12,
    sawApprovalGate: true,
    sawMalformedToolCall: false,
  },
  verdict: "GREEN",
  deterministicResults: DET,
  judgeResults: JUDGE,
};

describe("buildSoakLedgerRow", () => {
  it("builds a row carrying every replay field + a pinned ts", () => {
    const row = buildSoakLedgerRow(INPUT, () => "2026-06-15T00:00:00.000Z");
    expect(row.schemaVersion).toBe(1);
    expect(row.ts).toBe("2026-06-15T00:00:00.000Z");
    expect(row.scenarioId).toBe("cold_start_phrasing");
    expect(row.generatedText).toBe("lookin for a tucson\nhybrid around irvine");
    expect(row.contentHash).toBe("abc123");
    expect(row.claudeSessionId).toBe("sess-xyz");
    expect(row.trace?.runId).toBe("run-1");
    expect(row.verdict).toBe("GREEN");
    expect(row.deterministicResults).toEqual(DET);
    expect(row.judgeResults).toEqual(JUDGE);
  });
});

describe("serializeLedgerRow / parseLedgerJsonl", () => {
  it("serializes to a single line (multi-line prose escaped onto one line)", () => {
    const row = buildSoakLedgerRow(INPUT, () => "2026-06-15T00:00:00.000Z");
    const line = serializeLedgerRow(row);
    expect(line.endsWith("\n")).toBe(true);
    // Exactly one trailing newline — the embedded \n in the prose is JSON-escaped.
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  it("round-trips a row bit-for-bit through JSONL", () => {
    const row = buildSoakLedgerRow(INPUT, () => "2026-06-15T00:00:00.000Z");
    const [parsed] = parseLedgerJsonl(serializeLedgerRow(row));
    expect(parsed).toEqual(row);
  });

  it("parses a multi-row jsonl + skips blank lines", () => {
    const a = serializeLedgerRow(buildSoakLedgerRow(INPUT, () => "t1"));
    const b = serializeLedgerRow(buildSoakLedgerRow({ ...INPUT, scenarioId: "two" }, () => "t2"));
    const rows = parseLedgerJsonl(`${a}\n${b}\n`);
    expect(rows.length).toBe(2);
    expect(rows[0]!.ts).toBe("t1");
    expect(rows[1]!.scenarioId).toBe("two");
  });

  it("fails LOUD on a malformed row", () => {
    expect(() => parseLedgerJsonl("{not valid json")).toThrow(/malformed row on line 1/);
  });
});
