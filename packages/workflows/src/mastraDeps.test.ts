/**
 * L1 smoke — Mastra backbone dependency trio (ESM residue defense).
 *
 * The three @mastra/* packages are pinned EXACTLY as a date-matched trio
 * (core@1.41.0 + memory@1.20.2 + libsql@1.12.1): their
 * published peer ranges are looser than reality (libsql@1.12.1 imports
 * core-internal symbols that core@1.38 lacks — mastra#10602-class residue).
 * This test freezes "the trio imports under NodeNext ESM" so any future bump
 * that breaks the combo fails here, not at first live run.
 */

import { describe, expect, it } from "vitest";

describe("Mastra backbone trio — ESM import smoke", () => {
  it("@mastra/core resolves Mastra", async () => {
    const core = await import("@mastra/core");
    expect(typeof core.Mastra).toBe("function");
  });

  it("@mastra/core/workflows resolves createWorkflow/createStep", async () => {
    const wf = await import("@mastra/core/workflows");
    expect(typeof wf.createWorkflow).toBe("function");
    expect(typeof wf.createStep).toBe("function");
  });

  it("@mastra/memory resolves Memory", async () => {
    const mem = await import("@mastra/memory");
    expect(typeof mem.Memory).toBe("function");
  });

  it("@mastra/libsql resolves LibSQLStore (mastra.db carve-out)", async () => {
    const libsql = await import("@mastra/libsql");
    expect(typeof libsql.LibSQLStore).toBe("function");
  });
});
