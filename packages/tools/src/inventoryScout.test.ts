/**
 * Unit tests — inventory scout. The pure fingerprint table (likelySrpPath) and
 * the homepage→canned-path probe flow (resolveSrp). All HTTP goes through an
 * injected fake fetch; no real network.
 */

import { describe, expect, it } from "vitest";
import { likelySrpPath, resolveSrp } from "./inventoryScout.js";

const HOMEPAGE = "https://dealer.example.com";

function htmlWith(marker: string): string {
  return `<html><head><title>Example Dealer</title></head><body>${marker}</body></html>`;
}

interface RecordedCall {
  url: string;
  method: string;
}

/**
 * Fake fetch keyed by exact URL. Each route returns a Response (or an Error to
 * throw). Unrouted URLs fail loudly. Calls are recorded so tests can assert
 * which probes ran and that they were plain GETs.
 */
function makeFetch(routes: Record<string, () => Response | Error>): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    const route = routes[url];
    if (route === undefined) throw new Error(`unrouted fake-fetch URL: ${url}`);
    const out = route();
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { impl, calls };
}

describe("likelySrpPath", () => {
  it("maps a DealerOn homepage to /new-vehicles/", () => {
    expect(likelySrpPath(htmlWith("Powered by DealerOn"))).toBe("/new-vehicles/");
  });

  it("maps a DealerFire homepage to /new-inventory.htm", () => {
    expect(likelySrpPath(htmlWith("Powered by DealerFire"))).toBe("/new-inventory.htm");
  });

  it("maps a DealerInspire homepage to /new-vehicles/", () => {
    expect(likelySrpPath(htmlWith('<script src="https://cdn.dealerinspire.com/x.js">'))).toBe(
      "/new-vehicles/",
    );
  });

  it("maps a Dealer.com homepage to /new-inventory/index.htm", () => {
    expect(likelySrpPath(htmlWith('<script src="https://static.dealer.com/v9/main.js">'))).toBe(
      "/new-inventory/index.htm",
    );
  });

  it("matches the cobalt.com alternative of the Dealer.com fingerprint", () => {
    expect(likelySrpPath(htmlWith("assets.cobalt.com/loader"))).toBe(
      "/new-inventory/index.htm",
    );
  });

  it("prefers a specific platform over the broad last-row Dealer.com match", () => {
    // A DealerInspire page that ALSO mentions dealer.com must hit the
    // dealerinspire row — the broad dealercom fingerprint is checked last.
    const html = htmlWith("DealerInspire widgets, analytics via dealer.com");
    expect(likelySrpPath(html)).toBe("/new-vehicles/");
  });

  it("falls back to /new-inventory when no fingerprint matches", () => {
    expect(likelySrpPath(htmlWith("Family Owned Since 1972"))).toBe("/new-inventory");
  });
});

describe("resolveSrp", () => {
  it("returns the canned SRP URL when the fingerprint hits and the probe is a fresh 200", async () => {
    const srpUrl = `${HOMEPAGE}/new-vehicles/`;
    const { impl, calls } = makeFetch({
      [HOMEPAGE]: () => new Response(htmlWith("Powered by DealerOn"), { status: 200 }),
      [srpUrl]: () => new Response(htmlWith("42 new vehicles"), { status: 200 }),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toEqual({ srpUrl });
    expect(calls.map((c) => c.url)).toEqual([HOMEPAGE, srpUrl]);
    // Both probes are plain GETs — never HEAD (dealer sites 405 on HEAD).
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("probes the generic /new-inventory default when no fingerprint matches", async () => {
    const srpUrl = `${HOMEPAGE}/new-inventory`;
    const { impl } = makeFetch({
      [HOMEPAGE]: () => new Response(htmlWith("Family Owned Since 1972"), { status: 200 }),
      [srpUrl]: () => new Response(htmlWith("inventory"), { status: 200 }),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toEqual({ srpUrl });
  });

  it("returns null on a block-signature homepage and never probes further", async () => {
    const { impl, calls } = makeFetch({
      [HOMEPAGE]: () =>
        new Response("<title>Attention Required! | Cloudflare</title>", { status: 200 }),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null on a 403 homepage with an unrecognized body", async () => {
    const { impl, calls } = makeFetch({
      [HOMEPAGE]: () => new Response("nope", { status: 403 }),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null on a non-blocky homepage HTTP error without probing", async () => {
    const { impl, calls } = makeFetch({
      [HOMEPAGE]: () => new Response("server fell over", { status: 500 }),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when the canned-path probe is not a fresh 200", async () => {
    const srpUrl = `${HOMEPAGE}/new-vehicles/`;
    const { impl, calls } = makeFetch({
      [HOMEPAGE]: () => new Response(htmlWith("Powered by DealerOn"), { status: 200 }),
      [srpUrl]: () => new Response("not here", { status: 404 }),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toBeNull();
    expect(calls.map((c) => c.url)).toEqual([HOMEPAGE, srpUrl]);
  });

  it("returns null on a homepage network error", async () => {
    const { impl } = makeFetch({
      [HOMEPAGE]: () => new Error("connect ECONNREFUSED"),
    });

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toBeNull();
  });

  it("returns null when the homepage fetch aborts on timeout", async () => {
    // The fake observes that a timeout AbortSignal was wired in, then fails the
    // way an expired AbortSignal.timeout() does.
    let sawAbortSignal = false;
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawAbortSignal = init?.signal instanceof AbortSignal;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;

    await expect(resolveSrp(HOMEPAGE, { fetchImpl: impl })).resolves.toBeNull();
    expect(sawAbortSignal).toBe(true);
  });
});
