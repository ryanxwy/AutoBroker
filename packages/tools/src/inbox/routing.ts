/**
 * inbox routing — bind a discovered reply thread to the dealer it came from,
 * SCOPED to one search profile. Read-only here (the actual binding write rides
 * the one atomic applyInboxBatch transaction); this module answers "which
 * dealer, for THIS profile?".
 *
 * THE LADDER (first match wins):
 *   1. an explicit `thread_routing` row already binds this thread to a profile —
 *      honor it (and surface the bound dealer of the thread's stored row);
 *   2. the sender email matches a `dealer_contacts` row whose dealer is bound to
 *      THIS profile (profile_dealers) — route to that dealer;
 *   2.5. the sender's host stem matches a bound dealer's website host stem —
 *      route to that dealer (the new-salesperson-address / empty-contacts guard;
 *      tie-break = first bound dealer by rowid);
 *   3. otherwise the thread is `unrouted` (the review card surfaces it; nothing
 *      is written for it on approve unless the user later binds it).
 *
 * PROFILE SCOPING (the parity invariant): `lookupDealerBySender` only matches a
 * contact whose dealer is bound to the PASSED profile. A sender that belongs to
 * a dealer bound to a DIFFERENT profile returns null — a reply never leaks
 * across searches.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only — the tools
 * layer never imports drizzle-orm operators.
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

import { hostStem } from "./discovery.js";

/** Normalize an email for the contact lookup (lowercase + trim). The contact
 *  rows store `normalized_email`, written the same way upstream. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The registrable host stem of a sender address (the part after the last `@`,
 *  reduced the same way a dealer website is). e.g. "sam@www.bob-hyundai.com" →
 *  "bob-hyundai". null when there is no domain part. Pure. */
function senderHostStem(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain === "") return null;
  // Reuse the website host-stem reduction (www-strip + TLD-drop) by routing the
  // bare domain through a synthetic URL — keeps the stem logic single-source.
  return hostStem(`https://${domain}`);
}

/**
 * Find the dealer (bound to `profileId`) whose website host stem equals the
 * sender's host stem, or null. The tie-break for two bound dealers sharing a
 * stem is the first by rowid (deterministic). The stem comparison is done in TS
 * (the website is a full URL, not a bare stem in the column), scanning the
 * profile's bound dealers in rowid order. Read-only, profile-scoped.
 */
function lookupDealerByHost(
  db: Db,
  email: string,
  profileId: string,
): { dealerId: string } | null {
  const stem = senderHostStem(email);
  if (stem === null || stem === "") return null;
  const rows = db.$client
    .prepare(
      "SELECT d.dealer_id AS dealer_id, d.website AS website " +
        "FROM dealers d " +
        "JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id " +
        "WHERE pd.search_profile_id = ? AND d.website IS NOT NULL " +
        "ORDER BY d.rowid",
    )
    .all(profileId) as Array<{ dealer_id: string; website: string }>;
  for (const r of rows) {
    if (hostStem(r.website) === stem) return { dealerId: r.dealer_id };
  }
  return null;
}

/**
 * Find the dealer (bound to `profileId`) that owns the sender address, or null.
 * The match is the (dealer bound to this profile) ⋈ (its contacts) — a sender
 * bound to a different profile's dealer does not match. Read-only.
 */
export function lookupDealerBySender(
  db: Db,
  email: string,
  profileId: string,
): { dealerId: string } | null {
  const row = db.$client
    .prepare(
      "SELECT dc.dealer_id AS dealer_id " +
        "FROM dealer_contacts dc " +
        "JOIN profile_dealers pd ON pd.dealer_id = dc.dealer_id " +
        "WHERE dc.normalized_email = ? AND pd.search_profile_id = ? " +
        "LIMIT 1",
    )
    .get(normalizeEmail(email), profileId) as { dealer_id: string } | undefined;
  return row === undefined ? null : { dealerId: row.dealer_id };
}

/** Why a thread could not be routed (closed set, surfaced verbatim). */
export type UnroutedReason = "unknown_sender";

/** A routed thread carries its dealer + the rung that matched; an unrouted one
 *  carries its reason. */
export type RouteResult =
  | { dealerId: string; reason: "existing_binding" | "known_contact" | "dealer_domain" }
  | { unrouted: UnroutedReason };

/**
 * Route one thread for `profileId` down the ladder above. Read-only — the
 * binding write happens inside the atomic apply.
 */
export function routeThread(
  db: Db,
  args: { threadId: string; senderEmail: string; profileId: string },
): RouteResult {
  // Rung 1 — an explicit thread_routing binding for this thread (any prior bind
  // wins; the inbox sweep never re-binds an already-bound thread to a different
  // profile).
  const bound = db.$client
    .prepare("SELECT search_profile_id FROM thread_routing WHERE thread_id = ? LIMIT 1")
    .get(args.threadId) as { search_profile_id: string } | undefined;
  if (bound !== undefined) {
    const dealer = db.$client
      .prepare("SELECT dealer_id FROM threads WHERE thread_id = ? LIMIT 1")
      .get(args.threadId) as { dealer_id: string } | undefined;
    if (dealer !== undefined) {
      return { dealerId: dealer.dealer_id, reason: "existing_binding" };
    }
    // A routing row with no thread row (mid-ingest): fall through to sender.
  }

  // Rung 2 — sender → dealer-bound-to-this-profile (exact known contact).
  const bySender = lookupDealerBySender(db, args.senderEmail, args.profileId);
  if (bySender !== null) {
    return { dealerId: bySender.dealerId, reason: "known_contact" };
  }

  // Rung 2.5 — sender host stem matches a bound dealer's website host stem. This
  // is the false-negative guard: on the first sweep dealer_contacts is empty, so
  // rung 2 cannot fire, and a reply from a new salesperson address at a KNOWN
  // dealer would otherwise be unrouted. The match is the dealer's registrable
  // host, not the exact mailbox.
  const byHost = lookupDealerByHost(db, args.senderEmail, args.profileId);
  if (byHost !== null) {
    return { dealerId: byHost.dealerId, reason: "dealer_domain" };
  }

  // Rung 3 — unrouted.
  return { unrouted: "unknown_sender" };
}
