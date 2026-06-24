import { describe, it, expect } from "vitest";

import { ProfileSagaStack, type RetractionTask } from "./sagaStack.js";

describe("ProfileSagaStack — per-profile LIFO compensation", () => {
  it("runs local compensations in LIFO order", async () => {
    const order: string[] = [];
    const saga = new ProfileSagaStack("profile-A");
    saga.push({ key: "a", boundary: "local", undo: () => void order.push("a") });
    saga.push({ key: "b", boundary: "local", undo: () => void order.push("b") });
    saga.push({ key: "c", boundary: "local", undo: () => void order.push("c") });

    const result = await saga.compensate("aborted");

    expect(order).toEqual(["c", "b", "a"]); // last-in compensated first
    expect(result.undone).toEqual(["c", "b", "a"]);
    expect(result.retractions).toEqual([]);
  });

  it("is idempotent: a second compensate does not re-run any undo", async () => {
    const order: string[] = [];
    const saga = new ProfileSagaStack("profile-A");
    saga.push({ key: "a", boundary: "local", undo: () => void order.push("a") });

    await saga.compensate("aborted");
    await saga.compensate("aborted");

    expect(order).toEqual(["a"]); // exactly once
  });

  it("is conditional: a step whose shouldCompensate() is false is skipped", async () => {
    const order: string[] = [];
    const saga = new ProfileSagaStack("profile-A");
    saga.push({ key: "gone", boundary: "local", shouldCompensate: () => false, undo: () => void order.push("gone") });
    saga.push({ key: "live", boundary: "local", shouldCompensate: () => true, undo: () => void order.push("live") });

    const result = await saga.compensate("aborted");

    expect(order).toEqual(["live"]);
    expect(result.undone).toEqual(["live"]);
  });

  it("NEVER silently undoes a committed real send — it surfaces a human-facing retraction task instead", async () => {
    const order: string[] = [];
    const retraction: RetractionTask = {
      profileId: "profile-A",
      runId: "run-1",
      kind: "retract_lead",
      reason: "pipeline_aborted_after_send",
      summary: { heading: "Retract the inquiry you sent?", lines: [{ label: "Vehicle", value: "2026 Honda Accord" }] },
    };
    const saga = new ProfileSagaStack("profile-A");
    saga.push({ key: "localwrite", boundary: "local", undo: () => void order.push("localwrite") });
    saga.push({ key: "sent", boundary: "send", retraction, undo: () => void order.push("SHOULD_NOT_RUN") });

    const result = await saga.compensate("aborted");

    // The local write was rolled back; the send was NOT undone.
    expect(order).toEqual(["localwrite"]);
    expect(result.undone).toEqual(["localwrite"]);
    // The committed send became a human-facing retraction task (never a silent undo).
    expect(result.retractions).toEqual([retraction]);
  });
});
