/**
 * statusProjection unit tests — all 10 Mastra statuses → the 7 product statuses
 * (BACKEND_SERVICES §5/§6). Pure; no Mastra, no I/O.
 */

import { describe, expect, it } from "vitest";

import { projectStatus, MASTRA_RUN_STATUSES } from "./statusProjection.js";

describe("projectStatus — all 10 Mastra statuses", () => {
  it("maps each of the 10 live-probed statuses to a product status", () => {
    expect(projectStatus("pending")).toBe("pending");
    expect(projectStatus("running")).toBe("running");
    expect(projectStatus("waiting")).toBe("running");
    expect(projectStatus("paused")).toBe("running");
    expect(projectStatus("suspended")).toBe("awaiting_approval");
    expect(projectStatus("success")).toBe("done");
    expect(projectStatus("canceled")).toBe("aborted");
    expect(projectStatus("failed")).toBe("error");
    expect(projectStatus("tripwire")).toBe("error");
    expect(projectStatus("bailed")).toBe("error");
  });

  it("covers exactly the 10 declared statuses (no input left unmapped)", () => {
    expect(MASTRA_RUN_STATUSES).toHaveLength(10);
    for (const s of MASTRA_RUN_STATUSES) {
      // Every status must project to a non-throwing product status.
      expect(typeof projectStatus(s)).toBe("string");
    }
  });
});

describe("projectStatus — declined hint fork (§5 app metadata)", () => {
  it("success + declined hint → declined (workflow outcome was declined)", () => {
    expect(projectStatus("success", { declined: true })).toBe("declined");
  });

  it("canceled + declined hint → declined (user decline at a form gate)", () => {
    expect(projectStatus("canceled", { declined: true })).toBe("declined");
  });

  it("canceled WITHOUT the hint → aborted (a stale-run/abort cancel)", () => {
    expect(projectStatus("canceled")).toBe("aborted");
  });

  it("the declined hint does NOT turn an error into declined", () => {
    expect(projectStatus("failed", { declined: true })).toBe("error");
  });
});
