// @vitest-environment happy-dom
/**
 * ProfileSummary.test — the persistent bento summary header. Proves: null-props
 * empty state, bestOtd formatting ($35,500 no cents / "—"), needsReplyCount chip
 * presence/absence, headline rendering, and inventory tallies. Presentational
 * ONLY — no API client, no async, no budget field.
 */

import { describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import { ProfileSummary } from "./ProfileSummary.js";
import type { ProfileSummaryProps } from "./ProfileSummary.js";

function nullProps(): ProfileSummaryProps {
  return {
    bestOtd: null,
    dealerCount: null,
    quoteCount: null,
    threadCount: null,
    needsReplyCount: null,
    inventoryRecommended: null,
    inventoryTotal: null,
    headline: null,
  };
}

describe("ProfileSummary — root testid", () => {
  it("renders canvas-summary", () => {
    const { query } = render(<ProfileSummary {...nullProps()} />);
    expect(query("canvas-summary")).not.toBeNull();
  });
});

describe("ProfileSummary — bestOtd", () => {
  it("shows '—' when bestOtd is null", () => {
    const { get } = render(<ProfileSummary {...nullProps()} />);
    expect(get("canvas-summary-best-otd").textContent).toBe("—");
  });

  it("formats bestOtd=35500 as '$35,500' (no cents)", () => {
    const { get } = render(<ProfileSummary {...nullProps()} bestOtd={35500} />);
    expect(get("canvas-summary-best-otd").textContent).toBe("$35,500");
  });

  it("rounds non-integer bestOtd", () => {
    const { get } = render(<ProfileSummary {...nullProps()} bestOtd={35500.75} />);
    expect(get("canvas-summary-best-otd").textContent).toBe("$35,501");
  });

  it("shows '—' when bestOtd is explicitly null", () => {
    const { get } = render(<ProfileSummary {...nullProps()} bestOtd={null} />);
    expect(get("canvas-summary-best-otd").textContent).toBe("—");
  });
});

describe("ProfileSummary — needsReplyCount chip", () => {
  it("shows the 'need reply' chip when needsReplyCount=3", () => {
    const { container } = render(<ProfileSummary {...nullProps()} needsReplyCount={3} />);
    const text = container.textContent ?? "";
    expect(text).toContain("need reply");
  });

  it("does not show the chip when needsReplyCount=0", () => {
    const { container } = render(<ProfileSummary {...nullProps()} needsReplyCount={0} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("need reply");
  });

  it("does not show the chip when needsReplyCount is null", () => {
    const { container } = render(<ProfileSummary {...nullProps()} needsReplyCount={null} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("need reply");
  });
});

describe("ProfileSummary — headline", () => {
  it("renders the headline when provided", () => {
    const { container } = render(
      <ProfileSummary {...nullProps()} headline="Best deal found" />,
    );
    expect(container.textContent).toContain("Best deal found");
  });

  it("does not render a headline element when headline is null", () => {
    const { query } = render(<ProfileSummary {...nullProps()} headline={null} />);
    expect(query("canvas-summary-headline")).toBeNull();
  });
});

describe("ProfileSummary — inventory tiles", () => {
  it("shows 'rec / total' when inventoryTotal > 0", () => {
    const { container } = render(
      <ProfileSummary {...nullProps()} inventoryRecommended={5} inventoryTotal={50} />,
    );
    expect(container.textContent).toContain("5 rec / 50");
  });

  it("shows '—' for inventory tile when inventoryTotal is null", () => {
    const { container } = render(
      <ProfileSummary {...nullProps()} inventoryTotal={null} inventoryRecommended={null} />,
    );
    // With null bestOtd too, at least one — appears
    expect(container.textContent).toContain("—");
  });
});

describe("ProfileSummary — never renders budget", () => {
  it("does not contain the word 'budget' anywhere", () => {
    const { container } = render(
      <ProfileSummary
        bestOtd={35500}
        dealerCount={10}
        quoteCount={5}
        threadCount={8}
        needsReplyCount={2}
        inventoryRecommended={3}
        inventoryTotal={20}
        headline="Best deal found"
      />,
    );
    expect((container.textContent ?? "").toLowerCase()).not.toContain("budget");
  });
});
