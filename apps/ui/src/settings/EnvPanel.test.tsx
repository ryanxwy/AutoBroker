// @vitest-environment happy-dom
/**
 * EnvPanel.test — the Environment panel, driven against an injected ApiClient
 * (mock fetch) over a fixed getEnvConfig() shape. Proves the rows render FROM
 * the server response (one row per curated var, incl. the read-only fuse + the
 * paths), the control type follows each row's classification, and the editable
 * controls write the right wire value:
 *
 *   - enum → "real" parks a confirm (no call); "Use real Gmail" commits with
 *     "real"; "Keep sample inbox" cancels with NO call + the select snaps back.
 *   - enum "real" → "fake" commits immediately (one call, no confirm).
 *   - bool toggle writes the STRING "0" when shown / "1" when hidden.
 *   - the fuse row renders a read-only badge with NO interactive control.
 *   - InfoHint: bubble present on hover + on keyboard focus (aria-describedby
 *     resolves), Escape dismisses.
 *   - a successful write invokes onChanged.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import type { AsyncState } from "../api/useApi.js";
import type { EnvConfigResponse, EnvVarState } from "../api/wire.js";
import { change, click, render } from "../test/render.js";
import { EnvPanel } from "./EnvPanel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A curated set mirroring the server projection: gmail enum, the bool toggle,
 *  the read-only fuse, demo status, and the two paths. `backend` lets a test
 *  start from real (to exercise real→fake). */
function curatedVars(backend: "fake" | "real" = "fake"): EnvVarState[] {
  return [
    {
      id: "gmail_backend",
      envVar: "AUTOBROKER_GMAIL_BACKEND",
      classification: "editable-enum",
      editable: true,
      allowedValues: ["fake", "real"],
      default: "fake",
      numericMin: null,
      numericMax: null,
      label: "Email mode",
      tooltip: "Email mode tooltip.",
      value: backend,
    },
    {
      id: "gmail_account",
      envVar: "AUTOBROKER_GMAIL_ACCOUNT",
      classification: "editable-text",
      editable: true,
      allowedValues: null,
      default: null,
      numericMin: null,
      numericMax: null,
      label: "Gmail account",
      tooltip: "Gmail account tooltip.",
      value: "",
    },
    {
      id: "chrome_headless",
      envVar: "AUTOBROKER_CHROME_HEADLESS",
      classification: "editable-bool",
      editable: true,
      allowedValues: ["1", "0"],
      default: "1",
      numericMin: null,
      numericMax: null,
      label: "Show the browser",
      tooltip: "Show the browser tooltip.",
      value: "1", // headless = window hidden
    },
    {
      id: "block_external_mutations",
      envVar: "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS",
      classification: "read-only-status",
      editable: false,
      allowedValues: null,
      default: null,
      numericMin: null,
      numericMax: null,
      label: "Safety fuse",
      tooltip: "Safety fuse tooltip.",
      value: "armed",
    },
    {
      id: "demo_seed",
      envVar: "AUTOBROKER_DEMO_SEED",
      classification: "read-only-status",
      editable: false,
      allowedValues: null,
      default: null,
      numericMin: null,
      numericMax: null,
      label: "Demo mode",
      tooltip: "Demo mode tooltip.",
      value: "off",
    },
    {
      id: "data_dir",
      envVar: "AUTOBROKER_DATA_DIR",
      classification: "read-only-path",
      editable: false,
      allowedValues: null,
      default: null,
      numericMin: null,
      numericMax: null,
      label: "Data folder",
      tooltip: "Data folder tooltip.",
      value: "/Users/you/.autobroker-ts",
    },
    {
      id: "db_path",
      envVar: "",
      classification: "read-only-path",
      editable: false,
      allowedValues: null,
      default: null,
      numericMin: null,
      numericMax: null,
      label: "Database file",
      tooltip: "Database file tooltip.",
      value: "/Users/you/.autobroker-ts/autobroker.db",
    },
  ];
}

/** A mock fetch covering GET + PUT /api/settings/env. `puts` captures PUT
 *  bodies; `backend` seeds the GET (and the PUT echo). */
function mockFetch(opts: { puts?: Array<Record<string, unknown>>; backend?: "fake" | "real" }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const vars = curatedVars(opts.backend ?? "fake");
    if (url.endsWith("/api/settings/env") && init?.method === "PUT") {
      opts.puts?.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ ok: true, vars });
    }
    if (url.endsWith("/api/settings/env")) {
      return json({ vars });
    }
    return json({ error: { code: "nf", message: "no route" } }, 404);
  }) as typeof fetch;
}

/** A resolved env AsyncState wrapping a curated set (the panel renders FROM it;
 *  the GET mock above only matters for refetch-after-write, which App owns). */
function okEnv(backend: "fake" | "real" = "fake"): AsyncState<EnvConfigResponse> & {
  refetch: () => void;
  refreshing: boolean;
} {
  return { kind: "ok", data: { vars: curatedVars(backend) }, refetch: () => {}, refreshing: false };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Set a <select> value + fire React's change inside act() (the shared `change`
 *  helper is typed for input/textarea; a select needs its own setter). */
function changeSelect(node: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("EnvPanel — rows render from the store response", () => {
  it("renders one row per curated var, incl. the read-only fuse + both paths", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<EnvPanel client={client} env={okEnv()} onChanged={() => {}} />);

    expect(r.query("env-panel")).not.toBeNull();
    expect(r.query("env-row-gmail_backend")).not.toBeNull();
    expect(r.query("env-select-gmail_backend")).not.toBeNull();
    expect(r.query("env-toggle-chrome_headless")).not.toBeNull();
    // read-only fuse → a badge, no control.
    expect(r.query("env-badge-block_external")).not.toBeNull();
    // paths → mono code, the resolved value straight off the response.
    expect(r.get("env-path-data_dir").textContent).toContain(".autobroker-ts");
    expect(r.query("env-path-db_path")).not.toBeNull();
    // the keyword line shows the literal env var.
    expect(r.get("env-keyword-gmail_backend").textContent).toBe("AUTOBROKER_GMAIL_BACKEND");
    r.unmount();
  });

  it("the fuse row has NO interactive control (no toggle / select on that row)", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<EnvPanel client={client} env={okEnv()} onChanged={() => {}} />);

    // The controls area carries the status badge but NO interactive control —
    // no select, no checkbox, and no button (the only button on the row is the
    // ⓘ hint, which lives in the keyword line, not the controls area).
    const controls = r
      .get("env-row-block_external_mutations")
      .querySelector(".key-row-controls") as HTMLElement;
    expect(controls.querySelector("select")).toBeNull();
    expect(controls.querySelector('input[type="checkbox"]')).toBeNull();
    expect(controls.querySelector("button")).toBeNull();
    // and the badge reads the armed projection (not the raw "1").
    expect(r.get("env-badge-block_external").textContent).toContain("armed");
    r.unmount();
  });
});

describe("EnvPanel — enum gate-before-control", () => {
  it("switching to real shows the confirm; Use real Gmail calls setEnvConfig('gmail_backend','real')", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const onChanged = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch({ puts }) });
    const r = render(<EnvPanel client={client} env={okEnv("fake")} onChanged={onChanged} />);

    // No confirm + no call until the sensitive value is picked.
    expect(r.query("env-confirm-gmail_backend")).toBeNull();
    changeSelect(r.get("env-select-gmail_backend") as HTMLSelectElement, "real");
    expect(r.query("env-confirm-gmail_backend")).not.toBeNull();
    expect(puts).toHaveLength(0); // parked — no call yet.

    click(r.get("env-confirm-yes-gmail_backend"));
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ id: "gmail_backend", value: "real" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("Keep sample inbox cancels with NO call and the select snaps back to fake", () => {
    const puts: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ puts }) });
    const r = render(<EnvPanel client={client} env={okEnv("fake")} onChanged={() => {}} />);

    changeSelect(r.get("env-select-gmail_backend") as HTMLSelectElement, "real");
    expect((r.get("env-select-gmail_backend") as HTMLSelectElement).value).toBe("real"); // pending
    click(r.get("env-confirm-no-gmail_backend"));

    expect(puts).toHaveLength(0); // no call
    expect(r.query("env-confirm-gmail_backend")).toBeNull(); // confirm gone
    expect((r.get("env-select-gmail_backend") as HTMLSelectElement).value).toBe("fake"); // snapped back
    r.unmount();
  });

  it("real → fake commits immediately (one call, no confirm)", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ puts, backend: "real" }) });
    const r = render(<EnvPanel client={client} env={okEnv("real")} onChanged={() => {}} />);

    changeSelect(r.get("env-select-gmail_backend") as HTMLSelectElement, "fake");
    await flush();
    expect(r.query("env-confirm-gmail_backend")).toBeNull(); // never confirms the safe direction
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ id: "gmail_backend", value: "fake" });
    r.unmount();
  });
});

/** Toggle a controlled checkbox to `next` + fire React's change inside act(). */
function toggleCheckbox(box: HTMLInputElement, next: boolean): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  act(() => {
    setter?.call(box, next);
    box.dispatchEvent(new Event("click", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** An env read with the headless var overridden to a chosen value. */
function envWithHeadless(value: "1" | "0"): AsyncState<EnvConfigResponse> & {
  refetch: () => void;
  refreshing: boolean;
} {
  const vars = curatedVars().map((v) => (v.id === "chrome_headless" ? { ...v, value } : v));
  return { kind: "ok", data: { vars }, refetch: () => {}, refreshing: false };
}

describe("EnvPanel — bool toggle wire value", () => {
  it("checking 'Show the browser' writes the STRING '0' (headless off = window shown)", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ puts }) });
    // value "1" (headless) → checkbox starts UNCHECKED (window hidden).
    const r = render(<EnvPanel client={client} env={envWithHeadless("1")} onChanged={() => {}} />);

    const box = r.get("env-toggle-chrome_headless").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(false);

    toggleCheckbox(box, true); // check it → show the window → headless off → "0".
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ id: "chrome_headless", value: "0" });
    r.unmount();
  });

  it("unchecking 'Show the browser' writes the STRING '1' (headless on = window hidden)", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ puts }) });
    // value "0" → checkbox starts CHECKED (window shown).
    const r = render(<EnvPanel client={client} env={envWithHeadless("0")} onChanged={() => {}} />);

    const box = r.get("env-toggle-chrome_headless").querySelector("input") as HTMLInputElement;
    expect(box.checked).toBe(true);

    toggleCheckbox(box, false); // uncheck it → hide the window → headless on → "1".
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ id: "chrome_headless", value: "1" });
    r.unmount();
  });
});

describe("EnvPanel — gmail_account text control", () => {
  it("renders a text input + Save; typing then Save writes the trimmed value once", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const onChanged = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch({ puts }) });
    const r = render(<EnvPanel client={client} env={okEnv()} onChanged={onChanged} />);

    const input = r.get("env-input-gmail_account") as HTMLInputElement;
    const save = r.get("env-save-gmail_account") as HTMLButtonElement;
    // Empty + unchanged → Save disabled, no call.
    expect(save.disabled).toBe(true);

    change(input, "  person@example.com  ");
    expect(save.disabled).toBe(false);
    click(save);
    await flush();

    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ id: "gmail_account", value: "person@example.com" }); // trimmed
    expect(onChanged).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("never fires a write on keystrokes alone (only on Save)", () => {
    const puts: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ puts }) });
    const r = render(<EnvPanel client={client} env={okEnv()} onChanged={() => {}} />);

    change(r.get("env-input-gmail_account") as HTMLInputElement, "typing@example.com");
    expect(puts).toHaveLength(0); // parked in the draft — no call until Save.
    r.unmount();
  });
});

describe("EnvPanel — InfoHint accessible tooltip", () => {
  it("the bubble exists with role=tooltip and aria-describedby resolves it on the trigger", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<EnvPanel client={client} env={okEnv()} onChanged={() => {}} />);

    const trigger = r.get("info-hint-gmail_backend");
    const describedby = trigger.getAttribute("aria-describedby");
    expect(describedby).not.toBeNull();
    const bubble = r.get("info-hint-bubble-gmail_backend");
    expect(bubble.getAttribute("role")).toBe("tooltip");
    expect(bubble.id).toBe(describedby);
    expect(bubble.textContent).toContain("Email mode tooltip");
    r.unmount();
  });

  it("the bubble is revealed on keyboard focus (focus-within) and Escape dismisses it", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<EnvPanel client={client} env={okEnv()} onChanged={() => {}} />);

    const trigger = r.get("info-hint-gmail_backend") as HTMLButtonElement;
    const wrap = trigger.closest(".info-hint-wrap") as HTMLElement;
    // Not dismissed at rest → CSS :focus-within / :hover would reveal it.
    expect(wrap.getAttribute("data-dismissed")).toBe("false");

    // Focus the trigger (keyboard reach) → still armed (revealed by focus-within).
    act(() => {
      trigger.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    });
    expect(wrap.getAttribute("data-dismissed")).toBe("false");

    // Escape → dismissed (bubble hidden while focus remains).
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(wrap.getAttribute("data-dismissed")).toBe("true");
    r.unmount();
  });
});
