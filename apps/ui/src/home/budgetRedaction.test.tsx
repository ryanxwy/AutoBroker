// @vitest-environment happy-dom
/**
 * budgetRedaction.test — budget_max NEVER appears on a summary/preview surface
 * (budget red-line: budget_max is internal-only, never dealer-facing — see
 * CLAUDE.md). The SnapshotCard and the Canvas profile card consume the
 * dealer-SAFE ProfileSnapshot, which has no budget accessor, so even a profile
 * row carrying budget_max cannot leak it into rendered summary text — the
 * canvas renders budget only as the "internal-only" lock chip.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import { SnapshotCard } from "./SnapshotCard.js";
import { toSnapshot, SUMMARY_EXCLUDED_KEYS } from "./profileView.js";
import { ApiClient } from "../api/client.js";
import type { ProfileRow } from "../api/wire.js";
import { Canvas } from "../canvas/Canvas.js";
import { render } from "../test/render.js";

// A row WITH a budget value the user typed — it must never reach a summary.
const ROW_WITH_BUDGET: ProfileRow = {
  search_profile_id: "p1",
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  location_query: "Irvine, CA 92614",
  search_radius_miles: 25,
  financing_preference: "finance",
  dealer_count: 3,
  thread_count: 2,
  best_otd: 38990,
  budget_max: 42000, // INTERNAL_ONLY — must NOT render.
};

/** A mock fetch serving the two reads the Canvas makes. */
function canvasFetch(): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/dealers")) return json([]);
    if (url.includes("/api/profiles")) return json([ROW_WITH_BUDGET]);
    return json([]);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("budget redaction — summary surfaces", () => {
  it("SUMMARY_EXCLUDED_KEYS lists budget_max", () => {
    expect(SUMMARY_EXCLUDED_KEYS).toContain("budget_max");
  });

  it("the snapshot projection drops budget entirely", () => {
    const snap = toSnapshot(ROW_WITH_BUDGET) as unknown as Record<string, unknown>;
    expect(snap["budget_max"]).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain("42000");
  });

  it("SnapshotCard renders no budget value (the 42000 never appears)", () => {
    const r = render(<SnapshotCard snapshot={toSnapshot(ROW_WITH_BUDGET)} />);
    expect(r.get("snapshot-card").textContent).not.toContain("42000");
    expect(r.get("snapshot-card").textContent).not.toContain("42,000");
    // the dealer-safe values DO render.
    expect(r.get("snapshot-vehicle").textContent).toContain("Tucson Hybrid");
    r.unmount();
  });

  it("the Canvas profile card renders no budget value — only the lock chip", async () => {
    const client = new ApiClient({ fetchImpl: canvasFetch() });
    const r = render(<Canvas client={client} onStartIntake={() => {}} />);
    await flush();
    const card = r.get("canvas-profile-card");
    expect(card.textContent).not.toContain("42000");
    expect(card.textContent).not.toContain("42,000");
    expect(card.textContent).toContain("internal-only");
    expect(r.get("canvas-vehicle").textContent).toContain("Tucson Hybrid");
    r.unmount();
  });
});
