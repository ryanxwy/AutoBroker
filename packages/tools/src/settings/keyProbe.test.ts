/**
 * keyProbe unit tests — the probe is STUBBED via the test seam, so these make
 * ZERO real external calls. Pins: a stubbed pass → {ok:true}; a stubbed fail →
 * {ok:false, detail}; the candidate value is passed through to the probe; an
 * unknown id / empty candidate is a failed probe (not a throw); and the global
 * fetch is never called (the stub seam is used).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetSecretsProbeForTests,
  __setSecretsProbeForTests,
  testKey,
} from "./keyProbe.js";

afterEach(() => {
  __resetSecretsProbeForTests();
  vi.restoreAllMocks();
});

describe("testKey (stubbed probe — no real external call)", () => {
  it("routes an LLM id to probeLlm and returns its pass result", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const probeLlm = vi.fn(async () => ({ ok: true, detail: "accepted" }));
    __setSecretsProbeForTests({ probeLlm });

    const res = await testKey("deepseek", "sk-candidate");
    expect(res).toEqual({ ok: true, detail: "accepted" });
    // the candidate value reached the probe verbatim.
    expect(probeLlm).toHaveBeenCalledWith("deepseek", "sk-candidate");
    // ZERO real external calls.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a failed probe result {ok:false, detail} unchanged", async () => {
    __setSecretsProbeForTests({
      probeLlm: async () => ({ ok: false, detail: "401 invalid key" }),
    });
    const res = await testKey("anthropic", "bad");
    expect(res).toEqual({ ok: false, detail: "401 invalid key" });
  });

  it("routes google_places to the geocode probe", async () => {
    const probeGeocode = vi.fn(async () => ({ ok: true, detail: "geocode OK" }));
    __setSecretsProbeForTests({ probeGeocode });
    const res = await testKey("google_places", "g-candidate");
    expect(res.ok).toBe(true);
    expect(probeGeocode).toHaveBeenCalledWith("g-candidate");
  });

  it("treats an unknown id as a failed probe (not a throw, no probe call)", async () => {
    const probeLlm = vi.fn();
    __setSecretsProbeForTests({ probeLlm });
    const res = await testKey("gemini", "x");
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("gemini");
    expect(probeLlm).not.toHaveBeenCalled();
  });

  it("treats an empty candidate as a failed probe", async () => {
    const probeLlm = vi.fn();
    __setSecretsProbeForTests({ probeLlm });
    const res = await testKey("openai", "");
    expect(res.ok).toBe(false);
    expect(probeLlm).not.toHaveBeenCalled();
  });

  it("claude_oauth: returns a presence-only ok:true result WITHOUT calling probeLlm or probeGeocode", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const probeLlm = vi.fn();
    const probeGeocode = vi.fn();
    __setSecretsProbeForTests({ probeLlm, probeGeocode });

    const res = await testKey("claude_oauth", "tok-oauth-value");
    expect(res.ok).toBe(true);
    // The presence detail must not leak the token value.
    expect(res.detail).not.toContain("tok-oauth-value");
    // No network probes invoked.
    expect(probeLlm).not.toHaveBeenCalled();
    expect(probeGeocode).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("claude_oauth with empty candidate → failed probe (same as other ids)", async () => {
    const probeLlm = vi.fn();
    __setSecretsProbeForTests({ probeLlm });
    const res = await testKey("claude_oauth", "");
    expect(res.ok).toBe(false);
    expect(probeLlm).not.toHaveBeenCalled();
  });
});
