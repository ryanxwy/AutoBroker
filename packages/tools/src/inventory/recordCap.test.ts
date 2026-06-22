/**
 * recordCap unit tests — resolver + constants.
 *
 * TDD: these were written before the implementation. Covers:
 *   - default when env var is unset
 *   - parses a valid integer value
 *   - clamps below MIN
 *   - clamps above MAX
 *   - returns default for a non-integer string
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PER_DEALER_RECORD_CAP_DEFAULT,
  PER_DEALER_RECORD_CAP_MAX,
  PER_DEALER_RECORD_CAP_MIN,
  resolvePerDealerRecordCap,
} from "./recordCap.js";

const ENV_VAR = "AUTOBROKER_PER_DEALER_RECORD_CAP";

let originalValue: string | undefined;

beforeEach(() => {
  originalValue = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = originalValue;
});

describe("resolvePerDealerRecordCap", () => {
  it("returns the default (20) when env var is unset", () => {
    expect(resolvePerDealerRecordCap()).toBe(PER_DEALER_RECORD_CAP_DEFAULT);
    expect(resolvePerDealerRecordCap()).toBe(20);
  });

  it("parses and returns a valid integer value from the env var", () => {
    process.env[ENV_VAR] = "35";
    expect(resolvePerDealerRecordCap()).toBe(35);
  });

  it("returns MIN (1) when the value is below the minimum", () => {
    process.env[ENV_VAR] = "0";
    expect(resolvePerDealerRecordCap()).toBe(PER_DEALER_RECORD_CAP_MIN);
    expect(resolvePerDealerRecordCap()).toBe(1);
  });

  it("returns MAX (80) when the value is above the maximum", () => {
    process.env[ENV_VAR] = "99";
    expect(resolvePerDealerRecordCap()).toBe(PER_DEALER_RECORD_CAP_MAX);
    expect(resolvePerDealerRecordCap()).toBe(80);
  });

  it("returns the default for a non-integer string", () => {
    process.env[ENV_VAR] = "not-a-number";
    expect(resolvePerDealerRecordCap()).toBe(PER_DEALER_RECORD_CAP_DEFAULT);
  });

  it("returns the default for an empty string", () => {
    process.env[ENV_VAR] = "";
    expect(resolvePerDealerRecordCap()).toBe(PER_DEALER_RECORD_CAP_DEFAULT);
  });

  it("returns MIN for boundary value 1", () => {
    process.env[ENV_VAR] = "1";
    expect(resolvePerDealerRecordCap()).toBe(1);
  });

  it("returns MAX for boundary value 80", () => {
    process.env[ENV_VAR] = "80";
    expect(resolvePerDealerRecordCap()).toBe(80);
  });
});

describe("constants", () => {
  it("PER_DEALER_RECORD_CAP_DEFAULT is 20", () => {
    expect(PER_DEALER_RECORD_CAP_DEFAULT).toBe(20);
  });

  it("PER_DEALER_RECORD_CAP_MIN is 1", () => {
    expect(PER_DEALER_RECORD_CAP_MIN).toBe(1);
  });

  it("PER_DEALER_RECORD_CAP_MAX is 80", () => {
    expect(PER_DEALER_RECORD_CAP_MAX).toBe(80);
  });
});
