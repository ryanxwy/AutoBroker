/**
 * L1 unit tests — the fake-mailbox-send-only preflight, the fail-CLOSED 2-AND
 * matrix that gates every send during the fake-send phase. Freezes:
 *   - all-true is the ONLY pass (does not throw);
 *   - each SINGLE-false throws FakeMailboxPreflightError, naming the failed
 *     condition: (a) adapter not a FakeGmailAdapter instance,
 *     (b) backend not "fake".
 *
 * No DB, no network: FakeGmailAdapter stores its injected db but touches it
 * lazily (only on a read/send call), so a never-used stub handle is enough to
 * construct an instance.
 */

import { describe, expect, it } from "vitest";

import { FakeGmailAdapter } from "./fakeAdapter.js";
import {
  assertFakeMailboxSendOnly,
  FakeMailboxPreflightError,
  type FakeMailboxPreflightDeps,
} from "./sendPreflight.js";
import type { Db } from "@autobroker/db";

// FakeGmailAdapter only stores the handle at construction (no query runs until a
// read/send call), so this never-touched stub is sufficient for preflight tests.
const STUB_DB = {} as unknown as Db;

function fakeAdapter(): FakeGmailAdapter {
  return new FakeGmailAdapter(STUB_DB);
}

describe("assertFakeMailboxSendOnly", () => {
  it("passes when both conditions hold (the only pass)", () => {
    const deps: FakeMailboxPreflightDeps = { adapter: fakeAdapter() };
    expect(() => assertFakeMailboxSendOnly(deps)).not.toThrow();
  });

  it("throws when (a) the adapter is not a FakeGmailAdapter instance", () => {
    // A plain object that LOOKS like a fake adapter (kind:"fake") but is not the
    // class — instance identity must still reject it.
    const notTheClass = { kind: "fake" } as unknown as FakeGmailAdapter;
    expect(() => assertFakeMailboxSendOnly({ adapter: notTheClass })).toThrow(
      FakeMailboxPreflightError,
    );
  });

  it("throws when (b) the backend does not self-declare 'fake'", () => {
    // A genuine instance, but its self-declared kind is overridden to "real" to
    // isolate condition (b) from condition (a).
    const adapter = fakeAdapter();
    Object.defineProperty(adapter, "kind", { value: "real" });
    expect(() => assertFakeMailboxSendOnly({ adapter })).toThrow(
      FakeMailboxPreflightError,
    );
  });

  it("reports the first failed condition in matrix order", () => {
    const notTheClass = { kind: "fake" } as unknown as FakeGmailAdapter;
    try {
      assertFakeMailboxSendOnly({ adapter: notTheClass });
      expect.unreachable("preflight should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FakeMailboxPreflightError);
      expect((err as FakeMailboxPreflightError).failedCondition).toBe("adapter_not_fake_instance");
    }
  });
});
