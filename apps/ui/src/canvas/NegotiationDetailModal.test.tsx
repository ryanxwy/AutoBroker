// @vitest-environment happy-dom
/**
 * NegotiationDetailModal.test — the read-only per-dealer negotiation detail the
 * buyer opens by clicking a board card. Proves the section presence + ORDER
 * (title → contacts → status summary → strategy → next steps → competing →
 * replies → footer), the title-omitted-when-null branch, contacts with a mailto
 * + role (role row omitted when null), the competing $ figure WITHOUT a competitor
 * name, replies newest-first with an ABSOLUTE timestamp on a numeric received_at,
 * the null-content reply drop, and the lazy LLM-summary that degrades to the
 * deterministic status_line. NEVER a budget, NEVER a bare id. (Portaled → queried
 * off document.)
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import type { DealerNegotiationDetail, DealerNegotiationSummary } from "../api/wire.js";
import { render } from "../test/render.js";
import { NegotiationDetailModal } from "./NegotiationDetailModal.js";

const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const docAll = (testId: string): HTMLElement[] =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)) as HTMLElement[];

function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeDetail(overrides: Partial<DealerNegotiationDetail> = {}): DealerNegotiationDetail {
  return {
    dealer_id: "d-1",
    name: "Jim Click Hyundai",
    city: "Tucson",
    state: "AZ",
    negotiation_status: "countered",
    email_count: 6,
    quote_sent: true,
    best_competing_otd: 41000,
    batna_gap_usd: 2210,
    status_line: "The dealer countered; you are $2,210 above the best competing quote.",
    strategy: "Hold firm and ask them to match the best competing out-the-door price.",
    next_steps: ["Reply asking them to beat $41,000 OTD.", "Give them 48 hours."],
    contacts: [
      {
        contact_id: "c-1",
        display_name: "Pat Seller",
        email: "pat@jimclick.example",
        role: "sales manager",
        is_primary_reply_target: true,
      },
    ],
    replies: [
      {
        message_id: "m-old",
        sender_name: "Pat Seller",
        sender_email: "pat@jimclick.example",
        subject: "Re: Tucson availability",
        body_excerpt: "We can do $43,000 out the door.",
        received_at: Date.parse("2026-06-10T12:00:00.000Z"),
      },
      {
        message_id: "m-new",
        sender_name: "Pat Seller",
        sender_email: "pat@jimclick.example",
        subject: "Re: best price",
        body_excerpt: "Updated: $42,500 out the door.",
        received_at: Date.parse("2026-06-12T12:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("NegotiationDetailModal — closed", () => {
  it("renders nothing visible when detail is null", () => {
    render(<NegotiationDetailModal detail={null} onClose={() => {}} />);
    expect(docQuery("modal-dialog")).toBeNull();
  });
});

describe("NegotiationDetailModal — sections", () => {
  it("shows the dealer name as the title", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    expect(docQuery("negotiation-detail-title")!.textContent).toBe("Jim Click Hyundai");
    r.unmount();
  });

  it("OMITS the title when the dealer name is null", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail({ name: null })} onClose={() => {}} />);
    expect(docQuery("negotiation-detail-modal")).not.toBeNull();
    expect(docQuery("negotiation-detail-title")).toBeNull();
    r.unmount();
  });

  it("renders contacts with a mailto link + role, dropping the role row when null", () => {
    const r = render(
      <NegotiationDetailModal
        detail={makeDetail({
          contacts: [
            { contact_id: "c-1", display_name: "Pat Seller", email: "pat@x.example", role: "sales manager", is_primary_reply_target: true },
            { contact_id: "c-2", display_name: "Sam Desk", email: "sam@x.example", role: null, is_primary_reply_target: false },
          ],
        })}
        onClose={() => {}}
      />,
    );
    const rows = docAll("negotiation-contact-row");
    expect(rows).toHaveLength(2);
    const mailto = rows[0]!.querySelector('a[href^="mailto:"]');
    expect(mailto!.getAttribute("href")).toBe("mailto:pat@x.example");
    expect(rows[0]!.textContent).toContain("sales manager");
    // second contact has a null role → no role text
    expect(rows[1]!.textContent).not.toContain("sales manager");
    r.unmount();
  });

  it("renders the deterministic status_line in the status summary", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    const sum = docQuery("negotiation-status-summary")!;
    expect(sum.textContent).toContain("The dealer countered");
    r.unmount();
  });

  it("renders strategy + next steps (as an ordered list)", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    expect(docQuery("negotiation-strategy")!.textContent).toContain("Hold firm");
    const next = docQuery("negotiation-next-steps")!;
    expect(next.tagName.toLowerCase()).toBe("ol");
    expect(next.querySelectorAll("li")).toHaveLength(2);
    r.unmount();
  });

  it("renders the competing $ figure with NO competitor name", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    const comp = docQuery("negotiation-competing-quote")!;
    expect(comp.textContent).toContain("$41,000");
    // the scalar gap is shown; never a competing dealer's name (none in the payload)
    expect(comp.textContent).toContain("$2,210");
    r.unmount();
  });

  it("omits the competing block entirely when there is no competing OTD or gap", () => {
    const r = render(
      <NegotiationDetailModal
        detail={makeDetail({ best_competing_otd: null, batna_gap_usd: null })}
        onClose={() => {}}
      />,
    );
    expect(docQuery("negotiation-competing-quote")).toBeNull();
    r.unmount();
  });

  it("renders replies newest-first with an ABSOLUTE timestamp on a numeric received_at", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    const rows = docAll("negotiation-reply-row");
    expect(rows).toHaveLength(2);
    // newest (m-new, Jun 12) before older (m-old, Jun 10)
    expect(rows[0]!.textContent).toContain("$42,500");
    expect(rows[1]!.textContent).toContain("$43,000");
    // absolute timestamp present (year), not a relative "days ago"
    expect(rows[0]!.textContent).toContain("2026");
    expect(rows[0]!.textContent).not.toContain("days ago");
    r.unmount();
  });

  it("drops a reply with no displayable content (all-null row)", () => {
    const r = render(
      <NegotiationDetailModal
        detail={makeDetail({
          replies: [
            { message_id: "m-keep", sender_name: "Pat", sender_email: "p@x.example", subject: "Re", body_excerpt: "we can do $42,000", received_at: Date.parse("2026-06-12T12:00:00.000Z") },
            { message_id: "m-drop", sender_name: null, sender_email: null, subject: null, body_excerpt: null, received_at: null },
          ],
        })}
        onClose={() => {}}
      />,
    );
    expect(docAll("negotiation-reply-row")).toHaveLength(1);
    r.unmount();
  });

  it("renders the sections in order: title → contact → status → strategy → next → competing → reply", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    const modal = docQuery("negotiation-detail-modal")!;
    const ids = Array.from(modal.querySelectorAll<HTMLElement>("[data-testid]")).map(
      (n) => n.getAttribute("data-testid")!,
    );
    const at = (id: string): number => ids.indexOf(id);
    expect(at("negotiation-detail-title")).toBeGreaterThanOrEqual(0);
    expect(at("negotiation-detail-title")).toBeLessThan(at("negotiation-contact-row"));
    expect(at("negotiation-contact-row")).toBeLessThan(at("negotiation-status-summary"));
    expect(at("negotiation-status-summary")).toBeLessThan(at("negotiation-strategy"));
    expect(at("negotiation-strategy")).toBeLessThan(at("negotiation-next-steps"));
    expect(at("negotiation-next-steps")).toBeLessThan(at("negotiation-competing-quote"));
    expect(at("negotiation-competing-quote")).toBeLessThan(at("negotiation-reply-row"));
    r.unmount();
  });

  it("never renders a bare dealer/message/contact id", () => {
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => {}} />);
    const text = docQuery("negotiation-detail-modal")!.textContent ?? "";
    expect(text).not.toContain("d-1");
    expect(text).not.toContain("m-new");
    expect(text).not.toContain("c-1");
    r.unmount();
  });

  it("Close button calls onClose", () => {
    let closed = false;
    const r = render(<NegotiationDetailModal detail={makeDetail()} onClose={() => (closed = true)} />);
    clickDoc(docQuery("negotiation-detail-close")!);
    expect(closed).toBe(true);
    r.unmount();
  });
});

describe("NegotiationDetailModal — lazy LLM summary", () => {
  it("shows the AI summary once it resolves (subordinate to the always-present status_line)", async () => {
    const fetchSummary = (): Promise<DealerNegotiationSummary> =>
      Promise.resolve({ summary: "They're motivated; one more nudge should close the gap." });
    const r = render(
      <NegotiationDetailModal detail={makeDetail()} fetchSummary={fetchSummary} onClose={() => {}} />,
    );
    await flush();
    const sum = docQuery("negotiation-status-summary")!;
    expect(sum.textContent).toContain("They're motivated");
    // the deterministic status_line is STILL present — the AI line never leaves a hole
    expect(sum.textContent).toContain("The dealer countered");
    r.unmount();
  });

  it("falls back to the status_line when the summary resolves null (degraded)", async () => {
    const fetchSummary = (): Promise<DealerNegotiationSummary> => Promise.resolve({ summary: null });
    const r = render(
      <NegotiationDetailModal detail={makeDetail()} fetchSummary={fetchSummary} onClose={() => {}} />,
    );
    await flush();
    const sum = docQuery("negotiation-status-summary")!;
    expect(sum.textContent).toContain("The dealer countered");
    r.unmount();
  });

  it("falls back to the status_line when the summary fetch throws", async () => {
    const fetchSummary = (): Promise<DealerNegotiationSummary> => Promise.reject(new Error("boom"));
    const r = render(
      <NegotiationDetailModal detail={makeDetail()} fetchSummary={fetchSummary} onClose={() => {}} />,
    );
    await flush();
    expect(docQuery("negotiation-status-summary")!.textContent).toContain("The dealer countered");
    r.unmount();
  });
});
