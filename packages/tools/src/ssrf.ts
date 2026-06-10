/**
 * SSRF-aware outbound-URL validator for incentive-source URLs — ported from
 * the legacy Python implementation with identical rule order, error codes,
 * and fail-closed semantics.
 *
 * Public surface:
 *   validateSourceUrl(url, opts?) — resolves on success; throws
 *     SourceUrlValidationError on the FIRST failing rule.
 *   isPrivateIp(ip)              — pure IP classifier, exported for tests.
 *
 * The 9 rules, in execution order (each `code` is pinned — the form UI maps
 * codes to user-facing copy, so they must stay stable):
 *   ⑨ url_too_long          — > 2048 utf-8 bytes. Checked first so the rest
 *                              of the parser never sees a multi-MB string.
 *   ① non_https             — https only.
 *   ② credentials_in_url    — no user:pass@host userinfo.
 *   ③④ path_traversal       — no ".." path segments, raw or percent-encoded.
 *   ⑤ shell_metacharacter   — none of ;&|`$()<> in the decoded path/query.
 *                              `{` and `}` are deliberately allowed: OEM URL
 *                              templates carry {model}/{zip} placeholders that
 *                              are substituted at scrape time (the substituted
 *                              URL is re-validated).
 *   ⑥ ip_literal_host       — host must be a name, not an IPv4/IPv6 literal.
 *   ⑧ idna_invalid          — non-ASCII hosts must be valid IDNA and must not
 *                              mix scripts within a single label (homograph
 *                              defence). Runs BEFORE the DNS rule so a
 *                              bad-Unicode hostname fails fast with the right
 *                              code.
 *   ⑦ private_ip_resolution — the host must resolve via DNS, and only to
 *                              public addresses. NXDOMAIN / resolver errors
 *                              fail CLOSED (a host that will not resolve is
 *                              just as unsafe to fetch as one that resolves
 *                              privately).
 *
 * Test-only escape hatch: AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS=1 opens BOTH
 * the scheme exception (plain http:// for localhost / 127.0.0.1) and the
 * IP-literal exception (https://127.0.0.1), so E2E runs can serve fixture
 * HTML from a local HTTP server. Production runs leave the variable unset.
 */

import { lookup } from "node:dns/promises";
import { Buffer } from "node:buffer";
import { domainToASCII } from "node:url";

export type SourceUrlValidationCode =
  | "non_https"
  | "credentials_in_url"
  | "path_traversal"
  | "shell_metacharacter"
  | "ip_literal_host"
  | "private_ip_resolution"
  | "idna_invalid"
  | "url_too_long";

/** Raised on the first failing rule. `field` is always "url" — the validator
 *  guards a single-input form and the UI attaches the error inline. */
export class SourceUrlValidationError extends Error {
  readonly code: SourceUrlValidationCode;
  readonly field = "url" as const;

  constructor(code: SourceUrlValidationCode, message: string) {
    super(message);
    this.name = "SourceUrlValidationError";
    this.code = code;
  }
}

export interface ValidateSourceUrlOptions {
  /** Injectable DNS resolver (host → every A/AAAA address) so tests never
   *  touch the network. Defaults to node:dns/promises `lookup({ all: true })`
   *  behind a 60s in-process cache. */
  resolveHost?: (host: string) => Promise<string[]>;
}

const LOCALHOST_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
// Shell metacharacter rejection set. Excludes `{` and `}` (template
// placeholders — see the file header). Every remaining char is an unambiguous
// shell-injection vector.
const SHELL_METAS = ";&|`$()<>";
const MAX_URL_BYTES = 2048;
const DNS_CACHE_TTL_MS = 60_000;

// ------------------------------------------------------------------------ //
// Lenient, NON-normalizing URL splitting                                    //
// ------------------------------------------------------------------------ //

interface SplitUrl {
  /** Lowercased scheme, "" when absent. */
  scheme: string;
  /** Userinfo pieces, "" when absent. */
  username: string;
  password: string;
  /** Lowercased hostname with IPv6 brackets stripped, "" when absent. */
  host: string;
  /** Raw (still percent-encoded) path and query. */
  path: string;
  query: string;
}

/**
 * Split a URL WITHOUT normalizing it. The WHATWG `URL` class is unusable
 * here: it resolves ".." dot-segments, percent-decodes, and punycodes the
 * host during parsing — destroying exactly the evidence rules ③④⑤⑧ must
 * inspect. This splitter never throws; missing pieces come back as "" and
 * the rule checks fail closed on them.
 */
function splitUrl(url: string): SplitUrl {
  // Fragment is irrelevant to every rule — drop it first, like the query/path
  // separation below, at the FIRST occurrence.
  const hashAt = url.indexOf("#");
  const noFragment = hashAt === -1 ? url : url.slice(0, hashAt);

  let scheme = "";
  let rest = noFragment;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/.exec(noFragment);
  if (schemeMatch) {
    scheme = schemeMatch[1]!.toLowerCase();
    rest = schemeMatch[2]!;
  }

  let netloc = "";
  if (rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const end = afterSlashes.search(/[\/?]/);
    netloc = end === -1 ? afterSlashes : afterSlashes.slice(0, end);
    rest = end === -1 ? "" : afterSlashes.slice(end);
  }

  let path = rest;
  let query = "";
  const questionAt = rest.indexOf("?");
  if (questionAt !== -1) {
    path = rest.slice(0, questionAt);
    query = rest.slice(questionAt + 1);
  }

  // Userinfo ends at the LAST "@" (so "a@b@host" keeps the host right).
  let username = "";
  let password = "";
  let hostport = netloc;
  const atSign = netloc.lastIndexOf("@");
  if (atSign !== -1) {
    const userinfo = netloc.slice(0, atSign);
    hostport = netloc.slice(atSign + 1);
    const colon = userinfo.indexOf(":");
    username = colon === -1 ? userinfo : userinfo.slice(0, colon);
    password = colon === -1 ? "" : userinfo.slice(colon + 1);
  }

  // Port split: "[v6]:port" closes at "]", otherwise the FIRST ":" ends the
  // host (a second colon without brackets is malformed and yields a hostname
  // that fails later rules — closed, not crashed).
  let host: string;
  if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    host = close === -1 ? hostport.slice(1) : hostport.slice(1, close);
  } else {
    const colon = hostport.indexOf(":");
    host = colon === -1 ? hostport : hostport.slice(0, colon);
  }

  return { scheme, username, password, host: host.toLowerCase(), path, query };
}

/**
 * Single-pass, byte-wise %XX decoding. The decoded text is only ever scanned
 * for ASCII (".." segments and shell metacharacters); UTF-8 continuation
 * bytes are >= 0x80 and can never alias into ASCII, so byte-wise decoding is
 * exact for these checks. Invalid sequences (e.g. a lone "%2") are left as-is
 * rather than throwing, and the output is NOT re-decoded ("%252e" → "%2e",
 * never "."), so double-encoding cannot smuggle a rejected character through.
 */
function percentDecode(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

// ------------------------------------------------------------------------ //
// IP parsing + private/special-range classification (no external libs)     //
// ------------------------------------------------------------------------ //

/** Strict dotted-quad parse: exactly 4 decimal octets 0–255, no leading
 *  zeros (so octal-looking forms like "010.1.1.1" are NOT literals here). */
function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Hex groups of one IPv6 side; a dotted-quad may appear only as the very
 *  last piece (contributing two 16-bit groups). Returns null on any
 *  malformed piece. */
function ipv6PartsToGroups(
  parts: string[],
  v4TailAllowed: boolean,
): number[] | null {
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes(".")) {
      if (!v4TailAllowed || i !== parts.length - 1) return null;
      const v4 = parseIpv4(part);
      if (v4 === null) return null;
      groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** Parse an IPv6 address into its eight 16-bit groups (handles "::"
 *  compression and the "::ffff:a.b.c.d" embedded-IPv4 form). Null on any
 *  malformation. Zone suffixes ("%eth0") are not supported → null. */
function parseIpv6(s: string): number[] | null {
  if (s.length === 0) return null;
  const dc = s.indexOf("::");
  if (dc !== -1 && s.includes("::", dc + 1)) return null; // at most one "::"
  if (dc === -1) {
    const groups = ipv6PartsToGroups(s.split(":"), true);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const left = s.slice(0, dc);
  const right = s.slice(dc + 2);
  const leftGroups = ipv6PartsToGroups(left === "" ? [] : left.split(":"), false);
  const rightGroups = ipv6PartsToGroups(right === "" ? [] : right.split(":"), true);
  if (leftGroups === null || rightGroups === null) return null;
  const filled = leftGroups.length + rightGroups.length;
  if (filled > 7) return null; // "::" must stand in for at least one group
  return [
    ...leftGroups,
    ...(new Array(8 - filled).fill(0) as number[]),
    ...rightGroups,
  ];
}

function v4ToInt(a: number, b: number, c: number, d: number): number {
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

/**
 * IPv4 ranges an outbound fetch must never target: "this network" 0/8,
 * RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT 100.64/10, loopback 127/8,
 * link-local 169.254/16 (cloud metadata lives here), IETF protocol
 * assignments 192.0.0/24, the TEST-NETs, benchmarking 198.18/15, multicast
 * 224/4, and reserved 240/4 (which includes the broadcast address).
 */
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [v4ToInt(0, 0, 0, 0), 8],
  [v4ToInt(10, 0, 0, 0), 8],
  [v4ToInt(100, 64, 0, 0), 10],
  [v4ToInt(127, 0, 0, 0), 8],
  [v4ToInt(169, 254, 0, 0), 16],
  [v4ToInt(172, 16, 0, 0), 12],
  [v4ToInt(192, 0, 0, 0), 24],
  [v4ToInt(192, 0, 2, 0), 24],
  [v4ToInt(192, 168, 0, 0), 16],
  [v4ToInt(198, 18, 0, 0), 15],
  [v4ToInt(198, 51, 100, 0), 24],
  [v4ToInt(203, 0, 113, 0), 24],
  [v4ToInt(224, 0, 0, 0), 4],
  [v4ToInt(240, 0, 0, 0), 4],
];

function isPrivateV4(octets: number[]): boolean {
  const value = v4ToInt(octets[0]!, octets[1]!, octets[2]!, octets[3]!);
  return PRIVATE_V4_RANGES.some(([base, prefix]) => {
    const mask = ((~0 << (32 - prefix)) >>> 0);
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function isPrivateV6(groups: number[]): boolean {
  // v4-mapped (::ffff:a.b.c.d) — classify as the embedded IPv4 address.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return isPrivateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  // Everything outside 2000::/3 (global unicast) is loopback / unspecified /
  // link-local fe80::/10 / unique-local fc00::/7 / multicast ff00::/8 /
  // v4-compatible / reserved space — block it all. Slightly stricter than the
  // minimum required set, in the fail-closed direction.
  const g0 = groups[0]!;
  if ((g0 & 0xe000) !== 0x2000) return true;
  // Inside global unicast, still block the IETF special-purpose carve-outs:
  // 2001::/23 (protocol assignments: TEREDO, benchmarking, ORCHID, …) and
  // 2001:db8::/32 (documentation).
  if (g0 === 0x2001 && (groups[1]! & 0xfe00) === 0) return true;
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

/**
 * True when `ip` is a private / loopback / link-local / CGNAT / unique-local
 * / multicast / reserved / unspecified address — anything an outbound fetch
 * must never target. v4-mapped IPv6 ("::ffff:a.b.c.d") is classified as the
 * embedded IPv4. An UNPARSEABLE string returns true: fail closed.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return isPrivateV4(v4);
  const v6 = parseIpv6(ip);
  if (v6 !== null) return isPrivateV6(v6);
  return true;
}

function isIpLiteralHost(host: string): boolean {
  const candidate =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return parseIpv4(candidate) !== null || parseIpv6(candidate) !== null;
}

// ------------------------------------------------------------------------ //
// Homograph (mixed-script) detection                                       //
// ------------------------------------------------------------------------ //

/**
 * Scripts we can name explicitly; anything else non-benign falls into a
 * single "Other" bucket. The named list covers every script with Latin
 * lookalikes that drive real homograph attacks (Cyrillic, Greek, Cherokee,
 * Armenian, …) plus the major non-confusable writing systems so legitimate
 * single-script IDN hosts classify cleanly.
 */
const NAMED_SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Cherokee", /\p{Script=Cherokee}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Georgian", /\p{Script=Georgian}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Han", /\p{Script=Han}/u],
  ["Hiragana", /\p{Script=Hiragana}/u],
  ["Katakana", /\p{Script=Katakana}/u],
  ["Hangul", /\p{Script=Hangul}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Bengali", /\p{Script=Bengali}/u],
  ["Tamil", /\p{Script=Tamil}/u],
  ["Ethiopic", /\p{Script=Ethiopic}/u],
  ["Myanmar", /\p{Script=Myanmar}/u],
];

/**
 * Distinct non-benign Unicode scripts present in one hostname label.
 * `Common` and `Inherited` (digits, hyphen, combining marks) are benign and
 * ignored — a label is only suspect when it mixes TWO OR MORE real scripts
 * (e.g. "pаypal" carrying Latin letters plus one Cyrillic "а").
 */
function labelScripts(label: string): Set<string> {
  const seen = new Set<string>();
  for (const ch of label) {
    if (/[\p{Script=Common}\p{Script=Inherited}]/u.test(ch)) continue;
    const named = NAMED_SCRIPTS.find(([, re]) => re.test(ch));
    seen.add(named === undefined ? "Other" : named[0]);
  }
  return seen;
}

// ------------------------------------------------------------------------ //
// DNS resolution (60s in-process cache — keeps re-validation cheap)        //
// ------------------------------------------------------------------------ //

const dnsCache = new Map<string, { at: number; ips: string[] }>();

/** Default resolver: every A/AAAA address for `host`, cached 60s. Only
 *  SUCCESSFUL resolutions are cached — failures propagate fresh each time. */
async function defaultResolveHost(host: string): Promise<string[]> {
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached !== undefined && now - cached.at < DNS_CACHE_TTL_MS) {
    return [...cached.ips];
  }
  const records = await lookup(host, { all: true });
  const ips = [...new Set(records.map((r) => r.address))].sort();
  dnsCache.set(host, { at: now, ips });
  return ips;
}

// ------------------------------------------------------------------------ //
// Public entry point                                                        //
// ------------------------------------------------------------------------ //

/**
 * Run the 9-rule policy against `url`. Resolves on success; throws
 * SourceUrlValidationError on the first failing rule. Every check fails
 * CLOSED: malformed input maps to a rejection code, never to a pass.
 */
export async function validateSourceUrl(
  url: string,
  opts?: ValidateSourceUrlOptions,
): Promise<void> {
  if (typeof url !== "string" || url === "") {
    throw new SourceUrlValidationError(
      "non_https",
      "URL must be a non-empty string.",
    );
  }

  // Rule ⑨ (length) — cheap; pinned first so the rest of the parser never
  // sees a multi-MB string. Counted in utf-8 BYTES, not UTF-16 code units.
  if (Buffer.byteLength(url, "utf8") > MAX_URL_BYTES) {
    throw new SourceUrlValidationError(
      "url_too_long",
      `URL exceeds ${MAX_URL_BYTES}-byte limit.`,
    );
  }

  const testAllowLocalhost =
    process.env.AUTOBROKER_TEST_ALLOW_LOCALHOST_URLS === "1";

  const { scheme, username, password, host, path, query } = splitUrl(url);

  // Rule ①: https-only scheme (with the localhost test escape for plain
  // http to 127.0.0.1 / localhost).
  if (
    scheme !== "https" &&
    !(testAllowLocalhost && scheme === "http" && LOCALHOST_HOSTS.has(host))
  ) {
    throw new SourceUrlValidationError(
      "non_https",
      `Scheme must be https; got '${scheme}'.`,
    );
  }

  // Rule ②: no credentials.
  if (username !== "" || password !== "") {
    throw new SourceUrlValidationError(
      "credentials_in_url",
      "URL must not carry credentials (user:pass@host).",
    );
  }

  if (host === "") {
    throw new SourceUrlValidationError(
      "non_https",
      "URL must have a hostname.",
    );
  }

  // Rules ③+④: no ".." path segments, raw or percent-encoded. Decoding first
  // covers both forms (".." stays ".." and "%2e%2e" becomes ".."), and a
  // %2F-encoded slash creates a real segment boundary before the split.
  const decodedPath = percentDecode(path);
  for (const segment of decodedPath.split("/")) {
    if (segment === "..") {
      throw new SourceUrlValidationError(
        "path_traversal",
        "URL path may not contain '..' segments.",
      );
    }
  }

  // Rule ⑤: shell metacharacters in the percent-DECODED path/query, so a
  // %3B-encoded ";" is caught alongside the raw form.
  for (const ch of decodedPath + percentDecode(query)) {
    if (SHELL_METAS.includes(ch)) {
      throw new SourceUrlValidationError(
        "shell_metacharacter",
        `URL path/query may not contain shell metacharacter '${ch}'.`,
      );
    }
  }

  // Rule ⑥: host must be a name, not an IP literal. The localhost test
  // escape admits the literal "127.0.0.1" only.
  const isIpLiteral = isIpLiteralHost(host);
  if (isIpLiteral && !(testAllowLocalhost && LOCALHOST_HOSTS.has(host))) {
    throw new SourceUrlValidationError(
      "ip_literal_host",
      "URL host must be a name, not an IP literal.",
    );
  }

  // Rule ⑧ (before the DNS rule so a bad-Unicode hostname fails fast with
  // the right code) — only non-ASCII hosts need IDNA scrutiny.
  if (!isIpLiteral && /[^\x00-\x7F]/.test(host)) {
    // Invisible / control / separator codepoints (e.g. a zero-width space
    // inside "exa​mple.com") never belong in a hostname. Node's own ToASCII
    // quietly STRIPS some of them instead of rejecting, so they are refused
    // explicitly here first.
    if (/[\p{C}\p{Z}]/u.test(host)) {
      throw new SourceUrlValidationError(
        "idna_invalid",
        "Hostname contains invisible or control characters; not valid IDNA.",
      );
    }
    // Structural IDNA validity (disallowed codepoints, bidi violations,
    // misplaced joiners, …): domainToASCII returns "" for invalid domains.
    if (domainToASCII(host) === "") {
      throw new SourceUrlValidationError(
        "idna_invalid",
        "Hostname is not valid IDNA.",
      );
    }
    // Mixed-script (homograph) defence: reject any single label carrying two
    // or more real scripts — e.g. "pаypal" is Latin letters around one
    // Cyrillic "а" and is exactly the classic lookalike attack.
    for (const label of host.split(".")) {
      if (label === "") continue;
      const scripts = labelScripts(label);
      if (scripts.size >= 2) {
        throw new SourceUrlValidationError(
          "idna_invalid",
          `Hostname label mixes scripts (${[...scripts].sort().join(", ")}) — likely homograph attack.`,
        );
      }
    }
  }

  // Rule ⑦: private/link-local DNS resolution. The localhost escape covers
  // this rule too — the test env serves fixtures over 127.0.0.1/localhost.
  // IP literals were already settled by rule ⑥.
  const skipPrivateIp = testAllowLocalhost && LOCALHOST_HOSTS.has(host);
  if (!isIpLiteral && !skipPrivateIp) {
    const resolveHost = opts?.resolveHost ?? defaultResolveHost;
    let ips: string[];
    try {
      ips = await resolveHost(host);
    } catch (err) {
      // NXDOMAIN or any resolver failure — fail closed.
      throw new SourceUrlValidationError(
        "private_ip_resolution",
        `Hostname did not resolve: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    if (ips.length === 0) {
      // A real resolver never returns an empty success; treat it as
      // unresolved rather than vacuously passing.
      throw new SourceUrlValidationError(
        "private_ip_resolution",
        "Hostname did not resolve: empty address list.",
      );
    }
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new SourceUrlValidationError(
          "private_ip_resolution",
          `Hostname resolves to a private/local IP (${ip}); refusing to fetch.`,
        );
      }
    }
  }
}
