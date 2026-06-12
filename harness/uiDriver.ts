/**
 * uiDriver — the UI-lane user-action driver. Launches its OWN Playwright
 * chromium (the TEST driver browser — distinct from the product's browser
 * service, which the SUT launches itself for dealer_geosearch scans), opens the
 * REAL built dashboard served by the SUT, and exposes the user-action verbs the
 * case resume scripts need: type into the chat rail, fill the rendered intake
 * form by its real widgets, click the real Submit/Cancel/override buttons,
 * launch a skill from the top-bar Skills popover's Run button, and wait for the
 * turn's terminal rendering.
 *
 * Every verb acts through the DOM exactly as a non-technical user would —
 * NEVER through POST /api/skill-runs or /form-decision (the API lane owns
 * those). The driver also CAPTURES real DOM-derived ui_checks (form rendered
 * before any prose, gate-zone-precedes-prose document order, seeded prefill
 * visible, terminal summary visible) plus a screenshot per check moment into
 * the evidence dir, so the verdict's ui_checks are dashboard-DOM facts, not
 * API re-pulls alone.
 *
 * Selector surface: the committed stable data-testid set only
 * (chat-input-textarea / chat-send / intake-form / intake-field-<name> /
 * intake-submit / intake-decline / gate-force-override-* / topbar-skills /
 * skills-popover / ledger-run-<skill> (the popover row's Run button) /
 * gate-banner / assistant-turn[data-status] / turn-zone-* / turn-declined /
 * turn-error / stop-card[data-stop-code] / stop-intake-cta / stop-pick-option /
 * turn-resolution[data-resolution]).
 *
 * Dependency wall: harness layer, with ONE sanctioned exception — this module
 * imports `playwright` to drive the test browser (the dependency-cruiser rule
 * carves out exactly this file, mirroring the apps/ui/e2e carve-out). It still
 * NEVER touches the product DB or a provider.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { UiCheck } from "./evaluator.js";

// ---------------------------------------------------------------------------
// the pure selector plan (L1-testable, no browser)
// ---------------------------------------------------------------------------

/** One DOM action the form-fill performs (derived from the case content). */
export type FormAction =
  | { kind: "fill"; testid: string; value: string }
  | { kind: "check"; testid: string }
  | { kind: "setChecked"; testid: string; checked: boolean };

/** Radio-group fields whose option inputs carry `intake-field-<name>-<value>`. */
const RADIO_FIELDS = new Set(["year", "financing_preference", "phone_policy"]);
/** Checkbox (0|1) fields. */
const CHECKBOX_FIELDS = new Set(["military_first_responder", "current_brand_owner"]);

/**
 * Map case-content fields onto the rendered widgets' DOM actions. ONLY fields
 * present (and non-null) in the content are acted on — null/absent fields stay
 * exactly as the form rendered them (seeded or empty). Mirrors the UI's widget
 * map (formModel WIDGET_BY_FIELD) by field name.
 */
export function planFormActions(fields: Record<string, unknown>): FormAction[] {
  const actions: FormAction[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const testid = `intake-field-${name}`;
    if (RADIO_FIELDS.has(name)) {
      actions.push({ kind: "check", testid: `${testid}-${String(value)}` });
    } else if (CHECKBOX_FIELDS.has(name)) {
      actions.push({ kind: "setChecked", testid, checked: value === 1 || value === true });
    } else {
      actions.push({ kind: "fill", testid, value: String(value) });
    }
  }
  return actions;
}

/** data-testid → CSS selector. */
export function tid(id: string): string {
  return `[data-testid="${id}"]`;
}

/** Parse the run id off a /runs/:id pathname, or null. */
export function runIdFromPath(pathname: string): string | null {
  const m = /^\/runs\/([^/]+)\/?$/.exec(pathname);
  return m === null ? null : decodeURIComponent(m[1]!);
}

// ---------------------------------------------------------------------------
// the driver
// ---------------------------------------------------------------------------

export interface UiDriverOpts {
  /** The SUT base URL (the server host serving the built SPA). */
  baseUrl: string;
  /** Where the per-check screenshots land (created if absent). */
  screenshotDir: string;
  /** Headless test browser (default true). */
  headless?: boolean;
}

/** Terminal statuses an assistant turn renders via data-status. */
export type UiTerminal = "done" | "declined" | "error";

const TERMINAL_SELECTOR = (["done", "declined", "error"] as const)
  .map((s) => `${tid("assistant-turn")}[data-status="${s}"]`)
  .join(", ");

const DEFAULT_TIMEOUT = 20_000;

export class UiDriver {
  readonly checks: UiCheck[] = [];
  private shot = 0;
  private screenshotDir: string;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly baseUrl: string,
    screenshotDir: string,
  ) {
    this.screenshotDir = screenshotDir;
  }

  /** Start a new case STEP: screenshots land in the step's evidence dir and the
   *  accumulated checks reset (one ui_checks set per verdict). The browser
   *  session itself persists — the whole case is one user journey. */
  beginStep(screenshotDir: string): void {
    mkdirSync(screenshotDir, { recursive: true });
    this.screenshotDir = screenshotDir;
    this.checks.length = 0;
    this.shot = 0;
  }

  /** Launch the TEST chromium and open the dashboard shell (waits for the SPA
   *  main region — proves GET / served the real app shell, not a 404). */
  static async launch(opts: UiDriverOpts): Promise<UiDriver> {
    mkdirSync(opts.screenshotDir, { recursive: true });
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const driver = new UiDriver(browser, context, page, opts.baseUrl.replace(/\/$/, ""), opts.screenshotDir);
    await page.goto(driver.baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(tid("app-main"), { timeout: DEFAULT_TIMEOUT });
    return driver;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /** Screenshot the current viewport into the evidence dir (small PNG). */
  async screenshot(name: string): Promise<string> {
    this.shot += 1;
    const file = join(this.screenshotDir, `${String(this.shot).padStart(2, "0")}-${name}.png`);
    await this.page.screenshot({ path: file }).catch(() => {});
    return file;
  }

  // ---- user-action verbs ---------------------------------------------------

  /** Type into the REAL chat-rail textarea and click the Send button (the
   *  committed submit affordance; Enter is the keyboard twin). */
  async typeInChatRail(text: string): Promise<void> {
    await this.page.fill(tid("chat-input-textarea"), text);
    await this.page.click(tid("chat-send"));
  }

  /** Wait for the SPA to navigate to a run view and return its run id. Pass the
   *  previous run id so a step launched FROM an old run view waits for the NEW
   *  route, not the one already showing. */
  async waitForRunRoute(notRunId: string | null = null, timeoutMs = DEFAULT_TIMEOUT): Promise<string> {
    await this.page.waitForURL(
      (url) => {
        const id = runIdFromPath(url.pathname);
        return id !== null && id !== notRunId;
      },
      { timeout: timeoutMs },
    );
    const id = runIdFromPath(new URL(this.page.url()).pathname);
    if (id === null) throw new Error(`uiDriver: expected a /runs/:id route, got ${this.page.url()}`);
    return id;
  }

  /** Wait for the rendered intake form (the data_collection suspend surface). */
  async waitForIntakeForm(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("intake-form"), { timeout: timeoutMs });
  }

  /** Fill the rendered form through its real widgets. Opens the collapsed
   *  optional <details> section first (a real user click) so optional fields
   *  are interactable. ONLY fields present in `fields` are touched. */
  async fillRenderedForm(fields: Record<string, unknown>): Promise<void> {
    const optional = this.page.locator(tid("intake-section-optional"));
    if (
      (await optional.count()) > 0 &&
      !(await optional.evaluate((el) => (el as unknown as { open: boolean }).open))
    ) {
      await optional.locator("summary").click();
    }
    for (const action of planFormActions(fields)) {
      const sel = tid(action.testid);
      if (action.kind === "fill") await this.page.fill(sel, action.value);
      else if (action.kind === "check") await this.page.check(sel);
      else await this.page.setChecked(sel, action.checked);
    }
  }

  /** Click the real "Submit intake" button (waits for it to enable). */
  async clickSubmit(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("intake-submit")}:not([disabled])`, { timeout: timeoutMs });
    await this.page.click(tid("intake-submit"));
  }

  /** Click the real form Cancel (decline — terminal, zero write). */
  async clickDecline(): Promise<void> {
    await this.page.click(tid("intake-decline"));
  }

  /** Wait for the force-override gate card to render. */
  async waitForForceOverrideGate(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("gate-force-override"), { timeout: timeoutMs });
  }

  /** Confirm the force-override gate: fill the audited reason, click confirm. */
  async clickForceOverrideConfirm(reason: string): Promise<void> {
    await this.page.fill(tid("gate-force-override-reason"), reason);
    await this.page.click(tid("gate-force-override-confirm"));
  }

  /** Decline at the force-override gate. */
  async clickForceOverrideDecline(): Promise<void> {
    await this.page.click(tid("gate-force-override-decline"));
  }

  /** Open the top-bar Skills popover: wait for the trigger to be visible, click
   *  it, wait for the panel. The popover refetches profiles+skills on every
   *  open, so a just-created profile flips the pin-gated Run buttons enabled
   *  without any page navigation. */
  async openSkillsPopover(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("topbar-skills"), { timeout: timeoutMs });
    await this.page.click(tid("topbar-skills"));
    await this.page.waitForSelector(tid("skills-popover"), { timeout: timeoutMs });
  }

  /** Launch a skill from the Skills popover's real Run button (waits for the
   *  pin gate to enable it — `:not([disabled])` on a real <button>). No
   *  return-to-Home step: the popover is reachable from every route. */
  async launchSkillFromPopover(skillId: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.openSkillsPopover(timeoutMs);
    const sel = `${tid(`ledger-run-${skillId}`)}:not([disabled])`;
    await this.page.waitForSelector(sel, { timeout: timeoutMs });
    await this.page.click(sel);
  }

  /** checkStopCard: the typed profile-resolution STOP card rendered with the
   *  expected stop code (data-stop-code). Records ok:false on a missing card
   *  rather than throwing, so the verdict carries the evidence. */
  async checkStopCard(kind: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    let code: string | null = null;
    try {
      await this.page.waitForSelector(tid("stop-card"), { timeout: timeoutMs });
      code = await this.page.locator(tid("stop-card")).last().getAttribute("data-stop-code");
    } catch {
      code = null; // no card rendered — recorded below as a failed check.
    }
    this.record({
      surface: "dom:chat-rail",
      selector: tid("stop-card"),
      expected: `STOP card with data-stop-code="${kind}"`,
      observed: code === null ? "no stop card rendered" : `data-stop-code=${code}`,
      ok: code === kind,
    });
    await this.screenshot(`stop-card-${kind}`);
  }

  /** clickStopIntakeCta: drive the 0-active/missing-fields STOP card's intake
   *  CTA — a REAL intake run must start and render its form (zero-LLM until a
   *  submit, so this stays free). */
  async clickStopIntakeCta(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("stop-intake-cta"), { timeout: timeoutMs });
    await this.page.click(tid("stop-intake-cta"));
    let formVisible = true;
    try {
      await this.page.waitForSelector(tid("intake-form"), { timeout: timeoutMs });
    } catch {
      formVisible = false;
    }
    this.record({
      surface: "dom:chat-rail",
      selector: `${tid("stop-intake-cta")} → ${tid("intake-form")}`,
      expected: "intake CTA click starts a real intake run (form renders)",
      observed: formVisible ? "intake form rendered" : "no intake form after CTA click",
      ok: formVisible,
    });
    await this.screenshot("stop-intake-cta");
  }

  /** pickProfileStopOption: click the 2+-profiles STOP picker option whose
   *  VISIBLE text equals the vehicle label. Zero or ambiguous matches fail
   *  LOUD (never pick by index). The click re-launches the skill as a NEW run. */
  async pickProfileStopOption(label: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("stop-pick-option"), { timeout: timeoutMs });
    const options = this.page.locator(tid("stop-pick-option"));
    const texts = await options.allTextContents();
    const want = label.trim();
    const matches = texts
      .map((t, i) => ({ text: t.trim(), i }))
      .filter((x) => x.text === want);
    if (matches.length === 0) {
      throw new Error(
        `uiDriver: no STOP picker option labeled "${want}" (options: ${texts.map((t) => t.trim()).join(" | ")})`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`uiDriver: ambiguous STOP picker label "${want}" (${matches.length} matches)`);
    }
    this.record({
      surface: "dom:chat-rail",
      selector: tid("stop-pick-option"),
      expected: `exactly one picker option labeled "${want}"`,
      observed: `options: ${texts.map((t) => t.trim()).join(" | ")}`,
      ok: true,
    });
    await this.screenshot("stop-pick");
    await options.nth(matches[0]!.i).click();
  }

  /** checkMismatchBanner: the resolution-provenance meta tag on the rendered
   *  turn matches the expected branch — `pinned` when an explicit pin was
   *  honored, `inferred_newest` when the single-active inference ran. */
  async checkMismatchBanner(pinned: boolean, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    const expected = pinned ? "pinned" : "inferred_newest";
    let observed: string | null = null;
    try {
      await this.page.waitForSelector(tid("turn-resolution"), { timeout: timeoutMs });
      observed = await this.page.locator(tid("turn-resolution")).last().getAttribute("data-resolution");
    } catch {
      observed = null;
    }
    this.record({
      surface: "dom:chat-rail",
      selector: tid("turn-resolution"),
      expected: `resolution meta "${expected}"`,
      observed: observed === null ? "no resolution meta rendered" : `data-resolution=${observed}`,
      ok: observed === expected,
    });
    await this.screenshot(`resolution-${expected}`);
  }

  /** Wait until the active assistant turn reaches a terminal rendering
   *  (data-status done|declined|error) and return which. */
  async waitForTerminal(timeoutMs = DEFAULT_TIMEOUT): Promise<UiTerminal> {
    const el = await this.page.waitForSelector(TERMINAL_SELECTOR, { timeout: timeoutMs });
    const status = await el.getAttribute("data-status");
    if (status === "done" || status === "declined" || status === "error") return status;
    throw new Error(`uiDriver: unexpected terminal data-status "${String(status)}"`);
  }

  // ---- DOM-derived ui_checks (each records + screenshots one moment) --------

  private record(check: UiCheck): void {
    this.checks.push(check);
  }

  /** form_rendered: the intake form is visible while the turn's prose zone has
   *  not rendered any answer yet (form BEFORE any prose). Call right after
   *  waitForIntakeForm. */
  async checkFormRenderedBeforeProse(): Promise<void> {
    // String-form evaluate: the harness tsconfig has no DOM lib, and this
    // snippet runs inside the page anyway.
    const observed = (await this.page.evaluate(
      `(() => {
        const form = document.querySelector('[data-testid="intake-form"]');
        const text = document.querySelector('[data-testid="turn-zone-text"]');
        return {
          formVisible: form !== null,
          proseText: text === null ? "" : (text.textContent ?? "").trim(),
        };
      })()`,
    )) as { formVisible: boolean; proseText: string };
    this.record({
      surface: "dom:chat-rail",
      selector: tid("intake-form"),
      expected: "form visible with no prose answer rendered yet",
      observed: `formVisible=${observed.formVisible} prose="${observed.proseText.slice(0, 60)}"`,
      ok: observed.formVisible && observed.proseText === "",
    });
    await this.screenshot("form-rendered");
  }

  /** gate_before_prose: the gate zone PRECEDES the prose/meta zones in document
   *  order inside the rendered turn (compareDocumentPosition — real DOM order,
   *  not timestamps). Call while a gate/form is showing. */
  async checkGateBeforeProse(): Promise<void> {
    const observed = (await this.page.evaluate(
      `(() => {
        const gate = document.querySelector('[data-testid="turn-zone-gate"]');
        const meta = document.querySelector('[data-testid="turn-zone-meta"]');
        const text = document.querySelector('[data-testid="turn-zone-text"]');
        if (gate === null || meta === null) return { gate: gate !== null, gateBeforeMeta: false, gateBeforeText: null };
        const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
        return {
          gate: true,
          gateBeforeMeta: Boolean(gate.compareDocumentPosition(meta) & FOLLOWING),
          gateBeforeText: text === null ? null : Boolean(gate.compareDocumentPosition(text) & FOLLOWING),
        };
      })()`,
    )) as { gate: boolean; gateBeforeMeta: boolean; gateBeforeText: boolean | null };
    this.record({
      surface: "dom:chat-rail",
      selector: `${tid("turn-zone-gate")} vs ${tid("turn-zone-text")}/${tid("turn-zone-meta")}`,
      expected: "gate zone precedes prose/meta zones in DOM order",
      observed: `gate=${observed.gate} gateBeforeMeta=${observed.gateBeforeMeta} gateBeforeText=${String(observed.gateBeforeText)}`,
      ok: observed.gate && observed.gateBeforeMeta && observed.gateBeforeText !== false,
    });
    await this.screenshot("gate-before-prose");
  }

  /** banner_gate_before_prose: the app-level gate banner host PRECEDES the main
   *  workbench region and any prose zone in document order
   *  (compareDocumentPosition — the same mechanism as the rail-track check;
   *  the banner track holds gate-before-prose by mount position, the rail by
   *  zone order). The banner host never reuses turn-zone-gate. */
  async checkBannerGateBeforeProse(): Promise<void> {
    const observed = (await this.page.evaluate(
      `(() => {
        const banner = document.querySelector('[data-testid="gate-banner"]');
        const main = document.querySelector('[data-testid="app-main"]');
        const text = document.querySelector('[data-testid="turn-zone-text"]');
        if (banner === null || main === null) return { banner: banner !== null, bannerBeforeMain: false, bannerBeforeText: null };
        const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
        return {
          banner: true,
          bannerBeforeMain: Boolean(banner.compareDocumentPosition(main) & FOLLOWING),
          bannerBeforeText: text === null ? null : Boolean(banner.compareDocumentPosition(text) & FOLLOWING),
        };
      })()`,
    )) as { banner: boolean; bannerBeforeMain: boolean; bannerBeforeText: boolean | null };
    this.record({
      surface: "dom:app-shell",
      selector: `${tid("gate-banner")} vs ${tid("app-main")}/${tid("turn-zone-text")}`,
      expected: "gate banner host precedes app-main and any prose zone in DOM order",
      observed: `banner=${observed.banner} bannerBeforeMain=${observed.bannerBeforeMain} bannerBeforeText=${String(observed.bannerBeforeText)}`,
      ok: observed.banner && observed.bannerBeforeMain && observed.bannerBeforeText !== false,
    });
    await this.screenshot("banner-gate-before-prose");
  }

  /** form_seeded (freeform): at least one field widget VISIBLY carries a
   *  prefilled value before the driver touches anything. Prefill values are
   *  LLM-nondeterministic, so this asserts presence-of-any-seed, never exact
   *  values. Call after waitForIntakeForm, BEFORE fillRenderedForm. */
  async checkFormSeeded(): Promise<void> {
    const observed = (await this.page.evaluate(
      `(() => {
        const widgets = Array.from(document.querySelectorAll('[data-testid^="intake-field-"]'));
        const seeded = [];
        for (const w of widgets) {
          if (w instanceof HTMLInputElement) {
            if ((w.type === "radio" || w.type === "checkbox") && w.checked) {
              seeded.push(w.getAttribute("data-testid") ?? "");
            } else if (w.type !== "radio" && w.type !== "checkbox" && w.value.trim() !== "") {
              seeded.push(w.getAttribute("data-testid") ?? "");
            }
          }
        }
        return seeded;
      })()`,
    )) as string[];
    this.record({
      surface: "dom:intake-form",
      selector: '[data-testid^="intake-field-"]',
      expected: ">=1 field visibly prefilled from the prose (any seed)",
      observed: observed.length === 0 ? "no seeded fields" : `seeded: ${observed.slice(0, 6).join(", ")}`,
      ok: observed.length > 0,
    });
    await this.screenshot("form-seeded");
  }

  /** terminal_summary_visible: the terminal rendering matches the terminal kind
   *  (done → non-empty prose summary; declined → the cancelled line; error →
   *  the error line). Call after waitForTerminal. */
  async checkTerminalSummaryVisible(terminal: UiTerminal): Promise<void> {
    const observed = (await this.page.evaluate(
      `(() => {
        const text = document.querySelector('[data-testid="turn-zone-text"]');
        const declined = document.querySelector('[data-testid="turn-declined"]');
        const error = document.querySelector('[data-testid="turn-error"]');
        return {
          proseText: text === null ? "" : (text.textContent ?? "").trim(),
          declinedVisible: declined !== null,
          errorVisible: error !== null,
        };
      })()`,
    )) as { proseText: string; declinedVisible: boolean; errorVisible: boolean };
    const ok =
      terminal === "done"
        ? observed.proseText.length > 0
        : terminal === "declined"
          ? observed.declinedVisible
          : observed.errorVisible;
    this.record({
      surface: "dom:chat-rail",
      selector: terminal === "done" ? tid("turn-zone-text") : terminal === "declined" ? tid("turn-declined") : tid("turn-error"),
      expected: `terminal "${terminal}" rendering visible`,
      observed:
        terminal === "done"
          ? `summary="${observed.proseText.slice(0, 80)}"`
          : `declinedVisible=${observed.declinedVisible} errorVisible=${observed.errorVisible}`,
      ok,
    });
    await this.screenshot(`terminal-${terminal}`);
  }

  /** run_started_from_ui: the SPA navigated to /runs/:id and the run view shows
   *  the same id (the UI action — not an API POST — started this run). */
  async checkRunViewBound(runId: string): Promise<void> {
    const shown = await this.page
      .locator(tid("run-view-id"))
      .first()
      .textContent()
      .catch(() => null);
    this.record({
      surface: "dom:run-view",
      selector: tid("run-view-id"),
      expected: `run view bound to ${runId}`,
      observed: `shown=${String(shown).trim()}`,
      ok: shown !== null && shown.trim() === runId,
    });
    await this.screenshot("run-view-bound");
  }

  /** Read the terminal prose summary text (for the empty-result waiver signal —
   *  the geosearch confirm step's summary is a deterministic zero-LLM template). */
  async terminalSummaryText(): Promise<string> {
    const text = await this.page
      .locator(tid("turn-zone-text"))
      .first()
      .textContent()
      .catch(() => null);
    return (text ?? "").trim();
  }
}
