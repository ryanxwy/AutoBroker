// @vitest-environment happy-dom
/**
 * Incentives.test — the presentational Incentives canvas section. Proves: the
 * clickable row opens a portalled read-only detail modal (and Close dismisses
 * it), the amount/eligibility/expiry inner fields, the empty/loading/error
 * states, and that all existing testids remain intact.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { IncentiveList } from "../api/wire.js";
import { click, render } from "../test/render.js";
import { Incentives } from "./Incentives.js";

/** The detail modal portals to document.body — query it off the document. */
const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function ok(data: IncentiveList): AsyncState<IncentiveList> {
  return { kind: "ok", data };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    type: "Customer Cash",
    amount: 2500,
    expires: "2026-07-31",
    eligibility: "All buyers",
    scrape_source_url: "https://www.hyundaiusa.com/offers",
    scraped_at: "2026-06-15T12:00:00Z",
    ...overrides,
  };
}

describe("Incentives — empty / loading / error", () => {
  it("renders the empty sentinel when there are no incentives", () => {
    const { query } = render(<Incentives incentives={ok([])} />);
    expect(query("canvas-incentives-empty")).not.toBeNull();
  });

  it("renders a loading message", () => {
    const { container } = render(<Incentives incentives={{ kind: "loading" }} />);
    expect(container.textContent ?? "").toContain("Loading incentives");
  });

  it("renders an error in a role=alert element", () => {
    const { container } = render(
      <Incentives incentives={{ kind: "error", message: "boom", code: "fetch_failed" }} />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("boom");
  });
});

describe("Incentives — row rendering", () => {
  it("renders one row per incentive with type/amount/eligibility/expiry", () => {
    const { all, get } = render(<Incentives incentives={ok([makeRow()] as IncentiveList)} />);
    expect(all("canvas-incentive-row")).toHaveLength(1);
    expect(get("canvas-incentive-type").textContent).toBe("Customer Cash");
    expect(get("canvas-incentive-amount").textContent).toBe("$2,500");
    expect(get("canvas-incentive-eligibility").textContent).toBe("All buyers");
    expect(get("canvas-incentive-expiry").textContent).toContain("expires 2026-07-31");
  });
});

describe("Incentives — detail modal", () => {
  it("opens the portalled modal when a row is clicked", () => {
    const r = render(<Incentives incentives={ok([makeRow()] as IncentiveList)} />);
    expect(docQuery("modal-dialog")).toBeNull();

    click(r.get("canvas-incentive-row"));

    const dialog = docQuery("modal-dialog");
    expect(dialog).not.toBeNull();
    expect(docQuery("incentive-detail-title")!.textContent).toBe("Customer Cash");
    expect(dialog!.textContent).toContain("$2,500");
    r.unmount();
  });

  it("closes the modal when Close is clicked", () => {
    const r = render(<Incentives incentives={ok([makeRow()] as IncentiveList)} />);
    click(r.get("canvas-incentive-row"));
    expect(docQuery("modal-dialog")).not.toBeNull();

    clickDoc(docQuery("incentive-detail-close")!);
    expect(docQuery("modal-dialog")).toBeNull();
    r.unmount();
  });
});
