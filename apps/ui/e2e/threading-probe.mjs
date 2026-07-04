/**
 * Reply-threading live probe — validates that a buyer-mode follow-up / closeout
 * we sent actually threaded onto the dealer's EXISTING conversation, purely via
 * the RFC-2822 headers (In-Reply-To / References + subject) we emit. We NEVER
 * send a Gmail threadId, so a matching thread at the recipient is proof the
 * headers did the work.
 *
 * Structurally READ-ONLY: every read goes through ReadOnlyGmailAdapter whose
 * send() always throws — there is no code path to a send from this script.
 *
 * It is run MANUALLY post-merge against a real mailbox (not in CI). Given the id
 * of a message we already sent, the dealer thread's gmail_thread_id, and the
 * stored inbound rfc_message_id we replied to, it asserts:
 *   (1) the sent message's threadId equals the dealer thread's gmail_thread_id —
 *       Gmail DERIVED that thread from our RFC headers (we sent no threadId);
 *   (2) that thread contains a message whose rfcMessageId equals the stored
 *       inbound anchor — i.e. our In-Reply-To/References linked the reply to the
 *       exact inbound message (co-membership is the observable threading result;
 *       the mapped Message intentionally does not surface raw In-Reply-To bytes);
 *   (3) the sent message's Subject starts with "Re:";
 *   plus a belt: the thread's messages include the sent id.
 *
 * Prints ONE structured JSON object to stdout on success. Exits non-zero on any
 * failed assertion or unrecoverable error.
 *
 * Usage (ids via argv or env):
 *   pnpm -r build && node apps/ui/e2e/threading-probe.mjs <sentId> <threadId> <inboundRfcId>
 *   THREADING_PROBE_SENT_ID / THREADING_PROBE_THREAD_ID / THREADING_PROBE_INBOUND_RFC_ID
 */

import { homedir } from "node:os";
import { join } from "node:path";

// All imports resolve to built @autobroker/tools dist — run `pnpm -r build` first.
import {
  assertReadProbeEnvelope,
  createGmailAdapter,
  ReadOnlyGmailAdapter,
} from "@autobroker/tools";

// Probe always runs in buyer mode; the data dir is the isolated parity tree.
process.env.AUTOBROKER_MODE = "buyer";
process.env.AUTOBROKER_DATA_DIR = join(homedir(), ".autobroker-ts");

const sentId = process.argv[2] ?? process.env.THREADING_PROBE_SENT_ID ?? "";
const expectedThreadId = process.argv[3] ?? process.env.THREADING_PROBE_THREAD_ID ?? "";
const expectedInboundRfcId =
  process.argv[4] ?? process.env.THREADING_PROBE_INBOUND_RFC_ID ?? "";

function requireArg(name, value) {
  if (value === "") {
    process.stderr.write(`[threading-probe] missing required input: ${name}\n`);
    process.exit(2);
  }
}

async function main() {
  requireArg("sentId", sentId);
  requireArg("threadId", expectedThreadId);
  requireArg("inboundRfcId", expectedInboundRfcId);

  // assertReadProbeEnvelope throws if any of:
  //   - isHarnessContext() is true (NODE_ENV=test / harness sentinels);
  //   - data dir is under the production ~/.autobroker tree;
  //   - token record is absent or has no account.
  const { account } = assertReadProbeEnvelope();
  process.stderr.write(
    `[threading-probe] account: ${account}  sent: ${sentId}  thread: ${expectedThreadId}\n`,
  );

  // ReadOnlyGmailAdapter wraps the real adapter; its send() always throws so a
  // send is structurally impossible from this handle.
  const ro = new ReadOnlyGmailAdapter(createGmailAdapter());

  const healthResult = await ro.health();
  if (!healthResult.ok) {
    process.stderr.write(`[threading-probe] health check failed: ${healthResult.detail}\n`);
    process.exit(1);
  }

  // (1) Read the message we sent; Gmail assigns its threadId from the RFC headers
  //     we emitted (we never send a threadId), so it must equal the dealer thread.
  const sent = await ro.getMessage(sentId);
  const threadIdMatches = sent.threadId === expectedThreadId;
  const subjectIsReply = sent.subject.trim().toLowerCase().startsWith("re:");

  // (2)+(belt) Hydrate the thread: the sent id must be a member, and the stored
  //     inbound anchor's rfc Message-ID must be present — i.e. In-Reply-To/
  //     References linked the reply to that exact inbound message.
  const thread = await ro.getThread(expectedThreadId);
  const sentInThread = thread.messages.some((m) => m.messageId === sentId);
  const inboundAnchorPresent = thread.messages.some(
    (m) => m.rfcMessageId === expectedInboundRfcId,
  );

  const report = {
    account,
    sentId,
    expectedThreadId,
    expectedInboundRfcId,
    sentThreadId: sent.threadId,
    sentSubject: sent.subject,
    threadIdMatches,
    subjectIsReply,
    sentInThread,
    inboundAnchorPresent,
    threadMessageCount: thread.messages.length,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  const ok = threadIdMatches && subjectIsReply && sentInThread && inboundAnchorPresent;
  if (!ok) {
    process.stderr.write("[threading-probe] FAIL — one or more threading assertions did not hold\n");
    process.exit(1);
  }
  process.stderr.write("[threading-probe] PASS — reply threaded on RFC headers alone\n");
}

main().catch((err) => {
  process.stderr.write(`[threading-probe] fatal: ${String(err)}\n`);
  process.exit(1);
});
