// @vitest-environment happy-dom
/**
 * DealerTiles.test — the presentational Dealers canvas section. Proves: the
 * clickable tile opens a portalled read-only detail modal (and Close dismisses
 * it), the "lead submitted" chip, pagination via usePagedList/Pager, the
 * empty/loading/error states, and that all existing testids remain intact.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { DealerList } from "../api/wire.js";
import { click, render } from "../test/render.js";
import { DealerTiles } from "./DealerTiles.js";

/** The detail modal portals to document.body — query it off the document. */
const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function ok(data: DealerList): AsyncState<DealerList> {
  return { kind: "ok", data };
}

function makeDealer(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    dealer_id: "dealer-1",
    name: "Jim Click Hyundai",
    address: "750 W Auto Mall Dr",
    city: "Tucson",
    state: "AZ",
    postal_code: "85705",
    phone: "(520) 555-0140",
    rating: 4.6,
    review_count: 312,
    distance_miles: 5.2,
    candidate_status: "bound",
    lead_submission_count: 1,
    website: "https://www.jimclickhyundai.com",
    ...overrides,
  };
}

describe("DealerTiles — empty / loading / error", () => {
  it("renders the empty sentinel when there are no dealers", () => {
    const { query } = render(<DealerTiles dealers={ok([])} />);
    expect(query("canvas-dealers-empty")).not.toBeNull();
  });

  it("renders a loading message", () => {
    const { container } = render(<DealerTiles dealers={{ kind: "loading" }} />);
    expect(container.textContent ?? "").toContain("Loading dealers");
  });

  it("renders an error in a role=alert element", () => {
    const { container } = render(
      <DealerTiles dealers={{ kind: "error", message: "boom", code: "fetch_failed" }} />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("boom");
  });
});

describe("DealerTiles — tile rendering", () => {
  it("renders one tile per dealer with the name + distance", () => {
    const { all, get } = render(<DealerTiles dealers={ok([makeDealer()])} />);
    expect(all("canvas-dealer-tile")).toHaveLength(1);
    expect(get("canvas-dealer-tile").textContent).toContain("Jim Click Hyundai");
    expect(get("canvas-dealer-tile").textContent).toContain("5.2 mi");
  });

  it("renders the 'lead submitted' chip when lead_submission_count > 0", () => {
    const { query } = render(<DealerTiles dealers={ok([makeDealer()])} />);
    expect(query("dealer-lead-submitted")).not.toBeNull();
  });

  it("omits the 'lead submitted' chip when lead_submission_count is 0", () => {
    const { query } = render(
      <DealerTiles dealers={ok([makeDealer({ lead_submission_count: 0 })])} />,
    );
    expect(query("dealer-lead-submitted")).toBeNull();
  });
});

describe("DealerTiles — give-up advisory chip", () => {
  it("renders 'consider switching' + the cheaper-elsewhere gap for give_up_switch (budget-free)", () => {
    const { query } = render(
      <DealerTiles
        dealers={ok([
          makeDealer({ verdict: "give_up_switch", verdict_reason: "silent", batna_gap_usd: 1000, lead_submission_count: 0 }),
        ])}
      />,
    );
    const chip = query("dealer-verdict-switch");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("consider switching");
    expect(chip!.textContent).toMatch(/\$[\d,]+ cheaper elsewhere/); // a dealer-side gap, never a budget
  });

  it("renders 'gone quiet' for a cold hold, and 'paused' for the anti-pester cap (never 'switching')", () => {
    const cold = render(
      <DealerTiles dealers={ok([makeDealer({ verdict: "hold", verdict_reason: "silent", lead_submission_count: 0 })])} />,
    );
    expect(cold.query("dealer-verdict-hold")!.textContent).toContain("gone quiet");
    expect(cold.query("dealer-verdict-switch")).toBeNull();

    const paused = render(
      <DealerTiles
        dealers={ok([makeDealer({ verdict: "hold", verdict_reason: "unanswered_cap", lead_submission_count: 0 })])}
      />,
    );
    expect(paused.query("dealer-verdict-hold")!.textContent).toContain("paused");
    expect(paused.query("dealer-verdict-switch")).toBeNull();

    const stuck = render(
      <DealerTiles dealers={ok([makeDealer({ verdict: "hold", verdict_reason: "non_improving", lead_submission_count: 0 })])} />,
    );
    expect(stuck.query("dealer-verdict-hold")!.textContent).toContain("not moving");
  });

  it("renders no verdict chip for an active dealer or one with no advisory", () => {
    const cont = render(
      <DealerTiles dealers={ok([makeDealer({ verdict: "continue", lead_submission_count: 0 })])} />,
    );
    expect(cont.query("dealer-verdict-switch")).toBeNull();
    expect(cont.query("dealer-verdict-hold")).toBeNull();

    const absent = render(<DealerTiles dealers={ok([makeDealer({ lead_submission_count: 0 })])} />);
    expect(absent.query("dealer-verdict-switch")).toBeNull();
    expect(absent.query("dealer-verdict-hold")).toBeNull();
  });
});

describe("DealerTiles — detail modal", () => {
  it("opens the portalled modal when a tile is clicked", () => {
    const r = render(<DealerTiles dealers={ok([makeDealer()])} />);
    expect(docQuery("modal-dialog")).toBeNull();

    click(r.get("canvas-dealer-tile"));

    const dialog = docQuery("modal-dialog");
    expect(dialog).not.toBeNull();
    expect(docQuery("dealer-detail-title")!.textContent).toBe("Jim Click Hyundai");
    expect(dialog!.textContent).toContain("(520) 555-0140");
    r.unmount();
  });

  it("closes the modal when Close is clicked", () => {
    const r = render(<DealerTiles dealers={ok([makeDealer()])} />);
    click(r.get("canvas-dealer-tile"));
    expect(docQuery("modal-dialog")).not.toBeNull();

    clickDoc(docQuery("dealer-detail-close")!);
    expect(docQuery("modal-dialog")).toBeNull();
    r.unmount();
  });
});

describe("DealerTiles — pagination", () => {
  it("renders no pager for 12 or fewer dealers", () => {
    const dealers = Array.from({ length: 12 }, (_, i) => makeDealer({ dealer_id: `d-${i}` }));
    const { query } = render(<DealerTiles dealers={ok(dealers)} />);
    expect(query("canvas-pager")).toBeNull();
  });

  it("renders a pager and limits to 12 per page for more than 12 dealers", () => {
    const dealers = Array.from({ length: 15 }, (_, i) => makeDealer({ dealer_id: `d-${i}` }));
    const { query, all } = render(<DealerTiles dealers={ok(dealers)} />);
    expect(query("canvas-pager")).not.toBeNull();
    expect(all("canvas-dealer-tile")).toHaveLength(12);
  });
});
