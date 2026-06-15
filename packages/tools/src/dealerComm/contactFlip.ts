/**
 * contactFlip — the single irreversible write that promotes one dealer contact
 * to the primary reply target. A negotiation follow-up may, on an EXPLICIT user
 * override only, change which of a dealer's contacts future replies address; that
 * is a state change with no undo, so it lives behind a sensitive re-confirm
 * suspend and is committed here as ONE all-or-nothing transaction.
 *
 * The shape is clear-all-then-set-one: every contact of the dealer is reset to
 * non-primary, then exactly the named contact is set primary. The set MUST touch
 * exactly one row (the contact must belong to the dealer); a `changes !== 1`
 * guard throws, and the throw rolls back the clear-all too — so a bad contactId
 * leaves the prior primary flags untouched, never a dealer with zero primaries.
 *
 * Tools-layer: the ONLY code that opens the product DB writes this flip. Pure
 * better-sqlite3 (db.$client) — no Drizzle query builder, mirroring the inbox /
 * hygiene write paths.
 */

import type { Db } from "../db.js";

const CLEAR_ALL = "UPDATE dealer_contacts SET is_primary_reply_target = 0 WHERE dealer_id = ?";
const SET_ONE =
  "UPDATE dealer_contacts SET is_primary_reply_target = 1 WHERE contact_id = ? AND dealer_id = ?";

/**
 * Promote `contactId` to the sole primary reply target for `dealerId`, in one
 * transaction. Throws (rolling the whole transaction back) when the contact is
 * not a contact of the dealer — so the clear-all never lands without a matching
 * set, and the dealer is never left with no primary contact. Irreversible state:
 * call only after the sensitive re-confirm suspend has approved.
 */
export function setPrimaryReplyTarget(db: Db, args: { dealerId: string; contactId: string }): void {
  const tx = db.$client.transaction((dealerId: string, contactId: string) => {
    db.$client.prepare(CLEAR_ALL).run(dealerId);
    const res = db.$client.prepare(SET_ONE).run(contactId, dealerId);
    if (res.changes !== 1) {
      // A throw inside a better-sqlite3 transaction rolls back the clear-all.
      throw new Error(
        `setPrimaryReplyTarget: contact ${contactId} is not a contact of dealer ${dealerId} ` +
          `(expected to update exactly 1 row, updated ${res.changes})`,
      );
    }
  });
  tx(args.dealerId, args.contactId);
}
