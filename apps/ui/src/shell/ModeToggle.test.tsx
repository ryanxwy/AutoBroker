// @vitest-environment happy-dom
/**
 * ModeToggle.test — the TopBar app-mode posture switch. Covers the four
 * load-bearing behaviors: (1) it REFLECTS the current mode (active segment +
 * aria-checked); (2) switching TO buyer (the sensitive, can-send direction)
 * opens a confirm FIRST and does NOT write until confirmed; (3) confirming
 * writes app_mode=buyer via setEnvConfig + refetches; (4) switching TO test (the
 * safe direction) commits immediately with no confirm.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import { click, render } from "../test/render.js";
import { ModeToggle } from "./ModeToggle.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The confirm dialog renders through createPortal into document.body, so its
// nodes live OUTSIDE the render container — query the document directly.
const docGet = (testId: string): HTMLElement => {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (node === null) throw new Error(`no node with data-testid="${testId}"`);
  return node as HTMLElement;
};
const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A stub client recording setEnvConfig calls; resolves like a 200 PUT. */
function stubClient(): { client: ApiClient; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const client = {
    setEnvConfig: (id: string, value: string): Promise<void> => {
      calls.push([id, value]);
      return Promise.resolve();
    },
  } as unknown as ApiClient;
  return { client, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ModeToggle", () => {
  it("reflects the current mode (one lamp: data-mode + aria-checked)", async () => {
    const { client } = stubClient();
    const r = render(<ModeToggle mode="buyer" onSwitched={() => {}} client={client} />);
    await flush();

    // Buyer: the single lamp carries data-mode=buyer + aria-checked=true.
    expect(r.get("mode-toggle").getAttribute("data-mode")).toBe("buyer");
    expect(r.get("mode-toggle").getAttribute("aria-checked")).toBe("true");
    expect(r.get("mode-toggle").textContent).toContain("Buyer");
    r.unmount();

    // Test: data-mode=test + aria-checked=false, label "Test".
    const r2 = render(<ModeToggle mode="test" onSwitched={() => {}} client={client} />);
    await flush();
    expect(r2.get("mode-toggle").getAttribute("data-mode")).toBe("test");
    expect(r2.get("mode-toggle").getAttribute("aria-checked")).toBe("false");
    expect(r2.get("mode-toggle").textContent).toContain("Test");
    r2.unmount();
  });

  it("clicking the lamp in TEST opens a confirm first and does NOT write until confirmed", async () => {
    const { client, calls } = stubClient();
    const onSwitched = vi.fn();
    const r = render(<ModeToggle mode="test" onSwitched={onSwitched} client={client} />);
    await flush();

    // Click the lamp (test → buyer) — the confirm appears, but nothing is written.
    click(r.get("mode-toggle"));
    await flush();
    expect(docQuery("mode-confirm-title")).not.toBeNull();
    expect(docQuery("mode-confirm-buyer")).not.toBeNull();
    expect(calls).toHaveLength(0);
    expect(onSwitched).not.toHaveBeenCalled();

    // Confirm — now it writes app_mode=buyer and refetches.
    click(docGet("mode-confirm-buyer"));
    await flush();
    expect(calls).toEqual([["app_mode", "buyer"]]);
    expect(onSwitched).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("cancelling the confirm writes nothing", async () => {
    const { client, calls } = stubClient();
    const r = render(<ModeToggle mode="test" onSwitched={() => {}} client={client} />);
    await flush();

    click(r.get("mode-toggle"));
    await flush();
    click(docGet("mode-confirm-cancel"));
    await flush();

    expect(docQuery("mode-confirm-title")).toBeNull();
    expect(calls).toHaveLength(0);
    r.unmount();
  });

  it("clicking the lamp in BUYER is immediate — no confirm, writes app_mode=test", async () => {
    const { client, calls } = stubClient();
    const onSwitched = vi.fn();
    const r = render(<ModeToggle mode="buyer" onSwitched={onSwitched} client={client} />);
    await flush();

    // Click the lamp (buyer → test): the safe direction commits with no confirm.
    click(r.get("mode-toggle"));
    await flush();

    expect(docQuery("mode-confirm-title")).toBeNull();
    expect(calls).toEqual([["app_mode", "test"]]);
    expect(onSwitched).toHaveBeenCalledTimes(1);
    r.unmount();
  });
});
