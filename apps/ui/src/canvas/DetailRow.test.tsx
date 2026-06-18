// @vitest-environment happy-dom
/**
 * DetailRow.test — the shared label/value row used inside the canvas detail
 * modals' `<dl>`. Proves: it renders the label `<dt>` + value `<dd>`, omits the
 * whole row when the value is null/empty, and only wraps the value in `<strong>`
 * when `emphasize` is set (default false renders the bare value).
 */

import { describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import { DetailRow } from "./DetailRow.js";

/** Render a DetailRow inside a <dl> and return the list element for querying. */
function renderRow(el: JSX.Element): { dl: HTMLElement; unmount: () => void } {
  const r = render(<dl data-testid="dl">{el}</dl>);
  return { dl: r.get("dl"), unmount: r.unmount };
}

describe("DetailRow", () => {
  it("renders the label as <dt> and the value as <dd>", () => {
    const { dl, unmount } = renderRow(<DetailRow label="VIN" value="ABC123" />);
    expect(dl.querySelector("dt")?.textContent).toBe("VIN");
    expect(dl.querySelector("dd")?.textContent).toBe("ABC123");
    unmount();
  });

  it("omits the row entirely when value is null", () => {
    const { dl, unmount } = renderRow(<DetailRow label="VIN" value={null} />);
    expect(dl.querySelector("dt")).toBeNull();
    expect(dl.querySelector("dd")).toBeNull();
    unmount();
  });

  it("omits the row entirely when value is an empty string", () => {
    const { dl, unmount } = renderRow(<DetailRow label="VIN" value="" />);
    expect(dl.querySelector("dt")).toBeNull();
    expect(dl.querySelector("dd")).toBeNull();
    unmount();
  });

  it("does not wrap the value in <strong> by default", () => {
    const { dl, unmount } = renderRow(<DetailRow label="Total" value="$100" />);
    expect(dl.querySelector("dd strong")).toBeNull();
    expect(dl.querySelector("dd")?.textContent).toBe("$100");
    unmount();
  });

  it("wraps the value in <strong> when emphasize is true", () => {
    const { dl, unmount } = renderRow(<DetailRow label="Total" value="$100" emphasize />);
    const strong = dl.querySelector("dd strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("$100");
    unmount();
  });
});
