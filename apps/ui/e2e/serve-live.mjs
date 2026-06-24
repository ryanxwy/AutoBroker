/**
 * serve-live.mjs — the LIVE e2e dashboard host for the 全技能巡检.
 *
 * Like serve.mjs it boots the REAL @autobroker/server + serves the REAL built
 * apps/ui/dist on an ISOLATED throwaway DB, but it is wired for a LIVE DeepSeek
 * walkthrough (the loop e2e), NOT the deterministic UI lane:
 *
 *   - DeepSeek is REAL: we do NOT pin a dummy key, so boot's loadDotEnvKeys
 *     loads DEEPSEEK_API_KEY from .env and every LLM step (intake trim-verify,
 *     dealer_reply_extract, negotiation drafts) talks to the real provider.
 *   - The geocoder is a query-HONORING fixture map (resolveLocation → the metro
 *     allowlist's real coords): the Places key has no Geocoding entitlement (a
 *     live geocode blocks) and the 巡检 stays hermetic, yet ANY allowlist city
 *     resolves — so the buyer-brain can search any metro (brand+city), not Irvine.
 *   - Safety floor armed: AUTOBROKER_MODE=test — the sole send-control floor; the
 *     Gmail backend projects to fake from it. AUTOBROKER_TEST_AUTO_APPROVE is
 *     NEVER set.
 *
 * Control routes (OUTSIDE /api, the wall is untouched):
 *   POST /__e2e/inject_replies { profileId, replies:[{dealerName,dealerWebsite,
 *        from,subject,body,attachment?}] } → applyDealerReplySeeds (the tested
 *        harness seeder: bound dealer + thread + inbound 'pending' message +
 *        fake-mailbox body) so the dashboard's email skills have a real corpus.
 *        Echoes applied.threadIds[] so the dealer-brain can post in-thread counters.
 *   POST /__e2e/inject_reply_to_thread { threadId, from, subject, body } → append a
 *        dealer COUNTER into an existing thread (live multi-round negotiation).
 *   GET  /__e2e/audit?action=  → count audit_log rows (verification).
 *   GET  /__e2e/rows?table=    → count rows in an allow-listed table (verification).
 *   GET  /__e2e/dataquality?skill=&profileId= → per-skill USABILITY coverage
 *                              (covered/n + nullEscape/gated escapes), NOT count —
 *                              catches a count-green / quality-empty scan.
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
  __setHarnessModelWrapper,
  JsonlFileSink,
  parseTranscriptJsonl,
  recordingModel,
  replayModel,
  TraceIndex,
} from "@autobroker/model";
import {
  __setHarnessGenerateFaultForTests,
  __setIntakeDepsForTests,
  resetMastraForTests,
  resetRuntimeGlueForTests,
} from "@autobroker/workflows";
// __setHarnessGenerateFaultForTests is the model-layer generate-fault seam (T4-U2),
// re-exported by @autobroker/workflows: arming it makes the next resolved model fail
// closed (llm_500 throw / llm_timeout reject) — the LLM twin of the geocode
// tool_timeout. NODE_ENV="test" (set below) satisfies its test-only guard.

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
// actually exercisable by the e2e 巡检.
const INSERT_DEALER =
  "INSERT INTO dealers (dealer_id, name, website, country, contact_email) VALUES (?, ?, ?, 'US', ?) " +
  "ON CONFLICT(dealer_id) DO UPDATE SET contact_email = excluded.contact_email";
// status is parameterized so the SHARED-DEALER mode can seed a 'candidate' row
// (the production geosearch shape — upsertDealers writes 'candidate') while the
// default per-profile-unique path keeps pre-binding 'bound' (so the live 巡检's
// closeout/negotiation/digest, which read pd.status='bound', stay exercisable
// without first running lead_submit). A 'bound' row from a SECOND profile sharing
// one dealer_id would trip the partial-unique uq_profile_dealers_bound_dealer
// index (which the composite-PK ON CONFLICT does NOT catch) → 'candidate' is the
// only shape both profiles can hold, leaving the live claimDealer step to pick the
// exclusivity winner — exactly the production flow the shared-dealer mode tests.
const BIND_DEALER =
  "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, ?) " +
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
// Parameterized-direction message insert (the hygiene CRM seed needs an OUTBOUND
// sibling message; INSERT_MESSAGE above hardcodes 'inbound').
const INSERT_MSG_DIR =
  "INSERT INTO messages (message_id, thread_id, direction, sender_email, subject, body_text, " +
  "received_at, search_profile_id, quote_extraction_status) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(message_id) DO NOTHING";
// message_analysis row marking an inbound message as suppressible CRM noise — the
// table dealer_hygiene's 5b CRM-only detector reads (is_current=1 + a suppressible
// intent like 'nurture'); the existing inject_replies route never writes it, which
// is exactly why hygiene found nothing to clean in the 巡检.
const INSERT_ANALYSIS =
  "INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent, search_profile_id) " +
  "VALUES (?, ?, 1, 1, ?, ?) ON CONFLICT(analysis_id) DO NOTHING";
// A named dealer-side contact (the reply-target ladder's rung-1 primary_reply_target
// / rung-2 latest_inbound_contact). normalized_email is NOT NULL with a UNIQUE
// (dealer_id, normalized_email) index, so we always write the lowercased trim.
// foreign_keys=ON means messages.contact_id can only be set AFTER the
// dealer_contacts row exists — injectContact inserts the contact first, then links.
const INSERT_CONTACT =
  "INSERT INTO dealer_contacts " +
  "(contact_id, dealer_id, email, display_name, normalized_email, role, is_primary_reply_target, search_profile_id) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(contact_id) DO NOTHING";
const SET_MSG_CONTACT =
  "UPDATE messages SET contact_id = ? WHERE thread_id = ? AND direction = 'inbound'";
let injectSeq = 0;
// ~2 days ago (not a fixed 2024 epoch): keeps replies INSIDE the negotiation
// follow-up window (max 14d since the dealer's last reply) and reads as a fresh
// inbox, so the e2e 巡检 can actually exercise negotiation_followup +
// dealer_closeout_email drafts. Monotonic via injectSeq below.
const BASE_MS = Date.now() - 2 * 24 * 60 * 60 * 1000;

// The per-reply receive clock. By default every reply lands at BASE_MS (~2d ago),
// so the timing gate (gateDecisionForTarget) only ever returns "ready" — skip
// (cold >14d) and wait (<24h since OUR send) never fire. ageHoursAgo / delayMinutes
// let a case age a reply explicitly so the gate's skip/wait edges are exercisable.
//   - ageHoursAgo: now minus N hours (use a large N like 360 to force "skip").
//   - delayMinutes: BASE_MS plus N minutes (a small nudge relative to the floor).
// Caveat: each reply is its own single-message seedFakeMailbox call, so the
// fakeSeed strict-increasing guard does NOT span replies — an out-of-order
// ageHoursAgo batch will NOT throw at seed time. Order replies[] oldest-first by
// convention so the +injectSeq epsilon doesn't fight your intended tie order.
function replyBaseMs(reply) {
  if (typeof reply.ageHoursAgo === "number") return Date.now() - reply.ageHoursAgo * 60 * 60 * 1000;
  if (typeof reply.delayMinutes === "number") return BASE_MS + reply.delayMinutes * 60 * 1000;
  return BASE_MS;
}

function injectDealerReplies(profileId, replies) {
  const adb = openDb();
  try {
    const insertDealer = adb.$client.prepare(INSERT_DEALER);
    const bindDealer = adb.$client.prepare(BIND_DEALER);
    const insertThread = adb.$client.prepare(INSERT_THREAD);
    const insertMessage = adb.$client.prepare(INSERT_MESSAGE);
    let dealers = 0, threads = 0, messages = 0, attachments = 0;
    // Echo each seeded thread so the dealer-brain can post an in-thread COUNTER
    // (round 2+) via /__e2e/inject_reply_to_thread — multi-round live negotiation.
    const threadIds = [];
    for (const reply of replies) {
      const slug = `${profileId}-${randomUUID().slice(0, 8)}`;
      // B2 SHARED-DEALER MODE: if the caller supplies an explicit `dealer_key`, that
      // string is used as the dealer_id directly instead of the per-profile-unique
      // slug. Calling inject_replies for a SECOND profile with the SAME dealer_key
      // reuses the existing dealers row (ON CONFLICT DO UPDATE) and inserts a fresh
      // profile_dealers 'candidate' row for that profile — so both profiles share one
      // rooftop and the live claimDealer step decides the exclusivity winner (a
      // 'bound' second row would trip uq_profile_dealers_bound_dealer). Omitting
      // dealer_key preserves the old per-profile-unique 'bound' pre-bind.
      const sharedDealer = typeof reply.dealer_key === "string" && reply.dealer_key.length > 0;
      const dealerId = sharedDealer
        ? `live-dealer-${reply.dealer_key}`
        : `live-dealer-${slug}`;
      const threadId = `live-thread-${slug}`;
      const messageId = `live-msg-${slug}`;
      const gmailMessageId = `live-gmsg-${slug}`;
      const internalDateMs = replyBaseMs(reply) + injectSeq++;
      const receivedAt = new Date(internalDateMs).toISOString();
      if (insertDealer.run(dealerId, reply.dealerName, reply.dealerWebsite, reply.from).changes > 0) dealers++;
      bindDealer.run(profileId, dealerId, sharedDealer ? "candidate" : "bound");
      if (insertThread.run(threadId, dealerId, reply.subject, profileId, `live-gthread-${slug}`).changes > 0)
        threads++;
      threadIds.push({ dealerName: reply.dealerName, from: reply.from, threadId });
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
    return { dealers, threads, messages, attachments, threadIds };
  } finally {
    adb.$client.close();
  }
}

// Append a NEW inbound message into an EXISTING thread (a dealer's COUNTER in a
// live multi-round negotiation), instead of minting a fresh thread the way
// injectDealerReplies does. Looks up the thread's profile, writes one inbound
// 'pending' message on the SAME thread_id + appends into the same fake-mailbox
// thread (fake-${threadId}), reusing the monotonic injectSeq clock so the round-2
// timestamp stays strictly after round-1 (the watermark invariant). dealer_reply_
// extract then re-extracts the new pending message → a NEW dealer_quotes row
// carrying the revised OTD (keyed by the fresh gmail_message_id; the latest quote
// wins downstream), so negotiation_followup/dealer_closeout act on the updated OTD.
function injectReplyToThread(threadId, reply) {
  const adb = openDb();
  try {
    const row = adb.$client
      .prepare("SELECT search_profile_id AS profileId FROM threads WHERE thread_id = ?")
      .get(threadId);
    if (row === undefined || row.profileId === null) {
      return { ok: false, error: "unknown threadId (call inject_replies first)" };
    }
    const profileId = row.profileId;
    const slug = `${profileId}-${randomUUID().slice(0, 8)}`;
    const messageId = `live-msg-${slug}`;
    const gmailMessageId = `live-gmsg-${slug}`;
    const internalDateMs = BASE_MS + injectSeq++;
    const receivedAt = new Date(internalDateMs).toISOString();
    seedFakeMailbox({
      db: adb,
      threads: [{
        threadId: `fake-${threadId}`, // same fake thread → a 2+-message conversation
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
        }],
      }],
    });
    const changed = adb.$client.prepare(INSERT_MESSAGE).run(
      messageId, threadId, gmailMessageId, reply.from, reply.from,
      reply.dealerName, reply.subject, reply.body, receivedAt, profileId,
    ).changes;
    return { ok: true, threadId, messageId, messages: changed };
  } finally {
    adb.$client.close();
  }
}

// Seed CRM-only threads so dealer_hygiene's 3-stage destructive gate is
// exercisable. Per dealer, the 5b "CRM-only" detector fires when a dealer has
// (a) a real OUTBOUND conversation thread AND (b) a separate inbound-only thread
// whose only current message_analysis intent is suppressible CRM noise (nurture/
// marketing/…) with no quote/pricing intent and no offers row. So per dealer we
// insert: an outbound sibling thread+message + an inbound CRM thread+message +
// a message_analysis(intent='nurture') on the inbound message. No quotes/offers
// (those would disqualify the thread).
function injectCrmThreads(profileId, dealers) {
  const adb = openDb();
  try {
    const insertDealer = adb.$client.prepare(INSERT_DEALER);
    const bindDealer = adb.$client.prepare(BIND_DEALER);
    const insertThread = adb.$client.prepare(INSERT_THREAD);
    const insertMsgDir = adb.$client.prepare(INSERT_MSG_DIR);
    const insertAnalysis = adb.$client.prepare(INSERT_ANALYSIS);
    let threads = 0, analyses = 0;
    for (const d of dealers) {
      const slug = `${profileId}-${randomUUID().slice(0, 8)}`;
      const dealerId = `crm-dealer-${slug}`;
      const outThreadId = `crm-out-${slug}`;
      const crmThreadId = `crm-in-${slug}`;
      const nowIso = new Date(BASE_MS + injectSeq++).toISOString();
      insertDealer.run(dealerId, d.dealerName, "https://crm.example.com", "sales@crm.example.com");
      // Per-profile-unique CRM dealer (never shared) → keep the 'bound' pre-bind so
      // dealer_hygiene's bound-dealer reads find it.
      bindDealer.run(profileId, dealerId, "bound");
      // (a) the real outbound conversation thread (satisfies the EXISTS clause).
      insertThread.run(outThreadId, dealerId, "Your inquiry", profileId, `crm-gthread-out-${slug}`);
      insertMsgDir.run(`crm-msg-out-${slug}`, outThreadId, "outbound", "buyer@example.com",
        "Your inquiry", "Following up on the Tucson.", nowIso, profileId);
      // (b) the inbound-only CRM-noise thread that hygiene should flag.
      if (insertThread.run(crmThreadId, dealerId, d.subject ?? "This week's specials!", profileId,
        `crm-gthread-in-${slug}`).changes > 0) threads++;
      insertMsgDir.run(`crm-msg-in-${slug}`, crmThreadId, "inbound", d.from ?? "noreply@crm.example.com",
        d.subject ?? "This week's specials!", d.body ?? "Huge savings this weekend — visit us!", nowIso, profileId);
      if (insertAnalysis.run(`crm-an-${slug}`, `crm-msg-in-${slug}`, d.intent ?? "nurture", profileId).changes > 0)
        analyses++;
    }
    return { dealers: dealers.length, crmThreads: threads, analyses };
  } finally {
    adb.$client.close();
  }
}

// Seed a named dealer-side contact on an existing thread's dealer and link this
// thread's inbound message(s) to it, so resolveReplyTarget climbs from rung-4
// (dealers.contact_email) to rung-1 primary_reply_target (or rung-2
// latest_inbound_contact). Makes A18 contact-flip / A19 rename live-reachable —
// the workflow path (negotiationFollowup → setPrimaryReplyTarget) already exists;
// this is the missing fixture. Own openDb()/finally. The contact is inserted
// BEFORE the messages.contact_id UPDATE (foreign_keys=ON enforces that order).
function injectContact(threadId, contact) {
  const adb = openDb();
  try {
    const row = adb.$client
      .prepare("SELECT dealer_id AS dealerId, search_profile_id AS profileId FROM threads WHERE thread_id = ?")
      .get(threadId);
    if (row === undefined || row.dealerId === null) {
      return { ok: false, error: "unknown threadId (call inject_replies first)" };
    }
    const contactId = `live-contact-${row.dealerId}-${randomUUID().slice(0, 8)}`;
    const normalized = contact.email.trim().toLowerCase();
    adb.$client.prepare(INSERT_CONTACT).run(
      contactId, row.dealerId, contact.email, contact.displayName, normalized,
      contact.role, contact.isPrimary ? 1 : 0, row.profileId,
    );
    const messagesLinked = adb.$client.prepare(SET_MSG_CONTACT).run(contactId, threadId).changes;
    return { ok: true, threadId, contactId, messagesLinked };
  } finally {
    adb.$client.close();
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");
// A fresh DB must receive the WHOLE committed migration set in journal order — a
// later migration carries the fake_mailbox_* tables the inject route needs. Read
// drizzle's _journal.json (not a hardcoded list) so a newly-added migration is
// picked up automatically by the e2e 巡检 instead of being silently missed.
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
process.env.AUTOBROKER_MODE = "test"; // the sole send-control floor (Gmail projects to fake)
// NOTE: DEEPSEEK_API_KEY is intentionally NOT set here — boot's loadDotEnvKeys
// loads the real key from .env (no-clobber), so the LLM lane is LIVE.

// --- Phase-4 record/replay hook (ADDITIVE, env-gated, DEFAULT OFF) ------------
// Mirrors the generate-fault seam install above. When AUTOBROKER_RECORD_TRANSCRIPT
// is set, every resolved model TEES its LLM calls to that JSONL file (recordingModel)
// while still talking to the live provider — capturing a multi-profile transcript
// the freeze can replay. When AUTOBROKER_REPLAY_TRANSCRIPT is set, every resolved
// model returns the recorded calls token-for-token with NO provider (replayModel).
// Neither set → NO install, byte-identical to today. NODE_ENV="test" (set above)
// satisfies the seam's test-only guard. Record wins if both are somehow set.
const RECORD_TRANSCRIPT = process.env.AUTOBROKER_RECORD_TRANSCRIPT;
const REPLAY_TRANSCRIPT = process.env.AUTOBROKER_REPLAY_TRANSCRIPT;
if (RECORD_TRANSCRIPT) {
  const sink = new JsonlFileSink(RECORD_TRANSCRIPT);
  __setHarnessModelWrapper((model, alias) => recordingModel(model, sink, { runId: "live", alias }));
} else if (REPLAY_TRANSCRIPT) {
  const events = parseTranscriptJsonl(readFileSync(REPLAY_TRANSCRIPT, "utf8"));
  const index = new TraceIndex(events);
  const modelId = events[0]?.modelId ?? "replay";
  __setHarnessModelWrapper((_model, alias) => replayModel(index, { alias, modelId }));
}

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

// --- geocoder: a query-HONORING metro fixture map (NOT a live geocode) --------
// The Places key has NO Geocoding entitlement (a live geocode blocks), and an
// unattended e2e 巡检 should stay hermetic anyway. So instead of pinning ONE
// city we map the curated brand+city allowlist's metros → real coords: the typed
// location_query is matched by a 5-digit ZIP first, then a city-name substring,
// falling back to Irvine. This lets the buyer-brain search ANY allowlist metro
// (brand+city randomization) deterministically, with no external dependency.
// Keep these ZIPs/cities in lock-step with the loop prompt's metro allowlist.
// harnessGenerate stays REAL (live DeepSeek for intake too).
const METRO_FIXTURES = [
  { zip: "92602", city: "irvine",        lat: 33.6695, lng: -117.7669, addr: "Irvine, CA 92602, USA" },
  { zip: "90012", city: "los angeles",   lat: 34.0537, lng: -118.2428, addr: "Los Angeles, CA 90012, USA" },
  { zip: "92101", city: "san diego",     lat: 32.7174, lng: -117.1628, addr: "San Diego, CA 92101, USA" },
  { zip: "75201", city: "dallas",        lat: 32.7876, lng: -96.7990,  addr: "Dallas, TX 75201, USA" },
  { zip: "77002", city: "houston",       lat: 29.7589, lng: -95.3677,  addr: "Houston, TX 77002, USA" },
  { zip: "78701", city: "austin",        lat: 30.2700, lng: -97.7426,  addr: "Austin, TX 78701, USA" },
  { zip: "85004", city: "phoenix",       lat: 33.4515, lng: -112.0700, addr: "Phoenix, AZ 85004, USA" },
  { zip: "80202", city: "denver",        lat: 39.7491, lng: -104.9966, addr: "Denver, CO 80202, USA" },
  { zip: "98101", city: "seattle",       lat: 47.6109, lng: -122.3340, addr: "Seattle, WA 98101, USA" },
  { zip: "97204", city: "portland",      lat: 45.5183, lng: -122.6750, addr: "Portland, OR 97204, USA" },
  { zip: "60601", city: "chicago",       lat: 41.8855, lng: -87.6217,  addr: "Chicago, IL 60601, USA" },
  { zip: "30303", city: "atlanta",       lat: 33.7528, lng: -84.3915,  addr: "Atlanta, GA 30303, USA" },
  { zip: "33130", city: "miami",         lat: 25.7660, lng: -80.1960,  addr: "Miami, FL 33130, USA" },
  { zip: "33602", city: "tampa",         lat: 27.9517, lng: -82.4588,  addr: "Tampa, FL 33602, USA" },
  { zip: "28202", city: "charlotte",     lat: 35.2272, lng: -80.8431,  addr: "Charlotte, NC 28202, USA" },
  { zip: "37203", city: "nashville",     lat: 36.1534, lng: -86.7920,  addr: "Nashville, TN 37203, USA" },
  { zip: "10007", city: "new york",      lat: 40.7136, lng: -74.0089,  addr: "New York, NY 10007, USA" },
  { zip: "19107", city: "philadelphia",  lat: 39.9510, lng: -75.1605,  addr: "Philadelphia, PA 19107, USA" },
  { zip: "02110", city: "boston",        lat: 42.3573, lng: -71.0540,  addr: "Boston, MA 02110, USA" },
];
function resolveMetro(query) {
  const q = String(query ?? "").toLowerCase();
  const zip = q.match(/\b\d{5}\b/)?.[0] ?? null;
  const hit =
    (zip !== null ? METRO_FIXTURES.find((m) => m.zip === zip) : undefined) ??
    METRO_FIXTURES.find((m) => q.includes(m.city)) ??
    METRO_FIXTURES[0];
  return {
    kind: "resolved",
    location: { lat: hit.lat, lng: hit.lng, formattedAddress: hit.addr, postalCode: hit.zip },
    traceSpans: [],
  };
}
// --- injectable fault seam (T4-U2) -------------------------------------------
// A module-level one-shot fault flag the POST /__e2e/fault route arms. nextFault()
// decrements a remaining count and returns the armed mode while count > 0, then
// disarms to "none". "tool_timeout" throws from the geocode seam below;
// "llm_500"/"llm_timeout" are routed into the packages/model generate-fault seam
// (__setHarnessGenerateFaultForTests) by the route handler so the next resolved
// model fails closed. The geocode nextFault() counter is gated on "tool_timeout"
// (faultingResolveLocationStub) so it never eats an armed llm_* budget; the model
// seam is sticky-until-reset and decoupled from this counter.
const faultState = { mode: "none", remaining: 0 };
function nextFault() {
  if (faultState.remaining <= 0) {
    faultState.mode = "none";
    return "none";
  }
  faultState.remaining -= 1;
  const mode = faultState.mode;
  if (faultState.remaining === 0) faultState.mode = "none";
  return mode;
}

// The geocode stub, fault-aware: when tool_timeout is armed, throw (a transient
// tool fault). The intake resolveLocation step has NO try/catch and persist
// fail-louds on null coords, so the throw fails the run CLOSED — never a fabricated
// "resolved" or a NULL-coords write. geosearch reads persisted coords and never
// calls resolveLocation, so this only ever arms the INTAKE geocode step.
const faultingResolveLocationStub = async (query) => {
  // Only the geocode-relevant fault consumes the geocode budget — an armed llm_*
  // fault is left intact for the model seam (fixes the cross-mode counter foot-gun).
  if (faultState.mode === "tool_timeout" && nextFault() === "tool_timeout") {
    throw new Error("tool_timeout (injected fault: geocode)");
  }
  return resolveMetro(query);
};

resetMastraForTests();
resetRuntimeGlueForTests();
// Partial merge keeps the REAL harnessGenerate (live DeepSeek for intake too).
__setIntakeDepsForTests({ resolveLocation: faultingResolveLocationStub });

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
    // B2: pass through dealer_key when present so injectDealerReplies uses a
    // shared dealer_id across profiles instead of a per-profile-unique slug.
    ...(typeof r.dealer_key === "string" && r.dealer_key.length > 0 ? { dealer_key: r.dealer_key } : {}),
    ...(typeof r.ageHoursAgo === "number" ? { ageHoursAgo: r.ageHoursAgo } : {}),
    ...(typeof r.delayMinutes === "number" ? { delayMinutes: r.delayMinutes } : {}),
  }));
  const applied = injectDealerReplies(profileId, normalized);
  reply.code(200);
  return { ok: true, applied };
});

built.app.post("/__e2e/inject_crm_threads", async (req, reply) => {
  const body = req.body ?? {};
  const profileId = body.profileId;
  const dealers = Array.isArray(body.dealers) ? body.dealers : [];
  if (typeof profileId !== "string" || dealers.length === 0) {
    reply.code(400);
    return { ok: false, error: "profileId + non-empty dealers[] required" };
  }
  const normalized = dealers.map((d) => ({
    dealerName: String(d.dealerName ?? "CRM Dealer"),
    from: String(d.from ?? "noreply@crm.example.com"),
    subject: String(d.subject ?? "This week's specials!"),
    body: String(d.body ?? "Huge savings this weekend — visit us!"),
    intent: typeof d.intent === "string" ? d.intent : "nurture",
  }));
  const applied = injectCrmThreads(profileId, normalized);
  reply.code(200);
  return { ok: true, applied };
});

// Append a dealer's COUNTER into an existing thread (live multi-round negotiation).
// The threadId comes from inject_replies' echoed `applied.threadIds[].threadId`.
built.app.post("/__e2e/inject_reply_to_thread", async (req, reply) => {
  const body = req.body ?? {};
  if (typeof body.threadId !== "string" || typeof body.body !== "string" || body.body.length === 0) {
    reply.code(400);
    return { ok: false, error: "threadId + non-empty body required" };
  }
  const applied = injectReplyToThread(body.threadId, {
    from: String(body.from ?? "sales@dealer.example.com"),
    subject: String(body.subject ?? "Re: your inquiry"),
    body: body.body,
    dealerName: String(body.dealerName ?? "Dealer"),
  });
  reply.code(applied.ok ? 200 : 400);
  return applied;
});

// Seed a named reply-target contact on a thread's dealer + link the thread's
// inbound message(s) → unlocks reply-target rung 1/2 (primary_reply_target /
// latest_inbound_contact) so contact-flip (A18) / rename (A19) are reachable live.
built.app.post("/__e2e/inject_contact", async (req, reply) => {
  const body = req.body ?? {};
  if (typeof body.threadId !== "string" || typeof body.email !== "string" || body.email.length === 0) {
    reply.code(400);
    return { ok: false, error: "threadId + non-empty email required" };
  }
  const applied = injectContact(body.threadId, {
    email: body.email,
    displayName: typeof body.displayName === "string" ? body.displayName : null,
    role: typeof body.role === "string" ? body.role : null,
    isPrimary: body.isPrimary === true,
  });
  reply.code(applied.ok ? 200 : 400);
  return applied;
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

// Arm an injectable fault for the next N fault-points (T4-U2). {mode,count}:
//   mode ∈ "none" | "tool_timeout" | "llm_500" | "llm_timeout"
//   count = how many subsequent fault-points fire (default 1; "none" disarms; count
//           is only meaningful for tool_timeout — the model seam is sticky-until-reset).
// Returns {ok,mode,remaining}. tool_timeout throws from the geocode seam → the intake
// resolveLocation step fails CLOSED. llm_500/llm_timeout arm the packages/model
// generate-fault seam so the next resolved model fails closed (a provider-5xx /
// hung-request twin) — the throw flows through the workflows harness .catch()
// (NULL-not-$0 ledger row + re-throw), never a fabricated success. Used to
// adversarially test inv #4 (fail-closed) / #12 (no silent fallback).
const FAULT_MODES = new Set(["none", "tool_timeout", "llm_500", "llm_timeout"]);
built.app.post("/__e2e/fault", async (req, reply) => {
  const body = req.body ?? {};
  const mode = typeof body.mode === "string" ? body.mode : "none";
  if (!FAULT_MODES.has(mode)) {
    reply.code(400);
    return { ok: false, error: `unknown fault mode "${mode}"` };
  }
  if (mode === "none") {
    faultState.mode = "none";
    faultState.remaining = 0;
    __setHarnessGenerateFaultForTests("none"); // disarm the model seam too.
  } else {
    const count = Number.isInteger(body.count) && body.count > 0 ? body.count : 1;
    faultState.mode = mode;
    faultState.remaining = count;
    // Route the LLM faults into the model-layer generate seam so the NEXT resolved
    // model fails closed (llm_500 = throw, llm_timeout = reject-after-delay). The
    // geocode seam still consumes tool_timeout; the model seam is sticky-until-reset
    // (it manages its own arm/disarm, decoupled from the geocode nextFault() counter).
    if (mode === "llm_500" || mode === "llm_timeout") {
      __setHarnessGenerateFaultForTests(mode);
    }
  }
  reply.code(200);
  return { ok: true, mode: faultState.mode, remaining: faultState.remaining };
});

const ALLOWED_TABLES = new Set([
  "dealer_quotes", "quote_audits", "messages", "dealers", "profile_dealers",
  "threads", "search_profiles", "lead_submissions", "manufacturer_incentives",
  "inventory_listings", "audit_log", "fake_mailbox_messages", "message_analysis",
  "dealer_contacts",
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

// Data-QUALITY verdict (not count). /__e2e/rows can only count rows, so a scan
// that writes N listings with every price NULL reads identical to N good rows —
// the exact blind spot that passed a 0-priced scan GREEN (2026-06-22). This
// route returns per-skill USABILITY coverage: covered/n plus the structural
// escapes (nullEscape, gated) that distinguish a legitimately-empty result from
// a silent data-loss. Brand-agnostic ratios — names no make/metro/row-count, so
// it generalizes to the next random brand. Test-host only; product wall untouched.
const DATAQUALITY_SKILLS = new Set(["inventory_site_scan", "dealer_reply_extract"]);
built.app.get("/__e2e/dataquality", async (req, reply) => {
  const q = req.query ?? {};
  const skill = q.skill;
  const profileId = typeof q.profileId === "string" && q.profileId.length > 0 ? q.profileId : null;
  if (typeof skill !== "string" || !DATAQUALITY_SKILLS.has(skill)) {
    reply.code(400);
    return { ok: false, error: "unknown dataquality skill" };
  }
  const round2 = (x) => Math.round(x * 100) / 100;
  const adb = openDb();
  try {
    if (skill === "inventory_site_scan") {
      // Usable price coverage over the LIVE (non-superseded) listings.
      const where = profileId
        ? "WHERE superseded_at IS NULL AND search_profile_id = ?"
        : "WHERE superseded_at IS NULL";
      const r = adb.$client
        .prepare(
          `SELECT COUNT(*) AS n,
             SUM(CASE WHEN listed_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
             SUM(CASE WHEN msrp IS NOT NULL THEN 1 ELSE 0 END) AS msrp_present,
             SUM(CASE WHEN listed_price IS NOT NULL OR msrp IS NOT NULL THEN 1 ELSE 0 END) AS covered,
             SUM(CASE WHEN listing_url IS NOT NULL THEN 1 ELSE 0 END) AS vdp_linked
           FROM inventory_listings ${where}`,
        )
        .get(...(profileId ? [profileId] : []));
      const n = r.n ?? 0;
      const covered = r.covered ?? 0;
      reply.code(200);
      return {
        skill,
        n,
        metric: "price_coverage",
        covered,
        coverage: n > 0 ? round2(covered / n) : 0,
        priced: r.priced ?? 0,
        msrp_present: r.msrp_present ?? 0,
        // Honest gated-vs-lost discriminator (inventory_status='price_gated') is
        // not yet persisted (a separate backlog item); structurally 0 today, so a
        // genuinely all-gated dealer still FAILs — acceptable because in the bug
        // the VDP exposed the price and the scan dropped it.
        gated: 0,
        vdp_linked: r.vdp_linked ?? 0,
        nullEscape: n === 0,
      };
    }
    // dealer_reply_extract — OTD coverage over the extracted quotes.
    const whereQ = profileId ? "WHERE search_profile_id = ?" : "";
    const rq = adb.$client
      .prepare(
        `SELECT COUNT(*) AS n,
           SUM(CASE WHEN otd_total IS NOT NULL THEN 1 ELSE 0 END) AS otd_present
         FROM dealer_quotes ${whereQ}`,
      )
      .get(...(profileId ? [profileId] : []));
    const rm = adb.$client
      .prepare(
        `SELECT
           SUM(CASE WHEN quote_extraction_status = 'succeeded' THEN 1 ELSE 0 END) AS extract_succeeded,
           SUM(CASE WHEN quote_extraction_status = 'failed' THEN 1 ELSE 0 END) AS extract_failed
         FROM messages ${whereQ}`,
      )
      .get(...(profileId ? [profileId] : []));
    const n = rq.n ?? 0;
    const otd = rq.otd_present ?? 0;
    reply.code(200);
    return {
      skill,
      n,
      metric: "otd_coverage",
      covered: otd,
      coverage: n > 0 ? round2(otd / n) : 0,
      otd_present: otd,
      extract_succeeded: rm.extract_succeeded ?? 0,
      extract_failed: rm.extract_failed ?? 0,
      nullEscape: n === 0,
    };
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
