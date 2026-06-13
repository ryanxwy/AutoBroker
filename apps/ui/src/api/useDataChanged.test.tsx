// @vitest-environment happy-dom
/**
 * useDataChanged unit tests — the fresh-by-default refetch bus. A registered
 * view's refetch fires when invalidate names an intersecting kind, when the
 * window refocuses, and never after unmount. Pure (happy-dom + a tiny harness
 * component); no network.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../test/render.js";
import {
  invalidate,
  resetDataRefetchForTests,
  useDataRefetch,
  useRefocusRefetch,
} from "./useDataChanged.js";

afterEach(() => {
  resetDataRefetchForTests();
  vi.restoreAllMocks();
});

/** A throwaway view that registers `refetch` under `kinds` for its lifetime. */
function View({
  kinds,
  refetch,
  refocus = false,
}: {
  kinds: readonly string[];
  refetch: () => void;
  refocus?: boolean;
}): JSX.Element {
  useDataRefetch(kinds, refetch);
  if (refocus) useRefocusRefetch();
  return <div data-testid="view" />;
}

const DEALER_KINDS = ["dealers"] as const;
const PROFILE_KINDS = ["profiles"] as const;

describe("useDataChanged — invalidate fires the matching refetchers", () => {
  it("invalidate(['dealers']) calls a view registered under 'dealers' but not one under 'profiles'", () => {
    const dealers = vi.fn();
    const profiles = vi.fn();
    const r1 = render(<View kinds={DEALER_KINDS} refetch={dealers} />);
    const r2 = render(<View kinds={PROFILE_KINDS} refetch={profiles} />);

    act(() => invalidate(["dealers"]));
    expect(dealers).toHaveBeenCalledTimes(1);
    expect(profiles).not.toHaveBeenCalled();

    r1.unmount();
    r2.unmount();
  });

  it("a refetcher under two named kinds fires exactly once for an overlapping invalidate", () => {
    const both = vi.fn();
    const r = render(<View kinds={["profiles", "dealers"]} refetch={both} />);
    act(() => invalidate(["profiles", "dealers"]));
    expect(both).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("an unknown kind matches nothing (no throw, no fire)", () => {
    const dealers = vi.fn();
    const r = render(<View kinds={DEALER_KINDS} refetch={dealers} />);
    act(() => invalidate(["quotes"]));
    expect(dealers).not.toHaveBeenCalled();
    r.unmount();
  });

  it("a replayed data.changed just refetches again — idempotent (a plain GET overwrites state)", () => {
    const dealers = vi.fn();
    const r = render(<View kinds={DEALER_KINDS} refetch={dealers} />);
    act(() => invalidate(["dealers"]));
    act(() => invalidate(["dealers"])); // the reconnect-replay re-delivery
    // Two refetches, no accumulation harm — each is an independent GET.
    expect(dealers).toHaveBeenCalledTimes(2);
    r.unmount();
  });

  it("after unmount the refetcher is unregistered (invalidate is a no-op for it)", () => {
    const dealers = vi.fn();
    const r = render(<View kinds={DEALER_KINDS} refetch={dealers} />);
    r.unmount();
    act(() => invalidate(["dealers"]));
    expect(dealers).not.toHaveBeenCalled();
  });
});

describe("useDataChanged — fresh-on-refocus", () => {
  it("a window focus refetches every registered view", () => {
    const dealers = vi.fn();
    const r = render(<View kinds={DEALER_KINDS} refetch={dealers} refocus />);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(dealers).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("a visibilitychange to visible refetches; the refocus listeners detach on unmount", () => {
    const dealers = vi.fn();
    const r = render(<View kinds={DEALER_KINDS} refetch={dealers} refocus />);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(dealers).toHaveBeenCalledTimes(1);

    r.unmount();
    // After unmount neither the refetcher nor the listeners remain.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(dealers).toHaveBeenCalledTimes(1);
  });
});
