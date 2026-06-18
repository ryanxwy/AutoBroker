/**
 * In-process integration tests — GET /api/profiles/:id/quotes/:quoteId/source.
 * Drives the REAL Fastify app via inject(): REAL route → REAL tools reader
 * (readQuoteSourceDoc) → REAL FakeGmailAdapter (the default fake backend) reading
 * the seeded fake_mailbox_attachments row, against an ISOLATED tmp autobroker.db.
 * Nothing is injected — the env-driven gmail factory resolves to the fake lane and
 * the reader re-fetches the source bytes the same way reply_extract does.
 *
 * Covers:
 *   (a) 200 with the PNG bytes + content-type image/png + inline disposition for
 *       a seeded quote whose source message carries a PNG attachment.
 *   (b) an unknown quote id → 404.
 *   (c) a quote owned by ANOTHER profile (cross-profile) → 404.
 *   (d) an unknown profile id → 404.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the three committed migrations are hand-applied BEFORE buildServer (so the
 * boot's ensureProductSchema sentinel-skips and the seeded rows survive); NEVER
 * ~/.autobroker*. AUTOBROKER_TEST_AUTO_APPROVE is never set.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, seedFakeMailbox, type Db } from "@autobroker/tools";
import {
  resetMastraForTests,
  resetRuntimeGlueForTests,
} from "@autobroker/workflows";

import { buildServer, type BuiltServer } from "./server.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

/** A tiny valid 1x1 PNG (base64) so the attachment row has real decodable bytes. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const PROFILE_ID = "prof-src-1";

let tmpDir: string;
let db: Db;
let server: BuiltServer;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

/** Insert an active search profile so readProfileRow finds it (the 404 guard).
 *  brand defaults to "Hyundai"; a distinct brand frees a fresh active
 *  (account, brand) slot so a second profile under the same account is legal. */
function seedProfile(profileId: string, brand = "Hyundai"): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      profileId,
      2026,
      brand,
      "Tucson",
      "SEL",
      50,
      "Tucson, AZ 85704",
      "Tucson",
      "AZ",
      "85704",
      32.3349,
      -110.9762,
      "finance",
      "fake",
      "acct-1",
      brand,
      "Tucson, AZ 85704",
      "active",
    );
}

/** Insert a minimal dealer_quotes row pointing at a fake source message. */
function seedQuote(opts: { quoteId: string; profileId: string; sourceGmailMessageId: string }): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, quote_format, financing_mode) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.quoteId,
      "dealer-1",
      `msg-${opts.quoteId}`,
      opts.sourceGmailMessageId,
      opts.profileId,
      "image",
      "finance",
    );
}

beforeEach(async () => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-quote-src-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];

  db = openDb(); // <tmpDir>/autobroker.db
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");

  seedProfile(PROFILE_ID);
  seedFakeMailbox({
    db,
    threads: [
      {
        threadId: "src-thread-1",
        subject: "Re: quote",
        searchProfileId: PROFILE_ID,
        messages: [
          {
            messageId: "src-msg-1",
            direction: "inbound",
            from: "sales@dealer.test",
            to: "buyer@x.test",
            subject: "Re: quote",
            bodyText: "Attached is our OTD quote.",
            internalDateMs: 1000,
            attachments: [
              {
                attachmentId: "src-att-1",
                filename: "quote.png",
                mimeType: "image/png",
                dataBase64: TINY_PNG_BASE64,
              },
            ],
          },
        ],
      },
    ],
  });
  seedQuote({ quoteId: "q1", profileId: PROFILE_ID, sourceGmailMessageId: "src-msg-1" });

  resetMastraForTests();
  resetRuntimeGlueForTests();
  server = await buildServer({ quiet: true });
});

afterEach(async () => {
  if (server !== undefined) await server.app.close();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

describe("GET /api/profiles/:id/quotes/:quoteId/source", () => {
  it("streams the source PNG bytes with content-type image/png + inline disposition", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/profiles/${PROFILE_ID}/quotes/q1/source`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["content-disposition"]).toBe('inline; filename="quote.png"');
    // The raw payload bytes round-trip to the seeded PNG.
    expect(res.rawPayload.toString("base64")).toBe(TINY_PNG_BASE64);
  });

  it("returns 404 for an unknown quote id", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/profiles/${PROFILE_ID}/quotes/ghost/source`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error.code).toBe("not_found");
  });

  it("returns 404 for a quote owned by a different profile (cross-profile)", async () => {
    // q1 belongs to PROFILE_ID; ask under a different (also existing) profile.
    // A distinct brand frees a fresh active (account, brand) slot.
    seedProfile("prof-src-2", "Toyota");
    const res = await server.app.inject({
      method: "GET",
      url: `/api/profiles/prof-src-2/quotes/q1/source`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error.code).toBe("not_found");
  });

  it("returns 404 for an unknown profile id", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/profiles/ghost-profile/quotes/q1/source`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error.code).toBe("not_found");
  });
});
