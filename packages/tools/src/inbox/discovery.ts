/**
 * inbox discovery — the PURE 4-pass query builder + thread-hit dedupe +
 * keyword classifier the dealer-inbox sync drives. No DB, no network, no clock:
 * every input is passed in, every output is a value the workflow layer feeds to
 * the injected Gmail adapter's `search`.
 *
 * THE 4 PASSES (each query carries the relative `newer_than:<window>` clause the
 * adapter understands, so a pass only sees mail since the per-profile window):
 *   A — subject/keyword: the vehicle the search is for (the model is the strong
 *       discriminator dealers echo in a reply subject).
 *   B — body/keyword: the same vehicle term, body-scoped, to catch replies whose
 *       subject was rewritten but whose body names the car.
 *   C — known-contact: one `from:<email>` query per known dealer contact,
 *       BATCHED 15 emails per query (a dealer mailbox the buyer already knows).
 *   D — dealer-token repair: one query per dealer name/website token, BATCHED 20
 *       tokens per query (recovers replies from a dealer whose exact contact
 *       email is not yet on file — the "unlabeled repair" sweep).
 *
 * Each pass yields its own query strings; the workflow runs them in pass order
 * (A→B→C→D) and `dedupeThreadHits` keeps the FIRST pass that surfaced a thread
 * (the strongest signal wins — a subject hit outranks a token-repair hit).
 *
 * classifyThread is a DETERMINISTIC keyword classifier (quoted vs replied): a
 * thread whose dealer prose names a price/quote token is `quoted`, else
 * `replied`. This is promoted from a per-message judgment call to a pure
 * function — no LLM in the inbox sweep.
 *
 * Dependency wall: pure TS — imports nothing.
 */

// ---------------------------------------------------------------------------
// dealer tokens — the "unlabeled repair" sweep terms
// ---------------------------------------------------------------------------

/** Generic words that carry no dealer-identity signal — dropped from tokens so
 *  pass D never sweeps on "auto" / a make name (which every reply shares). */
const DEALER_TOKEN_STOP_SET: ReadonlySet<string> = new Set([
  "auto",
  "ford",
  "toyota",
  "honda",
  "dealer",
]);

/** Minimum token length — a token must be longer than this to be a candidate
 *  (a 1–3 char fragment is too noisy to sweep on). */
const DEALER_TOKEN_MIN_LEN = 3;

/** Lowercased registrable host stem of a website (the second-level label), or
 *  null when the URL does not parse. e.g. "https://www.bob-smith-hyundai.com/x"
 *  → "bob-smith-hyundai". Pure. */
export function hostStem(website: string): string | null {
  let host: string;
  try {
    const u = new URL(website);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".").filter((l) => l !== "");
  if (labels.length === 0) return null;
  // Drop a leading "www"; the registrable label is the second-to-last when a
  // TLD is present, else the only label.
  const trimmed = labels[0] === "www" ? labels.slice(1) : labels;
  if (trimmed.length === 0) return null;
  if (trimmed.length === 1) return trimmed[0]!;
  return trimmed[trimmed.length - 2]!;
}

/**
 * Token set for a dealer's "unlabeled repair" sweep (pass D): the alnum words
 * of the dealer name longer than the floor and outside the stop-set, PLUS the
 * website host stem. Sorted + dedup-stable so the query batches are
 * deterministic. Pure.
 */
export function dealerTokens(name: string, website: string | null): string[] {
  const out = new Set<string>();
  for (const raw of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > DEALER_TOKEN_MIN_LEN && !DEALER_TOKEN_STOP_SET.has(raw)) {
      out.add(raw);
    }
  }
  if (website !== null && website.trim() !== "") {
    const stem = hostStem(website);
    if (stem !== null && stem.length > DEALER_TOKEN_MIN_LEN && !DEALER_TOKEN_STOP_SET.has(stem)) {
      out.add(stem);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// the 4-pass query builder
// ---------------------------------------------------------------------------

/** The per-query batch sizes for the contact + token passes. */
export const CONTACT_BATCH_SIZE = 15;
export const DEALER_TOKEN_BATCH_SIZE = 20;

/** The discovery inputs (all caller-supplied — pure). */
export interface BuildInboxQueriesArgs {
  make: string;
  model: string;
  year: number;
  /** The relative Gmail window clause (e.g. "2d" / "36h"), from computeWindow. */
  window: string;
  /** Known dealer-contact emails (already normalized lowercase). */
  contactEmails: readonly string[];
  /** Dealer-name/website tokens for the unlabeled-repair sweep. */
  dealerTokens: readonly string[];
}

/** Chunk a list into fixed-size batches (last batch may be shorter). Pure. */
function batch<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build the ordered 4-pass query list. Every query ends with the
 * `newer_than:<window>` clause; the free-text portion of each query is a single
 * matchable token (a model name, one contact email, or one dealer token) so a
 * substring-matching backend resolves it — the live Gmail backend treats the
 * same strings as its richer search grammar. Pure.
 */
export function buildInboxQueries(args: BuildInboxQueriesArgs): string[] {
  const win = `newer_than:${args.window}`;
  const out: string[] = [];

  // Pass A — subject/keyword: the model is the strong discriminator.
  out.push(`subject:${args.model} ${win}`);

  // Pass B — body/keyword: the same vehicle term, body-scoped.
  out.push(`${args.model} ${win}`);

  // Pass C — known-contact `from:` (batched 15). One email per `from:` so a
  // substring backend resolves each; the live backend ORs them.
  for (const group of batch(args.contactEmails, CONTACT_BATCH_SIZE)) {
    out.push(`${group.map((e) => `from:${e}`).join(" OR ")} ${win}`);
  }

  // Pass D — dealer-token repair (batched 20).
  for (const group of batch(args.dealerTokens, DEALER_TOKEN_BATCH_SIZE)) {
    out.push(`${group.join(" OR ")} ${win}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// thread-hit dedupe — first-pass-wins
// ---------------------------------------------------------------------------

/** One thread surfaced by a discovery pass — the thread id + the message ids
 *  the backend reported for it under that pass. */
export interface ThreadHit {
  threadId: string;
  messageIds: string[];
}

/**
 * Collapse the per-pass hit lists into one deduped list, FIRST-PASS-WINS by
 * threadId (the passes arrive in A→B→C→D order, so the strongest signal that
 * first surfaced a thread keeps it; later duplicate sightings are dropped). The
 * winning hit's messageIds are unioned with any later sightings (a later pass
 * may report a message the first pass's narrower query missed). Pure.
 */
export function dedupeThreadHits(hitsByPass: readonly (readonly ThreadHit[])[]): ThreadHit[] {
  const byThread = new Map<string, { messageIds: string[]; seen: Set<string> }>();
  const order: string[] = [];
  for (const pass of hitsByPass) {
    for (const hit of pass) {
      let entry = byThread.get(hit.threadId);
      if (entry === undefined) {
        entry = { messageIds: [], seen: new Set() };
        byThread.set(hit.threadId, entry);
        order.push(hit.threadId);
      }
      for (const id of hit.messageIds) {
        if (!entry.seen.has(id)) {
          entry.seen.add(id);
          entry.messageIds.push(id);
        }
      }
    }
  }
  return order.map((threadId) => ({ threadId, messageIds: byThread.get(threadId)!.messageIds }));
}

// ---------------------------------------------------------------------------
// classify — quoted vs replied (deterministic keyword classifier)
// ---------------------------------------------------------------------------

/** The closed thread-classification vocabulary. */
export type ThreadClassification = "quoted" | "replied";

/** Tokens whose presence in dealer prose marks a thread as carrying a price /
 *  quote (vs a plain conversational reply). Lowercased substring match. */
const QUOTE_SIGNAL_TOKENS: readonly string[] = [
  "out-the-door",
  "out the door",
  "otd",
  "sale price",
  "selling price",
  "msrp",
  "quote",
  "$",
  "down payment",
  "per month",
  "/mo",
  "apr",
  "lease",
];

/** One message's text the classifier reads (subject + body, dealer prose). */
export interface ClassifyMessage {
  subject: string;
  bodyText: string;
}

/**
 * Classify a thread `quoted` vs `replied` from its messages' prose: if ANY
 * message names a price/quote signal token it is `quoted`, else `replied`.
 * Deterministic — no LLM. Pure.
 */
export function classifyThread(messages: readonly ClassifyMessage[]): ThreadClassification {
  for (const m of messages) {
    const hay = `${m.subject} ${m.bodyText}`.toLowerCase();
    if (QUOTE_SIGNAL_TOKENS.some((t) => hay.includes(t))) return "quoted";
  }
  return "replied";
}
