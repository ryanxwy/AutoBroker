/**
 * Unit tests for the AUTOBROKER_MODE switch + the fail-closed harness tripwire.
 * Pure env logic — no network, no DB.
 *
 * Freezes the contract:
 *   (a) buyer-by-default — unset/anything-but-"test" ⇒ buyer; only the exact
 *       "test" selects test mode;
 *   (b) harness-context detection keys on the fixture sentinel / NODE_ENV="test";
 *   (c) forceTestMode pins AUTOBROKER_MODE="test";
 *   (d) assertTestModeSafe is a no-op outside a harness context and throws, inside
 *       one, whenever the process is not in test mode — independent of the default.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  assertTestModeSafe,
  forceTestMode,
  isBuyerMode,
  isHarnessContext,
  isTestMode,
  ModeViolationError,
  resolveMode,
} from "./realSend.js";

const VARS = [
  "AUTOBROKER_MODE",
  "AUTOBROKER_HARNESS",
  "AUTOBROKER_HARNESS_FIXTURE",
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

/** Clear every harness-context signal so the process looks like a plain buyer run. */
function clearHarness(): void {
  delete process.env.AUTOBROKER_HARNESS;
  delete process.env.AUTOBROKER_HARNESS_FIXTURE;
  delete process.env.NODE_ENV;
}

describe("resolveMode / isBuyerMode / isTestMode — buyer by default, only 'test' flips", () => {
  it("is buyer when unset (buyer-by-default)", () => {
    delete process.env.AUTOBROKER_MODE;
    expect(resolveMode()).toBe("buyer");
    expect(isBuyerMode()).toBe(true);
    expect(isTestMode()).toBe(false);
  });

  it('is buyer for "buyer"', () => {
    process.env.AUTOBROKER_MODE = "buyer";
    expect(resolveMode()).toBe("buyer");
    expect(isBuyerMode()).toBe(true);
  });

  it('is buyer for any non-"test" value (e.g. garbage)', () => {
    process.env.AUTOBROKER_MODE = "nonsense";
    expect(resolveMode()).toBe("buyer");
    expect(isBuyerMode()).toBe(true);
  });

  it('is TEST only for the exact "test"', () => {
    process.env.AUTOBROKER_MODE = "test";
    expect(resolveMode()).toBe("test");
    expect(isTestMode()).toBe(true);
    expect(isBuyerMode()).toBe(false);
  });

  it("reads fresh on every call (no module caching)", () => {
    process.env.AUTOBROKER_MODE = "test";
    expect(isBuyerMode()).toBe(false);
    process.env.AUTOBROKER_MODE = "buyer";
    expect(isBuyerMode()).toBe(true);
  });
});

describe("isHarnessContext — harness sentinel / fixture sentinel / NODE_ENV=test", () => {
  it("true for the unconditional harness sentinel (covers the LIVE host, not just fixture)", () => {
    clearHarness();
    process.env.AUTOBROKER_HARNESS = "1";
    expect(isHarnessContext()).toBe(true);
  });

  it("true for the fixture sentinel", () => {
    clearHarness();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    expect(isHarnessContext()).toBe(true);
  });

  it('true for NODE_ENV="test"', () => {
    clearHarness();
    process.env.NODE_ENV = "test";
    expect(isHarnessContext()).toBe(true);
  });

  it("false for a plain buyer run", () => {
    clearHarness();
    expect(isHarnessContext()).toBe(false);
  });
});

describe("forceTestMode — pins AUTOBROKER_MODE=test", () => {
  it("pins test mode (the one send-control knob)", () => {
    process.env.AUTOBROKER_MODE = "buyer";
    forceTestMode();
    expect(process.env.AUTOBROKER_MODE).toBe("test");
    expect(isTestMode()).toBe(true);
  });
});

describe("assertTestModeSafe — fail-closed tripwire", () => {
  it("is a no-op outside a harness context (buyer mode allowed in production)", () => {
    clearHarness();
    process.env.AUTOBROKER_MODE = "buyer";
    expect(() => assertTestModeSafe()).not.toThrow();
  });

  it("THROWS in a harness context when not in test mode (the inverted-default hazard)", () => {
    clearHarness();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    process.env.AUTOBROKER_MODE = "buyer"; // ambient buyer default leaked into a harness
    expect(() => assertTestModeSafe()).toThrow(ModeViolationError);
  });

  it("passes in a harness context once forceTestMode has run", () => {
    clearHarness();
    process.env.AUTOBROKER_HARNESS_FIXTURE = "1";
    process.env.AUTOBROKER_MODE = "buyer";
    forceTestMode();
    expect(() => assertTestModeSafe()).not.toThrow();
  });
});
