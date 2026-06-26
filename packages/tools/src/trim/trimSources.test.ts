/**
 * trimSources tests — the read-only web trim lookup, driven entirely through an
 * injected fetchImpl + resolveHost so NO real network is touched. Focus: the
 * SSRF posture (allowlist, uddg decode, manual-redirect re-validation) + the
 * resolved/none failure taxonomy.
 */
import { describe, expect, it } from "vitest";

import { fetchTrimSources } from "./trimSources.js";

/** A minimal fetch Response stand-in (only the members the tool reads). */
function resp(status: number, body: string, location?: string): unknown {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "location" ? location ?? null : null) },
    text: async () => body,
  };
}

/** Public-IP resolver so validateSourceUrl never hits DNS in the test. */
const publicResolver = async (): Promise<string[]> => ["93.184.216.34"];

const TRIM_BODY =
  "<html><body><h1>2026 Honda Civic Trims</h1>" +
  "<p>The 2026 Honda Civic is offered in LX, Sport, Sport Hybrid, and Sport Touring Hybrid trims. " +
  "The LX is the base trim with a 2.0L engine and a 7-inch touchscreen. The Sport adds sport styling, " +
  "leather-trimmed seats, an 8-way power driver seat, and 18-inch wheels. The Sport Hybrid uses the " +
  "200-horsepower hybrid powertrain with heated front seats. The Sport Touring Hybrid is the top trim " +
  "with a 9-inch Google built-in touchscreen, a 12-speaker Bose system, and leather seating.</p>" +
  "</body></html>";

/** Build a DDG result page HTML linking the given organic URLs. */
function ddgHtml(urls: string[]): string {
  return urls
    .map((u) => `<a class="result__a" href="${u}">result</a>`)
    .join("\n");
}

describe("fetchTrimSources", () => {
  it("resolved: fetches the trusted seed page and returns its text", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("duckduckgo.com")) return resp(200, ddgHtml([]));
      if (url.includes("caranddriver.com")) return resp(200, TRIM_BODY);
      return resp(404, "");
    }) as unknown as typeof fetch;

    const r = await fetchTrimSources(
      { make: "Honda", model: "Civic", year: 2026 },
      { fetchImpl, resolveHost: publicResolver },
    );
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.text).toContain("Sport Touring");
    expect(r.sources.some((s) => s.includes("caranddriver.com"))).toBe(true);
  });

  it("allowlist: a non-allowlisted organic result is NEVER fetched (SSRF)", async () => {
    const touched: string[] = [];
    const fetchImpl = (async (url: string) => {
      touched.push(url);
      if (url.includes("duckduckgo.com")) {
        // DDG surfaces an attacker host + a trusted host
        return resp(200, ddgHtml(["https://evil.example.com/trims", "https://www.edmunds.com/honda/civic/2026/trims/"]));
      }
      if (url.includes("caranddriver.com")) return resp(404, "");
      if (url.includes("edmunds.com")) return resp(200, TRIM_BODY);
      return resp(404, "");
    }) as unknown as typeof fetch;

    const r = await fetchTrimSources(
      { make: "Honda", model: "Civic", year: 2026 },
      { fetchImpl, resolveHost: publicResolver },
    );
    // evil.example.com is NOT on the allowlist → never fetched.
    expect(touched.some((u) => u.includes("evil.example.com"))).toBe(false);
    expect(r.kind).toBe("resolved");
  });

  it("uddg: decodes the DuckDuckGo redirect wrapper to the real (allowlisted) target", async () => {
    const target = "https://www.edmunds.com/honda/civic/2026/trims/";
    const wrapped = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
    let fetchedEdmunds = false;
    const fetchImpl = (async (url: string) => {
      if (url.includes("html.duckduckgo.com")) return resp(200, ddgHtml([wrapped]));
      if (url.includes("caranddriver.com")) return resp(404, "");
      if (url === target) { fetchedEdmunds = true; return resp(200, TRIM_BODY); }
      return resp(404, "");
    }) as unknown as typeof fetch;

    const r = await fetchTrimSources(
      { make: "Honda", model: "Civic", year: 2026 },
      { fetchImpl, resolveHost: publicResolver },
    );
    expect(fetchedEdmunds).toBe(true);
    expect(r.kind).toBe("resolved");
  });

  it("redirect: a trusted page redirecting to a NON-allowlisted host is NOT followed", async () => {
    const touched: string[] = [];
    const fetchImpl = (async (url: string) => {
      touched.push(url);
      if (url.includes("duckduckgo.com")) return resp(200, ddgHtml([]));
      if (url.includes("caranddriver.com")) return resp(302, "", "https://internal.evil.example/secret");
      return resp(404, "");
    }) as unknown as typeof fetch;

    const r = await fetchTrimSources(
      { make: "Honda", model: "Civic", year: 2026 },
      { fetchImpl, resolveHost: publicResolver },
    );
    // The redirect target host is not allowlisted → the hop is dropped, not fetched.
    expect(touched.some((u) => u.includes("internal.evil.example"))).toBe(false);
    expect(r.kind).toBe("none");
  });

  it("none: every source unreachable → kind none (never throws, never blocks intake)", async () => {
    const fetchImpl = (async () => resp(404, "")) as unknown as typeof fetch;
    const r = await fetchTrimSources(
      { make: "Honda", model: "Civic", year: 2026 },
      { fetchImpl, resolveHost: publicResolver },
    );
    expect(r.kind).toBe("none");
  });

  it("failed-fetch on the search is non-fatal (falls back to the fixed seed)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("duckduckgo.com")) throw new Error("network down");
      if (url.includes("caranddriver.com")) return resp(200, TRIM_BODY);
      return resp(404, "");
    }) as unknown as typeof fetch;
    const r = await fetchTrimSources(
      { make: "Honda", model: "Civic", year: 2026 },
      { fetchImpl, resolveHost: publicResolver },
    );
    expect(r.kind).toBe("resolved");
  });
});
