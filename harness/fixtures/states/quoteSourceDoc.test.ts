/**
 * quoteSourceDoc.test.ts — the "click a quote card → embed the dealer's source
 * document" fixture state. Asserts the registry resolves "quote_source_doc", and
 * its seed populates ONE active profile + a bound dealer + ONE image quote whose
 * source message carries a decodable PNG attachment, against a fully migrated
 * throwaway DB, idempotently.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { getFixtureState } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-fixture-qsd-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-harness-1", "a@e.com");
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("quote_source_doc fixture state", () => {
  it("is resolvable from the registry", () => {
    const state = getFixtureState("quote_source_doc");
    expect(state.id).toBe("quote_source_doc");
  });

  it("seeds one active profile + one image quote whose source message carries a PNG attachment", () => {
    const state = getFixtureState("quote_source_doc");
    state.seed(db);

    const profiles = db.$client
      .prepare("SELECT COUNT(*) AS n FROM search_profiles WHERE status = 'active'")
      .get() as { n: number };
    expect(profiles.n).toBe(1);

    // ONE image quote pointing at the fake source message.
    const quote = db.$client
      .prepare(
        "SELECT quote_format, source_gmail_message_id FROM dealer_quotes WHERE quote_id = 'qsd-quote-1'",
      )
      .get() as { quote_format: string; source_gmail_message_id: string };
    expect(quote.quote_format).toBe("image");
    expect(quote.source_gmail_message_id).toBe("qsd-msg-1");

    // The source fake message owns exactly one PNG attachment (the embed bytes).
    // fake_mailbox_attachments.message_id FKs the fake message's PK, which IS the
    // gmail message id (seedFakeMailbox's messageId) the quote points at.
    const att = db.$client
      .prepare(
        "SELECT mime_type AS mime FROM fake_mailbox_attachments WHERE message_id = 'qsd-msg-1'",
      )
      .all() as Array<{ mime: string }>;
    expect(att).toHaveLength(1);
    expect(att[0]!.mime).toBe("image/png");

    // No real account string is present anywhere in the seeded corpus.
    const froms = db.$client
      .prepare("SELECT `from` AS f FROM fake_mailbox_messages")
      .all() as Array<{ f: string }>;
    for (const { f } of froms) {
      expect(f).toContain("example");
    }
  });
});
