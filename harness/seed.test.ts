/**
 * seed.test.ts — the case-seed writer (the one sanctioned harness DB write).
 * Asserts the dealer-name resolution contract (exact first, unique substring
 * second, LOUD failure on zero/ambiguous), the frozen-id pending rows landing
 * in the explicit isolated DB, and idempotent re-apply.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path (the runner passes --db
 * the same way); never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb } from "@autobroker/db";
import {
  FakeGmailAdapter,
  computeSourceId,
  loadReplyExtractCandidates,
  urlNormalize,
} from "@autobroker/tools";

import { applyDealerReplySeeds, applyInventorySourceSeeds, resolveSeedDealer } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "packages", "db", "drizzle");

/** Apply every committed migration in journal order — a later migration can add
 *  a column the reply-extract candidate SELECT reads. Used by every fixture DB
 *  in this file so no setup drifts to a partial schema. */
function applyAllMigrations(client: { exec: (sql: string) => unknown }): void {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const e of journal.entries) {
    client.exec(readFileSync(join(DRIZZLE_DIR, `${e.tag}.sql`), "utf8"));
  }
}

let tmpDir: string;
let dbPath: string;

const PROFILE_ID = "prof-seed-1";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-harness-seed-"));
  dbPath = join(tmpDir, "autobroker.db");
  const db = openDb(dbPath);
  try {
    applyAllMigrations(db.$client);
    const insDealer = db.$client.prepare(
      "INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')",
    );
    const bind = db.$client.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    );
    for (const [id, name] of [
      ["d-tustin", "Tustin Hyundai"],
      ["d-anaheim", "Russell Westbrook Hyundai of Anaheim"],
      ["d-gg", "Garden Grove Hyundai"],
    ] as const) {
      insDealer.run(id, name);
      bind.run(PROFILE_ID, id);
    }
    // A dealer bound to a DIFFERENT profile must be invisible to resolution.
    insDealer.run("d-other", "Tustin Kia");
    bind.run("prof-other", "d-other");
  } finally {
    db.$client.close();
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveSeedDealer — exact first, unique substring second, loud failure", () => {
  const dealers = [
    { dealerId: "d-1", name: "Tustin Hyundai" },
    { dealerId: "d-2", name: "Russell Westbrook Hyundai of Anaheim" },
    { dealerId: "d-3", name: "Garden Grove Hyundai" },
  ];

  it("exact name wins", () => {
    expect(resolveSeedDealer("Tustin Hyundai", dealers).dealerId).toBe("d-1");
  });

  it("a unique case-insensitive substring resolves", () => {
    expect(resolveSeedDealer("hyundai of anaheim", dealers).dealerId).toBe("d-2");
  });

  it("zero matches fail LOUD with the available names listed", () => {
    expect(() => resolveSeedDealer("Irvine BMW", dealers)).toThrow(/matched NO bound dealer/);
    expect(() => resolveSeedDealer("Irvine BMW", dealers)).toThrow(/Tustin Hyundai/);
  });

  it("ambiguous substrings fail LOUD", () => {
    expect(() => resolveSeedDealer("Hyundai", dealers)).toThrow(/ambiguous/);
  });
});

describe("applyInventorySourceSeeds — pending rows in the explicit isolated DB", () => {
  const SEEDS = [
    {
      dealer: "Tustin Hyundai",
      url: "https://www.tustinhyundai.com/new-inventory/index.htm?model=Tucson",
      sourceType: "manual",
    },
    {
      dealer: "Hyundai of Anaheim", // unique substring of the bound name
      url: "https://www.hyundaianaheim.com/new-inventory/index.htm",
      sourceType: "manual",
    },
  ];

  it("writes frozen-id pending rows scoped to the profile", () => {
    const result = applyInventorySourceSeeds({ dbPath, profileId: PROFILE_ID, seeds: SEEDS });
    expect(result.seeded).toBe(2);
    expect(result.sourceIds).toEqual([
      computeSourceId(PROFILE_ID, "d-tustin", urlNormalize(SEEDS[0]!.url)),
      computeSourceId(PROFILE_ID, "d-anaheim", urlNormalize(SEEDS[1]!.url)),
    ]);

    const db = openDb(dbPath);
    try {
      const rows = db.$client
        .prepare(
          "SELECT dealer_id, last_status, source_type, discovery_method FROM dealer_inventory_sources " +
            "WHERE search_profile_id = ? ORDER BY rowid",
        )
        .all(PROFILE_ID) as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        { dealer_id: "d-tustin", last_status: "pending", source_type: "manual", discovery_method: "manual" },
        { dealer_id: "d-anaheim", last_status: "pending", source_type: "manual", discovery_method: "manual" },
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("re-applying is idempotent (0 new rows, same ids)", () => {
    const again = applyInventorySourceSeeds({ dbPath, profileId: PROFILE_ID, seeds: SEEDS });
    expect(again.seeded).toBe(0);
    expect(again.sourceIds).toHaveLength(2);
  });

  it("a seed naming an unbound dealer fails LOUD and writes nothing new", () => {
    expect(() =>
      applyInventorySourceSeeds({
        dbPath,
        profileId: PROFILE_ID,
        seeds: [{ dealer: "Tustin Kia", url: "https://www.tustinkia.com/new/", sourceType: "manual" }],
      }),
    ).toThrow(/matched NO bound dealer/);
  });
});

describe("applyDealerReplySeeds — a coherent messages↔fake_mailbox↔dealer corpus", () => {
  // A FRESH isolated DB (the reply seeder CREATES dealers, so it must not collide
  // with the inventory describe's pre-bound dealers / profile).
  const REPLY_PROFILE = "prof-reply-1";
  let replyDb: string;

  beforeAll(() => {
    replyDb = join(tmpDir, "autobroker-reply.db");
    const db = openDb(replyDb);
    try {
      applyAllMigrations(db.$client);
    } finally {
      db.$client.close();
    }
  });

  const REPLIES = [
    {
      dealerName: "Alpha Hyundai",
      dealerWebsite: "alpha-hyundai.example.com",
      from: "Sales <sales@alpha-hyundai.example.com>",
      subject: "Re: 2026 Tucson Limited",
      body: "Selling price $33,990, doc fee $85, out-the-door $38,420.",
      attachment: null,
    },
    {
      dealerName: "Bravo Hyundai",
      dealerWebsite: "bravo-hyundai.example.com",
      from: "Quotes <quotes@bravo-hyundai.example.com>",
      subject: "Your Tucson quote (PDF)",
      body: "Quote attached.",
      attachment: {
        filename: "quote.pdf",
        mimeType: "application/pdf",
        // a 1-byte placeholder; the candidate/adapter coherence is what this
        // test asserts (the PDF text-layer extraction is exercised by the
        // attachmentText unit tests + the live case, not here).
        dataBase64: Buffer.from("%PDF-1.4 placeholder", "utf8").toString("base64"),
      },
    },
  ];

  it("seeds inbound+pending messages bound to threads bound to dealers bound to the profile", () => {
    const result = applyDealerReplySeeds({ dbPath: replyDb, profileId: REPLY_PROFILE, replies: REPLIES });
    expect(result.dealers).toBe(2);
    expect(result.threads).toBe(2);
    expect(result.messages).toBe(2);
    expect(result.attachments).toBe(1);

    const db = openDb(replyDb);
    try {
      // The candidate reader is the live run's first read — if it returns both
      // rows, the messages↔threads↔dealers↔profile chain resolved coherently.
      const candidates = loadReplyExtractCandidates(REPLY_PROFILE, db);
      expect(candidates).toHaveLength(2);
      for (const c of candidates) {
        expect(c.searchProfileId).toBe(REPLY_PROFILE);
        expect(c.dealerId).toMatch(/^dre-seed-dealer-/); // resolved via thread→dealer.
        expect(c.sourceGmailMessageId).toMatch(/^dre-seed-gmsg-/);
        expect(c.body.length).toBeGreaterThan(0);
      }

      // Each inbound row is direction='inbound', pending, intent NULL (CHECK).
      const rows = db.$client
        .prepare(
          "SELECT direction, quote_extraction_status, quote_extraction_intent, search_profile_id " +
            "FROM messages ORDER BY message_id",
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r["direction"]).toBe("inbound");
        expect(r["quote_extraction_status"]).toBe("pending");
        expect(r["quote_extraction_intent"]).toBeNull();
        expect(r["search_profile_id"]).toBe(REPLY_PROFILE);
      }

      // Every dealer is BOUND to the profile (the candidate JOIN depends on it).
      const boundCount = (
        db.$client
          .prepare("SELECT COUNT(*) AS n FROM profile_dealers WHERE search_profile_id = ?")
          .get(REPLY_PROFILE) as { n: number }
      ).n;
      expect(boundCount).toBe(2);
    } finally {
      db.$client.close();
    }
  });

  it("the fake_mailbox message is fetchable by gmail_message_id (the adapter handle)", async () => {
    const db = openDb(replyDb);
    try {
      const adapter = new FakeGmailAdapter(db);
      const candidates = loadReplyExtractCandidates(REPLY_PROFILE, db);
      const pdfCandidate = candidates.find((c) => c.sourceGmailMessageId.endsWith("reply-1"));
      expect(pdfCandidate).toBeDefined();

      // getMessage() keys on fake_mailbox_messages.message_id == the inbound
      // row's gmail_message_id — the coherence the live extractor depends on.
      const msg = await adapter.getMessage(pdfCandidate!.sourceGmailMessageId);
      expect(msg.bodyText).toContain("Quote attached.");
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]?.mimeType).toBe("application/pdf");

      // The bytes are downloadable through the adapter (the extractor's fetch).
      const data = await adapter.downloadAttachment(
        pdfCandidate!.sourceGmailMessageId,
        msg.attachments[0]!,
      );
      expect(data.mimeType).toBe("application/pdf");
      expect(data.bytes.length).toBeGreaterThan(0);
    } finally {
      db.$client.close();
    }
  });

  it("re-applying is idempotent (0 new rows; candidate set unchanged)", () => {
    const again = applyDealerReplySeeds({ dbPath: replyDb, profileId: REPLY_PROFILE, replies: REPLIES });
    expect(again.dealers).toBe(0);
    expect(again.threads).toBe(0);
    expect(again.messages).toBe(0);

    const db = openDb(replyDb);
    try {
      expect(loadReplyExtractCandidates(REPLY_PROFILE, db)).toHaveLength(2);
    } finally {
      db.$client.close();
    }
  });
});
