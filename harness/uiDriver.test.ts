/**
 * uiDriver.test.ts — the PURE selector-plan helpers, plus the generic verb
 * layer + recordDomState driven against a FAKE page (no real browser; the
 * choreography-specific verbs are exercised by the live UI-lane runs).
 */

import { describe, expect, it, vi } from "vitest";

import {
  planBatchRowDecisions,
  planFormActions,
  runIdFromPath,
  tid,
  UiDriver,
} from "./uiDriver.js";
import type { UiCheck } from "./evaluator.js";

// ---------------------------------------------------------------------------
// a fake Playwright page for the generic-verb + recordDomState unit tests
// ---------------------------------------------------------------------------

/** A scripted locator result keyed by the testid selector. */
interface FakeLocatorState {
  visible?: boolean;
  disabled?: boolean;
  text?: string;
  count?: number;
  /** getAttribute(name) → value (e.g. data-stage / data-decision). */
  attrs?: Record<string, string | null>;
}

/** Build a fake UiDriver whose page is scripted per selector. Bypasses the
 *  private constructor (compile-time only) — the verbs/recordDomState touch
 *  only page methods + this.checks/this.shot/this.screenshotDir. */
function fakeDriver(states: Record<string, FakeLocatorState> = {}): {
  driver: UiDriver;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const locator = (sel: string) => {
    const st = states[sel] ?? {};
    const node = {
      isVisible: () => Promise.resolve(st.visible ?? false),
      isDisabled: () => Promise.resolve(st.disabled ?? false),
      textContent: () => Promise.resolve(st.text ?? null),
      getAttribute: (name: string) => Promise.resolve(st.attrs?.[name] ?? null),
      // recordDomState's "visible" expect auto-waits via waitFor; the fake
      // resolves when scripted visible, rejects (the timeout twin) when not.
      waitFor: () =>
        st.visible ? Promise.resolve() : Promise.reject(new Error("not visible (fake timeout)")),
    };
    return {
      first: () => node,
      count: () => Promise.resolve(st.count !== undefined ? st.count : "disabled" in st ? 1 : st.visible ? 1 : 0),
      ...node,
    };
  };
  const page = {
    locator,
    waitForSelector: (...args: unknown[]) => {
      calls.push({ method: "waitForSelector", args });
      return Promise.resolve(null);
    },
    click: (...args: unknown[]) => {
      calls.push({ method: "click", args });
      return Promise.resolve();
    },
    fill: (...args: unknown[]) => {
      calls.push({ method: "fill", args });
      return Promise.resolve();
    },
    press: (...args: unknown[]) => {
      calls.push({ method: "press", args });
      return Promise.resolve();
    },
    reload: (...args: unknown[]) => {
      calls.push({ method: "reload", args });
      return Promise.resolve();
    },
    screenshot: () => Promise.resolve(Buffer.from("")),
  };
  // Construct without launching a browser. The private ctor is compile-time
  // only; cast through unknown to reach it from the test.
  const Ctor = UiDriver as unknown as new (...a: unknown[]) => UiDriver;
  const driver = new Ctor(null, null, page, "http://localhost", "/tmp/uc-test");
  // screenshot() writes a PNG — stub it so no disk write happens in unit tests.
  vi.spyOn(driver, "screenshot").mockResolvedValue("/tmp/uc-test/x.png");
  return { driver, calls };
}

const lastCheck = (driver: UiDriver): UiCheck => driver.checks[driver.checks.length - 1]!;

describe("planFormActions (case content → widget DOM actions)", () => {
  it("maps text/number fields to fill, radios to check, checkboxes to setChecked", () => {
    const actions = planFormActions({
      make: "Hyundai",
      search_radius_miles: 25,
      year: 2026,
      financing_preference: "finance",
      phone_policy: "fake",
      military_first_responder: 0,
      current_brand_owner: 1,
    });
    expect(actions).toContainEqual({ kind: "fill", testid: "intake-field-make", value: "Hyundai" });
    expect(actions).toContainEqual({ kind: "fill", testid: "intake-field-search_radius_miles", value: "25" });
    expect(actions).toContainEqual({ kind: "check", testid: "intake-field-year-2026" });
    expect(actions).toContainEqual({ kind: "check", testid: "intake-field-financing_preference-finance" });
    expect(actions).toContainEqual({ kind: "check", testid: "intake-field-phone_policy-fake" });
    expect(actions).toContainEqual({ kind: "setChecked", testid: "intake-field-military_first_responder", checked: false });
    expect(actions).toContainEqual({ kind: "setChecked", testid: "intake-field-current_brand_owner", checked: true });
  });

  it("skips null/absent fields — only fields present in the case content are touched", () => {
    const actions = planFormActions({ make: "Hyundai", trim: null });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ testid: "intake-field-make" });
  });
});

describe("planBatchRowDecisions (case rows → batch card drive plan)", () => {
  const TARGETS = [
    { dealer_id: "d-1", name: "Tustin Hyundai" },
    { dealer_id: "d-2", name: "Anaheim Hyundai" },
    { dealer_id: "d-3", name: "Harbor Hyundai" },
  ];

  it("rows=[] + default approve plans the explicit Select-all affordance", () => {
    expect(planBatchRowDecisions([], "approve", TARGETS)).toEqual({ kind: "select_all" });
  });

  it("resolves matches by NAME to dealer ids and fills unmatched rows from default_decision", () => {
    const plan = planBatchRowDecisions(
      [{ match: "Anaheim Hyundai", decision: "skip" }],
      "approve",
      TARGETS,
    );
    expect(plan).toEqual({
      kind: "rows",
      decisions: [
        { dealerId: "d-1", decision: "approve" },
        { dealerId: "d-2", decision: "skip" },
        { dealerId: "d-3", decision: "approve" },
      ],
    });
  });

  it("fails LOUD on a zero-match name (never picks by index)", () => {
    expect(() =>
      planBatchRowDecisions([{ match: "Nowhere Motors", decision: "approve" }], "approve", TARGETS),
    ).toThrow(/matched no suspend target/);
  });

  it("fails LOUD on an ambiguous name match", () => {
    const dup = [...TARGETS, { dealer_id: "d-4", name: "Tustin Hyundai" }];
    expect(() =>
      planBatchRowDecisions([{ match: "Tustin Hyundai", decision: "approve" }], "approve", dup),
    ).toThrow(/ambiguous/);
  });

  it("fails LOUD when a row is undecided (no match, no default_decision)", () => {
    expect(() =>
      planBatchRowDecisions([{ match: "Tustin Hyundai", decision: "approve" }], null, TARGETS),
    ).toThrow(/no default_decision/);
  });

  it("fails LOUD when an accept resolves to zero approves (all-skip — decline is the verb)", () => {
    expect(() => planBatchRowDecisions([], "skip", TARGETS)).toThrow(/ZERO approved rows/);
  });

  it("fails LOUD on an empty target set", () => {
    expect(() => planBatchRowDecisions([], "approve", [])).toThrow(/zero targets/);
  });
});

describe("runIdFromPath / tid", () => {
  it("parses /runs/:id and rejects other routes", () => {
    expect(runIdFromPath("/runs/abc-123")).toBe("abc-123");
    expect(runIdFromPath("/runs/abc-123/")).toBe("abc-123");
    expect(runIdFromPath("/profiles/p1")).toBeNull();
    expect(runIdFromPath("/")).toBeNull();
  });

  it("tid builds the stable data-testid selector", () => {
    expect(tid("chat-send")).toBe('[data-testid="chat-send"]');
  });
});

describe("generic verb layer (clickTestid / fillTestid / pressKey / reloadBrowser)", () => {
  it("clickTestid waits for then clicks the kebab-case data-testid selector", async () => {
    const { driver, calls } = fakeDriver();
    await driver.clickTestid("topbar-searches");
    expect(calls).toEqual([
      { method: "waitForSelector", args: ['[data-testid="topbar-searches"]', { timeout: 20_000 }] },
      { method: "click", args: ['[data-testid="topbar-searches"]'] },
    ]);
  });

  it("fillTestid fills the selector with the value", async () => {
    const { driver, calls } = fakeDriver();
    await driver.fillTestid("searches-filter", "Tucson");
    expect(calls).toContainEqual({ method: "fill", args: ['[data-testid="searches-filter"]', "Tucson"] });
  });

  it("pressKey presses the key on the selector", async () => {
    const { driver, calls } = fakeDriver();
    await driver.pressKey("chat-input-textarea", "Enter");
    expect(calls).toContainEqual({ method: "press", args: ['[data-testid="chat-input-textarea"]', "Enter"] });
  });

  it("reloadBrowser reloads then waits for the app shell", async () => {
    const { driver, calls } = fakeDriver();
    await driver.reloadBrowser();
    expect(calls[0]).toEqual({ method: "reload", args: [{ waitUntil: "domcontentloaded" }] });
    expect(calls[1]).toEqual({ method: "waitForSelector", args: ['[data-testid="app-main"]', { timeout: 20_000 }] });
  });
});

describe("hygiene_review verbs (the dealer_hygiene per-stage cleanup card)", () => {
  const SEL = (id: string) => `[data-testid="${id}"]`;

  it("readHygieneStage returns the hygiene-stage data-stage value", async () => {
    const { driver } = fakeDriver({ [SEL("hygiene-stage")]: { attrs: { "data-stage": "orphans" } } });
    expect(await driver.readHygieneStage()).toBe("orphans");
  });

  it("readHygieneStage fails loud when data-stage is missing", async () => {
    const { driver } = fakeDriver({ [SEL("hygiene-stage")]: {} });
    await expect(driver.readHygieneStage()).rejects.toThrow(/no data-stage/);
  });

  it("decideHygieneRow clicks hygiene-<decision>-<id> and asserts the row flipped", async () => {
    const { driver, calls } = fakeDriver({
      [SEL("hygiene-row-t-1")]: { attrs: { "data-decision": "approve" } },
    });
    await driver.decideHygieneRow("t-1", "approve");
    expect(calls).toContainEqual({ method: "click", args: ['[data-testid="hygiene-approve-t-1"]'] });
  });

  it("decideHygieneRow throws when the row's data-decision did not flip", async () => {
    const { driver } = fakeDriver({
      [SEL("hygiene-row-t-1")]: { attrs: { "data-decision": "undecided" } },
    });
    await expect(driver.decideHygieneRow("t-1", "approve")).rejects.toThrow(/data-decision="undecided"/);
  });

  it("checkHygieneCounter records ok when the counter text matches", async () => {
    const { driver } = fakeDriver({ [SEL("hygiene-counter")]: { text: "2/2 decided" } });
    await driver.checkHygieneCounter(2, 2);
    expect(lastCheck(driver)).toMatchObject({ surface: "dom:gate-banner", ok: true });
  });

  it("checkHygieneCounter records ok:false (never throws) on a mismatch", async () => {
    const { driver } = fakeDriver({ [SEL("hygiene-counter")]: { text: "1/2 decided" } });
    await driver.checkHygieneCounter(2, 2);
    expect(lastCheck(driver).ok).toBe(false);
  });

  it("clickHygieneDecline waits for then clicks the always-enabled decline", async () => {
    const { driver, calls } = fakeDriver();
    await driver.clickHygieneDecline();
    expect(calls).toContainEqual({ method: "click", args: ['[data-testid="hygiene-decline"]'] });
  });
});

describe("recordDomState (pushes a UiCheck with the right ok/fail)", () => {
  // The fake page keys its scripted states by the EXACT selector string the
  // verb builds. Exact and prefix selectors are different strings, so scripting
  // both forms lets the prefix test genuinely exercise data-testid^= (not a
  // spurious green): the SAME row family resolves count 0 under the exact
  // selector and count N under the prefix selector.
  const SEL = (id: string) => `[data-testid="${id}"]`;
  const PREFIX_SEL = (id: string) => `[data-testid^="${id}"]`;

  it("visible: ok when the widget is visible, fail when not", async () => {
    const ok = fakeDriver({ [SEL("searches-popover")]: { visible: true } }).driver;
    await ok.recordDomState("searches-popover", "visible");
    expect(lastCheck(ok)).toMatchObject({ surface: "dom:searches-popover", expected: "visible", ok: true });

    const bad = fakeDriver({ [SEL("searches-popover")]: { visible: false } }).driver;
    await bad.recordDomState("searches-popover", "visible");
    expect(lastCheck(bad).ok).toBe(false);
  });

  it("absent: ok when zero widgets match, fail when any present", async () => {
    const ok = fakeDriver({ [SEL("gate-banner")]: { count: 0 } }).driver;
    await ok.recordDomState("gate-banner", "absent");
    expect(lastCheck(ok)).toMatchObject({ expected: "absent", ok: true });

    const bad = fakeDriver({ [SEL("gate-banner")]: { count: 1 } }).driver;
    await bad.recordDomState("gate-banner", "absent");
    expect(lastCheck(bad).ok).toBe(false);
  });

  it("text: ok when the content carries the substring, fail otherwise", async () => {
    const ok = fakeDriver({ [SEL("turn-zone-text")]: { text: "5 dealer(s) discovered" } }).driver;
    await ok.recordDomState("turn-zone-text", "text", "discovered");
    expect(lastCheck(ok)).toMatchObject({ expected: 'text contains "discovered"', ok: true });

    const bad = fakeDriver({ [SEL("turn-zone-text")]: { text: "nothing here" } }).driver;
    await bad.recordDomState("turn-zone-text", "text", "discovered");
    expect(lastCheck(bad).ok).toBe(false);
  });

  it("count: ok when the match count equals the expected count", async () => {
    const ok = fakeDriver({ [SEL("searches-row-")]: { count: 2 } }).driver;
    await ok.recordDomState("searches-row-", "count", undefined, 2);
    expect(lastCheck(ok)).toMatchObject({ expected: "2 matching widget(s)", ok: true });

    const bad = fakeDriver({ [SEL("searches-row-")]: { count: 3 } }).driver;
    await bad.recordDomState("searches-row-", "count", undefined, 2);
    expect(lastCheck(bad).ok).toBe(false);
  });

  it("disabled: ok when the widget is disabled, fail (enabled vs absent) otherwise", async () => {
    const ok = fakeDriver({ [SEL("intake-submit")]: { count: 1, disabled: true } }).driver;
    await ok.recordDomState("intake-submit", "disabled");
    expect(lastCheck(ok)).toMatchObject({ expected: "disabled", observed: "disabled", ok: true });

    // present but not disabled → "enabled" (distinct from absence).
    const enabled = fakeDriver({ [SEL("intake-submit")]: { count: 1, disabled: false } }).driver;
    await enabled.recordDomState("intake-submit", "disabled");
    expect(lastCheck(enabled)).toMatchObject({ observed: "enabled", ok: false });

    // no element at all → "absent" (not conflated with "enabled").
    const missing = fakeDriver({ [SEL("intake-submit")]: { count: 0 } }).driver;
    await missing.recordDomState("intake-submit", "disabled");
    expect(lastCheck(missing)).toMatchObject({ observed: "absent", ok: false });
  });

  it("exact (default) targets one specific testid via data-testid=", async () => {
    const ok = fakeDriver({ [SEL("intake-submit")]: { count: 1, disabled: true } }).driver;
    await ok.recordDomState("intake-submit", "disabled"); // match defaults to "exact"
    expect(lastCheck(ok)).toMatchObject({ selector: SEL("intake-submit"), ok: true });

    const vis = fakeDriver({ [SEL("approval-prompt")]: { visible: true } }).driver;
    await vis.recordDomState("approval-prompt", "visible", undefined, undefined, "exact");
    expect(lastCheck(vis)).toMatchObject({ selector: SEL("approval-prompt"), ok: true });
  });

  it("prefix: count + absent target a dynamic-id family via data-testid^=", async () => {
    // The SAME row family scripted under both selector forms: exact resolves 0
    // (no widget's testid is literally "searches-row-"), prefix resolves N.
    const states = {
      [SEL("searches-row-")]: { count: 0 },
      [PREFIX_SEL("searches-row-")]: { count: 3 },
    };

    // exact count against the family is wrong (0 ≠ 3) — proves the modes differ.
    const exact = fakeDriver(states).driver;
    await exact.recordDomState("searches-row-", "count", undefined, 3, "exact");
    expect(lastCheck(exact)).toMatchObject({ selector: SEL("searches-row-"), ok: false });

    // prefix count matches the real family size.
    const prefix = fakeDriver(states).driver;
    await prefix.recordDomState("searches-row-", "count", undefined, 3, "prefix");
    expect(lastCheck(prefix)).toMatchObject({ selector: PREFIX_SEL("searches-row-"), ok: true });

    // prefix absent: ok only when the family is empty.
    const absentBad = fakeDriver(states).driver;
    await absentBad.recordDomState("searches-row-", "absent", undefined, undefined, "prefix");
    expect(lastCheck(absentBad)).toMatchObject({ selector: PREFIX_SEL("searches-row-"), ok: false });

    const absentOk = fakeDriver({ [PREFIX_SEL("searches-row-")]: { count: 0 } }).driver;
    await absentOk.recordDomState("searches-row-", "absent", undefined, undefined, "prefix");
    expect(lastCheck(absentOk)).toMatchObject({ selector: PREFIX_SEL("searches-row-"), ok: true });
  });
});
