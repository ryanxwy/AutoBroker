// @vitest-environment happy-dom
/**
 * SearchPicker — the shared active-searches picker (TopBar + the per-session pin
 * toggle). Freezes the row testids + the pin/unpin/new callbacks so both mount
 * points behave identically.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import { ApiClient } from "../api/client.js";
import { resetDataRefetchForTests } from "../api/useDataChanged.js";
import { render, click } from "../test/render.js";
import { SearchPicker } from "./SearchPicker.js";

const A = { search_profile_id: "a", year: 2026, make: "Honda", model: "Accord", status: "active" };
const B = { search_profile_id: "b", year: 2026, make: "Toyota", model: "Camry", status: "active" };

function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/profiles")) return json([A, B]);
    return json([]);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => resetDataRefetchForTests());

const NOOP = (): void => {};

describe("SearchPicker", () => {
  it("renders a pin toggle per active search and pins on click", async () => {
    const onPin = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(
      <SearchPicker client={client} pinnedProfileId={null} onPin={onPin} onUnpin={NOOP} onViewProfile={NOOP} onStartIntake={NOOP} close={NOOP} />,
    );
    await flush();
    expect(r.query("searches-row-a")).not.toBeNull();
    expect(r.query("searches-row-b")).not.toBeNull();
    click(r.get("searches-pin-a"));
    expect(onPin).toHaveBeenCalledWith("a");
    r.unmount();
  });

  it("shows unpin on the pinned row and unpins on click", async () => {
    const onUnpin = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(
      <SearchPicker client={client} pinnedProfileId="a" onPin={NOOP} onUnpin={onUnpin} onViewProfile={NOOP} onStartIntake={NOOP} close={NOOP} />,
    );
    await flush();
    expect(r.query("searches-unpin-a")).not.toBeNull();
    click(r.get("searches-unpin-a"));
    expect(onUnpin).toHaveBeenCalled();
    r.unmount();
  });

  it("starts a new search and closes", async () => {
    const onStartIntake = vi.fn();
    const close = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(
      <SearchPicker client={client} pinnedProfileId={null} onPin={NOOP} onUnpin={NOOP} onViewProfile={NOOP} onStartIntake={onStartIntake} close={close} />,
    );
    await flush();
    click(r.get("searches-new"));
    expect(onStartIntake).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    r.unmount();
  });
});
