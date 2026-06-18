// @vitest-environment happy-dom
/**
 * IncentiveDetailModal.test — the read-only manufacturer-incentive detail surface
 * a buyer opens by clicking an Incentive row. Proves: the amount chip, the
 * eligibility, the expiry, the captured-at line, and the external source link
 * (href/target/rel). A null source renders no link. NEVER a budget, NEVER a bare
 * id. (Portaled to document.body → queried off it.)
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { IncentiveRow } from "../api/wire.js";
import { render } from "../test/render.js";
import { IncentiveDetailModal } from "./IncentiveDetailModal.js";

const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function makeRow(overrides: Partial<IncentiveRow> = {}): IncentiveRow {
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

describe("IncentiveDetailModal", () => {
  it("renders nothing visible when row is null", () => {
    render(<IncentiveDetailModal row={null} onClose={() => {}} />);
    expect(docQuery("modal-dialog")).toBeNull();
  });

  it("shows the type as the title", () => {
    const r = render(<IncentiveDetailModal row={makeRow()} onClose={() => {}} />);
    expect(docQuery("incentive-detail-title")!.textContent).toBe("Customer Cash");
    r.unmount();
  });

  it("renders the amount, eligibility, and expiry", () => {
    const r = render(<IncentiveDetailModal row={makeRow()} onClose={() => {}} />);
    const modal = docQuery("incentive-detail-modal")!;
    expect(modal.textContent).toContain("$2,500");
    expect(modal.textContent).toContain("All buyers");
    expect(modal.textContent).toContain("expires 2026-07-31");
    r.unmount();
  });

  it("renders the captured-at line when scraped_at is present", () => {
    const r = render(<IncentiveDetailModal row={makeRow()} onClose={() => {}} />);
    expect(docQuery("incentive-detail-modal")!.textContent).toContain("captured");
    r.unmount();
  });

  it("renders the source link with href/target/rel", () => {
    const r = render(<IncentiveDetailModal row={makeRow()} onClose={() => {}} />);
    const link = docQuery("incentive-detail-source");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://www.hyundaiusa.com/offers");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toContain("noopener");
    r.unmount();
  });

  it("omits the source link when scrape_source_url is null", () => {
    const r = render(
      <IncentiveDetailModal row={makeRow({ scrape_source_url: null })} onClose={() => {}} />,
    );
    expect(docQuery("incentive-detail-source")).toBeNull();
    r.unmount();
  });

  it("omits the source link when scrape_source_url is not http(s)", () => {
    const r = render(
      <IncentiveDetailModal row={makeRow({ scrape_source_url: "javascript:void" })} onClose={() => {}} />,
    );
    expect(docQuery("incentive-detail-source")).toBeNull();
    r.unmount();
  });

  it("omits the amount chip when amount is null", () => {
    const r = render(<IncentiveDetailModal row={makeRow({ amount: null })} onClose={() => {}} />);
    expect(docQuery("incentive-detail-modal")!.textContent).not.toContain("$");
    r.unmount();
  });

  it("falls back to 'Incentive' when type is null", () => {
    const r = render(<IncentiveDetailModal row={makeRow({ type: null })} onClose={() => {}} />);
    expect(docQuery("incentive-detail-title")!.textContent).toBe("Incentive");
    r.unmount();
  });

  it("Close button calls onClose", () => {
    let closed = false;
    const r = render(<IncentiveDetailModal row={makeRow()} onClose={() => (closed = true)} />);
    clickDoc(docQuery("incentive-detail-close")!);
    expect(closed).toBe(true);
    r.unmount();
  });
});
