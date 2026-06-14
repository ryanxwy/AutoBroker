/**
 * repliesArrived.test.ts — the "dealer replies have landed" fixture state.
 * Asserts the registry resolves "replies_arrived", and its seed populates ONE
 * active profile + 2 fake-mailbox threads (+ messages, one with an attachment)
 * against a fully migrated throwaway DB, idempotently.
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
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-fixture-replies-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("replies_arrived fixture state", () => {
  it("is resolvable from the registry", () => {
    const state = getFixtureState("replies_arrived");
    expect(state.id).toBe("replies_arrived");
  });

  it("seeds one active profile + two fake-mailbox threads, idempotently", () => {
    const state = getFixtureState("replies_arrived");
    state.seed(db);
    state.seed(db); // idempotent re-run

    const profiles = db.$client
      .prepare("SELECT COUNT(*) AS n FROM search_profiles WHERE status = 'active'")
      .get() as { n: number };
    expect(profiles.n).toBe(1);

    const threads = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_threads")
      .get() as { n: number };
    expect(threads.n).toBe(2);

    const messages = db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM fake_mailbox_messages WHERE direction = 'inbound'",
      )
      .get() as { n: number };
    expect(messages.n).toBe(2);

    const attachments = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_attachments")
      .get() as { n: number };
    expect(attachments.n).toBe(1);

    // No real account string is present anywhere in the seeded corpus.
    const froms = db.$client
      .prepare("SELECT `from` AS f FROM fake_mailbox_messages")
      .all() as Array<{ f: string }>;
    for (const { f } of froms) {
      expect(f).toContain("example");
    }
  });
});
