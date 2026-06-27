/**
 * Buyer-mode Gmail read probe — validates real Gmail read access end-to-end
 * without sending. Structurally incapable of sending: all reads go through
 * ReadOnlyGmailAdapter whose send() always throws.
 *
 * Leg A (real reads, no DB write): calls assertReadProbeEnvelope, runs health /
 * getCurrentHistoryId / search, then samples up to MAX_SAMPLE threads via
 * getMessage and downloadAttachment + extractAttachmentText for any attachments.
 *
 * Leg B (deterministic extraction, no LLM, no egress of mailbox content):
 * runs classifyMessageQuoteClass and parseQuoteFromBody on each message's
 * bodyText to count how many yield a deterministic quote signal.
 *
 * Prints ONE structured JSON object to stdout on success. Exits non-zero on
 * any unrecoverable failure.
 *
 * Usage: pnpm -r build && node apps/ui/e2e/buyer-email-probe.mjs [windowDays]
 */

import { homedir } from "node:os";
import { join } from "node:path";

// All imports resolve to built @autobroker/tools dist — run `pnpm -r build` first.
import {
  assertReadProbeEnvelope,
  classifyMessageQuoteClass,
  createGmailAdapter,
  extractAttachmentText,
  parseQuoteFromBody,
  ReadOnlyGmailAdapter,
} from "@autobroker/tools";

// Probe always runs in buyer mode; the data dir is the isolated parity tree.
process.env.AUTOBROKER_MODE = "buyer";
process.env.AUTOBROKER_DATA_DIR = join(homedir(), ".autobroker-ts");

const MAX_SAMPLE = 20; // max threads to getMessage (keeps the probe bounded)
const windowDays = parseInt(process.argv[2] ?? "365", 10) || 365;

async function main() {
  // assertReadProbeEnvelope throws if any of:
  //   - isHarnessContext() is true (NODE_ENV=test / harness sentinels);
  //   - data dir is under the production ~/.autobroker tree;
  //   - token record is absent or has no account.
  const { account } = assertReadProbeEnvelope();
  process.stderr.write(
    `[probe] account: ${account}  window: ${windowDays}d  sample: up to ${MAX_SAMPLE} threads\n`,
  );

  // ReadOnlyGmailAdapter wraps the real adapter; its send() always throws so a
  // send is structurally impossible from this handle.
  const ro = new ReadOnlyGmailAdapter(createGmailAdapter());

  // Liveness check (never throws; returns { ok: false } on failure).
  const healthResult = await ro.health();
  if (!healthResult.ok) {
    process.stderr.write(`[probe] health check failed: ${healthResult.detail}\n`);
    process.exit(1);
  }
  process.stderr.write(`[probe] health ok: ${healthResult.detail}\n`);

  // Current history watermark (the full-resync anchor for inbox sync).
  const currentHistoryId = await ro.getCurrentHistoryId();

  // Search for threads in the window.
  const threads = await ro.search(`newer_than:${windowDays}d`, 100);
  const matched = threads.length;
  const sampleSet = threads.slice(0, MAX_SAMPLE);

  let scanned = 0;
  let withBodyText = 0;
  let attachmentsParsed = 0;
  let deterministicQuoteSignals = 0;

  for (const thread of sampleSet) {
    for (const msgId of thread.messageIds) {
      scanned++;
      const msg = await ro.getMessage(msgId);

      // Count bodyText coverage (non-empty bodyText = HTML→plain fallback may
      // have run; we can't distinguish from the Message struct, so withBodyText
      // approximates htmlOnlyRecovered).
      if (msg.bodyText.length > 0) withBodyText++;

      // Leg B — deterministic extraction: no LLM, no egress of mailbox content.
      const quoteClass = classifyMessageQuoteClass({
        body: msg.bodyText,
        attachments: msg.attachments,
      });
      const bodyQuote = parseQuoteFromBody(msg.bodyText);
      if (quoteClass !== "no_quote" || bodyQuote !== null) deterministicQuoteSignals++;

      // Attachment bytes extraction (extractAttachmentText never throws).
      for (const ref of msg.attachments) {
        try {
          const data = await ro.downloadAttachment(msg.messageId, ref);
          const result = await extractAttachmentText(data.bytes, data.mimeType, data.filename);
          if (result.ok) attachmentsParsed++;
        } catch (attachErr) {
          // Transient download failures are non-fatal; skip and continue.
          process.stderr.write(`[probe] attachment skip (${ref.filename ?? ref.attachmentId}): ${String(attachErr)}\n`);
        }
      }
    }
  }

  const report = {
    account,
    window: windowDays,
    matched,
    scanned,
    // withBodyText: messages where bodyText is non-empty after mapMessage.
    // This is the closest proxy for HTML→plain recovery available from the
    // Message struct (the HTML-only path populates bodyText when the
    // text/plain part is absent), but it cannot distinguish that case from
    // a normal text-part message — so no separate htmlOnlyRecovered field.
    withBodyText,
    attachmentsParsed,
    deterministicQuoteSignals,
    currentHistoryId,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[probe] fatal: ${String(err)}\n`);
  process.exit(1);
});
