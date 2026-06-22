/**
 * Gmail tool — read paths are free; the SEND path is the single fake/real switch
 * point of the whole system.
 *
 * The RFC-2822 message is hand-built (no MIME library) precisely so the fake/real
 * seam is ONE function: a backend's `send()` either hands the assembled raw
 * message to the live Gmail API (`users.messages.send`) or writes it to the local
 * fake mailbox. The backend is chosen by `createGmailAdapter` (real in buyer
 * mode, fake in test mode — AUTOBROKER_MODE="test"); there is no other place a
 * real send can originate.
 *
 * Adapters: @googleapis/gmail (per-API package) + a system-browser loopback OAuth
 * flow (token from the OS data dir, never embedded in a webview).
 *
 * INVARIANTS:
 *   - A real send is reachable ONLY through the L2 gate (`withGate`); this file
 *     never calls a backend's `send` outside an approved gate commit.
 *   - Budget is redacted from every outbound body — `redactBudget` substitutes
 *     each budget phrase out, and the `assertNoBudget` throwing wall is the belt
 *     that aborts assembly if anything still slips through. Both share the one
 *     pattern set in `./validators.js`.
 *   - email-pipeline tests run against a local fake-mailbox DB; real email is
 *     NEVER sent in tests, and a real backend is refused unless the data dir is
 *     the isolated parity dir.
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { resolveDataDir } from "./db.js";
import {
  assertEnvFuseDisarmed,
  withGate,
  type Approver,
  type GateRequest,
} from "./gate/index.js";
import { createRealGmailAdapter } from "./gmail/adapter.js";
import { FakeGmailAdapter } from "./gmail/fakeAdapter.js";
import { isBuyerMode } from "./realSend.js";
import { type GmailAdapter, type GmailBackend } from "./gmail/types.js";
import { assertNoBudget, assertUnicodeSafe, BUDGET_PHRASE_PATTERNS } from "./validators.js";

// `SendMode` (the result discriminator carried on every SendResult) and
// `GmailBackend` (the factory selector) are the SAME `"fake" | "real"` union by
// construction — defined ONCE in ./gmail/types.js (so the adapter interface can
// declare its `kind` without a circular import). Re-export both names here to
// keep the public surface stable.
export { type GmailBackend } from "./gmail/types.js";

/** Where a send actually goes — read off the adapter that ACTUALLY ran (its
 *  `kind`), never re-derived from the env. `fake` is the default for all
 *  non-production and all test paths; `real` requires both an approved gate
 *  verdict AND an isolated data dir. Alias of `GmailBackend`. */
export type SendMode = GmailBackend;

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

/** Thrown when a real backend is requested but the run envelope forbids it — an
 *  unknown backend string, or a real send against the production data dir. */
export class GmailBackendRefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "GmailBackendRefusedError";
  }
}

// ---------------------------------------------------------------------------
// Outbound message assembly + budget redaction
// ---------------------------------------------------------------------------

/**
 * Hard code-level budget redaction. NEVER rely on the prompt for this — a dollar
 * figure in an outbound body is a constraint violation regardless of sampling.
 *
 * Substitutes each leaked budget phrase with a neutral token. It consumes the
 * SAME pattern set the detector (`assertNoBudget`) uses, so the redactor and the
 * detector can never drift apart. After substitution `assertNoBudget` is the
 * belt: if any pattern still matches it throws (defense in depth).
 */
export function redactBudget(body: string): string {
  let out = body;
  for (const pattern of BUDGET_PHRASE_PATTERNS) {
    // The patterns are non-global (used with String.match for detection); apply a
    // global twin here so EVERY occurrence of the phrase is substituted, not just
    // the first. A bounded loop guard never lets a pathological pattern spin.
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    out = out.replace(globalPattern, "[redacted]");
  }
  return out;
}

/**
 * Hand-build an RFC-2822 message and return its base64url raw form — the exact
 * bytes the Gmail API expects. This is the seam: the SAME raw string is either
 * POSTed to the API or stored in the fake mailbox, so fake and real are
 * byte-identical except for the destination.
 *
 * The To/From/Subject lines are kept as simple UNFOLDED top-level headers — the
 * fake backend recovers them with a flat line scan over the header block, so a
 * folded continuation would break the round-trip.
 */
export function buildRaw(email: OutboundEmail): string {
  const redactedBody = redactBudget(email.body);
  // Throwing wall: a budget phrase still present in an outbound body aborts
  // assembly here, before any raw message exists — guards fake AND real sends.
  assertNoBudget(redactedBody);
  // A lone UTF-16 surrogate half in the body or subject cannot round-trip
  // through UTF-8 encoding (it would corrupt the assembled RFC-2822 bytes), so
  // abort assembly here before any raw message exists rather than silently
  // mangling the message — guards fake AND real sends.
  assertUnicodeSafe(redactedBody);
  assertUnicodeSafe(email.subject);

  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@autobroker.local>`;
  const headers = [
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    `To: ${unfold(email.to)}`,
    `From: ${unfold(email.from)}`,
    `Subject: ${unfold(email.subject)}`,
  ];
  const rfc2822 = `${headers.join("\r\n")}\r\n\r\n${redactedBody}`;
  return Buffer.from(rfc2822, "utf8").toString("base64url");
}

/** Collapse any CR/LF into single spaces so a header value stays on one line —
 *  the fake backend's header scan reads only the first physical line. */
function unfold(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Backend factory — the single fake/real switch point
// ---------------------------------------------------------------------------

/**
 * Resolve which backend to build. An explicit argument wins; otherwise the
 * AUTOBROKER_GMAIL_BACKEND env var is read FRESH on every call (never cached at
 * module scope), so a Keys-UI change takes effect with no restart. Unset/empty
 * follows the AUTOBROKER_MODE switch — "real" in buyer mode, "fake" in test mode;
 * anything other than "fake"/"real" is refused loudly.
 */
function resolveBackend(explicit?: GmailBackend): GmailBackend {
  if (explicit !== undefined) return explicit;
  const raw = process.env.AUTOBROKER_GMAIL_BACKEND;
  if (raw === undefined || raw === "") {
    // No explicit backend: follow the app mode. BUYER-BY-DEFAULT — a normal run
    // resolves the real backend (still gated by the L2 approval + L1 fuse at the
    // send seam); AUTOBROKER_MODE="test" resolves the fake mailbox instead.
    return isBuyerMode() ? "real" : "fake";
  }
  if (raw === "fake" || raw === "real") return raw;
  throw new GmailBackendRefusedError(
    `AUTOBROKER_GMAIL_BACKEND="${raw}" is not "fake" or "real"`,
  );
}

/**
 * Refuse a real backend ONLY when the active data dir is the PRODUCTION tree
 * ~/.autobroker (a denylist, not an allowlist): that one subtree is forbidden,
 * and everything else — the isolated parity tree ~/.autobroker-ts AND any dev /
 * throwaway dir — is allowed. This is the L1 floor: block prod, allow else, so a
 * real send can never reach a production mailbox by a mis-set data dir.
 */
function assertRealBackendAllowed(): void {
  const dataDir = resolve(resolveDataDir());
  const productionDir = join(homedir(), ".autobroker");
  const parityDir = join(homedir(), ".autobroker-ts");
  const underProd = dataDir === productionDir || dataDir.startsWith(productionDir + sep);
  const underParity = dataDir === parityDir || dataDir.startsWith(parityDir + sep);
  // `!underParity` is belt-and-suspenders (mirrors the preflight isolation shape):
  // the `+ sep` boundary already makes underProd and underParity mutually
  // exclusive (~/.autobroker-ts is never under ~/.autobroker/), so the clause can
  // never change the verdict — it stays as a defensive echo of intent.
  if (underProd && !underParity) {
    throw new GmailBackendRefusedError(
      `refuse: real Gmail backend with data dir under production ~/.autobroker (${dataDir})`,
    );
  }
}

/**
 * Build the active Gmail backend. Default follows the AUTOBROKER_MODE switch
 * (real in buyer mode; fake in test mode). A "real" backend is constructed lazily
 * (no I/O until first use) only after the data-dir isolation check passes.
 * The Fake's constructor opens the shared DB connection, so it is built ONLY here
 * at call time — never at module scope.
 */
export function createGmailAdapter(backend?: GmailBackend): GmailAdapter {
  const kind = resolveBackend(backend);
  if (kind === "real") {
    assertRealBackendAllowed();
    return createRealGmailAdapter();
  }
  return new FakeGmailAdapter();
}

// ---------------------------------------------------------------------------
// DI seam (test-only)
// ---------------------------------------------------------------------------

let _testAdapterOverride: GmailAdapter | null = null;

/** Inject a Gmail backend for tests. Guarded: refuses outside NODE_ENV=test so a
 *  production path can never swap the real send seam. */
export function __setGmailAdapterForTests(adapter: GmailAdapter): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setGmailAdapterForTests is test-only");
  }
  _testAdapterOverride = adapter;
}

/** Clear any test-injected backend. */
export function __resetGmailAdapterForTests(): void {
  _testAdapterOverride = null;
}

// ---------------------------------------------------------------------------
// Send seam — gate owner + adapter binder
// ---------------------------------------------------------------------------

export class GmailTool {
  constructor(
    private readonly approver: Approver,
    /** Stable id of the run asking, threaded into the gate request for audit. */
    private readonly runId: string,
    /** Optional explicit backend; otherwise resolved at send time via the
     *  test override or the factory (which reads the env-selected backend). */
    private readonly adapter?: GmailAdapter,
  ) {}

  /**
   * The single send entry point. Routes the proposed send THROUGH the L2 gate;
   * the backend's `send` runs only inside the approved commit, so a message can
   * only ever leave after explicit approval — fake and real share one path.
   */
  async send(email: OutboundEmail): Promise<SendResult | { declined: true }> {
    const raw = buildRaw(email);
    const req: GateRequest = {
      kind: "gmail_send",
      runId: this.runId,
      summary: `Send email to ${email.to} — "${email.subject}"`,
      payload: { to: email.to, subject: email.subject },
    };

    const result = await withGate(req, this.approver, async () => {
      // L1 outer ring, asserted AGAIN at the network boundary itself so the fuse
      // holds independently of the L2 path that brought us here. Fires for BOTH
      // backends now — strictly stronger than gating only the real branch.
      assertEnvFuseDisarmed("gmail_send");
      const adapter = this.adapter ?? _testAdapterOverride ?? createGmailAdapter();
      const { messageId } = await adapter.send(raw);
      // The discriminator tracks REALITY: it is the kind of the adapter that
      // actually performed the send (injected, test-override, OR factory-built),
      // not a re-read of the env — which can disagree with an injected adapter.
      const mode: SendMode = adapter.kind;
      return { mode, messageId };
    });

    if ("decision" in result) return { declined: true };
    return result;
  }
}
