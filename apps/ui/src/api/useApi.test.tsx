// @vitest-environment happy-dom
/**
 * useAsync unit tests — the app's only data-fetch primitive. Pins the
 * stale-while-revalidate contract: the FIRST load shows `loading`; a `refetch`
 * of already-loaded data KEEPS the prior `data` on screen (never drops to
 * loading/null) while the new GET is in flight, exposing `refreshing=true` for
 * that window, then swaps in the fresh data; a refetch error surfaces the error
 * state. Pure (happy-dom + a tiny harness component); the fetcher is a manually
 * resolved promise so the in-flight window is observable.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../test/render.js";
import { type AsyncState, useAsync } from "./useApi.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A harness that renders the hook's state into the DOM and stashes its
 *  refetch so a test can drive a manual refetch. */
function Probe<T>({
  fetcher,
  sink,
}: {
  fetcher: () => Promise<T>;
  sink: (s: AsyncState<T> & { refetch: () => void; refreshing: boolean }) => void;
}): JSX.Element {
  const state = useAsync<T>(fetcher, []);
  sink(state);
  return (
    <div
      data-testid="probe"
      data-kind={state.kind}
      data-refreshing={String(state.refreshing)}
      data-value={state.kind === "ok" ? String(state.data) : ""}
    />
  );
}

/** A promise the test resolves/rejects by hand, so the in-flight window is
 *  observable. The resolve/reject controls delegate to whatever the executor
 *  captured (the executor runs lazily when `fetcher()` is first called). */
function deferred<T>(): {
  fetcher: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const fetcher = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });
  return {
    fetcher,
    resolve: (v) => res(v),
    reject: (e) => rej(e),
  };
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("useAsync — stale-while-revalidate", () => {
  it("shows loading on first load, then ok with the data", async () => {
    const d = deferred<string>();
    let latest!: AsyncState<string> & { refetch: () => void; refreshing: boolean };
    const r = render(<Probe fetcher={d.fetcher} sink={(s) => (latest = s)} />);

    // First load: no data yet → loading, not refreshing.
    expect(r.get("probe").getAttribute("data-kind")).toBe("loading");
    expect(r.get("probe").getAttribute("data-refreshing")).toBe("false");

    await act(async () => {
      d.resolve("first");
    });
    await flush();
    expect(r.get("probe").getAttribute("data-kind")).toBe("ok");
    expect(r.get("probe").getAttribute("data-value")).toBe("first");
    r.unmount();
    void latest;
  });

  it("a refetch KEEPS the prior data (never loading) and exposes refreshing while in flight", async () => {
    // First load resolves, then a second deferred backs the refetch.
    let pending = deferred<string>();
    const fetcher = (): Promise<string> => pending.fetcher();
    let latest!: AsyncState<string> & { refetch: () => void; refreshing: boolean };
    const r = render(<Probe fetcher={fetcher} sink={(s) => (latest = s)} />);

    await act(async () => {
      pending.resolve("first");
    });
    await flush();
    expect(r.get("probe").getAttribute("data-value")).toBe("first");

    // Arm the next fetch, then refetch — the prior data must stay visible.
    pending = deferred<string>();
    act(() => latest.refetch());

    expect(r.get("probe").getAttribute("data-kind")).toBe("ok"); // NOT loading
    expect(r.get("probe").getAttribute("data-value")).toBe("first"); // stale data held
    expect(r.get("probe").getAttribute("data-refreshing")).toBe("true");

    // Resolve the refetch → swap to the fresh data, refreshing back to false.
    await act(async () => {
      pending.resolve("second");
    });
    await flush();
    expect(r.get("probe").getAttribute("data-kind")).toBe("ok");
    expect(r.get("probe").getAttribute("data-value")).toBe("second");
    expect(r.get("probe").getAttribute("data-refreshing")).toBe("false");
    r.unmount();
  });

  it("a refetch ERROR surfaces the error state (replacing the stale data)", async () => {
    let pending = deferred<string>();
    const fetcher = (): Promise<string> => pending.fetcher();
    let latest!: AsyncState<string> & { refetch: () => void; refreshing: boolean };
    const r = render(<Probe fetcher={fetcher} sink={(s) => (latest = s)} />);

    await act(async () => {
      pending.resolve("first");
    });
    await flush();
    expect(r.get("probe").getAttribute("data-kind")).toBe("ok");

    pending = deferred<string>();
    act(() => latest.refetch());
    expect(r.get("probe").getAttribute("data-refreshing")).toBe("true");

    await act(async () => {
      pending.reject(new Error("boom"));
    });
    await flush();
    expect(r.get("probe").getAttribute("data-kind")).toBe("error");
    expect(r.get("probe").getAttribute("data-refreshing")).toBe("false");
    r.unmount();
  });
});
