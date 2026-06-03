/**
 * Browser tool — Playwright-native. Read paths harvest dealer data directly from
 * JSON responses; the only MUTATING op (form submit / mutating click) is wrapped
 * by the L2 gate.
 *
 * READ strategy (decided 2026-06-02): prefer `page.route` + `page.waitForResponse`
 * to read structured JSON straight off the wire instead of scraping rendered
 * DOM. Dealer websites/attachments/emails are UNTRUSTED input — read the network
 * layer, don't trust the page.
 *
 * MUTATION strategy: a submit/click that causes an irreversible external action
 * is reachable ONLY through `withGate`. There is no second path from the model
 * to `page.click('submit')` — provider built-in tools are pinned with
 * allowedTools/tools:[] so the model can't reach a shell to bypass this.
 */

import { withGate, type Approver, type GateRequest } from "./gate/index.js";

/** Minimal slice of the Playwright Page surface this tool needs. Kept as a
 *  local interface so the scaffold typechecks before `playwright` is installed.
 *  TODO(phase-4): replace with `import type { Page } from "playwright"`. */
export interface PageLike {
  goto(url: string): Promise<unknown>;
  waitForResponse(predicate: (url: string) => boolean): Promise<{ json(): Promise<unknown> }>;
  click(selector: string): Promise<void>;
}

export interface DealerLeadForm {
  url: string;
  /** Field name -> value. Fake phone unless user explicitly opted in. */
  fields: Record<string, string>;
  /** CSS selector for the submit control. */
  submitSelector: string;
}

export class BrowserTool {
  constructor(private readonly approver: Approver) {}

  /**
   * READ — harvest a structured JSON response directly off the network. No gate
   * (read is free), but still the only place this package drives a browser.
   * TODO(phase-4): real Playwright context/page lifecycle + route interception.
   */
  async readJson(page: PageLike, url: string, match: (u: string) => boolean): Promise<unknown> {
    await page.goto(url);
    const resp = await page.waitForResponse(match);
    return resp.json();
  }

  /**
   * MUTATE — submit a dealer lead form. Routed THROUGH the L2 gate; the actual
   * `page.click(submit)` happens only inside an approved commit. A decline
   * returns without ever clicking.
   */
  async submitLeadForm(
    page: PageLike,
    form: DealerLeadForm,
  ): Promise<{ submitted: true } | { declined: true }> {
    const req: GateRequest = {
      kind: "dealer_form_submit",
      runId: "TODO-run-id", // TODO(phase-4): thread the real SkillRun id.
      summary: `Submit dealer lead form at ${form.url}`,
      payload: { url: form.url, fieldCount: Object.keys(form.fields).length },
    };

    const result = await withGate(req, this.approver, async () => {
      // TODO(phase-4): fill `form.fields` (fake phone unless opted in), then:
      await page.click(form.submitSelector); // network mutation — gate-approved only.
      return { submitted: true as const };
    });

    if ("decision" in result) return { declined: true };
    return result;
  }
}
