/**
 * Buyer-mode read probe helpers — a structurally send-blocked adapter facade
 * and a fail-closed pre-flight envelope guard used by the standalone
 * buyer-email-probe script to validate real Gmail read access without any
 * send path reachable.
 *
 * - assertReadProbeEnvelope(): throws (fail-closed) unless the process is
 *   outside every harness/test/CI context, the active data dir is NOT the
 *   production ~/.autobroker tree, and a token record with a non-empty account
 *   resolves. Returns { account } on success.
 *
 * - ReadOnlyGmailAdapter: wraps any GmailAdapter and delegates ONLY the seven
 *   read methods (search, getThread, getMessage, downloadAttachment,
 *   historyList, getCurrentHistoryId, health). Its send() ALWAYS throws — a
 *   send is STRUCTURALLY impossible from a handle wrapped this way; there is no
 *   condition, no env flag, just an unconditional throw.
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { resolveDataDir } from "../db.js";
import { isHarnessContext } from "../realSend.js";
import { loadTokenRecord } from "./auth.js";
import type {
  AttachmentData,
  AttachmentRef,
  GmailAdapter,
  GmailBackend,
  HealthResult,
  HistoryPage,
  Message,
  Thread,
  ThreadRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// assertReadProbeEnvelope
// ---------------------------------------------------------------------------

/**
 * Fail-closed pre-flight for the buyer-mode read probe. Throws unless:
 *   1. The process is outside every harness/test/CI context (isHarnessContext
 *      returns false — no NODE_ENV=test, no AUTOBROKER_HARNESS=1, no
 *      AUTOBROKER_HARNESS_FIXTURE=1).
 *   2. The resolved data dir is NOT the production ~/.autobroker tree (same
 *      denylist shape as the Gmail backend factory: block ~/.autobroker and
 *      anything under it; everything else allowed).
 *   3. A token record exists and carries a non-empty account field.
 *
 * On success returns { account } so the caller can display the resolved
 * mailbox address for the operator to confirm before reads proceed.
 *
 * Pure assertion — no I/O beyond loading the token record; never sends,
 * never writes.
 */
export function assertReadProbeEnvelope(): { account: string } {
  if (isHarnessContext()) {
    throw new Error(
      "assertReadProbeEnvelope: refused — running inside a harness/test/CI context " +
        "(NODE_ENV=test, AUTOBROKER_HARNESS=1, or AUTOBROKER_HARNESS_FIXTURE=1); " +
        "buyer-mode reads must only run in a real operator session",
    );
  }

  const dataDir = resolve(resolveDataDir());
  const productionDir = join(homedir(), ".autobroker");
  const underProd =
    dataDir === productionDir || dataDir.startsWith(productionDir + sep);
  if (underProd) {
    throw new Error(
      `assertReadProbeEnvelope: refused — data dir is under the production tree ` +
        `~/.autobroker (${dataDir}); use an isolated dir such as ~/.autobroker-ts`,
    );
  }

  const record = loadTokenRecord(); // throws if absent or unreadable
  const { account } = record;
  if (!account) {
    throw new Error(
      "assertReadProbeEnvelope: refused — token record has an empty account field",
    );
  }

  return { account };
}

// ---------------------------------------------------------------------------
// ReadOnlyGmailAdapter
// ---------------------------------------------------------------------------

/**
 * A structural send-block facade. Wraps any GmailAdapter and delegates the
 * seven read methods (search, getThread, getMessage, downloadAttachment,
 * historyList, getCurrentHistoryId, health) to the inner adapter unchanged.
 *
 * Its send() ALWAYS throws — there is no condition under which a send can
 * succeed from a handle wrapped this way. No runtime gate, no env check — the
 * throw is unconditional. Use this in any probe or diagnostic that must be
 * structurally incapable of sending, rather than relying on an env flag.
 */
export class ReadOnlyGmailAdapter implements GmailAdapter {
  #inner: GmailAdapter;
  constructor(inner: GmailAdapter) {
    this.#inner = inner;
  }

  get kind(): GmailBackend {
    return this.#inner.kind;
  }

  search(query: string, maxResults?: number): Promise<ThreadRef[]> {
    return this.#inner.search(query, maxResults);
  }

  getThread(threadId: string): Promise<Thread> {
    return this.#inner.getThread(threadId);
  }

  getMessage(messageId: string): Promise<Message> {
    return this.#inner.getMessage(messageId);
  }

  downloadAttachment(messageId: string, ref: AttachmentRef): Promise<AttachmentData> {
    return this.#inner.downloadAttachment(messageId, ref);
  }

  historyList(startHistoryId: string): Promise<HistoryPage> {
    return this.#inner.historyList(startHistoryId);
  }

  getCurrentHistoryId(): Promise<string> {
    return this.#inner.getCurrentHistoryId();
  }

  /** ALWAYS rejects — send is structurally forbidden from a read-only probe. */
  async send(_raw: string): Promise<{ messageId: string }> {
    throw new Error(
      "ReadOnlyGmailAdapter: send is forbidden in a read-only probe",
    );
  }

  health(): Promise<HealthResult> {
    return this.#inner.health();
  }
}
