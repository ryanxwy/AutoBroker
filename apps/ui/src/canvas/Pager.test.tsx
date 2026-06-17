// @vitest-environment happy-dom
/**
 * Pager.test — the presentational pagination bar. Proves render-nothing when
 * pageCount <= 1, correct range label text, disabled state on boundary buttons,
 * onPrev/onNext callbacks, and stable testids.
 */

import { describe, expect, it, vi } from "vitest";

import { click, render } from "../test/render.js";
import { Pager } from "./Pager.js";

const BASE = {
  page: 2,
  pageCount: 5,
  total: 25,
  rangeStart: 6,
  rangeEnd: 10,
  onPrev: () => {},
  onNext: () => {},
  canPrev: true,
  canNext: true,
};

describe("Pager — render-nothing guard", () => {
  it("returns null when pageCount is 1", () => {
    const { container } = render(
      <Pager {...BASE} page={1} pageCount={1} total={3} rangeStart={1} rangeEnd={3} />,
    );
    expect(container.querySelector('[data-testid="canvas-pager"]')).toBeNull();
  });

  it("returns null when pageCount is 0 (degenerate)", () => {
    const { container } = render(
      <Pager {...BASE} pageCount={0} />,
    );
    expect(container.querySelector('[data-testid="canvas-pager"]')).toBeNull();
  });
});

describe("Pager — range label", () => {
  it("renders the range label with en-dash and total", () => {
    const { get } = render(<Pager {...BASE} />);
    const label = get("canvas-pager-range");
    expect(label.textContent).toContain("6–10 of 25");
  });

  it("renders the noun when provided", () => {
    const { get } = render(<Pager {...BASE} noun="threads" />);
    const label = get("canvas-pager-range");
    expect(label.textContent).toContain("threads");
  });
});

describe("Pager — buttons", () => {
  it("Prev is disabled when canPrev=false", () => {
    const { get } = render(<Pager {...BASE} canPrev={false} />);
    const btn = get("canvas-pager-prev") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Next is disabled when canNext=false", () => {
    const { get } = render(<Pager {...BASE} canNext={false} />);
    const btn = get("canvas-pager-next") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Prev is enabled when canPrev=true", () => {
    const { get } = render(<Pager {...BASE} canPrev={true} />);
    const btn = get("canvas-pager-prev") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("Next is enabled when canNext=true", () => {
    const { get } = render(<Pager {...BASE} canNext={true} />);
    const btn = get("canvas-pager-next") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("clicking Prev calls onPrev", () => {
    const onPrev = vi.fn();
    const { get } = render(<Pager {...BASE} onPrev={onPrev} />);
    click(get("canvas-pager-prev"));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("clicking Next calls onNext", () => {
    const onNext = vi.fn();
    const { get } = render(<Pager {...BASE} onNext={onNext} />);
    click(get("canvas-pager-next"));
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});

describe("Pager — testids", () => {
  it("exposes canvas-pager root, canvas-pager-prev, canvas-pager-next, canvas-pager-range", () => {
    const { query } = render(<Pager {...BASE} />);
    expect(query("canvas-pager")).not.toBeNull();
    expect(query("canvas-pager-prev")).not.toBeNull();
    expect(query("canvas-pager-next")).not.toBeNull();
    expect(query("canvas-pager-range")).not.toBeNull();
  });
});
