/**
 * L1 unit tests — the read-only `profileHealth` projection that classifies each
 * non-terminal profile hot / warm / cold for the multi-profile pipeline. Freezes:
 *   - HOT on live-run membership, an applicable detect: flag, a ready+ok thread,
 *     or a recent pinned session;
 *   - COLD only when NOT hot AND the progress watermark is stale AND every thread
 *     is skip/capped (vacuously true with zero threads);
 *   - WARM otherwise (fresh/NULL watermark, or recent progress);
 *   - closed_out profiles are excluded; active and NULL-status profiles are kept;
 *   - the live→cold transition for one profile as the live set + clock change.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { profileHealth, type ProfileHealth } from "./profileHealth.js";
import { writeLastProgressAt } from "./progressWatermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed "now" so the relative-time fixtures are deterministic.
const NOW = Date.parse("2026-06-24T12:00:00.000Z");

let tmpDir: string;
let db: Db;

// ---------------------------------------------------------------------------
// Seed helpers (raw SQL — all NOT NULL columns satisfied)
// ---------------------------------------------------------------------------

function seedProfile(id: string, status: string | null): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, status) VALUES (?,?,?,?,?)",
    )
    .run(id, 2026, "Honda", "Accord", status);
}

function seedDealer(id: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, "Test Dealer");
}

function seedThread(threadId: string, profileId: string, dealerId: string): void {
  db.$client
    .prepare(
      "INSERT INTO threads (thread_id, dealer_id, search_profile_id, state) VALUES (?,?,?,?)",
    )
    .run(threadId, dealerId, profileId, "replied");
}

/** Insert a message; received_at is epoch-ms. Insertion order (rowid) is the
 *  call order, which drives the unanswered-follow-up count. quote_extraction_status
 *  is 'failed' (not the 'pending' default) so the message does NOT trip the
 *  detect:extract HOT branch — these fixtures exercise thread/watermark logic. */
function seedMessage(opts: {
  id: string;
  threadId: string;
  profileId: string;
  direction: "inbound" | "outbound";
  receivedAtMs?: number;
}): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, search_profile_id, direction, received_at, quote_extraction_status) VALUES (?,?,?,?,?,?)",
    )
    .run(opts.id, opts.threadId, opts.profileId, opts.direction, opts.receivedAtMs ?? null, "failed");
}

/** A dealer_quote with no matching quote_audits row → detectPipelineState.audit true. */
function seedQuote(quoteId: string, profileId: string, dealerId: string): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES (?,?,?,?,?,?)",
    )
    .run(quoteId, dealerId, `msg-${quoteId}`, `gm-${quoteId}`, profileId, "cash");
}

function seedSession(opts: {
  id: string;
  pinnedProfileId: string | null;
  lastActivityAt: string;
  archived?: number;
}): void {
  db.$client
    .prepare(
      "INSERT INTO sessions (id, title, created_at, last_activity_at, pinned_profile_id, archived) VALUES (?,?,?,?,?,?)",
    )
    .run(
      opts.id,
      "session",
      "2026-06-01T00:00:00.000Z",
      opts.lastActivityAt,
      opts.pinnedProfileId,
      opts.archived ?? 0,
    );
}

function findHealth(rows: ProfileHealth[], profileId: string): ProfileHealth {
  const row = rows.find((r) => r.profileId === profileId);
  if (row === undefined) throw new Error(`no health row for ${profileId}`);
  return row;
}

function clearAll(): void {
  for (const t of [
    "messages",
    "threads",
    "dealer_quotes",
    "sessions",
    "pipeline_state",
    "dealers",
    "search_profiles",
  ]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-profile-health-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0003_salty_jocasta.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  clearAll();
});

// ===========================================================================
// HOT — live run
// ===========================================================================

describe("profileHealth: HOT via live run", () => {
  it("a profile in liveRunProfileIds is hot with a live_run reason", () => {
    seedProfile("prof-A", "active");

    const rows = profileHealth(db, ["prof-A"], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("hot");
    expect(h.reasons).toContain("live_run");
  });
});

// ===========================================================================
// HOT — an applicable detect flag (unaudited quote → audit)
// ===========================================================================

describe("profileHealth: HOT via detectPipelineState", () => {
  it("a profile with an unaudited quote is hot with a detect: reason", () => {
    seedProfile("prof-A", "active");
    seedDealer("dealer-1");
    seedQuote("q-1", "prof-A", "dealer-1");

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("hot");
    expect(h.reasons.some((r) => r.startsWith("detect:"))).toBe(true);
    expect(h.reasons).toContain("detect:audit");
  });
});

// ===========================================================================
// HOT — a thread that is gate=ready AND cap=ok
// ===========================================================================

describe("profileHealth: HOT via a ready thread", () => {
  it("recent inbound + outbound >24h ago + low rounds/unanswered → thread_ready", () => {
    seedProfile("prof-A", "active");
    seedDealer("dealer-1");
    seedThread("t-1", "prof-A", "dealer-1");
    // Inbound came in just now (gate not skip), our last outbound was 2 days ago
    // (gate not wait → ready). Outbound first, inbound after → 0 unanswered, cap ok.
    seedMessage({ id: "m-out", threadId: "t-1", profileId: "prof-A", direction: "outbound", receivedAtMs: NOW - 2 * DAY_MS });
    seedMessage({ id: "m-in", threadId: "t-1", profileId: "prof-A", direction: "inbound", receivedAtMs: NOW });

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("hot");
    expect(h.reasons).toContain("thread_ready");
  });
});

// ===========================================================================
// HOT — a recent pinned session
// ===========================================================================

describe("profileHealth: HOT via a recent pinned session", () => {
  it("a session pinned to the profile with last_activity_at now, archived 0 → pinned_session", () => {
    seedProfile("prof-A", "active");
    seedSession({ id: "s-1", pinnedProfileId: "prof-A", lastActivityAt: "2026-06-24T12:00:00.000Z" });

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("hot");
    expect(h.reasons).toContain("pinned_session");
  });

  it("an ARCHIVED pinned session does NOT make the profile hot", () => {
    seedProfile("prof-A", "active");
    seedSession({
      id: "s-1",
      pinnedProfileId: "prof-A",
      lastActivityAt: "2026-06-24T12:00:00.000Z",
      archived: 1,
    });

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.reasons).not.toContain("pinned_session");
  });
});

// ===========================================================================
// COLD — stale watermark + all threads skip/capped
// ===========================================================================

describe("profileHealth: COLD", () => {
  it("watermark 30d old + a thread whose inbound is 30d old (gate skip) → cold", () => {
    seedProfile("prof-A", "active");
    seedDealer("dealer-1");
    seedThread("t-1", "prof-A", "dealer-1");
    // Inbound 30 days ago → > 14d max gap → gate skip.
    seedMessage({ id: "m-in", threadId: "t-1", profileId: "prof-A", direction: "inbound", receivedAtMs: NOW - 30 * DAY_MS });
    writeLastProgressAt(db, "prof-A", new Date(NOW - 30 * DAY_MS).toISOString());

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("cold");
    expect(h.reasons).toContain("dormant_30d");
    expect(h.reasons).toContain("all_threads_capped");
  });

  it("watermark 30d old + ZERO threads + not live → cold (vacuous all-threads)", () => {
    seedProfile("prof-A", "active");
    writeLastProgressAt(db, "prof-A", new Date(NOW - 30 * DAY_MS).toISOString());

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("cold");
    expect(h.reasons).toContain("all_threads_capped");
  });
});

// ===========================================================================
// WARM
// ===========================================================================

describe("profileHealth: WARM", () => {
  it("NULL watermark + zero threads + not live + not pinned → warm (a fresh profile is never cold)", () => {
    seedProfile("prof-A", "active");

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("warm");
  });

  it("watermark 2d old + not live + its only thread is capped → warm (recent progress)", () => {
    seedProfile("prof-A", "active");
    seedDealer("dealer-1");
    seedThread("t-1", "prof-A", "dealer-1");
    // Inbound 30d ago → gate skip, so the thread alone would not make it hot.
    seedMessage({ id: "m-in", threadId: "t-1", profileId: "prof-A", direction: "inbound", receivedAtMs: NOW - 30 * DAY_MS });
    // But the watermark is only 2 days old → not stale → not cold → warm.
    writeLastProgressAt(db, "prof-A", new Date(NOW - 2 * DAY_MS).toISOString());

    const rows = profileHealth(db, [], { nowMs: NOW });
    const h = findHealth(rows, "prof-A");
    expect(h.health).toBe("warm");
  });
});

// ===========================================================================
// status filtering
// ===========================================================================

describe("profileHealth: status filtering", () => {
  it("closed_out is excluded; active and NULL-status are included", () => {
    seedProfile("prof-active", "active");
    seedProfile("prof-null", null);
    seedProfile("prof-closed", "closed_out");

    const rows = profileHealth(db, [], { nowMs: NOW });
    const ids = rows.map((r) => r.profileId).sort();
    expect(ids).toEqual(["prof-active", "prof-null"]);
  });
});

// ===========================================================================
// transition — same profile hot then cold
// ===========================================================================

describe("profileHealth: live→cold transition", () => {
  it("hot while in the live set, then cold once removed + watermark aged + thread cold", () => {
    seedProfile("prof-A", "active");
    seedDealer("dealer-1");
    seedThread("t-1", "prof-A", "dealer-1");
    seedMessage({ id: "m-in", threadId: "t-1", profileId: "prof-A", direction: "inbound", receivedAtMs: NOW - 30 * DAY_MS });
    writeLastProgressAt(db, "prof-A", new Date(NOW - 30 * DAY_MS).toISOString());

    // While live → hot.
    const hotRows = profileHealth(db, ["prof-A"], { nowMs: NOW });
    expect(findHealth(hotRows, "prof-A").health).toBe("hot");

    // Removed from the live set, same aged state → cold.
    const coldRows = profileHealth(db, [], { nowMs: NOW });
    expect(findHealth(coldRows, "prof-A").health).toBe("cold");
  });
});
