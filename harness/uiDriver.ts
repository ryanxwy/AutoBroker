/**
 * uiDriver — the UI-lane user-action driver. Launches its OWN Playwright
 * chromium (the TEST driver browser — distinct from the product's browser
 * service, which the SUT launches itself for dealer_geosearch scans), opens the
 * REAL built dashboard served by the SUT, and exposes the user-action verbs the
 * case resume scripts need: type into the chat rail, fill the rendered intake
 * form by its real widgets, click the real Submit/Cancel/override buttons,
 * launch a skill from the chat-rail Skills tray's Run button, and wait for the
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
 * intake-submit / intake-decline / gate-intake-confirm-* / rail-skills-toggle /
 * skills-list / ledger-run-<skill> (the rail Skills-tray row's Run button) /
 * gate-banner / assistant-turn[data-status] / turn-zone-* / turn-declined /
 * turn-error / stop-card[data-stop-code] / stop-intake-cta / stop-pick-option /
 * turn-resolution[data-resolution] / batch-review-card / batch-row-<id> /
 * batch-approve-<id> / batch-skip-<id> / batch-select-all / batch-counter /
 * batch-submit / batch-decline / batch-skip-all / inbox-review-card / inbox-row-<dealerId> /
 * inbox-approve-<dealerId> / inbox-skip-<dealerId> / inbox-select-all /
 * inbox-counter / inbox-submit / inbox-decline / hygiene-review-card /
 * hygiene-stage[data-stage] / hygiene-row-<id> / hygiene-approve-<id> /
 * hygiene-skip-<id> / hygiene-select-all / hygiene-counter / hygiene-submit /
 * hygiene-decline / topbar-searches / searches-popover /
 * searches-row-<profileId> / searches-pin-<profileId> /
 * searches-unpin-<profileId> / session-pin / session-pin-popover (the rail's
 * per-session pin toggle) / rail-pin-title / pin-chip-unpin / canvas-summary /
 * canvas-tabs / canvas-tab-<key> (overview|dealers|inventory|quotes|replies|
 * incentives — the workbench tab strip; a domain's section testids render ONLY
 * once its tab is clicked, so a func case clicks canvas-tab-<domain> before
 * touching them) / canvas-panel-<key> / canvas-vehicle /
 * portfolio-board / portfolio-segment-<slug> / portfolio-card-<profileId> /
 * portfolio-health-<profileId> / portfolio-stage-<profileId> /
 * portfolio-status-bar / portfolio-status-link / needs-you-widget /
 * needs-you-item-<runId>).
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

// ---------------------------------------------------------------------------
// the pure batch-review row plan (L1-testable, no browser)
// ---------------------------------------------------------------------------

/** One suspend-payload target the row plan resolves names against. */
export interface BatchTarget {
  dealer_id: string;
  name: string;
}

/** The planned DOM drive for a batch_review accept: either the card's explicit
 *  Select-all button (rows=[] + default approve — the user affordance), or an
 *  ordered per-row decision list. */
export type BatchRowPlan =
  | { kind: "select_all" }
  | { kind: "rows"; decisions: Array<{ dealerId: string; decision: "approve" | "skip" }> };

/**
 * Resolve a case's batch row script against the suspend payload's targets.
 * Every `match` is a dealer NAME resolved to its dealer_id — zero or ambiguous
 * matches fail LOUD (never by index); `defaultDecision` covers unmatched rows
 * (its absence with unmatched rows also fails loud). An accept that resolves
 * to ZERO approves is rejected here too: the resume schema requires min-1 ids,
 * so an all-skip accept can never reach the wire — decline is the stop verb.
 */
export function planBatchRowDecisions(
  rows: Array<{ match: string; decision: "approve" | "skip" }>,
  defaultDecision: "approve" | "skip" | null,
  targets: BatchTarget[],
): BatchRowPlan {
  if (targets.length === 0) {
    throw new Error("batch plan: the suspend payload carries zero targets — nothing to review");
  }
  if (rows.length === 0 && defaultDecision === "approve") {
    return { kind: "select_all" };
  }
  const byId = new Map<string, "approve" | "skip">();
  for (const row of rows) {
    const want = row.match.trim();
    const matches = targets.filter((t) => t.name.trim() === want);
    if (matches.length === 0) {
      throw new Error(
        `batch plan: row match "${want}" matched no suspend target (targets: ${targets.map((t) => t.name).join(" | ")})`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`batch plan: row match "${want}" is ambiguous (${matches.length} targets share the name)`);
    }
    const id = matches[0]!.dealer_id;
    if (byId.has(id)) {
      throw new Error(`batch plan: target "${want}" decided twice by the row script`);
    }
    byId.set(id, row.decision);
  }
  const decisions = targets.map((t) => {
    const decision = byId.get(t.dealer_id) ?? defaultDecision;
    if (decision === null) {
      throw new Error(
        `batch plan: target "${t.name}" has no row entry and no default_decision — every row must be decided`,
      );
    }
    return { dealerId: t.dealer_id, decision };
  });
  if (!decisions.some((d) => d.decision === "approve")) {
    throw new Error(
      "batch plan: an accept resolved to ZERO approved rows (min-1 ids on the wire) — author a decline instead",
    );
  }
  return { kind: "rows", decisions };
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

  /** typeInChatRailHumanized (T2-U1): drive the chat-rail textarea PER-KEYSTROKE
   *  (real keydown/input events — exercising ChatInput's per-key auto-grow effect,
   *  the IME/keyCode guard, and the slash autocomplete that page.fill's atomic
   *  value-set never touches), then click Send. A DETERMINISTIC typo+backspace is
   *  injected at a fixed positional index (NOT Math.random — the func lane must be
   *  byte-identical across runs): at the midpoint character we type a wrong key,
   *  then Backspace, then the correct character, so the net committed text equals
   *  `text` exactly. `delay` is the per-key delay ms (default 0). typo:false types
   *  cleanly. */
  async typeInChatRailHumanized(
    text: string,
    opts: { delay?: number; typo?: boolean } = {},
  ): Promise<void> {
    const delay = opts.delay ?? 0;
    const injectTypo = opts.typo ?? true;
    const sel = tid("chat-input-textarea");
    await this.page.click(sel); // focus the real textarea (keyboard.type targets focus).
    const typoAt = injectTypo && text.length > 1 ? Math.floor(text.length / 2) : -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (i === typoAt) {
        // A deterministic wrong key (the next char, or "x" for a non-letter), then
        // correct it — net text is unchanged.
        const wrong = /[a-y]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 1) : "x";
        await this.page.keyboard.type(wrong, { delay });
        await this.page.keyboard.press("Backspace");
      }
      await this.page.keyboard.type(ch, { delay });
    }
    await this.page.click(tid("chat-send"));
  }

  /** checkComposerLockedWhileGated (T2-U2): while a data_collection gate is PENDING
   *  (the intake collect form is showing, turn status = awaiting_approval), the chat
   *  composer must be LOCKED — both the Send button and the textarea carry the
   *  disabled attribute — so a follow-up message typed mid-suspend cannot start a
   *  rogue second run answering the gate with prose. Records two real UiChecks (never
   *  a passthrough). Call at the data_collection suspend, BEFORE the resume decision.
   *  GATE-PENDING arm only; the run-in-flight arm (composer open while merely
   *  `running`) is a separate, owner-pending gap and is NOT asserted here. */
  async checkComposerLockedWhileGated(): Promise<void> {
    for (const testid of ["chat-send", "chat-input-textarea"]) {
      const present = (await this.page.locator(tid(testid)).count()) > 0;
      const disabled =
        present && (await this.page.locator(tid(testid)).first().isDisabled().catch(() => false));
      this.record({
        surface: `dom:${testid}`,
        selector: `${tid(testid)}[disabled]`,
        expected: "composer locked (disabled) while a data_collection gate is pending",
        observed: disabled ? "disabled" : present ? "enabled" : "absent",
        ok: disabled,
      });
    }
    await this.screenshot("composer-locked-while-gated");
  }

  /** The run id of the CURRENTLY shown /runs/:id route, or null (not on a run
   *  view). Used by the realtime-reactivity proof to address the open run
   *  stream the rail is subscribed to. */
  currentRunId(): string | null {
    return runIdFromPath(new URL(this.page.url()).pathname);
  }

  /** Wait until exactly `count` widgets match the (exact or prefix) testid — the
   *  realtime-reactivity settle: after a data.changed pulse the view refetches
   *  asynchronously (GET → state → re-render), so the proof waits for the grown
   *  count to LAND before scoring the dom_state anchor. Throws on timeout (the
   *  pulse did not refresh the view — a real failure). */
  async waitForTestidCount(
    testid: string,
    count: number,
    match: "exact" | "prefix" = "exact",
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<void> {
    const sel = match === "prefix" ? `[data-testid^="${testid}"]` : tid(testid);
    await this.page.waitForFunction(
      // String-form: runs in the page; the harness tsconfig has no DOM lib.
      `document.querySelectorAll('${sel.replace(/'/g, "\\'")}').length === ${count}`,
      { timeout: timeoutMs },
    );
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

  /** clickSubmitTwice: DOUBLE-click the intake submit (the impatient-user
   *  edge). Records the load-bearing ui_check: the button must DISABLE after
   *  the first click lands (React flushes the submitting state at the end of
   *  the discrete click event, so the second click of the pair hits a disabled
   *  button and never double-fires the decision). The exactly-one-row proof is
   *  the case's global-exact table anchor, not this check. */
  async clickSubmitTwice(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("intake-submit")}:not([disabled])`, { timeout: timeoutMs });
    await this.page.dblclick(tid("intake-submit"));
    let disabled = false;
    try {
      // The accept decision keeps the form in its submitting state while the
      // server resumes the workflow — a multi-second observable window.
      await this.page.waitForSelector(`${tid("intake-submit")}[disabled]`, { timeout: timeoutMs });
      disabled = true;
    } catch {
      disabled = false;
    }
    this.record({
      surface: "dom:intake-form",
      selector: `${tid("intake-submit")}[disabled]`,
      expected: "submit button disables after the first click of a double-click",
      observed: disabled ? "button disabled" : "button never disabled",
      ok: disabled,
    });
    await this.screenshot("submit-double-click");
  }

  /** Reload the page mid-journey (the accidental-refresh edge) and wait for
   *  the SPA shell to come back. The /runs/:id route survives the reload; the
   *  refresh-recovery path re-opens the stream and the form draft restores
   *  from localStorage (keyed by the stable runId). */
  async reloadPage(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.page.waitForSelector(tid("app-main"), { timeout: timeoutMs });
  }

  /** checkDraftRestored: after a mid-form reload, the form re-renders with the
   *  resume banner AND at least one field visibly carrying its pre-reload
   *  value (PII fields come back EMPTY by design — the draft strips them, so
   *  the check looks for ANY restored value, which slash mode can only get
   *  from the draft). Records ok:false rather than throwing. */
  async checkDraftRestored(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    let bannerVisible = false;
    try {
      await this.page.waitForSelector(tid("intake-form"), { timeout: timeoutMs });
      await this.page.waitForSelector(tid("resume-banner"), { timeout: timeoutMs });
      bannerVisible = true;
    } catch {
      bannerVisible = false;
    }
    const restored = (await this.page.evaluate(
      `(() => {
        const widgets = Array.from(document.querySelectorAll('[data-testid^="intake-field-"]'));
        const filled = [];
        for (const w of widgets) {
          if (w instanceof HTMLInputElement) {
            if ((w.type === "radio" || w.type === "checkbox") && w.checked) {
              filled.push(w.getAttribute("data-testid") ?? "");
            } else if (w.type !== "radio" && w.type !== "checkbox" && w.value.trim() !== "") {
              filled.push(w.getAttribute("data-testid") ?? "");
            }
          }
        }
        return filled;
      })()`,
    )) as string[];
    this.record({
      surface: "dom:intake-form",
      selector: `${tid("resume-banner")} + [data-testid^="intake-field-"]`,
      expected: "resume banner visible AND >=1 field value restored from the draft",
      observed: `banner=${bannerVisible} restored: ${restored.slice(0, 6).join(", ") || "none"}`,
      ok: bannerVisible && restored.length > 0,
    });
    await this.screenshot("draft-restored");
  }

  /** Click the resume banner's Continue (keep the restored draft values). */
  async clickResumeContinue(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("resume-continue"), { timeout: timeoutMs });
    await this.page.click(tid("resume-continue"));
  }

  /** Knock the TEST browser's network offline/online (breaks the dashboard's
   *  live SSE mid-run — the product browser the SUT drives is a different
   *  process and stays online). */
  async setOffline(offline: boolean): Promise<void> {
    await this.context.setOffline(offline);
  }

  /** Wait for the zone-4 browser trail to render on the active turn — the
   *  signal that the run is mid-flight ON THE DASHBOARD (browser frames only
   *  flow while the product browser scans). */
  async waitForBrowserTrail(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("turn-browser-trail"), { timeout: timeoutMs });
  }

  /** checkNoDuplicateSummary: after an SSE break + recovery, the terminal
   *  summary must render EXACTLY ONCE (a reconnect that replayed the backlog
   *  without prefix-skipping would append duplicate text parts — the same
   *  mechanism that would double milestones). `marker` is a regex matched
   *  globally against the turn's prose zone. */
  async checkNoDuplicateSummary(marker: RegExp): Promise<void> {
    const text = await this.page
      .locator(tid("turn-zone-text"))
      .first()
      .textContent()
      .catch(() => null);
    const matches = text === null ? [] : (text.match(new RegExp(marker.source, "g")) ?? []);
    const turnCount = await this.page.locator(tid("assistant-turn")).count();
    this.record({
      surface: "dom:chat-rail",
      selector: tid("turn-zone-text"),
      expected: `exactly one summary match for /${marker.source}/ and one assistant turn`,
      observed: `matches=${matches.length} turns=${turnCount} text="${(text ?? "").slice(0, 80)}"`,
      ok: matches.length === 1 && turnCount === 1,
    });
    await this.screenshot("no-duplicate-summary");
  }

  /** Click the real form Cancel (decline — terminal, zero write). */
  async clickDecline(): Promise<void> {
    await this.page.click(tid("intake-decline"));
  }

  /** Wait for the end-of-intake buyer confirmation card to render. */
  async waitForIntakeConfirmGate(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("gate-intake-confirm"), { timeout: timeoutMs });
  }

  /** Accept at the buyer confirmation card → continue to persist. */
  async clickIntakeConfirmAccept(): Promise<void> {
    await this.page.click(tid("gate-intake-confirm-accept"));
  }

  /** Decline at the buyer confirmation card → terminal, zero write. */
  async clickIntakeConfirmDecline(): Promise<void> {
    await this.page.click(tid("gate-intake-confirm-decline"));
  }

  /** Wait for the #1244 malformed_tool_call gate card (rail track). */
  async waitForMalformedGate(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("gate-malformed"), { timeout: timeoutMs });
  }

  /** Decline (Cancel) at the malformed gate — terminal, zero write. */
  async clickMalformedDecline(): Promise<void> {
    await this.page.click(tid("gate-malformed-decline"));
  }

  /** Open the chat-rail Skills tray: wait for the (always-mounted) <details>
   *  summary toggle, expand it if it isn't already open, then wait for the list.
   *  The rail re-reads profiles+skills live, so a just-created profile flips the
   *  pin-gated Run buttons enabled without any page navigation. Idempotent: the
   *  rail never unmounts, so a <details> left open by a prior step survives a
   *  client-side navigate — clicking again would CLOSE it, so we skip the click
   *  when the list is already visible. */
  async openSkillsPopover(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("rail-skills-toggle"), { timeout: timeoutMs });
    if (!(await this.page.locator(tid("skills-list")).isVisible())) {
      await this.page.click(tid("rail-skills-toggle"));
    }
    await this.page.waitForSelector(tid("skills-list"), { timeout: timeoutMs });
  }

  /** Launch a skill from the Skills popover's real Run button (waits for the
   *  pin gate to enable it — `:not([disabled])` on a real <button>). No
   *  return-to-Home step: the popover is reachable from every route. The popover
   *  surfaces only the SUGGESTED next-available skills by default; the rest hide
   *  behind a collapsed "More skills" disclosure, so when the target Run button
   *  is not present we expand that disclosure first to reveal it. */
  async launchSkillFromPopover(skillId: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.openSkillsPopover(timeoutMs);
    const runSel = tid(`ledger-run-${skillId}`);
    // The skill may be tucked behind the collapsed "More skills" disclosure —
    // a collapsed <details> keeps its rows in the DOM, so the row can resolve
    // while staying hidden. When the Run button isn't VISIBLE and the
    // disclosure exists, expand it (a real user click) before waiting.
    if (
      !(await this.page.locator(runSel).first().isVisible()) &&
      (await this.page.locator(tid("skills-more-toggle")).count()) > 0
    ) {
      await this.page.click(tid("skills-more-toggle"));
    }
    const sel = `${runSel}:not([disabled])`;
    await this.page.waitForSelector(sel, { timeout: timeoutMs });
    await this.page.click(sel);
  }

  /** Launch a skill by clicking a Canvas control that itself starts a run (e.g.
   *  the Threads section's "Retry failed extractions" button → escalate:true).
   *  Waits for the button to render, then clicks it — the host's onClick POSTs
   *  the start and navigates to /runs/:id (the caller's waitForRunRoute follows). */
  async launchSkillFromCanvasButton(testId: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid(testId), { timeout: timeoutMs });
    await this.page.click(tid(testId));
  }

  // ---- batch_review verbs (the gate-banner track's decision card) -----------

  /** Wait for the batch_review card to render on the gate-banner track. */
  async waitForBatchReviewCard(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("batch-review-card"), { timeout: timeoutMs });
  }

  /** Click one batch row's Approve/Skip control and assert the row's decision
   *  state flipped (data-decision on the row — the undecided default is gone). */
  async decideBatchRow(dealerId: string, decision: "approve" | "skip"): Promise<void> {
    await this.page.click(tid(`batch-${decision}-${dealerId}`));
    const observed = await this.page
      .locator(tid(`batch-row-${dealerId}`))
      .getAttribute("data-decision");
    if (observed !== decision) {
      throw new Error(
        `uiDriver: batch row ${dealerId} shows data-decision="${String(observed)}" after clicking ${decision}`,
      );
    }
  }

  /** Click the card's explicit Select-all button (the user affordance — the
   *  wire still carries the full explicit id list, never an approve-all). */
  async clickBatchSelectAll(): Promise<void> {
    await this.page.click(tid("batch-select-all"));
  }

  /** checkBatchCounter: the live decided/total counter reads exactly
   *  "<decided>/<total> decided". Records ok:false rather than throwing. */
  async checkBatchCounter(decided: number, total: number): Promise<void> {
    const text = (await this.page
      .locator(tid("batch-counter"))
      .textContent()
      .catch(() => null)) ?? "";
    const ok = text.includes(`${decided}/${total} decided`);
    this.record({
      surface: "dom:gate-banner",
      selector: tid("batch-counter"),
      expected: `counter "${decided}/${total} decided"`,
      observed: `counter "${text.trim()}"`,
      ok,
    });
    await this.screenshot("batch-counter");
  }

  /** checkBatchRowCount: the rendered target-row count equals `expected` (the
   *  cross-step check against the geosearch step's profile_dealers delta). */
  async checkBatchRowCount(expected: number): Promise<void> {
    const observed = await this.page.locator('[data-testid^="batch-row-"]').count();
    this.record({
      surface: "dom:gate-banner",
      selector: '[data-testid^="batch-row-"]',
      expected: `${expected} batch target rows (== the discovery step's profile_dealers delta)`,
      observed: `${observed} rows`,
      ok: observed === expected,
    });
    await this.screenshot("batch-row-count");
  }

  /** Click the batch Submit (waits for the every-row-decided gate to enable it). */
  async clickBatchSubmit(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("batch-submit")}:not([disabled])`, { timeout: timeoutMs });
    await this.page.click(tid("batch-submit"));
  }

  /** Click the batch Decline (always enabled — terminal, zero writes). */
  async clickBatchDecline(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("batch-decline"), { timeout: timeoutMs });
    await this.page.click(tid("batch-decline"));
  }

  /** Click the closeout "Skip all & reset" button (the skip_all_reset hand-off —
   *  terminal, ZERO writes; emits accept{skip_all:true} → the workflow's
   *  empty-intersection branch). Renders only on the closeout payload
   *  (spec.allowSkipAll), so this verb is closeout-scoped. */
  async clickBatchSkipAll(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("batch-skip-all"), { timeout: timeoutMs });
    await this.page.click(tid("batch-skip-all"));
  }

  // ---- inbox_review verbs (the dealer_inbox_check decision card) ------------
  // The InboxReviewCard mirrors the batch-review machinery (per-dealer
  // Approve/Skip, an explicit Select-all, a decided/total counter, Submit +
  // Decline) but uses the `inbox-` testid prefix and keys rows by dealer_id —
  // so these are NEW verbs, never the `batch-` ones aimed at the inventory card.

  /** Wait for the inbox-review card to render on the gate-banner track. */
  async waitForInboxReviewCard(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("inbox-review-card"), { timeout: timeoutMs });
  }

  /** Click one inbox row's Approve/Skip control and assert the row's decision
   *  state flipped (data-decision on the row — the undecided default is gone). */
  async decideInboxRow(dealerId: string, decision: "approve" | "skip"): Promise<void> {
    await this.page.click(tid(`inbox-${decision}-${dealerId}`));
    const observed = await this.page
      .locator(tid(`inbox-row-${dealerId}`))
      .getAttribute("data-decision");
    if (observed !== decision) {
      throw new Error(
        `uiDriver: inbox row ${dealerId} shows data-decision="${String(observed)}" after clicking ${decision}`,
      );
    }
  }

  /** Click the card's explicit Select-all button (the user affordance — the
   *  wire still carries the full explicit id list, never an approve-all). */
  async clickInboxSelectAll(): Promise<void> {
    await this.page.click(tid("inbox-select-all"));
  }

  /** checkInboxCounter: the live decided/total counter reads exactly
   *  "<decided>/<total> decided". Records ok:false rather than throwing. */
  async checkInboxCounter(decided: number, total: number): Promise<void> {
    const text = (await this.page
      .locator(tid("inbox-counter"))
      .textContent()
      .catch(() => null)) ?? "";
    const ok = text.includes(`${decided}/${total} decided`);
    this.record({
      surface: "dom:gate-banner",
      selector: tid("inbox-counter"),
      expected: `counter "${decided}/${total} decided"`,
      observed: `counter "${text.trim()}"`,
      ok,
    });
    await this.screenshot("inbox-counter");
  }

  /** Click the inbox Submit (waits for the every-row-decided + >=1-approved gate
   *  to enable it). */
  async clickInboxSubmit(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("inbox-submit")}:not([disabled])`, { timeout: timeoutMs });
    await this.page.click(tid("inbox-submit"));
  }

  /** Click the inbox Decline (always enabled — terminal, zero writes). */
  async clickInboxDecline(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("inbox-decline"), { timeout: timeoutMs });
    await this.page.click(tid("inbox-decline"));
  }

  // ---- hygiene_review verbs (the dealer_hygiene per-stage cleanup card) ------
  // The DESTRUCTIVE HygieneReviewCard renders ONCE PER STAGE across the three
  // strictly-ordered suspends (5a orphans → 5b CRM threads → 5c CRM contacts).
  // It mirrors the batch/inbox review machinery (per-row Approve/Skip, an
  // explicit Select-all, a decided/total counter, Submit + Decline) but uses the
  // `hygiene-` testid prefix, keys rows by the target id (a thread_id or
  // contact_id — NOT a dealer_id), and carries a `data-stage` the driver reads to
  // assert the strict stage order. These are NEW verbs, never the batch/inbox
  // ones.

  /** Wait for the hygiene-review card to render on the gate-banner track. */
  async waitForHygieneReviewCard(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("hygiene-review-card"), { timeout: timeoutMs });
  }

  /** Read the current stage's `data-stage` value off the hygiene-stage element
   *  (`orphans` | `crm_threads` | `crm_contacts`) — the strict-order proof. */
  async readHygieneStage(): Promise<string> {
    const stage = await this.page.locator(tid("hygiene-stage")).getAttribute("data-stage");
    if (stage === null) {
      throw new Error("uiDriver: hygiene-stage element carries no data-stage attribute");
    }
    return stage;
  }

  /** Click one hygiene row's Approve/Skip control and assert the row's decision
   *  state flipped (data-decision on the row — the undecided default is gone).
   *  `id` is the target's thread_id or contact_id (NOT a dealer_id). */
  async decideHygieneRow(id: string, decision: "approve" | "skip"): Promise<void> {
    await this.page.click(tid(`hygiene-${decision}-${id}`));
    const observed = await this.page
      .locator(tid(`hygiene-row-${id}`))
      .getAttribute("data-decision");
    if (observed !== decision) {
      throw new Error(
        `uiDriver: hygiene row ${id} shows data-decision="${String(observed)}" after clicking ${decision}`,
      );
    }
  }

  /** Click the card's explicit Select-all button (the user affordance — the wire
   *  still carries the full explicit id list, never an approve-all). */
  async clickHygieneSelectAll(): Promise<void> {
    await this.page.click(tid("hygiene-select-all"));
  }

  /** checkHygieneCounter: the live decided/total counter reads exactly
   *  "<decided>/<total> decided". Records ok:false rather than throwing. */
  async checkHygieneCounter(decided: number, total: number): Promise<void> {
    const text = (await this.page
      .locator(tid("hygiene-counter"))
      .textContent()
      .catch(() => null)) ?? "";
    const ok = text.includes(`${decided}/${total} decided`);
    this.record({
      surface: "dom:gate-banner",
      selector: tid("hygiene-counter"),
      expected: `counter "${decided}/${total} decided"`,
      observed: `counter "${text.trim()}"`,
      ok,
    });
    await this.screenshot("hygiene-counter");
  }

  /** Click the hygiene Submit (waits for the every-row-decided + >=1-approved
   *  gate to enable it). */
  async clickHygieneSubmit(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("hygiene-submit")}:not([disabled])`, { timeout: timeoutMs });
    await this.page.click(tid("hygiene-submit"));
  }

  /** Click the hygiene Decline (always enabled — terminal, ZERO writes for the
   *  WHOLE run, even when earlier stages were approved-and-staged). */
  async clickHygieneDecline(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("hygiene-decline"), { timeout: timeoutMs });
    await this.page.click(tid("hygiene-decline"));
  }

  // ---- approval verbs (the gate-banner track's ApprovalPrompt card) ---------

  /** Wait for the approval card to render on the gate-banner track. */
  async waitForApprovalPrompt(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("approval-prompt"), { timeout: timeoutMs });
  }

  /** Assert the approval card's bulk affordance matches its sensitivity: a
   *  SENSITIVE event (data-sensitive="true", e.g. the dealer_web_lead_submit
   *  email_fallback re-confirm — a mutating scope switch) must NOT expose an
   *  approve-all button (no batch-approval of a mutating tool), while a
   *  non-sensitive event (e.g. incentive_scrape's first-encounter approval) DOES.
   *  Reads the live card, records a REAL UiCheck (never a passthrough), and
   *  screenshots. Call after waitForApprovalPrompt, before the approve/deny. */
  async checkApprovalApproveAllForSensitivity(): Promise<void> {
    const observed = (await this.page.evaluate(
      `(() => {
        const card = document.querySelector('[data-testid="approval-prompt"]');
        const sensitive = card !== null && card.getAttribute("data-sensitive") === "true";
        const approveAll = document.querySelectorAll('[data-testid="approval-approve-all"]').length;
        return { present: card !== null, sensitive, approveAll };
      })()`,
    )) as { present: boolean; sensitive: boolean; approveAll: number };
    // sensitive ⇒ zero approve-all controls; non-sensitive ⇒ exactly one.
    const ok =
      observed.present && (observed.sensitive ? observed.approveAll === 0 : observed.approveAll === 1);
    this.record({
      surface: "dom:gate-banner",
      selector: `${tid("approval-prompt")}[data-sensitive] vs ${tid("approval-approve-all")}`,
      expected: observed.sensitive
        ? "sensitive approval card: zero approve-all affordances (no bulk-approve of a mutating scope)"
        : "non-sensitive approval card: exactly one approve-all affordance",
      observed: `present=${observed.present} sensitive=${observed.sensitive} approveAll=${observed.approveAll}`,
      ok,
    });
    await this.screenshot("approval-sensitivity-approve-all");
  }

  /** Click the approval card's Approve (accept — approves the shown action). */
  async clickApprovalApprove(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("approval-approve")}:not([disabled])`, {
      timeout: timeoutMs,
    });
    await this.page.click(tid("approval-approve"));
  }

  /** Click the approval card's Deny (decline — terminal, zero writes). */
  async clickApprovalDeny(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("approval-deny")}:not([disabled])`, {
      timeout: timeoutMs,
    });
    await this.page.click(tid("approval-deny"));
  }

  // ---- confirmation_gate verbs (pipeline_reset's destructive typed-YES card) -
  // The DESTRUCTIVE second-confirm surface (ConfirmationGateCard on the
  // gate-banner track). The Confirm button is DISABLED until the typed token
  // trims to the literal YES (a CLIENT pre-check); Cancel is always enabled
  // (the never-hidden decline). The wipe is reachable ONLY through Confirm.

  /** Wait for the destructive confirmation-gate card to render on the banner
   *  track. */
  async waitForConfirmationGateCard(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("confirmation-gate-card"), { timeout: timeoutMs });
  }

  /** checkResetConsequenceLines: the card renders EXACTLY `expected` plain-speech
   *  consequence lines (the destructive frame is fully shown before any decision
   *  — the card is never collapsed to a one-liner). Records ok:false rather than
   *  throwing, so the verdict carries the evidence. */
  async checkResetConsequenceLines(expected: number): Promise<void> {
    const observed = await this.page.locator(tid("reset-consequence-line")).count();
    this.record({
      surface: "dom:gate-banner",
      selector: tid("reset-consequence-line"),
      expected: `${expected} consequence line(s) shown before the user decides`,
      observed: `${observed} line(s)`,
      ok: observed === expected,
    });
    await this.screenshot("reset-consequence-lines");
  }

  /** Type a token into the reset confirm input (the typed-YES pre-check field). */
  async fillResetToken(token: string): Promise<void> {
    await this.page.fill(tid("reset-confirm-token"), token);
  }

  /** Click the destructive Confirm (waits for the typed-YES client gate to
   *  enable it — `:not([disabled])`). The card posts the canonical {confirm_token:
   *  "YES"} regardless of the typed casing. */
  async clickResetConfirm(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(`${tid("reset-confirm")}:not([disabled])`, { timeout: timeoutMs });
    await this.page.click(tid("reset-confirm"));
  }

  /** Click the always-enabled Cancel (decline — terminal, ZERO destruction). */
  async clickResetCancel(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("reset-cancel"), { timeout: timeoutMs });
    await this.page.click(tid("reset-cancel"));
  }

  /** checkResetConfirmDisabledFor: type a NON-YES token and assert the
   *  destructive Confirm button STAYS DISABLED — the client typed-YES gate holds
   *  the line, so a wrong token can never reach the wipe through the real card
   *  (Cancel must remain enabled, the never-hidden stop verb). The server-side
   *  re-validation (validateResetToken → 400) is a separate surface covered at
   *  L1; the production card normalizes Confirm to the canonical YES, so a wrong
   *  token never leaves the client. Records ok:false rather than throwing. */
  async checkResetConfirmDisabledFor(token: string): Promise<void> {
    await this.fillResetToken(token);
    const confirmDisabled = await this.page
      .locator(tid("reset-confirm"))
      .isDisabled()
      .catch(() => false);
    const cancelEnabled = !(await this.page
      .locator(tid("reset-cancel"))
      .isDisabled()
      .catch(() => true));
    this.record({
      surface: "dom:gate-banner",
      selector: `${tid("reset-confirm")}[disabled] (token="${token}")`,
      expected: `a non-YES token ("${token}") keeps Confirm DISABLED while Cancel stays enabled`,
      observed: `confirmDisabled=${confirmDisabled} cancelEnabled=${cancelEnabled}`,
      ok: confirmDisabled && cancelEnabled,
    });
    await this.screenshot("reset-bad-token-disabled");
  }

  /** pinProfileInSearches: the EXPLICIT pin verb — open the Searches popover,
   *  find the profile row whose vehicle-label title text equals `label` (zero or
   *  ambiguous matches fail LOUD, never by index), click its Pin control, wait
   *  for the row to flip to Unpin (the pin landed on the session), then close
   *  the popover. Sessions are never auto-pinned; this is the user action that
   *  pins one. */
  async pinProfileInSearches(label: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid("topbar-searches"), { timeout: timeoutMs });
    await this.page.click(tid("topbar-searches"));
    await this.page.waitForSelector(tid("searches-popover"), { timeout: timeoutMs });
    // The popover refetches on EVERY open and passes through a loading state —
    // counting rows the instant the panel is visible reads an empty list, not
    // the fetched one. Wait for the first row to materialize; a genuinely
    // zero-profile world times out here with a clear message instead.
    await this.page.waitForSelector('[data-testid^="searches-row-"]', { timeout: timeoutMs });

    const rows = this.page.locator('[data-testid^="searches-row-"]');
    const count = await rows.count();
    const want = label.trim();
    const matches: number[] = [];
    const seen: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const text = (
        (await rows.nth(i).locator('[data-testid^="searches-view-"]').first().textContent()) ?? ""
      ).trim();
      seen.push(text);
      if (text === want) matches.push(i);
    }
    if (matches.length === 0) {
      throw new Error(
        `uiDriver: no Searches row labeled "${want}" (rows: ${seen.join(" | ") || "none"})`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`uiDriver: ambiguous Searches row label "${want}" (${matches.length} matches)`);
    }
    const row = rows.nth(matches[0]!);
    // Locate the pin/unpin controls BY PROFILE ID, not by position: pinning a
    // search floats it into the "Pinned" group (re-sorts the list), so a
    // positional row locator would point at a DIFFERENT row after the click in a
    // multi-profile world. The id is stable across the re-sort. (Single-profile
    // behaviour is identical — one row, same id.)
    const rowTestId = (await row.getAttribute("data-testid")) ?? "";
    const profileId = rowTestId.startsWith("searches-row-")
      ? rowTestId.slice("searches-row-".length)
      : "";
    if (profileId === "") {
      throw new Error(`uiDriver: could not read a profile id from row "${want}" (${rowTestId})`);
    }
    await this.page.click(tid(`searches-pin-${profileId}`));
    // The pin landing re-renders the row with the Unpin verb — the DOM proof
    // the session now carries the pin.
    let pinned = true;
    try {
      await this.page.waitForSelector(tid(`searches-unpin-${profileId}`), { timeout: timeoutMs });
    } catch {
      pinned = false;
    }
    this.record({
      surface: "dom:searches-popover",
      selector: '[data-testid^="searches-pin-"]',
      expected: `Pin verb on "${want}" lands (row flips to Unpin)`,
      observed: pinned ? "row shows Unpin" : "row never flipped to Unpin",
      ok: pinned,
    });
    await this.screenshot("session-pinned");
    if (!pinned) throw new Error(`uiDriver: pinning "${want}" did not land (no Unpin verb appeared)`);
    await this.page.keyboard.press("Escape"); // close the popover.
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

  // ---- generic verb layer (pure-UI steps: any widget by data-testid) --------
  // These complement the named, choreography-specific verbs above. A pure-UI
  // case step drives a sequence of these against the SAME persistent page, then
  // scores dom_state assertions through recordDomState. The selector is always
  // built from the stable data-testid set (kebab-case), never a CSS path.

  /** Click any widget by its data-testid (waits for it to be present). */
  async clickTestid(testid: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid(testid), { timeout: timeoutMs });
    await this.page.click(tid(testid));
  }

  /** Fill any text input/textarea by its data-testid. */
  async fillTestid(testid: string, value: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid(testid), { timeout: timeoutMs });
    await this.page.fill(tid(testid), value);
  }

  /** Focus a widget by its data-testid and press a key (e.g. "Enter", "Escape"). */
  async pressKey(testid: string, key: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.waitForSelector(tid(testid), { timeout: timeoutMs });
    await this.page.press(tid(testid), key);
  }

  /** Reload the whole page and wait for the SPA shell to come back (the generic
   *  twin of reloadPage — same recovery, available to any pure-UI step). */
  async reloadBrowser(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.page.waitForSelector(tid("app-main"), { timeout: timeoutMs });
  }

  /** Navigate the SPA to a client-side route WITHOUT a full reload — the harness
   *  analog of clicking a notification deep-link (the digest skill's notify step
   *  deep-links to "/digest"; there is no static chrome link to it). Drives the
   *  app's OWN History-API router exactly as the in-app navigate() helper does
   *  (pushState + the autobroker:navigate event), then waits for the named
   *  settle testid the destination route mounts (proving the route resolved and
   *  rendered, not just that the URL changed). */
  async navigateTo(path: string, settleTestid: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    await this.page.evaluate(
      // String-form: runs in the page; the harness tsconfig has no DOM lib. This
      // mirrors apps/ui router.navigate(): push the path, fire the SPA's nav
      // event so every useRoute() consumer re-renders at the new route.
      `(() => {
        if (window.location.pathname !== ${JSON.stringify(path)}) {
          window.history.pushState({}, "", ${JSON.stringify(path)});
          window.dispatchEvent(new Event("autobroker:navigate"));
        }
      })()`,
    );
    await this.page.waitForSelector(tid(settleTestid), { timeout: timeoutMs });
  }

  /**
   * drag: a REAL pointer drag of a widget by a horizontal delta, then a
   * self-asserting check on the container's --rail-width. This is the func-lane
   * proof the jsdom unit test cannot give — real chromium does layout, so a
   * collapsed grab strip (the `.rail-resizer{flex:0 0 0px}` regression) makes the
   * pointer miss the seam and the width never move.
   *
   * The pointer drag uses page.mouse (move→down→move→up) so it emits real
   * pointerdown/move/up with a stable pointerId — RailResizer's setPointerCapture
   * needs that. The grab point is the element's CENTER; `dx<0` sweeps LEFT, which
   * (rail on the right) WIDENS the rail.
   *
   * Two assertion modes against the container's --rail-width (read computed
   * before/after) plus a localStorage-persist check:
   *   "delta" — the width changed by ≈|dx| in the widen direction (±TOL).
   *   "clamp" — the width changed (widen direction) but was CAPPED below |dx|
   *             (a far-past-max drag re-clamps to the layout max).
   * A regression that collapses the grab strip yields delta=0 → BOTH modes fail.
   */
  async drag(
    testid: string,
    dx: number,
    expect: "delta" | "clamp" = "delta",
    container = "app-body",
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<void> {
    const TOL = 8; // px slack for sub-pixel center rounding.
    const LS_KEY = "autobroker:rail-width";
    // Wait for ATTACHED (not visible): a regressed 0px-wide grab strip is in the
    // DOM but has no visible box, and we WANT to reach the boundingBox check
    // below (record a clean fail) rather than hang on a visibility wait.
    await this.page.waitForSelector(tid(testid), { state: "attached", timeout: timeoutMs });

    const readVar = async (): Promise<number> =>
      (await this.page.evaluate(
        `(() => {
          const el = document.querySelector('[data-testid="${container}"]');
          if (el === null) return NaN;
          return parseFloat(getComputedStyle(el).getPropertyValue("--rail-width"));
        })()`,
      )) as number;
    const readLs = async (): Promise<string | null> =>
      (await this.page.evaluate(`window.localStorage.getItem("${LS_KEY}")`)) as string | null;

    const before = await readVar();
    const box = await this.page.locator(tid(testid)).boundingBox();

    if (box === null || box.width === 0) {
      // No hittable box (a 0px-wide collapsed grab strip) — the drag can't land.
      // Record the regression directly rather than throwing.
      this.record({
        surface: `dom:--rail-width`,
        selector: `[data-testid="${container}"] --rail-width`,
        expected: `a ${dx}px pointer drag on ${testid} moves the rail width`,
        observed: `${testid} has no grab box (width=${box?.width ?? "null"}px) — drag missed the seam`,
        ok: false,
      });
      await this.screenshot(`drag-${testid}-no-grab-box`);
      return;
    }

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await this.page.mouse.move(cx, cy);
    await this.page.mouse.down();
    await this.page.mouse.move(cx + dx, cy, { steps: 12 });
    await this.page.mouse.up();

    const after = await readVar();
    const lsAfter = await readLs();
    const delta = after - before;
    const want = -dx; // dx<0 (leftward) widens by |dx|.

    let widthOk: boolean;
    let expected: string;
    if (expect === "clamp") {
      // Grew in the widen direction but capped below the requested |dx|.
      widthOk =
        Number.isFinite(delta) &&
        Math.sign(delta) === Math.sign(want) &&
        Math.abs(delta) > TOL &&
        Math.abs(delta) < Math.abs(want) - TOL;
      expected = `a ${dx}px drag (past max) widens but RE-CLAMPS: 0 < Δ < ${Math.abs(want)}px`;
    } else {
      widthOk = Number.isFinite(delta) && Math.abs(delta - want) <= TOL;
      expected = `a ${dx}px drag changes --rail-width by ≈${want}px (±${TOL})`;
    }
    this.record({
      surface: `dom:--rail-width`,
      selector: `[data-testid="${container}"] --rail-width`,
      expected,
      observed: `before=${before}px after=${after}px Δ=${Number.isFinite(delta) ? Math.round(delta) : "NaN"}px`,
      ok: widthOk,
    });

    // The committed width is persisted to localStorage (drag end → saveRailWidth).
    const lsNum = lsAfter === null ? NaN : Number(lsAfter);
    this.record({
      surface: `localStorage:${LS_KEY}`,
      selector: LS_KEY,
      expected: `persisted to the committed width (≈${Math.round(after)}px)`,
      observed: `stored=${lsAfter ?? "null"}`,
      ok: Number.isFinite(lsNum) && Math.abs(lsNum - after) <= TOL,
    });
    await this.screenshot(`drag-${testid}-${expect}`);
  }

  /**
   * recordDomState: run a dom_state assertion against the live page and push a
   * UiCheck (the same channel every named check uses). The five expects:
   *   visible  — the widget is present and visible.
   *   absent   — zero matching widgets are present.
   *   text     — the widget's text content carries `value` (substring).
   *   count    — exactly `count` matching widgets are present.
   *   disabled — the widget carries the disabled attribute.
   * `match` selects the testid match mode: "exact" (default) builds the exact
   * data-testid selector for one specific widget; "prefix" builds the CSS
   * attribute-prefix selector (data-testid^=) for a dynamic-id widget family
   * (e.g. counting or asserting the absence of searches-row-<id> rows). All five
   * expects respect the mode. Records ok:false rather than throwing, so the
   * verdict carries the evidence.
   */
  async recordDomState(
    testid: string,
    expect: "visible" | "absent" | "text" | "count" | "disabled",
    value?: string,
    count?: number,
    match: "exact" | "prefix" = "exact",
  ): Promise<void> {
    const sel = match === "prefix" ? `[data-testid^="${testid}"]` : tid(testid);
    let observed: string;
    let ok: boolean;
    if (expect === "visible") {
      // A positive "visible" assertion auto-waits for the widget (Playwright's
      // normal semantics): an element that appears after an async re-render —
      // e.g. a row flipping to Unpin right after a Pin click — must not race the
      // assert. On timeout it falls through to the not-visible record below.
      const visible = await this.page
        .locator(sel)
        .first()
        .waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT })
        .then(() => true)
        .catch(() => false);
      observed = visible ? "visible" : "not visible/absent";
      ok = visible;
    } else if (expect === "absent") {
      const n = await this.page.locator(sel).count();
      observed = `${n} matching widget(s)`;
      ok = n === 0;
    } else if (expect === "text") {
      const text = (await this.page.locator(sel).first().textContent().catch(() => null)) ?? "";
      observed = `text="${text.trim().slice(0, 80)}"`;
      ok = value !== undefined && text.includes(value);
    } else if (expect === "count") {
      const n = await this.page.locator(sel).count();
      observed = `${n} matching widget(s)`;
      ok = count !== undefined && n === count;
    } else {
      // disabled — distinguish a missing element (absent) from a present one
      // that is simply not disabled (enabled), mirroring count/visible.
      const present = (await this.page.locator(sel).count()) > 0;
      const disabled = present && (await this.page.locator(sel).first().isDisabled().catch(() => false));
      observed = disabled ? "disabled" : present ? "enabled" : "absent";
      ok = disabled;
    }
    this.record({
      surface: `dom:${testid}`,
      selector: sel,
      expected:
        expect === "text"
          ? `text contains "${value ?? ""}"`
          : expect === "count"
            ? `${count ?? "?"} matching widget(s)`
            : expect,
      observed,
      ok,
    });
    await this.screenshot(`dom-state-${testid}-${expect}`);
  }
}
