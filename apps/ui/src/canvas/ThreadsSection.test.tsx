// @vitest-environment happy-dom
/**
 * ThreadsSection.test — the presentational Dealer-replies canvas section. Proves
 * the empty wait-state copy (the contacted-dealer count), the row rendering with
 * a quoted/replied classification chip, the loading + error states, and that no
 * raw id is surfaced. Also proves pagination behaviour (10/page).
 */

import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import { click, render } from "../test/render.js";
import { ThreadsSection, type ThreadRow, type ThreadRowList } from "./ThreadsSection.js";

function ok(data: ThreadRowList): AsyncState<ThreadRowList> {
  return { kind: "ok", data };
}

describe("ThreadsSection — empty wait state", () => {
  it("renders the wait-copy naming the contacted-dealer count", () => {
    const { container } = render(<ThreadsSection threads={ok([])} dealerCount={3} />);
    const empty = container.querySelector('[data-testid="canvas-threads-empty"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("No replies yet");
    expect(empty!.textContent).toContain("contacted 3 dealers");
    expect(empty!.textContent).toContain("1–3 days");
  });
});

describe("ThreadsSection — rows", () => {
  const rows: ThreadRowList = [
    {
      thread_id: "t-1",
      dealer_name: "Example Hyundai",
      subject: "Re: Tucson availability",
      state: "quoted",
      updated_at: new Date().toISOString(),
    },
    {
      thread_id: "t-2",
      dealer_name: "Second Dealer",
      subject: "Re: quote",
      state: "replied",
      updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
  ];

  it("renders one row per thread with the classification chip", () => {
    const { container } = render(<ThreadsSection threads={ok(rows)} dealerCount={2} />);
    const rowEls = container.querySelectorAll('[data-testid="canvas-thread-row"]');
    expect(rowEls).toHaveLength(2);
    const chips = container.querySelectorAll('[data-testid="thread-class-chip"]');
    expect([...chips].map((c) => c.textContent)).toEqual(["quoted", "replied"]);
    // dealer name shows; the raw thread id never surfaces in the rendered text.
    const text = container.textContent ?? "";
    expect(text).toContain("Example Hyundai");
    expect(text).not.toContain("t-1");
  });

  it("does not render the empty wait-copy when rows are present", () => {
    const { container } = render(<ThreadsSection threads={ok(rows)} dealerCount={2} />);
    expect(container.querySelector('[data-testid="canvas-threads-empty"]')).toBeNull();
  });

  it("renders the extract-failed badge only on threads whose extraction failed", () => {
    const withBadge: ThreadRowList = [
      { ...rows[0]!, thread_id: "t-fail", extract_failed: true },
      { ...rows[1]!, thread_id: "t-ok", extract_failed: false },
    ];
    const { container } = render(<ThreadsSection threads={ok(withBadge)} dealerCount={2} />);
    const badges = container.querySelectorAll('[data-testid="message-extract-failed-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe("extraction failed, will retry");
  });

  it("renders no extract-failed badge when no thread failed", () => {
    const { container } = render(<ThreadsSection threads={ok(rows)} dealerCount={2} />);
    expect(container.querySelector('[data-testid="message-extract-failed-badge"]')).toBeNull();
  });
});

describe("ThreadsSection — loading / error", () => {
  it("renders a loading line", () => {
    const { container } = render(
      <ThreadsSection threads={{ kind: "loading" }} dealerCount={0} />,
    );
    expect(container.querySelector('[data-testid="canvas-threads"]')!.textContent).toContain(
      "Loading replies",
    );
  });

  it("renders an error line", () => {
    const { container } = render(
      <ThreadsSection
        threads={{ kind: "error", message: "boom", code: "x" }}
        dealerCount={0}
      />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert!.textContent).toContain("boom");
  });
});

/** Build N thread rows for pagination tests. */
function makeThreads(n: number): ThreadRowList {
  return Array.from({ length: n }, (_, i): ThreadRow => ({
    thread_id: `t-${i + 1}`,
    dealer_name: `Dealer ${i + 1}`,
    subject: `Subject ${i + 1}`,
    state: i % 2 === 0 ? "quoted" : "replied",
    updated_at: new Date(Date.now() - i * 3_600_000).toISOString(),
  }));
}

describe("ThreadsSection — pagination", () => {
  it("renders only 10 rows and shows Pager when there are >10 threads", () => {
    const threads = makeThreads(15);
    const { container } = render(<ThreadsSection threads={ok(threads)} dealerCount={5} />);
    const rows = container.querySelectorAll('[data-testid="canvas-thread-row"]');
    expect(rows).toHaveLength(10);
    const pager = container.querySelector('[data-testid="canvas-pager"]');
    expect(pager).not.toBeNull();
  });

  it("navigates to the next page showing the remaining threads", () => {
    const threads = makeThreads(15);
    const { container } = render(<ThreadsSection threads={ok(threads)} dealerCount={5} />);
    const nextBtn = container.querySelector('[data-testid="canvas-pager-next"]') as HTMLButtonElement;
    expect(nextBtn).not.toBeNull();
    click(nextBtn);
    const rows = container.querySelectorAll('[data-testid="canvas-thread-row"]');
    // 15 total, 10 on page 1, 5 on page 2
    expect(rows).toHaveLength(5);
  });

  it("does NOT render a Pager when there are 10 or fewer threads", () => {
    const threads = makeThreads(10);
    const { container } = render(<ThreadsSection threads={ok(threads)} dealerCount={4} />);
    // All 10 rows render
    const rows = container.querySelectorAll('[data-testid="canvas-thread-row"]');
    expect(rows).toHaveLength(10);
    // Pager returns null (pageCount=1)
    const pager = container.querySelector('[data-testid="canvas-pager"]');
    expect(pager).toBeNull();
  });

  it("does NOT render a Pager for a single-page list (<10 threads)", () => {
    const threads = makeThreads(3);
    const { container } = render(<ThreadsSection threads={ok(threads)} dealerCount={2} />);
    expect(container.querySelectorAll('[data-testid="canvas-thread-row"]')).toHaveLength(3);
    expect(container.querySelector('[data-testid="canvas-pager"]')).toBeNull();
  });
});
