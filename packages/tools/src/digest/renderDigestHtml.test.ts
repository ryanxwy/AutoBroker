import { describe, expect, it } from "vitest";

import { assertNoBudget } from "../validators.js";
import type { DigestPayload } from "./generateDigest.js";
import { renderDigestHtml } from "./renderDigestHtml.js";

function payload(): DigestPayload {
  return {
    state: "ok",
    generatedAtMs: 1_750_000_000_000,
    sinceHours: null,
    profiles: [
      {
        searchProfileId: "profile-1",
        vehicle: '<img src=x onerror="alert(1)"> Tucson',
        dealerCount: 1,
        boundDealerCount: 1,
        threadCount: 1,
        needsResponseCount: 1,
        unansweredQuestionCount: 0,
        offers: [
          {
            quoteId: "quote-1",
            dealerId: "dealer-1",
            dealerName: "A&B </li><script>alert(1)</script>",
            otdTotal: 38_000,
            financingMode: 'cash" autofocus onfocus="alert(1)',
            freshness: "fresh",
          },
        ],
        totalQuotes: 1,
        bestOtd: 38_000,
        freshnessMix: { fresh: 1, stale: 0, missing: 0 },
      },
    ],
    nextActions: [
      {
        kind: "needs_response",
        profileId: "profile-1",
        vehicle: "Tucson",
        count: 1,
        label: "Review <svg onload=alert(1)> & reply",
      },
    ],
    overallBestOtd: 38_000,
  };
}

describe("renderDigestHtml", () => {
  it("renders a standalone CSP snapshot and escapes every payload string", () => {
    const html = renderDigestHtml(payload());

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("A&amp;B &lt;/li&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("cash&quot; autofocus onfocus=&quot;alert(1)");
    expect(html).toContain("Review &lt;svg onload=alert(1)&gt; &amp; reply");
    expect(() => assertNoBudget(html)).not.toThrow();
  });

  it("returns no snapshot for the zero-active path", () => {
    const empty = payload();
    empty.state = "_NO_ACTIVE_SEARCHES";
    empty.profiles = [];
    expect(renderDigestHtml(empty)).toBe("");
  });
});
