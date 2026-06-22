/**
 * Unit tests for the AUTOBROKER_REAL_SEND master brake + the fail-closed
 * test-lane tripwire. Pure env logic — no network, no DB.
 *
 * Freezes the contract:
 *   (a) real-by-default — unset/"1" ⇒ enabled; only the exact "0" brakes;
 *   (b) test-lane detection keys on the explicit sentinels first;
 *   (c) forceTestLaneInternal pins fake + braked;
 *   (d) assertTestLaneInternal is a no-op outside a lane and throws, inside a
 *       lane, whenever real send is not braked — independent of the default.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  assertTestLaneInternal,
  forceTestLaneInternal,
  isRealSendEnabled,
  isTestLane,
  RealSendInTestLaneError,
} from "./realSend.js";

const VARS = [
  "AUTOBROKER_REAL_SEND",
  "AUTOBROKER_HARNESS_FIXTURE",
  "AUTOBROKER_E2E_LANE",
  "AUTOBROKER_GMAIL_BACKEND",
  "NODE_ENV",
] as const;
const original = new Map(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    const o = original.get(v);
    if (o === undefined) delete process.env[v];
    else process.env[v] = o;
  }
});

/** Clear every lane signal so the process looks like a plain production run. */
function clearLane(): void {
  delete process.env.AUTOBROKER_HARNESS_FIXTURE;
  delete process.env.AUTOBROKER_E2E_LANE;
  delete process.env.NODE_ENV;
}

describe("isRealSendEnabled — real by default, only '0' brakes", () => {
  it("is enabled when unset (real-by-default)", () => {
    delete process.env.AUTOBROKER_REAL_SEND;
    expect(isRealSendEnabled()).toBe(true);
  });

  it('is enabled for "1"', () => {
    process.env.AUTOBROKER_REAL_SEND = "1";
    expect(isRealSendEnabled()).toBe(true);
  });

  it('is BRAKED only for the exact "0"', () => {
    process.env.AUTOBROKER_REAL_SEND = "0";
    expect(isRealSendEnabled()).toBe(false);
  });

  it("reads fresh on every call (no module caching)", () => {
    process.env.AUTOBROKER_REAL_SEND = "0";
    expect(isRealSendEnabled()).toBe(false);
    process.env.AUTOBROKER_REAL_SEND = "1";
    expect(isRealSendEnabled()).toBe(true);
  });
});

describe("isTestLane — explicit sentinels first, NODE_ENV as belt", () => {
  it("true for the fixture sentinel", () => {
    clearLane();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    expect(isTestLane()).toBe(true);
  });

  it("true for the e2e sentinel", () => {
    clearLane();
    process.env.AUTOBROKER_E2E_LANE = "1";
    expect(isTestLane()).toBe(true);
  });

  it('true for NODE_ENV="test" (belt)', () => {
    clearLane();
    process.env.NODE_ENV = "test";
    expect(isTestLane()).toBe(true);
  });

  it("false for a plain production run", () => {
    clearLane();
    expect(isTestLane()).toBe(false);
  });
});

describe("forceTestLaneInternal — engages the master brake", () => {
  it("brakes real send (and leaves the Gmail backend var untouched)", () => {
    process.env.AUTOBROKER_REAL_SEND = "1";
    delete process.env.AUTOBROKER_GMAIL_BACKEND;
    forceTestLaneInternal();
    expect(process.env.AUTOBROKER_REAL_SEND).toBe("0");
    expect(isRealSendEnabled()).toBe(false);
    // boot must not synthesize a backend value (settings-route test asserts this).
    expect(process.env.AUTOBROKER_GMAIL_BACKEND).toBeUndefined();
  });
});

describe("assertTestLaneInternal — fail-closed tripwire", () => {
  it("is a no-op outside a test lane (real send allowed in production)", () => {
    clearLane();
    process.env.AUTOBROKER_REAL_SEND = "1";
    expect(() => assertTestLaneInternal()).not.toThrow();
  });

  it("THROWS in a test lane when real send is not braked (the inverted-default hazard)", () => {
    clearLane();
    process.env.AUTOBROKER_E2E_LANE = "1";
    process.env.AUTOBROKER_REAL_SEND = "1"; // ambient real default leaked into a lane
    expect(() => assertTestLaneInternal()).toThrow(RealSendInTestLaneError);
  });

  it("THROWS in a test lane with a real Gmail backend even if braked-by-other-means", () => {
    clearLane();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    process.env.AUTOBROKER_REAL_SEND = "0";
    process.env.AUTOBROKER_GMAIL_BACKEND = "real";
    expect(() => assertTestLaneInternal()).toThrow(RealSendInTestLaneError);
  });

  it("passes in a test lane once forceTestLaneInternal has run", () => {
    clearLane();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    process.env.AUTOBROKER_REAL_SEND = "1";
    forceTestLaneInternal();
    expect(() => assertTestLaneInternal()).not.toThrow();
  });
});
