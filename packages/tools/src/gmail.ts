/**
 * Gmail tool — read paths are free; the SEND path is the single fake/real switch
 * point of the whole system.
 *
 * The RFC-2822 message is hand-built (~30 LOC, no MIME library) precisely so the
 * fake/real seam is ONE function: `send()` either hands the assembled raw
 * message to the live Gmail API (`users.messages.send`) or writes it to the
 * local fake mailbox. Default is FAKE. There is no other place a real send can
 * originate.
 *
 * Adapters: @googleapis/gmail (per-API package) + google-auth-library (system
 * browser loopback + PKCE; OAuth token from the OS keyring — never embedded in a
 * webview).
 *
 * INVARIANTS:
 *   - A real send is reachable ONLY through the L2 gate (`withGate`); this file
 *     never calls the live API outside an approved gate commit.
 *   - Budget is redacted from every outbound body (hard code rule, not prompt).
 *   - email-pipeline tests run against a local fake-mailbox DB; real email is
 *     NEVER sent in tests.
 */

import {
  assertEnvFuseDisarmed,
  withGate,
  type Approver,
  type GateRequest,
} from "./gate/index.js";

/** Where a send actually goes. `fake` is the default for all non-production
 *  and all test paths; `real` requires both an approved gate verdict AND an
 *  explicit mode flip. */
export type SendMode = "fake" | "real";

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  /** Plain-text body. Budget figures are stripped before assembly (see redact). */
  body: string;
}

/** Result of a send attempt — carries the mode so callers/audit can see whether
 *  a real message left the process. */
export interface SendResult {
  mode: SendMode;
  /** Gmail message id on real send; synthetic local id on fake send. */
  messageId: string;
}

/**
 * Hand-build an RFC-2822 message and return its base64url raw form — the exact
 * bytes the Gmail API expects. This is the seam: the SAME raw string is either
 * POSTed to the API or stored in the fake mailbox, so fake and real are
 * byte-identical except for the destination.
 *
 * TODO(phase-4): real header assembly (Date, Message-ID, MIME-Version,
 * Content-Type, proper folding/encoding). Stub returns a placeholder.
 */
export function buildRaw(email: OutboundEmail): string {
  const redactedBody = redactBudget(email.body);
  // TODO(phase-4): assemble real RFC-2822 headers + body, then base64url.
  const rfc2822 =
    `To: ${email.to}\r\n` +
    `From: ${email.from}\r\n` +
    `Subject: ${email.subject}\r\n` +
    `\r\n` +
    redactedBody;
  return Buffer.from(rfc2822, "utf8").toString("base64url");
}

/**
 * Hard code-level budget redaction. NEVER rely on the prompt for this — a dollar
 * figure in an outbound body is a constraint violation regardless of sampling.
 * TODO(phase-4): port the legacy `_redact_budget` regex set from Python parity.
 */
export function redactBudget(body: string): string {
  // TODO(phase-4): strip budget mentions (price ceilings, "my budget is …").
  return body;
}

export class GmailTool {
  constructor(
    private readonly approver: Approver,
    /** Default FAKE. Only an explicit, audited flip enables real sends. */
    private readonly mode: SendMode = "fake",
  ) {}

  /**
   * The single send entry point. Routes the proposed send THROUGH the L2 gate;
   * the real/fake branch lives inside the approved commit so a real message can
   * only ever leave after explicit approval.
   */
  async send(email: OutboundEmail): Promise<SendResult | { declined: true }> {
    const raw = buildRaw(email);
    const req: GateRequest = {
      kind: "gmail_send",
      runId: "TODO-run-id", // TODO(phase-4): thread the real product run id.
      summary: `Send email to ${email.to} — "${email.subject}"`,
      payload: { to: email.to, subject: email.subject },
    };

    const result = await withGate(req, this.approver, async () => {
      if (this.mode === "fake") {
        // TODO(phase-4): write `raw` to the local fake-mailbox DB row.
        return { mode: "fake" as const, messageId: `fake-${Date.now()}` };
      }
      // L1 outer ring, asserted AGAIN at the network boundary itself so the
      // fuse holds independently of the L2 path that brought us here.
      assertEnvFuseDisarmed("gmail_send");
      // TODO(phase-4): real send via @googleapis/gmail users.messages.send({raw}).
      // Reaches the network ONLY here, ONLY inside an approved gate commit.
      void raw;
      return { mode: "real" as const, messageId: "TODO-real-message-id" };
    });

    if ("decision" in result) return { declined: true };
    return result;
  }

  // TODO(phase-4): read-path tools (search, thread get, attachment fetch) —
  // free, no gate, but still the only place this package calls the Gmail API.
}
