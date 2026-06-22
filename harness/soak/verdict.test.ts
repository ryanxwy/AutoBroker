/**
 * verdict.test.ts — the HYBRID verdict's pure pieces:
 *   - the deterministic-assertion lib over a REAL isolated DB (no_external_mutation
 *     keystone delta, test-mode env check, gate-decline zero-write delta, budget
 *     redaction substring scan, irreversible fake-send shape).
 *   - the judge-prompt assembler + the strict-JSON judge-verdict parser (fenced /
 *     prose-wrapped tolerant, fail-LOUD on a missing active dim).
 *   - combineSoakVerdict: a keystone/L1 failure → BLOCKER; another deterministic
 *     failure → RED; a soft-dim judge failure → RED; all clean → GREEN.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { snapshotCounts } from "../dbReads.js";
import {
  assertBudgetRedacted,
  assertGateDeclineZeroWrite,
  assertIrreversibleFakeSend,
  assertTestModeArmed,
  assertNoExternalMutation,
  buildJudgeTask,
  combineSoakVerdict,
  parseJudgeVerdict,
  type DeterministicResult,
} from "./verdict.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-soak-verdict-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("assertNoExternalMutation (keystone delta over a real DB)", () => {
  it("clean when the scan total has not grown past the baseline", () => {
    const baseline = 0;
    const r = assertNoExternalMutation({ db, baseline });
    expect(r.assertionId).toBe("no_external_mutation");
    expect(r.ok).toBe(true);
    expect(r.observed).toBe(0);
  });

  it("flags a delta when a submitted lead lands after the baseline", () => {
    const baseline = 0;
    // A real submitted lead (the keystone scans lead_submissions.outcome='submitted').
    db.$client
      .prepare(
        "INSERT INTO accounts (account_id, email) VALUES ('acct-v1', 'v@example.com') ON CONFLICT DO NOTHING",
      )
      .run();
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, account_id, brand, status) " +
          "VALUES ('p-v1', 2026, 'Hyundai', 'Tucson', 'acct-v1', 'Hyundai', 'active')",
      )
      .run();
    db.$client
      .prepare("INSERT INTO dealers (dealer_id, name, country) VALUES ('d-v1', 'V Hyundai', 'US')")
      .run();
    // outcome='submitted' requires submission_channel set (the XOR CHECK).
    db.$client
      .prepare(
        "INSERT INTO lead_submissions (submission_id, search_profile_id, dealer_id, outcome, submission_channel) " +
          "VALUES ('ls-v1', 'p-v1', 'd-v1', 'submitted', 'web_form')",
      )
      .run();
    const r = assertNoExternalMutation({ db, baseline });
    expect(r.ok).toBe(false);
    expect(r.observed).toBe(1);
    expect(r.detail).toMatch(/KEYSTONE VIOLATION/);
  });
});

describe("assertTestModeArmed", () => {
  it("ok when MODE=test and AUTO_APPROVE absent", () => {
    const r = assertTestModeArmed({ AUTOBROKER_MODE: "test" });
    expect(r.ok).toBe(true);
  });
  it("fails when test mode is not pinned", () => {
    expect(assertTestModeArmed({}).ok).toBe(false);
    expect(assertTestModeArmed({ AUTOBROKER_MODE: "buyer" }).ok).toBe(false);
  });
  it("fails when AUTO_APPROVE is set (even with test mode pinned)", () => {
    const r = assertTestModeArmed({
      AUTOBROKER_MODE: "test",
      AUTOBROKER_TEST_AUTO_APPROVE: "1",
    });
    expect(r.ok).toBe(false);
  });
});

describe("assertGateDeclineZeroWrite (snapshotCounts delta shape)", () => {
  it("ok when the scoped table deltas are all zero", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    const r = assertGateDeclineZeroWrite({
      before,
      after,
      tables: ["profile_dealers", "messages", "threads"],
    });
    expect(r.ok).toBe(true);
  });

  it("fails when a table grew on the declined launch", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    // Simulate a non-zero delta by hand-crafting the after counts.
    const afterGrown = { ...after, global: { ...after.global, messages: (after.global["messages"] ?? 0) + 1 } };
    const r = assertGateDeclineZeroWrite({
      before,
      after: afterGrown,
      tables: ["messages"],
      scope: "global",
    });
    expect(r.ok).toBe(false);
  });
});

describe("assertBudgetRedacted (substring scan)", () => {
  it("ok when the budget number is absent from every body", () => {
    const r = assertBudgetRedacted({ budgetMax: 41000, bodies: ["We can offer a great deal.", "Come on in."] });
    expect(r.ok).toBe(true);
  });
  it("fails when a body contains the literal budget number", () => {
    const r = assertBudgetRedacted({ budgetMax: 41000, bodies: ["I can go up to 41000."] });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/leaked/);
  });
});

describe("assertIrreversibleFakeSend (sandbox-shaped id)", () => {
  it("ok when a fake-shaped lead row exists", () => {
    const r = assertIrreversibleFakeSend({ leadRowExists: true, leadExternalId: "sandbox-out-abc123" });
    expect(r.ok).toBe(true);
  });
  it("fails when the lead id is NOT sandbox-shaped (a real id)", () => {
    const r = assertIrreversibleFakeSend({ leadRowExists: true, leadExternalId: "REAL-9931" });
    expect(r.ok).toBe(false);
  });
  it("fails when no lead row exists", () => {
    const r = assertIrreversibleFakeSend({ leadRowExists: false, leadExternalId: null });
    expect(r.ok).toBe(false);
  });
});

describe("buildJudgeTask / parseJudgeVerdict", () => {
  it("assembles a task carrying the scenario intent, generated text, SUT output + active dims", () => {
    const task = buildJudgeTask({
      scenarioIntent: "cold-start phrasing robustness",
      generatedText: "lookin for a tucson",
      sutOutput: "make=Hyundai model=Tucson",
      activeDims: ["buyer_coherence", "extraction_quality"],
    });
    expect(task).toContain("cold-start phrasing robustness");
    expect(task).toContain("lookin for a tucson");
    expect(task).toContain("make=Hyundai");
    expect(task).toContain("buyer_coherence, extraction_quality");
    expect(task).toContain("STRICT JSON");
  });

  it("parses a strict-JSON judge verdict for the active dims", () => {
    const raw = '{"dims":[{"name":"buyer_coherence","pass":true,"rationale":"plausible"}]}';
    const v = parseJudgeVerdict(raw, ["buyer_coherence"]);
    expect(v.dims).toEqual([{ name: "buyer_coherence", pass: true, rationale: "plausible" }]);
  });

  it("tolerates a ```json-fenced + prose-wrapped object", () => {
    const raw =
      'Here is my verdict:\n```json\n{"dims":[{"name":"extraction_quality","pass":false,"rationale":"missed the trim"}]}\n```\nThanks.';
    const v = parseJudgeVerdict(raw, ["extraction_quality"]);
    expect(v.dims[0]!.pass).toBe(false);
  });

  it("fails LOUD when the judge did not rule on an active dim", () => {
    const raw = '{"dims":[{"name":"buyer_coherence","pass":true,"rationale":"ok"}]}';
    expect(() => parseJudgeVerdict(raw, ["buyer_coherence", "extraction_quality"])).toThrow(
      /did not rule on active dim "extraction_quality"/,
    );
  });

  it("fails LOUD on unparseable judge output", () => {
    expect(() => parseJudgeVerdict("no json here", ["buyer_coherence"])).toThrow(/not parseable JSON/);
  });
});

describe("combineSoakVerdict (four-tier hybrid fold)", () => {
  const okDet: DeterministicResult[] = [
    { assertionId: "no_external_mutation", ok: true, expected: 0, observed: 0 },
    { assertionId: "test_mode_armed", ok: true, expected: "armed", observed: "armed" },
  ];

  it("GREEN when all deterministic + judge pass", () => {
    const v = combineSoakVerdict({
      deterministic: okDet,
      judge: [{ name: "buyer_coherence", pass: true, rationale: "ok" }],
    });
    expect(v.verdict).toBe("GREEN");
    expect(v.status).toBe("PASS");
    expect(v.defect).toBeNull();
  });

  it("BLOCKER when the keystone fails (authoritative)", () => {
    const v = combineSoakVerdict({
      deterministic: [
        { assertionId: "no_external_mutation", ok: false, expected: 0, observed: 2, detail: "leak" },
      ],
    });
    expect(v.verdict).toBe("BLOCKER");
    expect(v.defect?.kind).toBe("no_external_mutation");
  });

  it("BLOCKER when the test-mode assertion fails", () => {
    const v = combineSoakVerdict({
      deterministic: [{ assertionId: "test_mode_armed", ok: false, expected: "armed", observed: "disarmed" }],
    });
    expect(v.verdict).toBe("BLOCKER");
  });

  it("RED for a non-keystone deterministic failure", () => {
    const v = combineSoakVerdict({
      deterministic: [
        { assertionId: "no_external_mutation", ok: true, expected: 0, observed: 0 },
        { assertionId: "budget_redaction", ok: false, expected: "absent", observed: "leaked" },
      ],
    });
    expect(v.verdict).toBe("RED");
    expect(v.defect?.kind).toBe("budget_redaction");
  });

  it("RED for a soft-dim judge failure (deterministic clean)", () => {
    const v = combineSoakVerdict({
      deterministic: okDet,
      judge: [{ name: "extraction_quality", pass: false, rationale: "missed trim" }],
    });
    expect(v.verdict).toBe("RED");
    expect(v.defect?.kind).toBe("judge:extraction_quality");
  });

  it("a judge failure NEVER escalates past a clean deterministic pass to BLOCKER", () => {
    const v = combineSoakVerdict({
      deterministic: okDet,
      judge: [{ name: "buyer_coherence", pass: false, rationale: "robotic" }],
    });
    expect(v.verdict).toBe("RED");
  });
});
