// @vitest-environment happy-dom
/**
 * KeyRow.test — the managed-key row, driven against an injected ApiClient (mock
 * fetch). Proves: the Show/Hide toggle flips the input type + aria-pressed; Test
 * renders the pass/fail verdict (a fail is role=alert with the detail); Save
 * fires saveKey + the brief Saved badge + onChanged; a required-but-missing key
 * shows the add-it pointer; a configured key shows the masked placeholder + Clear.
 *
 * The masked-value rule: a configured key NEVER shows its value — the input is
 * empty with the "•••• stored" placeholder, and Show only ever reveals what was
 * just typed this session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import { change, click, render } from "../test/render.js";
import { KEY_DEFS } from "./keyDefs.js";
import { KeyRow } from "./KeyRow.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deepseekDef = KEY_DEFS.find((d) => d.id === "deepseek")!;
const anthropicDef = KEY_DEFS.find((d) => d.id === "anthropic")!;

/** A mock fetch covering the three key routes; `saved` captures POST bodies,
 *  `testOk` drives the probe verdict. */
function mockFetch(opts: {
  saved?: Array<Record<string, unknown>>;
  cleared?: string[];
  testOk?: boolean;
  testDetail?: string;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/test") && init?.method === "POST") {
      return json({ ok: opts.testOk ?? true, detail: opts.testDetail ?? "key accepted" });
    }
    if (url.endsWith("/api/settings/keys") && init?.method === "POST") {
      opts.saved?.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ ok: true });
    }
    if (url.includes("/api/settings/keys/") && init?.method === "DELETE") {
      opts.cleared?.push(url);
      return new Response(null, { status: 204 });
    }
    return json({ error: { code: "nf", message: "no route" } }, 404);
  }) as typeof fetch;
}

async function flush(): Promise<void> {
  // Drain several microtask + macrotask cycles. The test-connection path is
  // click → setState('testing') → await client.testKey() (async fetch) →
  // setState('pass'/'fail'); a single setTimeout(0) can fire before that chain
  // settles under full-suite concurrency, leaving data-state='testing' (the
  // load-flake). Looping micro+macro drains covers the await + React re-render.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("KeyRow — show/hide + masking", () => {
  it("the input starts masked (password) and the Show toggle flips it to text + aria-pressed", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<KeyRow client={client} def={deepseekDef} present={false} onChanged={() => {}} />);

    const input = r.get("key-input-deepseek") as HTMLInputElement;
    expect(input.type).toBe("password");
    const toggle = r.get("key-toggle-deepseek");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    click(toggle);
    expect((r.get("key-input-deepseek") as HTMLInputElement).type).toBe("text");
    expect(r.get("key-toggle-deepseek").getAttribute("aria-pressed")).toBe("true");
    r.unmount();
  });

  it("a configured key shows the masked placeholder (never the value) + a Clear button", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<KeyRow client={client} def={deepseekDef} present onChanged={() => {}} />);

    const input = r.get("key-input-deepseek") as HTMLInputElement;
    expect(input.value).toBe(""); // never the stored secret
    expect(input.placeholder).toContain("stored");
    expect(r.query("key-clear-deepseek")).not.toBeNull();
    r.unmount();
  });
});

describe("KeyRow — required-missing", () => {
  it("a required key with no value flags the add-it pointer + the required mark", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<KeyRow client={client} def={deepseekDef} present={false} onChanged={() => {}} />);
    expect(r.query("key-required-mark-deepseek")).not.toBeNull();
    expect(r.query("key-missing-deepseek")).not.toBeNull();
    r.unmount();
  });

  it("an OPTIONAL key with no value shows neither the required mark nor the missing pointer", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<KeyRow client={client} def={anthropicDef} present={false} onChanged={() => {}} />);
    expect(r.query("key-required-mark-anthropic")).toBeNull();
    expect(r.query("key-missing-anthropic")).toBeNull();
    r.unmount();
  });
});

describe("KeyRow — test connection", () => {
  it("Test renders a pass verdict (role=status, data-state=pass) on ok:true", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ testOk: true, testDetail: "HTTP 200" }) });
    const r = render(<KeyRow client={client} def={deepseekDef} present={false} onChanged={() => {}} />);

    change(r.get("key-input-deepseek") as HTMLInputElement, "sk-candidate");
    click(r.get("key-test-deepseek"));
    await flush();

    const result = r.get("key-test-result-deepseek");
    expect(result.getAttribute("data-state")).toBe("pass");
    expect(result.getAttribute("role")).toBe("status");
    expect(result.textContent).toContain("HTTP 200");
    r.unmount();
  });

  it("Test renders a fail verdict (role=alert, data-state=fail) with the readable detail on ok:false", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ testOk: false, testDetail: "401 invalid key" }) });
    const r = render(<KeyRow client={client} def={deepseekDef} present={false} onChanged={() => {}} />);

    change(r.get("key-input-deepseek") as HTMLInputElement, "bad-key");
    click(r.get("key-test-deepseek"));
    await flush();

    const result = r.get("key-test-result-deepseek");
    expect(result.getAttribute("data-state")).toBe("fail");
    expect(result.getAttribute("role")).toBe("alert");
    expect(result.textContent).toContain("401 invalid key");
    r.unmount();
  });
});

describe("KeyRow — save", () => {
  it("Save fires saveKey with the candidate, shows the Saved badge, and calls onChanged", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const onChanged = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch({ saved }) });
    const r = render(<KeyRow client={client} def={deepseekDef} present={false} onChanged={onChanged} />);

    // Save is disabled until a candidate is typed.
    expect((r.get("key-save-deepseek") as HTMLButtonElement).disabled).toBe(true);
    change(r.get("key-input-deepseek") as HTMLInputElement, "sk-new-key");
    expect((r.get("key-save-deepseek") as HTMLButtonElement).disabled).toBe(false);

    click(r.get("key-save-deepseek"));
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ id: "deepseek", value: "sk-new-key" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(r.query("key-saved-deepseek")).not.toBeNull();
    // After save the input clears (never re-shows the value).
    expect((r.get("key-input-deepseek") as HTMLInputElement).value).toBe("");
    r.unmount();
  });
});
