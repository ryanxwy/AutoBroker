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
