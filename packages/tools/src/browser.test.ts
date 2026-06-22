/**
 * Browser service unit tests — NO real browser. Covers the pure, load-bearing
 * pieces: the personal-page isolation denylist, the robots.txt Disallow parse,
 * the backoff/politeness math (with injected rand), the snapshot cap, the
 * extract-vs-snapshot completeness decision, and the opened-once emitter
 * wrapper. Real-chromium coverage lives in browser.smoke.test.ts behind
 * AUTOBROKER_BROWSER_SMOKE=1.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertFilterTargetAllowed,
  assertIsolated,
  assertZipTargetAllowed,
  assertZipValue,
  BrowserIsolationError,
  capSnapshot,
  computeBackoffMs,
  FilterInteractionRefusedError,
  gatedSubmitForm,
  LocationZipRefusedError,
  NULL_EMITTER,
  openedOnce,
  parseRobotsDisallow,
  politenessDelayMs,
  probeFilterTarget,
  probeZipTarget,
  rowsComplete,
  runFilterVerb,
  runLocationZip,
  SNAPSHOT_CAP_CHARS,
  type BrowserEmitter,
  type FilterControlPage,
  type FilterDomDocument,
  type FilterDomElement,
  type FilterTargetProbe,
  type FormPage,
  type ZipControlPage,
  type ZipTargetProbe,
} from "./browser.js";
import { ExternalMutationsBlockedError, type Approver } from "./gate/index.js";

const BLOCKED_PREFIX =
  /^BLOCKED: detected personal-profile Chrome page in the controlled browser\./;

describe("assertIsolated — personal-page denylist", () => {
  it("clean URLs pass", () => {
    expect(() =>
      assertIsolated([
        "https://www.tustinhyundai.com/new-inventory/",
        "https://example.com/?q=settings",
        "data:text/html,<p>hi</p>",
        "about:blank",
      ]),
    ).not.toThrow();
  });

  it.each([
    "chrome://history",
    "chrome://settings/passwords",
    "https://mail.google.com/mail/u/0/#inbox",
    "https://accounts.google.com/signin/v2",
  ])("denylisted URL %s throws with the BLOCKED: prefix", (url) => {
    expect(() => assertIsolated([url])).toThrow(BrowserIsolationError);
    expect(() => assertIsolated([url])).toThrow(BLOCKED_PREFIX);
  });

  it("one bad URL among clean ones still throws", () => {
    expect(() =>
      assertIsolated(["https://dealer.example/", "chrome://settings", "https://ok.example/"]),
    ).toThrow(BrowserIsolationError);
  });
});

describe("parseRobotsDisallow — star group only, longest prefix", () => {
  it("a * group Disallow prefix matches", () => {
    const robots = "User-agent: *\nDisallow: /search";
    expect(parseRobotsDisallow(robots, "/search/cars")).toBe(true);
    expect(parseRobotsDisallow(robots, "/inventory")).toBe(false);
  });

  it("specific-UA groups are ignored", () => {
    const robots = "User-agent: Googlebot\nDisallow: /";
    expect(parseRobotsDisallow(robots, "/anything")).toBe(false);
  });

  it("a shared group listing * among other agents applies", () => {
    const robots = "User-agent: Googlebot\nUser-agent: *\nDisallow: /private";
    expect(parseRobotsDisallow(robots, "/private/x")).toBe(true);
  });

  it("rules after a NEW specific-UA group do not leak into the * group", () => {
    const robots =
      "User-agent: *\nDisallow: /a\n\nUser-agent: Googlebot\nDisallow: /b";
    expect(parseRobotsDisallow(robots, "/a/page")).toBe(true);
    expect(parseRobotsDisallow(robots, "/b/page")).toBe(false);
  });

  it("empty Disallow means allow", () => {
    const robots = "User-agent: *\nDisallow:";
    expect(parseRobotsDisallow(robots, "/anything")).toBe(false);
  });

  it("comments and blank lines are tolerated; longest prefix decides", () => {
    const robots =
      "# dealer robots\n\nUser-agent: *\nDisallow: /a # inline comment\nDisallow: /a/b\n";
    expect(parseRobotsDisallow(robots, "/a/b/c")).toBe(true);
    expect(parseRobotsDisallow(robots, "/a")).toBe(true);
    expect(parseRobotsDisallow(robots, "/z")).toBe(false);
  });

  it("empty robots.txt allows everything (fetch failure → caller passes nothing)", () => {
    expect(parseRobotsDisallow("", "/")).toBe(false);
  });
});

describe("computeBackoffMs — full jitter", () => {
  it("rand=1 yields the full window: base*2^attempt up to the cap", () => {
    const one = () => 1;
    expect(computeBackoffMs(0, 1000, 8000, one)).toBe(1000);
    expect(computeBackoffMs(1, 1000, 8000, one)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 8000, one)).toBe(8000); // 8000 exactly
    expect(computeBackoffMs(10, 1000, 8000, one)).toBe(8000); // capped
  });

  it("rand=0 yields 0 (full-jitter floor)", () => {
    expect(computeBackoffMs(5, 1000, 8000, () => 0)).toBe(0);
  });

  it("rand=0.5 yields half the window", () => {
    expect(computeBackoffMs(2, 1000, 8000, () => 0.5)).toBe(2000);
  });
});

describe("politenessDelayMs — min interval ± 0.5s jitter", () => {
  it("rand=0.5 (zero jitter): waits out the remaining interval", () => {
    const half = () => 0.5;
    expect(politenessDelayMs(0, 500, 2000, half)).toBe(1500);
    expect(politenessDelayMs(0, 2000, 2000, half)).toBe(0);
  });

  it("jitter bounds: rand=1 adds +500ms, rand=0 subtracts 500ms", () => {
    expect(politenessDelayMs(0, 0, 2000, () => 1)).toBe(2500);
    expect(politenessDelayMs(0, 0, 2000, () => 0)).toBe(1500);
  });

  it("never negative once the interval has long elapsed", () => {
    expect(politenessDelayMs(0, 60_000, 2000, () => 1)).toBe(0);
    expect(politenessDelayMs(0, 60_000, 2000, () => 0)).toBe(0);
  });
});

describe("capSnapshot — 120k char cap", () => {
  it("short text is unchanged", () => {
    expect(capSnapshot("hello")).toBe("hello");
  });

  it("text exactly at the cap is unchanged", () => {
    const text = "x".repeat(SNAPSHOT_CAP_CHARS);
    expect(capSnapshot(text)).toBe(text);
  });

  it("over-cap text is truncated to the cap and is a prefix", () => {
    const text = "a".repeat(SNAPSHOT_CAP_CHARS) + "TAIL";
    const capped = capSnapshot(text);
    expect(capped.length).toBe(SNAPSHOT_CAP_CHARS);
    expect(text.startsWith(capped)).toBe(true);
  });
});

describe("rowsComplete — the extract-vs-snapshot decision", () => {
  type Row = { name: string | null; price: number | null; note?: string };
  const required: ("name" | "price")[] = ["name", "price"];

  it("zero rows is NOT complete (snapshot fallback)", () => {
    const r = rowsComplete<Row>([], required);
    expect(r.allComplete).toBe(false);
    expect(r.completeRows).toEqual([]);
  });

  it("all rows with every required key non-null → evaluate path", () => {
    const rows: Row[] = [
      { name: "Tucson SEL", price: 31000 },
      { name: "Tucson XRT", price: 33000 },
    ];
    const r = rowsComplete(rows, required);
    expect(r.allComplete).toBe(true);
    expect(r.completeRows).toEqual(rows);
  });

  it("a null/undefined required key makes the row incomplete; complete rows are kept in order", () => {
    const rows: Row[] = [
      { name: "Tucson SEL", price: 31000 },
      { name: null, price: 33000 },
      { name: "Tucson XRT", price: null },
    ];
    const r = rowsComplete(rows, required);
    expect(r.allComplete).toBe(false);
    expect(r.completeRows).toEqual([{ name: "Tucson SEL", price: 31000 }]);
  });

  it("a missing NON-required key does not break completeness", () => {
    const rows: Row[] = [{ name: "Tucson SEL", price: 31000 }];
    expect(rowsComplete(rows, required).allComplete).toBe(true);
  });
});

describe("openedOnce — opened fires at most once per session", () => {
  function recording(): { calls: (string | undefined)[]; emitter: BrowserEmitter } {
    const calls: (string | undefined)[] = [];
    return {
      calls,
      emitter: {
        opened: (url?: string) => {
          calls.push(url);
        },
        action: () => undefined,
        error: () => undefined,
        closed: () => undefined,
      },
    };
  }

  it("multiple calls forward only the first (with its url)", () => {
    const { calls, emitter } = recording();
    const open = openedOnce(emitter);
    expect(open.didOpen()).toBe(false);
    open.opened("https://first.example/");
    open.opened("https://second.example/");
    open.opened();
    expect(calls).toEqual(["https://first.example/"]);
    expect(open.didOpen()).toBe(true);
  });

  it("didOpen stays false when never opened (no closed() pairing in cleanup)", () => {
    const open = openedOnce(NULL_EMITTER);
    expect(open.didOpen()).toBe(false);
  });
});

describe("gatedSubmitForm — the gate/decline/fuse safety branches", () => {
  const FORM = {
    url: "https://dealer.example/contact",
    fields: { first_name: "Ada", phone: "(949) 555-0100" },
    submitSelector: "button[type=submit]",
  };

  function fakePage(): { page: FormPage; ops: string[] } {
    const ops: string[] = [];
    return {
      ops,
      page: {
        fill: async (selector, value) => {
          ops.push(`fill:${selector}=${value}`);
        },
        click: async (selector) => {
          ops.push(`click:${selector}`);
        },
      },
    };
  }

  const approve: Approver = { decide: async () => true };
  const decline: Approver = { decide: async () => false };

  // These submit tests assume real send is ON (the product default) unless a test
  // overrides it — the global vitest setup brakes the suite, so re-release it here
  // and restore after each case (the real-send brake is exercised by its own test).
  let prevRealSend: string | undefined;
  let prevFuse: string | undefined;
  beforeEach(() => {
    prevRealSend = process.env.AUTOBROKER_REAL_SEND;
    prevFuse = process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
    process.env.AUTOBROKER_REAL_SEND = "1";
  });
  afterEach(() => {
    if (prevRealSend === undefined) delete process.env.AUTOBROKER_REAL_SEND;
    else process.env.AUTOBROKER_REAL_SEND = prevRealSend;
    // Restore the fuse var too — the brake test deletes it, so own its cleanup
    // here rather than leaking the prior state into later cases in this file.
    if (prevFuse === undefined) delete process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
    else process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = prevFuse;
  });

  it("a declined approver returns {declined} without ever touching the page", async () => {
    const { page, ops } = fakePage();
    const result = await gatedSubmitForm({
      runId: "run-1",
      page,
      form: FORM,
      approver: decline,
      emitter: NULL_EMITTER,
    });
    expect(result).toEqual({ declined: true });
    expect(ops).toEqual([]); // no fill, no click — zero side effects on decline
  });

  it("an approver that THROWS is treated as a decline (fail-closed)", async () => {
    const { page, ops } = fakePage();
    const result = await gatedSubmitForm({
      runId: "run-1",
      page,
      form: FORM,
      approver: {
        decide: async () => {
          throw new Error("approver crashed");
        },
      },
      emitter: NULL_EMITTER,
    });
    expect(result).toEqual({ declined: true });
    expect(ops).toEqual([]);
  });

  it("the armed L1 env fuse blocks the click even when the approver approves", async () => {
    const { page, ops } = fakePage();
    const prev = process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
    process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "1";
    try {
      await expect(
        gatedSubmitForm({
          runId: "run-1",
          page,
          form: FORM,
          approver: approve,
          emitter: NULL_EMITTER,
        }),
      ).rejects.toThrow(ExternalMutationsBlockedError);
    } finally {
      if (prev === undefined) delete process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
      else process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = prev;
    }
    expect(ops.some((op) => op.startsWith("click:"))).toBe(false); // never reached the click
  });

  it("the real-send brake blocks the click even with the fuse disarmed and the approver approving", async () => {
    const { page, ops } = fakePage();
    delete process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS; // fuse disarmed
    process.env.AUTOBROKER_REAL_SEND = "0"; // braked
    await expect(
      gatedSubmitForm({
        runId: "run-1",
        page,
        form: FORM,
        approver: approve,
        emitter: NULL_EMITTER,
      }),
    ).rejects.toThrow(ExternalMutationsBlockedError);
    expect(ops.some((op) => op.startsWith("click:"))).toBe(false); // never reached the click
  });

  it("an approved gate fills then clicks, and announces the submit", async () => {
    const { page, ops } = fakePage();
    const actions: string[] = [];
    const emitter: BrowserEmitter = {
      ...NULL_EMITTER,
      action: (type, target) => {
        actions.push(`${type}:${target}`);
      },
    };
    const result = await gatedSubmitForm({
      runId: "run-1",
      page,
      form: FORM,
      approver: approve,
      emitter,
    });
    expect(result).toEqual({ submitted: true });
    expect(ops).toEqual([
      'fill:[name="first_name"]=Ada',
      'fill:[name="phone"]=(949) 555-0100',
      "click:button[type=submit]",
    ]);
    expect(actions).toEqual([`submit:${FORM.url}`]);
  });
});

// ---------------------------------------------------------------------------
// Filter interaction face — the fences and the no-action-on-refusal contract.
// ---------------------------------------------------------------------------

/** Minimal structural fake element (the probe walks exactly these members). */
function makeEl(opts: {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  closest?: Record<string, FilterDomElement | null>;
  query?: Record<string, FilterDomElement | null>;
  parent?: FilterDomElement | null;
}): FilterDomElement {
  return {
    tagName: opts.tag.toUpperCase(),
    textContent: opts.text ?? "",
    parentElement: opts.parent ?? null,
    getAttribute: (name) => opts.attrs?.[name] ?? null,
    closest: (sel) => opts.closest?.[sel] ?? null,
    querySelector: (sel) => opts.query?.[sel] ?? null,
  };
}

const PII_FORM_SELECTOR = 'input[type="email"], input[type="tel"]';

function withDocument<T>(doc: FilterDomDocument, fn: () => T): T {
  const g = globalThis as { document?: FilterDomDocument };
  g.document = doc;
  try {
    return fn();
  } finally {
    delete g.document;
  }
}

describe("probeFilterTarget — the in-page target descriptor", () => {
  it("returns null without a document, and null when nothing matches", () => {
    expect(probeFilterTarget("select")).toBeNull(); // no document in node
    expect(withDocument({ querySelector: () => null }, () => probeFilterTarget("select"))).toBeNull();
  });

  it("describes a free-standing select (no PII form, option text folded in)", () => {
    const select = makeEl({ tag: "select", attrs: { name: "make" }, text: "Hyundai Kia Genesis" });
    const probe = withDocument(
      { querySelector: (sel) => (sel === "select[name='make']" ? select : null) },
      () => probeFilterTarget("select[name='make']"),
    );
    expect(probe).toEqual({
      tag: "select",
      inputType: null,
      role: null,
      accessibleText: expect.stringContaining("Hyundai Kia Genesis") as string,
      inPiiForm: false,
    });
  });

  it("flags a target inside a <form> that collects email/phone", () => {
    const piiForm = makeEl({
      tag: "form",
      query: { [PII_FORM_SELECTOR]: makeEl({ tag: "input", attrs: { type: "email" } }) },
    });
    const wrapper = makeEl({ tag: "div", parent: piiForm });
    const input = makeEl({ tag: "input", attrs: { type: "checkbox" }, parent: wrapper });
    const probe = withDocument({ querySelector: () => input }, () => probeFilterTarget("input"));
    expect(probe?.inPiiForm).toBe(true);
  });

  it("folds wrapping-label and for-linked-label text into the accessible text", () => {
    const wrappingLabel = makeEl({ tag: "label", text: "New (24)" });
    const box = makeEl({
      tag: "input",
      attrs: { type: "checkbox", id: "cond-new" },
      closest: { label: wrappingLabel },
    });
    const forLabel = makeEl({ tag: "label", text: "Condition" });
    const probe = withDocument(
      {
        querySelector: (sel) => (sel === 'label[for="cond-new"]' ? forLabel : box),
      },
      () => probeFilterTarget("#cond-new"),
    );
    expect(probe?.accessibleText).toContain("New (24)");
    expect(probe?.accessibleText).toContain("Condition");
  });
});

describe("assertFilterTargetAllowed — three fences, denylist first", () => {
  function probe(overrides: Partial<FilterTargetProbe> = {}): FilterTargetProbe {
    return {
      tag: "select",
      inputType: null,
      role: null,
      accessibleText: "Make Model Year",
      inPiiForm: false,
      ...overrides,
    };
  }

  it("(a) denylist on the accessible text refuses loudly", () => {
    for (const text of [
      "Check Availability",
      "Get ePrice",
      "Get E-Price",
      "Value Your Trade",
      "Get Pre-Approved Now",
      "Schedule Test Drive",
      "Contact Us",
      "Get Quote",
      "Chat with us",
      "Special Offers",
      "Apply for Financing",
      "Reserve Now",
    ]) {
      expect(() => assertFilterTargetAllowed("apply", "button.x", probe({ tag: "button", accessibleText: text }))).toThrow(
        FilterInteractionRefusedError,
      );
      expect(() => assertFilterTargetAllowed("apply", "button.x", probe({ tag: "button", accessibleText: text }))).toThrow(
        /denylist/,
      );
    }
  });

  it("(a) denylist on the SELECTOR refuses even when the text is clean", () => {
    expect(() => assertFilterTargetAllowed("apply", ".eprice-bar button", probe({ tag: "button", accessibleText: "Apply" }))).toThrow(/denylist/);
  });

  it("(a) denylist outranks the allowlist — a deny-worded <select> still refuses", () => {
    expect(() => assertFilterTargetAllowed("select", "select", probe({ accessibleText: "Finance options" }))).toThrow(/denylist/);
  });

  it("(b) the lead-form structure fence refuses a clean-worded target", () => {
    expect(() => assertFilterTargetAllowed("tick", "input", probe({ tag: "input", inputType: "checkbox", inPiiForm: true }))).toThrow(
      /lead-capture form/,
    );
  });

  it("(c) allowlist passes: select on <select>, tick on checkbox/radio, apply on apply-worded buttons", () => {
    expect(() => assertFilterTargetAllowed("select", "select[name='make']", probe())).not.toThrow();
    expect(() => assertFilterTargetAllowed("tick", "input", probe({ tag: "input", inputType: "checkbox", accessibleText: "New" }))).not.toThrow();
    expect(() => assertFilterTargetAllowed("tick", "input", probe({ tag: "input", inputType: "radio", accessibleText: "New" }))).not.toThrow();
    for (const text of ["Apply Filters", "Update Results", "Search Inventory"]) {
      expect(() => assertFilterTargetAllowed("apply", "button.go", probe({ tag: "button", accessibleText: text }))).not.toThrow();
    }
    // role=button counts as button-ish.
    expect(() => assertFilterTargetAllowed("apply", "div.go", probe({ tag: "div", role: "button", accessibleText: "Update Results" }))).not.toThrow();
  });

  it("(c) allowlist rejections: wrong widget kinds and non-apply button text", () => {
    expect(() => assertFilterTargetAllowed("select", "input", probe({ tag: "input", inputType: "text" }))).toThrow(/only <select>/);
    expect(() => assertFilterTargetAllowed("tick", "input", probe({ tag: "input", inputType: "text" }))).toThrow(/checkbox\/radio/);
    expect(() => assertFilterTargetAllowed("tick", "a", probe({ tag: "a" }))).toThrow(/checkbox\/radio/);
    expect(() => assertFilterTargetAllowed("apply", "a.go", probe({ tag: "a", accessibleText: "Update Results" }))).toThrow(/must be a button/);
    expect(() => assertFilterTargetAllowed("apply", "button.go", probe({ tag: "button", accessibleText: "Go" }))).toThrow(
      /apply \/ update results \/ search inventory/,
    );
  });
});

describe("runFilterVerb — probe, fence, act; a refusal never touches the page", () => {
  function fakeFilterPage(probeResult: FilterTargetProbe | null): {
    page: FilterControlPage;
    ops: string[];
  } {
    const ops: string[] = [];
    return {
      ops,
      page: {
        evaluate: async () => probeResult,
        selectOption: async (selector, values) => {
          ops.push(`selectOption:${selector}:${JSON.stringify(values)}`);
          return [];
        },
        check: async (selector) => {
          ops.push(`check:${selector}`);
        },
        click: async (selector) => {
          ops.push(`click:${selector}`);
        },
      },
    };
  }

  function cleanProbe(overrides: Partial<FilterTargetProbe> = {}): FilterTargetProbe {
    return {
      tag: "select",
      inputType: null,
      role: null,
      accessibleText: "Make",
      inPiiForm: false,
      ...overrides,
    };
  }

  it("denylist refusal happens BEFORE any page action", async () => {
    const { page, ops } = fakeFilterPage(cleanProbe({ accessibleText: "Check Availability" }));
    await expect(
      runFilterVerb({ page, emitter: NULL_EMITTER, verb: "select", selector: "select", option: "Hyundai" }),
    ).rejects.toThrow(FilterInteractionRefusedError);
    expect(ops).toEqual([]);
  });

  it("a selector matching nothing refuses (loudly, zero actions)", async () => {
    const { page, ops } = fakeFilterPage(null);
    await expect(
      runFilterVerb({ page, emitter: NULL_EMITTER, verb: "apply", selector: "button.go" }),
    ).rejects.toThrow(/no element matches/);
    expect(ops).toEqual([]);
  });

  it("select verb without an option refuses before acting", async () => {
    const { page, ops } = fakeFilterPage(cleanProbe());
    await expect(
      runFilterVerb({ page, emitter: NULL_EMITTER, verb: "select", selector: "select" }),
    ).rejects.toThrow(/needs an option/);
    expect(ops).toEqual([]);
  });

  it("approved select sets the option by value-or-label and voices the action", async () => {
    const { page, ops } = fakeFilterPage(cleanProbe());
    const actions: string[] = [];
    const emitter: BrowserEmitter = {
      ...NULL_EMITTER,
      action: (type, target) => {
        actions.push(`${type}:${target}`);
      },
    };
    await runFilterVerb({ page, emitter, verb: "select", selector: "select[name='make']", option: "Hyundai" });
    expect(ops).toEqual([
      `selectOption:select[name='make']:${JSON.stringify([{ value: "Hyundai" }, { label: "Hyundai" }])}`,
    ]);
    expect(actions).toEqual(["filter_select:select[name='make'] = Hyundai"]);
  });

  it("approved tick checks the box; approved apply clicks the button — both voiced", async () => {
    const tick = fakeFilterPage(cleanProbe({ tag: "input", inputType: "checkbox", accessibleText: "New" }));
    const actions: string[] = [];
    const emitter: BrowserEmitter = {
      ...NULL_EMITTER,
      action: (type, target) => {
        actions.push(`${type}:${target}`);
      },
    };
    await runFilterVerb({ page: tick.page, emitter, verb: "tick", selector: "#cond-new" });
    expect(tick.ops).toEqual(["check:#cond-new"]);

    const apply = fakeFilterPage(cleanProbe({ tag: "button", accessibleText: "Update Results" }));
    await runFilterVerb({ page: apply.page, emitter, verb: "apply", selector: "button.go" });
    expect(apply.ops).toEqual(["click:button.go"]);

    expect(actions).toEqual(["filter_tick:#cond-new", "filter_apply:button.go"]);
  });
});

// ---------------------------------------------------------------------------
// Location-ZIP face — fences + the hard US-ZIP value constraint. Types the
// profile ZIP into a page's own location picker (ZIP digits only); never an
// identity field, never a lead-capture form.
// ---------------------------------------------------------------------------

describe("assertZipValue — only a US ZIP types, never identity", () => {
  it("accepts a 5-digit ZIP and ZIP+4", () => {
    expect(() => assertZipValue("92614")).not.toThrow();
    expect(() => assertZipValue("92614-1234")).not.toThrow();
  });

  it("refuses every non-ZIP value LOUDLY (name, phone, street, partial digits)", () => {
    for (const bad of [
      "Jane Doe", // a name
      "949-555-0173", // a phone
      "123 Main St", // a street address
      "9261", // too few digits
      "926145", // too many digits
      "abcde", // letters
      "", // empty
      "92614 ", // trailing space
    ]) {
      expect(() => assertZipValue(bad)).toThrow(LocationZipRefusedError);
      expect(() => assertZipValue(bad)).toThrow(/not a US ZIP/);
    }
  });
});

describe("assertZipTargetAllowed — three fences + the input allowlist", () => {
  function zipProbe(overrides: Partial<ZipTargetProbe> = {}): ZipTargetProbe {
    return {
      tag: "input",
      inputType: "text",
      name: "zipcode",
      id: null,
      placeholder: "Enter ZIP",
      accessibleText: "ZIP Code",
      inPiiForm: false,
      ...overrides,
    };
  }

  it("allows a ZIP/postal/location input (text/tel/number/search)", () => {
    expect(() => assertZipTargetAllowed("#zip", zipProbe())).not.toThrow();
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inputType: "tel" }))).not.toThrow();
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inputType: "number" }))).not.toThrow();
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inputType: "search" }))).not.toThrow();
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inputType: null }))).not.toThrow();
    // wording allowlist matches on name / id / placeholder / accessibleText
    expect(() =>
      assertZipTargetAllowed("#x", zipProbe({ name: null, placeholder: null, accessibleText: "", id: "postal-code" })),
    ).not.toThrow();
    expect(() =>
      assertZipTargetAllowed("#x", zipProbe({ name: null, id: null, placeholder: "Your location" })),
    ).not.toThrow();
  });

  it("(a) refuses a ZIP field that ALSO reads like a lead-capture control", () => {
    expect(() =>
      assertZipTargetAllowed("#zip", zipProbe({ accessibleText: "ZIP — Get Quote" })),
    ).toThrow(/denylist/);
    expect(() => assertZipTargetAllowed(".eprice-bar #zip", zipProbe())).toThrow(/denylist/);
  });

  it("(b) refuses a ZIP field sitting inside an email/phone lead form", () => {
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inPiiForm: true }))).toThrow(
      /lead-capture form/,
    );
  });

  it("(c) refuses a non-input, or an input of the wrong type", () => {
    expect(() => assertZipTargetAllowed("select", zipProbe({ tag: "select", inputType: null }))).toThrow(
      /only text\/tel\/number\/search/,
    );
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inputType: "email" }))).toThrow(
      /only text\/tel\/number\/search/,
    );
    expect(() => assertZipTargetAllowed("#zip", zipProbe({ inputType: "checkbox" }))).toThrow(
      /only text\/tel\/number\/search/,
    );
  });

  it("(d) refuses a name/contact input (no zip/postal/location wording)", () => {
    expect(() =>
      assertZipTargetAllowed(
        "#fullname",
        zipProbe({ name: "fullname", id: "fullname", placeholder: "Full name", accessibleText: "Your name" }),
      ),
    ).toThrow(/must read zip \/ postal \/ location/);
    expect(() =>
      assertZipTargetAllowed(
        "#phone",
        zipProbe({ inputType: "tel", name: "phone", id: null, placeholder: "Phone number", accessibleText: "Phone" }),
      ),
    ).toThrow(/must read zip \/ postal \/ location/);
  });
});

describe("runLocationZip — value gate first, then probe → fence → fill → submit", () => {
  function fakeZipPage(
    probeResult: ZipTargetProbe | null,
    opts: { failUnlessForced?: boolean } = {},
  ): {
    page: ZipControlPage;
    ops: string[];
  } {
    const ops: string[] = [];
    return {
      ops,
      page: {
        evaluate: async () => probeResult,
        fill: async (selector, value, options) => {
          if (opts.failUnlessForced && options?.force !== true) {
            throw new Error("not actionable (collapsed picker)");
          }
          ops.push(`fill:${selector}:${value}${options?.force ? ":force" : ""}`);
        },
        press: async (selector, key, options) => {
          if (opts.failUnlessForced && options?.force !== true) {
            throw new Error("not actionable (collapsed picker)");
          }
          ops.push(`press:${selector}:${key}${options?.force ? ":force" : ""}`);
        },
      },
    };
  }

  function cleanZipProbe(overrides: Partial<ZipTargetProbe> = {}): ZipTargetProbe {
    return {
      tag: "input",
      inputType: "text",
      name: "zip",
      id: null,
      placeholder: "ZIP",
      accessibleText: "ZIP Code",
      inPiiForm: false,
      ...overrides,
    };
  }

  it("a non-ZIP value is refused BEFORE the page is even probed", async () => {
    const { page, ops } = fakeZipPage(cleanZipProbe());
    await expect(
      runLocationZip({ page, emitter: NULL_EMITTER, selector: "#zip", zip: "Jane Doe" }),
    ).rejects.toThrow(/not a US ZIP/);
    expect(ops).toEqual([]); // value gate fires before any evaluate/fill
  });

  it("a refused target (name field) never fills", async () => {
    const { page, ops } = fakeZipPage(
      cleanZipProbe({ name: "fullname", placeholder: "Full name", accessibleText: "Your name" }),
    );
    await expect(
      runLocationZip({ page, emitter: NULL_EMITTER, selector: "#fullname", zip: "92614" }),
    ).rejects.toThrow(LocationZipRefusedError);
    expect(ops).toEqual([]);
  });

  it("a ZIP into a ZIP input fills, submits via Enter, and voices location_zip", async () => {
    const { page, ops } = fakeZipPage(cleanZipProbe());
    const actions: string[] = [];
    const emitter: BrowserEmitter = {
      ...NULL_EMITTER,
      action: (type, target) => {
        actions.push(`${type}:${target}`);
      },
    };
    await runLocationZip({ page, emitter, selector: "#zip", zip: "92614" });
    expect(ops).toEqual(["fill:#zip:92614", "press:#zip:Enter"]);
    expect(actions).toEqual(["location_zip:#zip = 92614"]);
  });

  it("a collapsed picker (present but not actionable) force-fills and VOICES the fallback", async () => {
    const { page, ops } = fakeZipPage(cleanZipProbe(), { failUnlessForced: true });
    const actions: string[] = [];
    const emitter: BrowserEmitter = {
      ...NULL_EMITTER,
      action: (type, target) => {
        actions.push(`${type}:${target}`);
      },
    };
    await runLocationZip({ page, emitter, selector: "#zip", zip: "92614" });
    expect(ops).toEqual(["fill:#zip:92614:force", "press:#zip:Enter:force"]);
    // the fallback is voiced (never silent) BEFORE the success voice
    expect(actions).toEqual(["location_zip_forced:#zip", "location_zip:#zip = 92614"]);
  });

  it("a selector matching nothing refuses (loudly, zero actions)", async () => {
    const { page, ops } = fakeZipPage(null);
    await expect(
      runLocationZip({ page, emitter: NULL_EMITTER, selector: "#zip", zip: "92614" }),
    ).rejects.toThrow(/no element matches/);
    expect(ops).toEqual([]);
  });
});

describe("probeZipTarget survives page.evaluate serialization", () => {
  it("rehydrated from source (no module scope), it still describes a ZIP input", () => {
    // The function SOURCE ships into the page — module-scope references do not
    // exist there. Rebuilding from toString() in an empty scope reproduces that
    // boundary: any out-of-scope reference throws.
    const rehydrated = new Function(`return (${probeZipTarget.toString()});`)() as typeof probeZipTarget;

    const input = makeEl({
      tag: "input",
      attrs: { type: "text", name: "zip", id: "zip-input", placeholder: "Enter ZIP" },
    });
    const fakeDoc: FilterDomDocument = {
      querySelector: (sel) => (sel === "#zip-input" || sel === 'label[for="zip-input"]' ? (sel === "#zip-input" ? input : null) : null),
    };
    const probe = withDocument(fakeDoc, () => rehydrated("#zip-input"));
    expect(probe).not.toBeNull();
    expect(probe?.tag).toBe("input");
    expect(probe?.inputType).toBe("text");
    expect(probe?.name).toBe("zip");
    expect(probe?.id).toBe("zip-input");
    expect(probe?.placeholder).toBe("Enter ZIP");
    expect(probe?.inPiiForm).toBe(false);
  });

  it("flags a ZIP input inside an email/phone lead form (the structural fence)", () => {
    const piiForm = makeEl({
      tag: "form",
      query: { [PII_FORM_SELECTOR]: makeEl({ tag: "input", attrs: { type: "tel" } }) },
    });
    const wrapper = makeEl({ tag: "div", parent: piiForm });
    const input = makeEl({
      tag: "input",
      attrs: { type: "text", name: "zip" },
      parent: wrapper,
    });
    const probe = withDocument({ querySelector: () => input }, () => probeZipTarget("input"));
    expect(probe?.inPiiForm).toBe(true);
  });
});
