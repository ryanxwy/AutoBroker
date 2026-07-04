/**
 * closeoutDraft — the canonical closeout message a buyer sends when they pick a
 * dealer and want to be removed from the others' follow-up lists. The body and
 * subject are fixed templates (byte-snapshotted) so a closeout always reads the
 * same; the only variation is the vehicle phrase and the greeting name.
 *
 * Pure functions — no I/O, no DB.
 */

/** The profile fields the closeout reads. */
export interface CloseoutProfile {
  year?: number | null;
  make?: string | null;
  model?: string | null;
}

/** The dealer fields the closeout greeting reads. */
export interface CloseoutDealer {
  /** A contact display name, if one is known (e.g. "Pat Rivera"). */
  contactName?: string | null;
}

/** Join the present year/make/model parts into a vehicle phrase, or "" when none
 *  are known. */
function vehicleParts(profile: CloseoutProfile): string {
  return [profile.year ?? "", profile.make ?? "", profile.model ?? ""]
    .map((p) => String(p).trim())
    .filter((p) => p !== "")
    .join(" ");
}

/**
 * The closeout body. Names the vehicle when known, falling back to "this
 * vehicle" so a closeout still reads naturally on a profile with no vehicle.
 */
export function buildCloseoutDraft(
  profile: CloseoutProfile,
  _dealer: CloseoutDealer,
): string {
  const vehicle = vehicleParts(profile);
  // With a known vehicle: "on the {year make model}". Without one: "on this
  // vehicle" — note the article changes ("the" → "this"), not just the noun.
  const subject = vehicle !== "" ? `the ${vehicle}` : "this vehicle";
  return (
    `Thanks for your help on ${subject}. I'm closing out my search ` +
    "and have selected another dealer. Please remove me from your " +
    "follow-up list."
  );
}

/**
 * Choose the greeting name for a dealer contact. A name that looks human (two
 * alphabetic words, e.g. "Pat Rivera") yields its first name; anything else — a
 * role mailbox, a CRM placeholder, an empty value — yields the neutral "there".
 */
export function closeoutGreetingName(dealer: CloseoutDealer): string {
  const name = (dealer.contactName ?? "").trim();
  if (looksHuman(name)) {
    return name.split(/\s+/)[0]!;
  }
  return "there";
}

/** Heuristic: a human name is at least two whitespace-separated tokens, each a
 *  run of letters (allowing an internal hyphen or apostrophe). Single tokens,
 *  digits, and `@`/punctuation-bearing strings (role mailboxes, CRM ids) fail. */
function looksHuman(name: string): boolean {
  if (name === "") return false;
  const tokens = name.split(/\s+/);
  if (tokens.length < 2) return false;
  return tokens.every((t) => /^[A-Za-z][A-Za-z'-]*$/.test(t));
}
