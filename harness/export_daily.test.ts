/**
 * export_daily.test.ts — exportDaily against a tmp ledger DB. Proves
 * the locked snake_case wire shape + the NULL-not-$0 rule end-to-end: a usage-bearing
 * row exports cost_usd; an 'unavailable' row exports cost_usd:null (NEVER 0).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportDaily, serializeExport, type DailyHarnessExport } from "./export_daily.js";
import { insertLedgerRow, makeTmpDb, type TmpDb } from "./testSupport.js";

let tmp: TmpDb;

/** An empty runs-root inside the tmp dir so the multi-DB union never touches
 *  the machine's real ~/.autobroker-ts/harness-runs state. */
function isolatedRunsRoot(): string {
  return `${tmp.dir}/harness-runs`;
}

beforeEach(() => {
  tmp = makeTmpDb();
});
afterEach(() => {
  tmp.close();
});

describe("exportDaily", () => {
  it("emits the locked shape with snake_case run keys", () => {
    insertLedgerRow(tmp.db, { runId: "r-1", createdAt: "2026-06-05", costUsd: 0.0009, latencyMs: 7320 });
    const doc = exportDaily("2026-06-05", isolatedRunsRoot());
    expect(doc.date).toBe("2026-06-05");
    expect(typeof doc.code_repo_head_sha).toBe("string");
    expect(doc.runs).toHaveLength(1);
    const r = doc.runs[0]!;
    expect(r.run_id).toBe("r-1");
    expect(r.skill).toBe("search_profile_intake");
    expect(r.layer).toBe("L2");
    expect(r.provider).toBe("deepseek");
    expect(r.model_alias).toBe("deepseek-v4-flash");
    expect(r.cost_usd).toBeCloseTo(0.0009);
    expect(r.duration_ms).toBe(7320);
    expect(r.pricing_source).toBe("deepseek-2026-06");
    expect(r.fail_reason).toBeNull();
  });

  it("preserves NULL-not-$0: an unavailable row exports cost_usd:null (never 0)", () => {
    insertLedgerRow(tmp.db, { runId: "r-null", createdAt: "2026-06-05", costUsd: null, pricingSource: "unavailable", failReason: "usage_missing" });
    const doc = exportDaily("2026-06-05", isolatedRunsRoot());
    const r = doc.runs[0]!;
    expect(r.cost_usd).toBeNull();
    expect(r.cost_usd).not.toBe(0);
    expect(r.pricing_source).toBe("unavailable");
    expect(r.fail_reason).toBe("usage_missing");
  });

  it("only includes rows in the date window", () => {
    insertLedgerRow(tmp.db, { runId: "r-today", createdAt: "2026-06-05", costUsd: 0.001 });
    insertLedgerRow(tmp.db, { runId: "r-yesterday", createdAt: "2026-06-04", costUsd: 0.001 });
    const doc = exportDaily("2026-06-05", isolatedRunsRoot());
    expect(doc.runs.map((r) => r.run_id)).toEqual(["r-today"]);
  });

  it("includes full-ISO-timestamp rows that fall on the date (bucket band)", () => {
    insertLedgerRow(tmp.db, { runId: "r-iso", createdAt: "2026-06-05T13:22:01.000Z", costUsd: 0.001 });
    const doc = exportDaily("2026-06-05", isolatedRunsRoot());
    expect(doc.runs.map((r) => r.run_id)).toContain("r-iso");
  });

  it("rejects a non-YYYY-MM-DD date", () => {
    expect(() => exportDaily("June 5", isolatedRunsRoot())).toThrow(/YYYY-MM-DD/);
  });

  it("a day with no ledger rows exports an empty runs[] (not a crash)", () => {
    const doc = exportDaily("2026-06-05", isolatedRunsRoot());
    expect(doc.runs).toEqual([]);
    expect(doc.date).toBe("2026-06-05");
  });

  it("serializes deterministically with a trailing newline", () => {
    insertLedgerRow(tmp.db, { runId: "r-1", createdAt: "2026-06-05", costUsd: 0.001 });
    const doc: DailyHarnessExport = exportDaily("2026-06-05", isolatedRunsRoot());
    const s = serializeExport(doc);
    expect(s.endsWith("\n")).toBe(true);
    expect(serializeExport(doc)).toBe(s); // stable.
  });
});
