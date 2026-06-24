import { describe, it, expect, beforeEach } from "vitest";

import {
  beginRunGuarded,
  DuplicateRunIdError,
  releaseRunOwnership,
  resetRuntimeGlueForTests,
} from "./runtimeGlue.js";

/**
 * A faithful fake of the @mastra/core Workflow surface that beginRunGuarded
 * uses: `id`, `getWorkflowRunById(runId)`, and `createRun({runId})` returning a
 * handle with `start()`. The fake exists ONLY to control the timing of
 * getWorkflowRunById so two callers can be made to interleave deterministically
 * (the real Mastra run-lifecycle methods are otherwise the unit under test's
 * collaborators, not the unit itself).
 */
function fakeWorkflow(
  opts: {
    existing?: Record<string, { status: string }>;
    onGetById?: () => Promise<void>;
    createThrows?: boolean;
  } = {},
) {
  const created: string[] = [];
  const existing = opts.existing ?? {};
  const wf = {
    id: "wf-test",
    async getWorkflowRunById(runId: string): Promise<{ status: string } | null> {
      if (opts.onGetById) await opts.onGetById();
      return existing[runId] ?? null;
    },
    async createRun({ runId }: { runId: string }): Promise<{ start: () => Promise<unknown> }> {
      if (opts.createThrows) throw new Error("createRun boom");
      created.push(runId);
      return { start: async () => ({ status: "suspended" }) };
    },
  };
  return { wf, created };
}

describe("beginRunGuarded — concurrent dup-runId TOCTOU", () => {
  beforeEach(() => {
    resetRuntimeGlueForTests();
  });

  it("two concurrent starts of the same runId: exactly one creates the run, the other throws DuplicateRunIdError", async () => {
    // getWorkflowRunById blocks on a shared gate so BOTH callers are inside the
    // existence-check window before either proceeds — the exact race the guard
    // must close.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { wf, created } = fakeWorkflow({ onGetById: () => gate });

    const p1 = beginRunGuarded(wf as never, { runId: "dup-1", inputData: {} });
    const p2 = beginRunGuarded(wf as never, { runId: "dup-1", inputData: {} });
    release();

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateRunIdError);
    // The run was created exactly once — no #5549 silent clobber.
    expect(created).toEqual(["dup-1"]);
  });

  it("a createRun failure rolls back the ownership reservation (no grow-only ghost)", async () => {
    const { wf } = fakeWorkflow({ createThrows: true });
    await expect(
      beginRunGuarded(wf as never, { runId: "boom-1", inputData: {} }),
    ).rejects.toThrow("createRun boom");
    // Rolled back: nothing left to release.
    expect(releaseRunOwnership("boom-1")).toBe(false);
  });

  it("a runId already in storage throws DuplicateRunIdError and leaves no reservation", async () => {
    const { wf, created } = fakeWorkflow({ existing: { "exists-1": { status: "suspended" } } });
    await expect(
      beginRunGuarded(wf as never, { runId: "exists-1", inputData: {} }),
    ).rejects.toBeInstanceOf(DuplicateRunIdError);
    expect(created).toEqual([]); // never created a second run
    expect(releaseRunOwnership("exists-1")).toBe(false);
  });

  it("a successful start registers ownership; releaseRunOwnership frees it once then is idempotent", async () => {
    const { wf, created } = fakeWorkflow();
    const begun = await beginRunGuarded(wf as never, { runId: "ok-1", inputData: {} });
    await begun.started;
    expect(created).toEqual(["ok-1"]);
    expect(releaseRunOwnership("ok-1")).toBe(true); // was owned
    expect(releaseRunOwnership("ok-1")).toBe(false); // already freed
  });
});
