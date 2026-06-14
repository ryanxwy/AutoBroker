/**
 * inbox CRM-sender detection — the PURE host table + predicate that flags a
 * reply that came through a dealer CRM / lead-management platform relay rather
 * than from a dealer's own salesperson mailbox. The inbox sweep records the
 * flag (it routes/ingests the thread either way); a later hygiene pass uses it
 * to demote a CRM-only relay contact that never produced a real quote.
 *
 * Matching is suffix-based on the sender's email host, so a sub-domained relay
 * (e.g. "mail.podium.email") still matches "podium.email".
 *
 * Dependency wall: pure TS — imports nothing.
 */

/** Known dealer CRM / lead-platform relay hosts. Suffix-matched. */
export const CRM_PLATFORM_HOSTS: readonly string[] = [
  "podium.email",
  "carleadsup.com",
  "activengage.com",
  "carsaver.com",
  "leadventure.com",
];

/** The host portion of an email address (after the last "@"), lowercased, or
 *  null when the address has no host. Pure. */
function emailHost(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * True when the sender address's host is (or is a sub-domain of) a known CRM /
 * lead-platform relay host. Pure.
 */
export function detectCrmPlatformSender(email: string): boolean {
  const host = emailHost(email);
  if (host === null) return false;
  return CRM_PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
