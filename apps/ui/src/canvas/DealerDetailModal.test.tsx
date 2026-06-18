// @vitest-environment happy-dom
/**
 * DealerDetailModal.test — the read-only dealer detail surface a buyer opens by
 * clicking a Dealer tile. Proves: the full address, the tel: phone link, the
 * rating + reviews, the "lead submitted" chip, and the external website link
 * (href/target/rel). Omitted fields (null website/phone) render no row. NEVER a
 * budget, NEVER a bare dealer_id. (Portaled to document.body → queried off it.)
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { DealerRow } from "../api/wire.js";
import { render } from "../test/render.js";
import { DealerDetailModal } from "./DealerDetailModal.js";

const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): DealerRow {
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

describe("DealerDetailModal", () => {
  it("renders nothing visible when row is null", () => {
    render(<DealerDetailModal row={null} onClose={() => {}} />);
    expect(docQuery("modal-dialog")).toBeNull();
  });

  it("shows the dealer name as the title", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    expect(docQuery("dealer-detail-title")!.textContent).toBe("Jim Click Hyundai");
    r.unmount();
  });

  it("joins the full address from the address parts", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    const modal = docQuery("dealer-detail-modal")!;
    expect(modal.textContent).toContain("750 W Auto Mall Dr, Tucson, AZ, 85705");
    r.unmount();
  });

  it("renders the phone as a tel: link (NOT target=_blank)", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    const phone = docQuery("dealer-detail-phone");
    expect(phone).not.toBeNull();
    expect(phone!.getAttribute("href")).toBe("tel:(520) 555-0140");
    expect(phone!.getAttribute("target")).toBeNull();
    r.unmount();
  });

  it("renders the rating + review count", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    const modal = docQuery("dealer-detail-modal")!;
    expect(modal.textContent).toContain("4.6 ★");
    expect(modal.textContent).toContain("312 reviews");
    r.unmount();
  });

  it("renders the 'lead submitted' chip when lead_submission_count > 0", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    expect(docQuery("dealer-detail-modal")!.textContent).toContain("lead submitted");
    r.unmount();
  });

  it("renders the website link with href/target/rel", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    const link = docQuery("dealer-detail-website");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://www.jimclickhyundai.com");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toContain("noopener");
    r.unmount();
  });

  it("omits the website link when website is null", () => {
    const r = render(<DealerDetailModal row={makeRow({ website: null })} onClose={() => {}} />);
    expect(docQuery("dealer-detail-website")).toBeNull();
    r.unmount();
  });

  it("omits the website link when website is not an http(s) string", () => {
    const r = render(
      <DealerDetailModal row={makeRow({ website: "ftp://x" })} onClose={() => {}} />,
    );
    expect(docQuery("dealer-detail-website")).toBeNull();
    r.unmount();
  });

  it("omits the phone row when phone is null", () => {
    const r = render(<DealerDetailModal row={makeRow({ phone: null })} onClose={() => {}} />);
    expect(docQuery("dealer-detail-phone")).toBeNull();
    r.unmount();
  });

  it("omits the rating when rating is null", () => {
    const r = render(<DealerDetailModal row={makeRow({ rating: null })} onClose={() => {}} />);
    expect(docQuery("dealer-detail-modal")!.textContent).not.toContain("★");
    r.unmount();
  });

  it("falls back to 'Dealer' when name is null", () => {
    const r = render(<DealerDetailModal row={makeRow({ name: null })} onClose={() => {}} />);
    expect(docQuery("dealer-detail-title")!.textContent).toBe("Dealer");
    r.unmount();
  });

  it("never renders the bare dealer_id", () => {
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => {}} />);
    expect(docQuery("dealer-detail-modal")!.textContent).not.toContain("dealer-1");
    r.unmount();
  });

  it("Close button calls onClose", () => {
    let closed = false;
    const r = render(<DealerDetailModal row={makeRow()} onClose={() => (closed = true)} />);
    clickDoc(docQuery("dealer-detail-close")!);
    expect(closed).toBe(true);
    r.unmount();
  });
});
