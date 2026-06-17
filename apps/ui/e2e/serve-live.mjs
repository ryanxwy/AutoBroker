/**
 * serve-live.mjs — the LIVE e2e dashboard host for the nightly 全技能巡检.
 *
 * Like serve.mjs it boots the REAL @autobroker/server + serves the REAL built
 * apps/ui/dist on an ISOLATED throwaway DB, but it is wired for a LIVE DeepSeek
 * walkthrough (the loop e2e), NOT the deterministic UI lane:
 *
 *   - DeepSeek is REAL: we do NOT pin a dummy key, so boot's loadDotEnvKeys
 *     loads DEEPSEEK_API_KEY from .env and every LLM step (intake trim-verify,
 *     dealer_reply_extract, negotiation drafts) talks to the real provider.
 *   - The geocoder is STILL stubbed (resolveLocation → a fixed real location):
 *     the Places key has no Geocoding entitlement, so a live geocode blocks.
 *   - Safety floor armed: AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1 (fake-send) +
 *     AUTOBROKER_GMAIL_BACKEND=fake. AUTOBROKER_TEST_AUTO_APPROVE is NEVER set.
 *
 * Control routes (OUTSIDE /api, the wall is untouched):
 *   POST /__e2e/inject_replies { profileId, replies:[{dealerName,dealerWebsite,
 *        from,subject,body,attachment?}] } → applyDealerReplySeeds (the tested
 *        harness seeder: bound dealer + thread + inbound 'pending' message +
 *        fake-mailbox body) so the dashboard's email skills have a real corpus.
 *   GET  /__e2e/audit?action=  → count audit_log rows (verification).
 *   GET  /__e2e/rows?table=    → count rows in an allow-listed table (verification).
 *
 * Run: pnpm e2e:serve-live   (from the repo root; prints a JSON line). Plain
 * node — every import resolves to a built @autobroker/* dist, so no tsx loader.
 * Fixed port 8131 so Playwright can navigate to a known URL.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildServer } from "@autobroker/server";
import { openDb, seedFakeMailbox } from "@autobroker/tools";
import {
  __setIntakeDepsForTests,
  resetMastraForTests,
  resetRuntimeGlueForTests,
} from "@autobroker/workflows";

// Inlined from harness/seed.ts applyDealerReplySeeds (so this runs under plain
// node — tsx is not resolvable from the repo root). Creates, per reply: a bound
// dealer + profile-scoped thread + inbound 'pending' message + the fake-mailbox
// body the FakeGmailAdapter reads. internalDateMs is globally monotonic via a
// module counter so multi-round injections stay strictly increasing.
// contact_email is the reply-target ladder's rung-4 fallback. Without it (and
// without dealer_contacts / contact_id-bearing messages / lead_submissions for
// these injected dealers) negotiation_followup + dealer_closeout_email resolve a
// null reply target and silently report "no candidates" — so seed it from the
// dealer's reply `from`, which IS their contact address, to make those drafts
// actually exercisable by the nightly 巡检.
const INSERT_DEALER =
  "INSERT INTO dealers (dealer_id, name, website, country, contact_email) VALUES (?, ?, ?, 'US', ?) " +
  "ON CONFLICT(dealer_id) DO UPDATE SET contact_email = excluded.contact_email";
const BIND_DEALER =
  "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound') " +
  "ON CONFLICT(search_profile_id, dealer_id) DO NOTHING";
// gmail_thread_id must be set: dealer_closeout_email replies on the thread and
// uses gmail_thread_id as the in_reply_to anchor — a null anchor with a non-null
// thread_id trips the reply double-flag invariant (thread_flag_mismatch) and the
// closeout send fails closed. A real ingested thread always carries it, so seed a
// stable fake gmail thread id to keep closeout exercisable.
const INSERT_THREAD =
  "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id, gmail_thread_id) " +
  "VALUES (?, ?, ?, 'replied', ?, ?) ON CONFLICT(thread_id) DO NOTHING";
const INSERT_MESSAGE =
  "INSERT INTO messages " +
  "(message_id, thread_id, gmail_message_id, direction, sender, sender_email, sender_name, " +
  "subject, body_text, received_at, search_profile_id, quote_extraction_status, quote_extraction_intent) " +
  "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, 'pending', NULL) " +
  "ON CONFLICT(message_id) DO NOTHING";
let injectSeq = 0;
// ~2 days ago (not a fixed 2024 epoch): keeps replies INSIDE the negotiation
// follow-up window (max 14d since the dealer's last reply) and reads as a fresh
// inbox, so the nightly 巡检 can actually exercise negotiation_followup +
// dealer_closeout_email drafts. Monotonic via injectSeq below.
const BASE_MS = Date.now() - 2 * 24 * 60 * 60 * 1000;

function injectDealerReplies(profileId, replies) {
  const adb = openDb();
  try {
    const insertDealer = adb.$client.prepare(INSERT_DEALER);
    const bindDealer = adb.$client.prepare(BIND_DEALER);
    const insertThread = adb.$client.prepare(INSERT_THREAD);
    const insertMessage = adb.$client.prepare(INSERT_MESSAGE);
    let dealers = 0, threads = 0, messages = 0, attachments = 0;
    for (const reply of replies) {
      const slug = `${profileId}-${randomUUID().slice(0, 8)}`;
      const dealerId = `live-dealer-${slug}`;
      const threadId = `live-thread-${slug}`;
      const messageId = `live-msg-${slug}`;
      const gmailMessageId = `live-gmsg-${slug}`;
      const internalDateMs = BASE_MS + injectSeq++;
      const receivedAt = new Date(internalDateMs).toISOString();
      if (insertDealer.run(dealerId, reply.dealerName, reply.dealerWebsite, reply.from).changes > 0) dealers++;
      bindDealer.run(profileId, dealerId);
      if (insertThread.run(threadId, dealerId, reply.subject, profileId, `live-gthread-${slug}`).changes > 0)
        threads++;
      const attachment = reply.attachment === null ? undefined : [{
        attachmentId: `live-att-${slug}`,
        filename: reply.attachment.filename,
        mimeType: reply.attachment.mimeType,
        dataBase64: reply.attachment.dataBase64,
      }];
      const fakeResult = seedFakeMailbox({
        db: adb,
        threads: [{
          threadId: `fake-${threadId}`,
          subject: reply.subject,
          searchProfileId: profileId,
          messages: [{
            messageId: gmailMessageId,
            direction: "inbound",
            from: reply.from,
            to: "buyer@example.com",
            subject: reply.subject,
            bodyText: reply.body,
            internalDateMs,
            ...(attachment !== undefined ? { attachments: attachment } : {}),
          }],
        }],
      });
      attachments += fakeResult.attachments;
      if (insertMessage.run(messageId, threadId, gmailMessageId, reply.from, reply.from,
        reply.dealerName, reply.subject, reply.body, receivedAt, profileId).changes > 0) messages++;
    }
    return { dealers, threads, messages, attachments };
  } finally {
    adb.$client.close();
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");
// A fresh DB must receive the WHOLE committed migration set in journal order — a
// later migration carries the fake_mailbox_* tables the inject route needs. Read
// drizzle's _journal.json (not a hardcoded list) so a newly-added migration is
// picked up automatically by the nightly 巡检 instead of being silently missed.
function migrationFilesInOrder() {
  try {
    const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"));
    const tags = (journal.entries ?? []).map((e) => e.tag).filter(Boolean);
    if (tags.length > 0) return tags.map((t) => join(DRIZZLE_DIR, `${t}.sql`));
  } catch { /* fall through to a sorted glob */ }
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(DRIZZLE_DIR, f));
}
const MIGRATION_FILES = migrationFilesInOrder();
const PORT = Number(process.env.PORT ?? 8131);

// --- isolation + safety floor (NEVER ~/.autobroker*; never auto-approve) ----
// Default to a fresh throwaway dir per boot. AUTOBROKER_LIVE_E2E_REUSE_DIR lets a
// restart reuse an already-seeded dir (paired with the idempotent migration guard
// below) so a long 巡检 survives a server restart without re-seeding from scratch.
const tmpDir =
  process.env.AUTOBROKER_LIVE_E2E_REUSE_DIR ?? mkdtempSync(join(tmpdir(), "autobroker-live-e2e-"));
process.env.AUTOBROKER_DATA_DIR = tmpDir;
delete process.env.AUTOBROKER_DB;
process.env.NODE_ENV = "test"; // arms the intake deps seam guard
delete process.env.AUTOBROKER_TEST_AUTO_APPROVE;
process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "1"; // fake-send floor
process.env.AUTOBROKER_GMAIL_BACKEND = "fake";
// NOTE: DEEPSEEK_API_KEY is intentionally NOT set here — boot's loadDotEnvKeys
// loads the real key from .env (no-clobber), so the LLM lane is LIVE.

const dbPath = join(tmpDir, "autobroker.db");
const db = openDb();
// A reused dir already carries the schema — re-running the (no-IF-NOT-EXISTS)
// migration set would throw "table already exists". Apply only to a fresh DB.
const alreadyMigrated =
  db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
    .get() !== undefined;
if (!alreadyMigrated) {
  for (const file of MIGRATION_FILES) db.$client.exec(readFileSync(file, "utf8"));
  db.$client
    .prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)")
    .run("acct-live-e2e-1", "live-e2e@example.com");
}
db.$client.close();

// --- geocoder stub ONLY (a fixed real location); harnessGenerate stays REAL ---
const RESOLVED = {
  kind: "resolved",
  location: {
    lat: 33.6695, lng: -117.7669,
    formattedAddress: "Irvine, CA 92602, USA",
    postalCode: "92602",
  },
  traceSpans: [],
};
const resolveLocationStub = async () => RESOLVED;

resetMastraForTests();
resetRuntimeGlueForTests();
// Partial merge keeps the REAL harnessGenerate (live DeepSeek for intake too).
__setIntakeDepsForTests({ resolveLocation: resolveLocationStub });

const built = await buildServer({ quiet: true });

built.app.post("/__e2e/inject_replies", async (req, reply) => {
  const body = req.body ?? {};
  const profileId = body.profileId;
  const replies = Array.isArray(body.replies) ? body.replies : [];
  if (typeof profileId !== "string" || replies.length === 0) {
    reply.code(400);
    return { ok: false, error: "profileId + non-empty replies[] required" };
  }
  const normalized = replies.map((r) => ({
    dealerName: String(r.dealerName ?? "Dealer"),
    dealerWebsite: String(r.dealerWebsite ?? "https://dealer.example.com"),
    from: String(r.from ?? "sales@dealer.example.com"),
    subject: String(r.subject ?? "Re: your inquiry"),
    body: String(r.body ?? ""),
    attachment: r.attachment ?? null,
  }));
  const applied = injectDealerReplies(profileId, normalized);
  reply.code(200);
  return { ok: true, applied };
});

built.app.get("/__e2e/audit", async (req, reply) => {
  const action = (req.query ?? {}).action;
  const adb = openDb();
  try {
    const sql = typeof action === "string" && action.length > 0
      ? "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?"
      : "SELECT COUNT(*) AS n FROM audit_log";
    const stmt = adb.$client.prepare(sql);
    const row = typeof action === "string" && action.length > 0 ? stmt.get(action) : stmt.get();
    reply.code(200);
    return { action: action ?? null, count: row.n };
  } finally {
    adb.$client.close();
  }
});

const ALLOWED_TABLES = new Set([
  "dealer_quotes", "quote_audits", "messages", "dealers", "profile_dealers",
  "threads", "search_profiles", "lead_submissions", "manufacturer_incentives",
  "inventory_listings", "audit_log", "fake_mailbox_messages",
]);
built.app.get("/__e2e/rows", async (req, reply) => {
  const table = (req.query ?? {}).table;
  if (typeof table !== "string" || !ALLOWED_TABLES.has(table)) {
    reply.code(400);
    return { ok: false, error: "unknown table" };
  }
  const adb = openDb();
  try {
    const row = adb.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    reply.code(200);
    return { table, count: row.n };
  } finally {
    adb.$client.close();
  }
});

const listenAddr = await built.app.listen({ host: "127.0.0.1", port: PORT });
const addr = built.app.server.address();
const port = typeof addr === "object" && addr !== null ? addr.port : PORT;
console.log(JSON.stringify({ liveE2e: "listening", url: listenAddr, port, dataDir: tmpDir }));

const shutdown = async () => {
  try { await built.app.close(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
