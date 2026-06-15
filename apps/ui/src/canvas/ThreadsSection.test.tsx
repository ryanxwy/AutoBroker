// @vitest-environment happy-dom
/**
 * ThreadsSection.test — the presentational Dealer-replies canvas section. Proves
 * the empty wait-state copy (the contacted-dealer count), the row rendering with
 * a quoted/replied classification chip, the loading + error states, and that no
 * raw id is surfaced.
 */

import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import { render } from "../test/render.js";
import { ThreadsSection, type ThreadRowList } from "./ThreadsSection.js";

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

describe("ThreadsSection — manual cross-provider retry affordance", () => {
  const failedRows: ThreadRowList = [
    {
      thread_id: "t-fail",
      dealer_name: "Example Hyundai",
      subject: "Re: Tucson availability",
      state: "replied",
      updated_at: new Date().toISOString(),
      extract_failed: true,
    },
  ];
  const cleanRows: ThreadRowList = [
    {
      thread_id: "t-ok",
      dealer_name: "Example Hyundai",
      subject: "Re: Tucson availability",
      state: "quoted",
      updated_at: new Date().toISOString(),
      extract_failed: false,
    },
  ];

  it("renders the retry button (disclosing Anthropic) when a thread failed AND the key is present", () => {
    const { container } = render(
      <ThreadsSection
        threads={ok(failedRows)}
        dealerCount={1}
        anthropicReady={true}
        onRetryFailedExtractions={() => {}}
      />,
    );
    const btn = container.querySelector('[data-testid="retry-failed-extractions"]');
    expect(btn).not.toBeNull();
    // The label DISCLOSES the egress provider (the privacy-conservative contract).
    expect(btn!.textContent).toContain("Anthropic");
    // The no-key hint is NOT shown when the key is present.
    expect(container.querySelector('[data-testid="retry-failed-extractions-hint"]')).toBeNull();
  });

  it("invokes the launch callback on click", () => {
    let clicked = 0;
    const { container } = render(
      <ThreadsSection
        threads={ok(failedRows)}
        dealerCount={1}
        anthropicReady={true}
        onRetryFailedExtractions={() => {
          clicked += 1;
        }}
      />,
    );
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="retry-failed-extractions"]',
    );
    btn!.click();
    expect(clicked).toBe(1);
  });

  it("renders the Settings hint (not the button) when a thread failed but the key is ABSENT", () => {
    const { container } = render(
      <ThreadsSection
        threads={ok(failedRows)}
        dealerCount={1}
        anthropicReady={false}
        onRetryFailedExtractions={() => {}}
      />,
    );
    expect(container.querySelector('[data-testid="retry-failed-extractions"]')).toBeNull();
    const hint = container.querySelector('[data-testid="retry-failed-extractions-hint"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("Anthropic key in Settings");
  });

  it("renders NEITHER the button nor the hint when no thread failed (key present)", () => {
    const { container } = render(
      <ThreadsSection
        threads={ok(cleanRows)}
        dealerCount={1}
        anthropicReady={true}
        onRetryFailedExtractions={() => {}}
      />,
    );
    expect(container.querySelector('[data-testid="retry-failed-extractions"]')).toBeNull();
    expect(container.querySelector('[data-testid="retry-failed-extractions-hint"]')).toBeNull();
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
