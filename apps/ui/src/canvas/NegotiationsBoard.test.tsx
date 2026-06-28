// @vitest-environment happy-dom
/**
 * NegotiationsBoard.test — the per-dealership negotiation board on the canvas
 * Negotiations tab. Proves: one card per dealer with the per-metric testids
 * carrying the right values (emails / quote-sent / best OTD / best discount), the
 * status chip + give-up verdict chip, the actionability sort (countered/stalled
 * first), the "needs you now" accent on the top cards, the empty wait-state copy,
 * and that no bare id / budget surfaces.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type {
  DealerNegotiationDetail,
  DealerNegotiationList,
  DealerNegotiationRow,
} from "../api/wire.js";
import { click, render } from "../test/render.js";
import { NegotiationsBoard } from "./NegotiationsBoard.js";

/** Query a (portaled) modal node off the document, not the render container. */
const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Dispatch the two other dismiss paths the bug report cited (both route to onClose). */
function escape(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}
function mousedown(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

function makeDetail(overrides: Partial<DealerNegotiationDetail> = {}): DealerNegotiationDetail {
  return {
    dealer_id: "d-1",
    name: "Jim Click Hyundai",
    city: "Tucson",
    state: "AZ",
    website: "https://jimclick.example",
    negotiation_status: "countered",
    email_count: 6,
    quote_sent: true,
    best_competing_otd: 41000,
    batna_gap_usd: 2210,
    status_line: "The dealer countered; you are $2,210 above the best competing quote.",
    strategy: "Hold firm.",
    next_steps: ["Reply asking them to beat $41,000 OTD."],
    contacts: [],
    replies: [],
    ...overrides,
  };
}

function ok(data: DealerNegotiationList): AsyncState<DealerNegotiationList> {
  return { kind: "ok", data };
}

function makeRow(overrides: Partial<DealerNegotiationRow> = {}): DealerNegotiationRow {
  return {
    dealer_id: "d-1",
    name: "Jim Click Hyundai",
    city: "Tucson",
    state: "AZ",
    candidate_status: "bound",
    lead_submission_count: 1,
    email_count: 5,
    extract_failed_count: 0,
    quote_sent: true,
    best_otd: 43210,
    best_discount: 2500,
    negotiation_status: "quoted",
    ...overrides,
  };
}

describe("NegotiationsBoard — empty wait state", () => {
  it("renders the wait-copy naming the contacted-dealer count", () => {
    const { container } = render(<NegotiationsBoard negotiations={ok([])} dealerCount={3} />);
    const empty = container.querySelector('[data-testid="canvas-negotiations-empty"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("3");
  });
});

describe("NegotiationsBoard — cards + metrics", () => {
  it("renders one card per dealer inside the grid", () => {
    const { container } = render(
      <NegotiationsBoard
        negotiations={ok([makeRow(), makeRow({ dealer_id: "d-2", name: "Second" })])}
        dealerCount={2}
      />,
    );
    expect(container.querySelector('[data-testid="canvas-negotiation-grid"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="canvas-negotiation-card"]')).toHaveLength(2);
  });

  it("renders each per-metric testid with the correct value", () => {
    const { container } = render(
      <NegotiationsBoard negotiations={ok([makeRow()])} dealerCount={1} />,
    );
    expect(container.querySelector('[data-testid="canvas-negotiation-email-count"]')!.textContent).toContain("5");
    expect(container.querySelector('[data-testid="canvas-negotiation-quote-sent"]')!.textContent!.toLowerCase()).toContain("yes");
    expect(container.querySelector('[data-testid="canvas-negotiation-otd"]')!.textContent).toContain("$43,210");
    expect(container.querySelector('[data-testid="canvas-negotiation-discount"]')!.textContent).toContain("$2,500");
  });

  it("shows '—' for a null OTD / discount without fabricating a number", () => {
    const { container } = render(
      <NegotiationsBoard
        negotiations={ok([makeRow({ best_otd: null, best_discount: null, quote_sent: false })])}
        dealerCount={1}
      />,
    );
    expect(container.querySelector('[data-testid="canvas-negotiation-otd"]')!.textContent).toContain("—");
    expect(container.querySelector('[data-testid="canvas-negotiation-discount"]')!.textContent).toContain("—");
    expect(container.querySelector('[data-testid="canvas-negotiation-quote-sent"]')!.textContent!.toLowerCase()).toContain("no");
  });

  it("renders the dealer name + status chip, never the bare dealer_id", () => {
    const { container } = render(
      <NegotiationsBoard negotiations={ok([makeRow({ negotiation_status: "countered" })])} dealerCount={1} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Jim Click Hyundai");
    expect(text).toContain("countered");
    expect(text).not.toContain("d-1");
  });

  it("lights the extract-failed badge when extract_failed_count > 0, and not when 0", () => {
    const failed = render(
      <NegotiationsBoard
        negotiations={ok([makeRow({ extract_failed_count: 1 })])}
        dealerCount={1}
      />,
    );
    expect(
      failed.container.querySelector('[data-testid="message-extract-failed-badge"]'),
    ).not.toBeNull();

    const clean = render(
      <NegotiationsBoard negotiations={ok([makeRow({ extract_failed_count: 0 })])} dealerCount={1} />,
    );
    expect(
      clean.container.querySelector('[data-testid="message-extract-failed-badge"]'),
    ).toBeNull();
  });

  it("renders the give-up verdict chip (consider switching + the BATNA gap, no competitor name)", () => {
    const { container } = render(
      <NegotiationsBoard
        negotiations={ok([makeRow({ verdict: "give_up_switch", batna_gap_usd: 1800 })])}
        dealerCount={1}
      />,
    );
    const chip = container.querySelector('[data-testid="negotiation-verdict-switch"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("$1,800");
  });
});

describe("NegotiationsBoard — actionability sort + accent", () => {
  it("sorts countered/stalled cards to the top (rank asc), regardless of input order", () => {
    const rows: DealerNegotiationList = [
      makeRow({ dealer_id: "d-quoted", name: "Quoted Co", negotiation_status: "quoted" }),
      makeRow({ dealer_id: "d-dormant", name: "Dormant Co", negotiation_status: "dormant" }),
      makeRow({ dealer_id: "d-countered", name: "Countered Co", negotiation_status: "countered" }),
      makeRow({ dealer_id: "d-stalled", name: "Stalled Co", negotiation_status: "stalled" }),
    ];
    const { container } = render(<NegotiationsBoard negotiations={ok(rows)} dealerCount={4} />);
    const names = [...container.querySelectorAll('[data-testid="canvas-negotiation-card"]')].map(
      (c) => c.querySelector("h3")?.textContent ?? "",
    );
    expect(names).toEqual(["Countered Co", "Stalled Co", "Quoted Co", "Dormant Co"]);
  });

  it("breaks a rank tie by batna_gap_usd descending", () => {
    const rows: DealerNegotiationList = [
      makeRow({ dealer_id: "d-a", name: "Small Gap", negotiation_status: "countered", batna_gap_usd: 200 }),
      makeRow({ dealer_id: "d-b", name: "Big Gap", negotiation_status: "countered", batna_gap_usd: 5000 }),
    ];
    const { container } = render(<NegotiationsBoard negotiations={ok(rows)} dealerCount={2} />);
    const names = [...container.querySelectorAll('[data-testid="canvas-negotiation-card"]')].map(
      (c) => c.querySelector("h3")?.textContent ?? "",
    );
    expect(names).toEqual(["Big Gap", "Small Gap"]);
  });

  it("gives the top (countered/stalled) cards the 'needs you now' accent, others not", () => {
    const rows: DealerNegotiationList = [
      makeRow({ dealer_id: "d-countered", name: "Countered Co", negotiation_status: "countered" }),
      makeRow({ dealer_id: "d-quoted", name: "Quoted Co", negotiation_status: "quoted" }),
    ];
    const { container } = render(<NegotiationsBoard negotiations={ok(rows)} dealerCount={2} />);
    const cards = [...container.querySelectorAll('[data-testid="canvas-negotiation-card"]')];
    expect(cards[0]!.className).toContain("negotiation-needs-you");
    expect(cards[1]!.className).not.toContain("negotiation-needs-you");
  });
});

describe("NegotiationsBoard — loading / error", () => {
  it("renders a loading line", () => {
    const { container } = render(
      <NegotiationsBoard negotiations={{ kind: "loading" }} dealerCount={0} />,
    );
    expect(container.textContent).toContain("Loading");
  });

  it("renders an error line", () => {
    const { container } = render(
      <NegotiationsBoard
        negotiations={{ kind: "error", message: "boom", code: "x" }}
        dealerCount={0}
      />,
    );
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("boom");
  });
});

describe("NegotiationsBoard — open/close lifecycle (openId is authoritative)", () => {
  it("opens the detail modal on a card click and CLOSES it on Close — even though the detail cache stays 'ok'", async () => {
    const r = render(
      <NegotiationsBoard
        negotiations={ok([makeRow()])}
        dealerCount={1}
        fetchDetail={() => Promise.resolve(makeDetail())}
      />,
    );

    // Open: click the card, let the detail fetch resolve → modal present.
    click(r.get("canvas-negotiation-card"));
    await flush();
    expect(docQuery("negotiation-detail-modal")).not.toBeNull();

    // Close: the stale-while-revalidate detail cache stays {kind:"ok"} after the
    // card closes, so a modal gated on detail.kind alone would never dismiss.
    // Gating on openId makes Close truly close.
    click(docQuery("negotiation-detail-close")!);
    await flush();
    expect(docQuery("negotiation-detail-modal")).toBeNull();
    expect(docQuery("modal-backdrop")).toBeNull();

    r.unmount();
  });

  it("Escape and a backdrop click also dismiss the modal (the other two reported paths)", async () => {
    const r = render(
      <NegotiationsBoard
        negotiations={ok([makeRow()])}
        dealerCount={1}
        fetchDetail={() => Promise.resolve(makeDetail())}
      />,
    );

    // Escape.
    click(r.get("canvas-negotiation-card"));
    await flush();
    expect(docQuery("negotiation-detail-modal")).not.toBeNull();
    escape(docQuery("modal-dialog")!);
    await flush();
    expect(docQuery("negotiation-detail-modal")).toBeNull();

    // Backdrop click (re-open first).
    click(r.get("canvas-negotiation-card"));
    await flush();
    expect(docQuery("negotiation-detail-modal")).not.toBeNull();
    mousedown(docQuery("modal-backdrop")!);
    await flush();
    expect(docQuery("negotiation-detail-modal")).toBeNull();

    r.unmount();
  });

  it("does NOT flash a prior dealer's stale detail when reopening a DIFFERENT card before its fetch resolves", async () => {
    // d-1 resolves immediately; d-2's fetch is held pending so the stale-while-
    // revalidate cache still holds d-1's detail while d-2 is openId. The
    // dealer_id === openId guard must keep d-1's detail off-screen.
    let resolveD2: (() => void) | null = null;
    const fetchDetail = (id: string): Promise<DealerNegotiationDetail> => {
      if (id === "d-2") {
        return new Promise((res) => {
          resolveD2 = () => res(makeDetail({ dealer_id: "d-2", name: "Second Motors" }));
        });
      }
      return Promise.resolve(makeDetail({ dealer_id: "d-1", name: "Jim Click Hyundai" }));
    };
    const r = render(
      <NegotiationsBoard
        negotiations={ok([makeRow(), makeRow({ dealer_id: "d-2", name: "Second Motors" })])}
        dealerCount={2}
        fetchDetail={fetchDetail}
      />,
    );
    const cardOf = (name: string): HTMLElement =>
      r.all("canvas-negotiation-card").find((c) => (c.textContent ?? "").includes(name))!;

    // Open d-1, then close.
    click(cardOf("Jim Click Hyundai"));
    await flush();
    expect(docQuery("negotiation-detail-title")!.textContent).toBe("Jim Click Hyundai");
    click(docQuery("negotiation-detail-close")!);
    await flush();

    // Open d-2: its fetch is pending, so `detail` still holds d-1 (SWR). The modal
    // must NOT show d-1's title (no stale flash) — it stays closed until d-2 lands.
    click(cardOf("Second Motors"));
    await flush();
    expect(docQuery("negotiation-detail-title")).toBeNull();

    // Resolve d-2 → the modal opens on the CORRECT dealer.
    act(() => resolveD2!());
    await flush();
    expect(docQuery("negotiation-detail-title")!.textContent).toBe("Second Motors");

    r.unmount();
  });

  it("does NOT re-open a closed modal when the board re-renders on a data refresh", async () => {
    const r = render(
      <NegotiationsBoard
        negotiations={ok([makeRow()])}
        dealerCount={1}
        fetchDetail={() => Promise.resolve(makeDetail())}
      />,
    );
    click(r.get("canvas-negotiation-card"));
    await flush();
    click(docQuery("negotiation-detail-close")!);
    await flush();
    expect(docQuery("negotiation-detail-modal")).toBeNull();

    // A data.changed pulse re-renders the board with refreshed rows; the closed
    // modal must stay closed (no card was re-clicked).
    r.rerender(
      <NegotiationsBoard
        negotiations={ok([makeRow({ email_count: 8 })])}
        dealerCount={1}
        fetchDetail={() => Promise.resolve(makeDetail({ email_count: 8 }))}
      />,
    );
    await flush();
    expect(docQuery("negotiation-detail-modal")).toBeNull();

    r.unmount();
  });
});
