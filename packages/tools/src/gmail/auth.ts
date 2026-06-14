/**
 * Gmail OAuth — the loopback consent flow + token persistence + the authorized
 * client the real adapter runs on.
 *
 * DUAL-VERSION SAFETY: the OAuth2 client is ALWAYS constructed from the gmail
 * package's OWN bundled `auth` (`import { auth } from "@googleapis/gmail"`).
 * Mixing a separately-installed google-auth-library OAuth2Client with the gmail
 * client's bundled one ships the request unauthenticated ("Login Required"), so
 * we never import an OAuth2Client value from google-auth-library — only its
 * TYPES (erased at runtime, no version coupling).
 *
 * TOKEN AT REST: the refresh token + a copy of the client creds live as 0600
 * JSON inside the isolated TS data dir (<AUTOBROKER_DATA_DIR>/gmail/), never the
 * legacy store. The account is a PARAMETER — never a hardcoded constant — so no
 * real mailbox address is baked into the code.
 *
 * AUTO-REFRESH: the authorized client re-persists its token whenever the library
 * mints a fresh access token (the `tokens` event), so a long-lived process keeps
 * a current token on disk without a re-consent.
 */

import { exec } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// Bundled auth ONLY — see the dual-version note above. `auth.OAuth2` is the
// gmail package's own OAuth2 client class. We derive ALL OAuth types from this
// value (InstanceType / setCredentials param), never from a directly-installed
// google-auth-library — importing that package's types pulls a DIFFERENT version
// whose OAuth2Client diverges (the dual-version trap surfaces as a type error
// here just as it would as "Login Required" at runtime).
import { auth as googleAuth } from "@googleapis/gmail";

/** The bundled OAuth2 client type (whatever google-auth-library version the
 *  gmail package vendors) — derived from the value so it never diverges. */
type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;
/** The bundled credentials shape, taken from the client's own setCredentials. */
type Credentials = Parameters<OAuth2Client["setCredentials"]>[0];

/** The four scopes the product authorizes once (read + send + label ops). Send
 *  capability is granted but every real send stays gate-blocked — capability is
 *  not use. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
] as const;

const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

/** The persisted token JSON shape (same fields the consent flow mints). */
export interface TokenRecord {
  account: string;
  client_id: string;
  refresh_token: string;
  access_token: string | null;
  token_type: string;
  scope: string;
  expiry_date: number | null;
  obtained_at: string;
}

/** The minimal installed/desktop OAuth client creds. */
export interface InstalledClient {
  client_id: string;
  client_secret: string;
}

/** Resolve the isolated gmail data dir (<AUTOBROKER_DATA_DIR>/gmail/), expanding
 *  a leading ~ and defaulting to the parity-period TS data dir. */
export function gmailDataDir(): string {
  const base = (process.env.AUTOBROKER_DATA_DIR ?? "~/.autobroker-ts").replace(/^~/, homedir());
  return join(base, "gmail");
}

/** Absolute path to the persisted token JSON. */
export function tokenPath(): string {
  return join(gmailDataDir(), "token.json");
}

/** Absolute path to the colocated client-creds JSON. */
export function clientPath(): string {
  return join(gmailDataDir(), "client.json");
}

/** Read the persisted token record (throws if absent/unreadable — the caller
 *  decides whether that means "not connected"). */
export function loadTokenRecord(): TokenRecord {
  return JSON.parse(readFileSync(tokenPath(), "utf8")) as TokenRecord;
}

/** Read the colocated installed client creds. */
export function loadClient(): InstalledClient {
  const raw = JSON.parse(readFileSync(clientPath(), "utf8")) as {
    installed?: InstalledClient;
    web?: InstalledClient;
  };
  const c = raw.installed ?? raw.web;
  if (c?.client_id === undefined || c?.client_secret === undefined) {
    throw new Error(`no installed/web client with client_id+secret in ${clientPath()}`);
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

/** Write the token + client JSON 0600 into the isolated gmail data dir. The
 *  token is written FIRST so a later hiccup never costs a single-use code. */
export function persistTokenRecord(record: TokenRecord, client: InstalledClient): void {
  const dir = gmailDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tokenPath(), 0o600);
  writeFileSync(clientPath(), JSON.stringify({ installed: client }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(clientPath(), 0o600);
}

/** Map a fresh token-event credential set onto the persisted record, preserving
 *  the fields the library does not re-issue (refresh_token, account). Exported
 *  for the auto-refresh wiring and its unit test. */
export function mergeCredentialsIntoRecord(
  prev: TokenRecord,
  creds: Credentials,
): TokenRecord {
  return {
    ...prev,
    refresh_token: creds.refresh_token ?? prev.refresh_token,
    access_token: creds.access_token ?? prev.access_token,
    token_type: creds.token_type ?? prev.token_type,
    scope: creds.scope ?? prev.scope,
    expiry_date: creds.expiry_date ?? prev.expiry_date,
  };
}

/**
 * Build an authorized OAuth2 client from a persisted token + client, wiring the
 * `tokens` event so a refreshed access token is re-persisted (0600) without a
 * re-consent. Uses the bundled `auth.OAuth2` only.
 */
export function authorizedClient(
  record: TokenRecord,
  client: InstalledClient,
): OAuth2Client {
  const oauth = new googleAuth.OAuth2({
    clientId: client.client_id,
    clientSecret: client.client_secret,
  });
  // Build the credential set with only the fields we have — exactOptionalPropertyTypes
  // forbids passing an explicit `undefined` for an optional property.
  const creds: Credentials = {
    refresh_token: record.refresh_token,
    token_type: record.token_type,
    scope: record.scope,
  };
  if (record.access_token !== null) creds.access_token = record.access_token;
  if (record.expiry_date !== null) creds.expiry_date = record.expiry_date;
  oauth.setCredentials(creds);
  // Re-persist on every refresh so the on-disk token never goes stale.
  oauth.on("tokens", (creds: Credentials) => {
    persistTokenRecord(mergeCredentialsIntoRecord(record, creds), client);
  });
  return oauth;
}

/** Load the persisted token + client and return an authorized client ready for
 *  the gmail API (the real adapter's lazy service provider). */
export function loadAuthorizedClient(): OAuth2Client {
  return authorizedClient(loadTokenRecord(), loadClient());
}

function consentHtml(body: string): string {
  return `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">${body}</body>`;
}

/**
 * Run the one-time loopback consent flow for `account`:
 *   1. start a transient 127.0.0.1:0 server (ephemeral port → redirect URI);
 *   2. generate the consent URL (offline + prompt=consent for a refresh token)
 *      and open the system browser;
 *   3. wait for the redirect carrying ?code=…;
 *   4. exchange the code for tokens;
 *   5. persist the token + client 0600 into the isolated data dir.
 *
 * The account is a PARAMETER (the login_hint + the stored record), never a
 * constant — no real address is baked in. Returns the persisted record.
 */
export async function runConsentFlow(
  account: string,
  client: InstalledClient,
): Promise<TokenRecord> {
  const { server, port } = await new Promise<{ server: http.Server; port: number }>(
    (resolve, reject) => {
      const s = http.createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (addr === null || typeof addr === "string") {
          reject(new Error("loopback server did not bind a port"));
          return;
        }
        resolve({ server: s, port: addr.port });
      });
    },
  );
  const redirectUri = `http://localhost:${port}`;

  const oauth = new googleAuth.OAuth2({
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUri,
  });

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline", // required to receive a refresh_token
    prompt: "consent", // force a fresh refresh_token even on re-grant
    scope: [...GMAIL_SCOPES],
    login_hint: account,
    include_granted_scopes: true,
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for browser consent (5 min)"));
    }, CONSENT_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (err !== null) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(consentHtml(`<h2>Consent denied</h2><p><code>${err}</code> — you can close this tab.</p>`));
        clearTimeout(timer);
        reject(new Error(`consent denied: ${err}`));
        return;
      }
      if (code === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(consentHtml(`<h2>Connected to Gmail</h2><p>You can close this tab and return to the terminal.</p>`));
      clearTimeout(timer);
      resolve(code);
    });
  });

  exec(`open ${JSON.stringify(authUrl)}`);

  const code = await codePromise;
  server.close();

  const { tokens } = await oauth.getToken(code);
  if (tokens.refresh_token === undefined || tokens.refresh_token === null) {
    throw new Error(
      "no refresh_token returned — revoke prior grants and re-run, or ensure prompt=consent + access_type=offline",
    );
  }

  const record: TokenRecord = {
    account,
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? null,
    token_type: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? GMAIL_SCOPES.join(" "),
    expiry_date: tokens.expiry_date ?? null,
    obtained_at: new Date().toISOString(),
  };
  persistTokenRecord(record, client);
  return record;
}
