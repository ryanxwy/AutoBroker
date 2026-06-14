/**
 * hygiene verify — commitHygiene: the SINGLE atomic writer for the whole
 * dealer-hygiene run. ALL approved deletes/suppressions/demotions land in ONE
 * db.$client.transaction, so a guard throw (HygieneRejectedError) or any failure
 * rolls back the WHOLE run — all-or-nothing. This is what makes "decline at any
 * stage = zero writes for the whole run" airtight: the three suspend stages only
 * STAGE ids; nothing reaches the DB until this single commit, which the workflow
 * runs ONLY when no stage declined.
 *
 * POST-WRITE ASSERTIONS (inside the transaction, so a violation rolls back):
 *   - no orphan's gmail_thread_id leaked into thread_suppression (the orphan
 *     red-line — orphans are DELETEd, never suppressed);
 *   - no quote-owning contact was demoted (defense in depth over the guard).
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only — no drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) + the sibling
 * write closures only.
 */

import type { Db } from "@autobroker/db";

import { deleteOrphanThread, demoteCrmContact, suppressThread } from "./writes.js";

/** A staged orphan-thread delete (the gmail_thread_id carried so the post-write
 *  assertion can prove it never leaked into a suppression row). */
export interface StagedOrphan {
  thread_id: string;
  gmail_thread_id: string;
}

export interface CommitHygieneArgs {
  runId: string;
  stagedOrphans: readonly StagedOrphan[];
  stagedThreads: readonly string[];
  stagedContacts: readonly string[];
}

export interface CommitHygieneResult {
  orphans_deleted: number;
  crm_threads_suppressed: number;
  crm_contacts_suppressed: number;
}

/** A post-write assertion failed — a logic bug, not a guard rejection. Thrown
 *  inside the transaction so the whole commit rolls back. */
export class HygieneAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HygieneAssertionError";
  }
}

/**
 * Apply ALL approved hygiene actions in ONE transaction. A thrown guard or
 * assertion rolls the whole batch back (zero net writes). Returns the per-stage
 * counts of rows that actually changed.
 */
export function commitHygiene(db: Db, args: CommitHygieneArgs): CommitHygieneResult {
  const c = db.$client;
  const orphanGmailIds = new Set(args.stagedOrphans.map((o) => o.gmail_thread_id));

  const txn = c.transaction((): CommitHygieneResult => {
    let orphans_deleted = 0;
    let crm_threads_suppressed = 0;
    let crm_contacts_suppressed = 0;

    for (const o of args.stagedOrphans) {
      if (deleteOrphanThread(db, o.thread_id)) orphans_deleted += 1;
    }
    for (const threadId of args.stagedThreads) {
      if (suppressThread(db, threadId, args.runId)) crm_threads_suppressed += 1;
    }
    for (const contactId of args.stagedContacts) {
      if (demoteCrmContact(db, contactId, args.runId)) crm_contacts_suppressed += 1;
    }

    // Post-write assertion 1 — the orphan red-line: no orphan's gmail_thread_id
    // (a real message-id) may appear in any thread_suppression row.
    if (orphanGmailIds.size > 0) {
      const placeholders = [...orphanGmailIds].map(() => "?").join(", ");
      const leaked = c
        .prepare(
          `SELECT COUNT(*) AS n FROM thread_suppression WHERE gmail_thread_id IN (${placeholders})`,
        )
        .get(...orphanGmailIds) as { n: number };
      if (leaked.n > 0) {
        throw new HygieneAssertionError("orphan gmail_thread_id leaked into thread_suppression");
      }
    }

    // Post-write assertion 2 — no quote-owning contact ended up demoted by this
    // run (defense in depth: the guard should have rejected it first).
    if (args.stagedContacts.length > 0) {
      const placeholders = args.stagedContacts.map(() => "?").join(", ");
      const offending = c
        .prepare(
          "SELECT COUNT(*) AS n FROM dealer_contacts dc " +
            "WHERE dc.contact_id IN (" +
            placeholders +
            ") AND dc.is_crm_platform_sender = 1 AND EXISTS (" +
            "  SELECT 1 FROM dealer_quotes dq JOIN messages m ON m.message_id = dq.message_id " +
            "  WHERE m.contact_id = dc.contact_id" +
            ")",
        )
        .get(...args.stagedContacts) as { n: number };
      if (offending.n > 0) {
        throw new HygieneAssertionError("a quote-owning contact was demoted");
      }
    }

    return { orphans_deleted, crm_threads_suppressed, crm_contacts_suppressed };
  });

  return txn();
}
