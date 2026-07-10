/**
 * Gmail loopback re-consent — one-time OAuth setup utility.
 *
 * Reuses the existing "installed" (desktop) BYO OAuth client and runs the
 * loopback flow against the system browser: the user clicks "Allow", Google
 * redirects to a transient 127.0.0.1 server here, and the auth code is exchanged
 * for a refresh token. The refresh token + a copy of the client creds are
 * persisted as 0600 JSON inside the TS data dir, isolated from the legacy
 * Python ~/.autobroker/ store.
 *
 * Scopes requested match the parity oracle's set so the consent screen accepts
 * them and we authorize once for the whole product (read + send + label ops):
 *   gmail.readonly, gmail.send, gmail.modify, gmail.labels
 * (send capability is granted here, but granting is not sending: in test mode
 *  every send resolves to the local fake mailbox, and in buyer mode a real send
 *  happens only through an L2 approval; the default is manual and first-send
 *  automation must be explicitly enabled.)
 *
 * The account is a PARAMETER (env var or argv), never a hardcoded constant, so
 * no real mailbox address is baked into the committed source.
 *
 * Run:  AUTOBROKER_GMAIL_ACCOUNT=you@example.com node packages/tools/scripts/gmail-reconsent.mjs
 *   or: node packages/tools/scripts/gmail-reconsent.mjs you@example.com
 */

import http from "node:http";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Use @googleapis/gmail's OWN bundled auth (its google-auth-library version) so
// the OAuth2 client is recognized by the gmail API client. Mixing a top-level
// google-auth-library OAuth2Client with the package's bundled one sends the
// request unauthenticated → "Login Required".
import { gmail as gmailApi, auth as googleAuth } from "@googleapis/gmail";

const CREDENTIALS_PATH = join(homedir(), ".autobroker", "oauth", "credentials.json");
const DATA_DIR = (process.env.AUTOBROKER_DATA_DIR || "~/.autobroker-ts").replace(/^~/, homedir());
const OUT_DIR = join(DATA_DIR, "gmail");
const TOKEN_PATH = join(OUT_DIR, "token.json");
const CLIENT_PATH = join(OUT_DIR, "client.json");

/** Resolve which account to authorize — NO address is hardcoded. Precedence:
 *    argv[2]  →  AUTOBROKER_GMAIL_ACCOUNT  →  the saved settings/env.json
 *  (the same file the app's Settings → Environment → "Gmail account" writes).
 *  Exits with usage when none is configured. */
function resolveAccount() {
  const fromArg = process.argv[2];
  if (fromArg && fromArg.length > 0) return fromArg;
  const fromEnv = process.env.AUTOBROKER_GMAIL_ACCOUNT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const env = JSON.parse(readFileSync(join(DATA_DIR, "settings", "env.json"), "utf8"));
    if (typeof env.gmail_account === "string" && env.gmail_account.length > 0) {
      return env.gmail_account;
    }
  } catch {
    // No saved settings file — fall through to the usage error.
  }
  console.error(
    "\n  No Gmail account configured. Set it once, then re-run:\n" +
      "    • in the app:  Settings → Environment → Gmail account, or\n" +
      "    • AUTOBROKER_GMAIL_ACCOUNT=you@example.com node packages/tools/scripts/gmail-reconsent.mjs, or\n" +
      "    • node packages/tools/scripts/gmail-reconsent.mjs you@example.com\n",
  );
  process.exit(1);
}

const ACCOUNT = resolveAccount();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

function loadInstalledClient() {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const c = raw.installed || raw.web;
  if (!c?.client_id || !c?.client_secret) {
    throw new Error(`No installed/web client with client_id+secret in ${CREDENTIALS_PATH}`);
  }
  return c;
}

function html(body) {
  return `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">${body}</body>`;
}

async function main() {
  const client = loadInstalledClient();
  console.log(`\n  Gmail re-consent for: ${ACCOUNT}`);
  console.log(`  Client: ${client.client_id.slice(0, 24)}… (installed/desktop)\n`);

  // 1) Start a transient loopback server on an ephemeral port.
  const { server, port } = await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
  const redirectUri = `http://localhost:${port}`;

  const oauth = new googleAuth.OAuth2({
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUri,
  });

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline", // required to receive a refresh_token
    prompt: "consent", // force a fresh refresh_token even on re-grant
    scope: SCOPES,
    login_hint: ACCOUNT,
    include_granted_scopes: true,
  });

  // 2) Wait for the redirect carrying ?code=…
  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for browser consent (5 min)."));
    }, CONSENT_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html(`<h2>Consent denied</h2><p>Google returned: <code>${err}</code>. You can close this tab.</p>`));
        clearTimeout(timer);
        reject(new Error(`Consent denied: ${err}`));
        return;
      }
      if (!code) {
        // Ignore favicon / stray hits.
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(`<h2>✓ AutoBroker is connected to Gmail</h2><p>You can close this tab and return to the terminal.</p>`));
      clearTimeout(timer);
      resolve(code);
    });
  });

  // 3) Open the consent page (and print it as a fallback).
  console.log("  Opening the Google consent page in your browser…");
  console.log("  If it does not open, paste this URL:\n");
  console.log("  " + authUrl + "\n");
  exec(`open ${JSON.stringify(authUrl)}`);

  const code = await codePromise;
  server.close();

  // 4) Exchange the code for tokens.
  const { tokens } = await oauth.getToken(code);
  oauth.setCredentials(tokens);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token returned. Re-run after revoking prior grants, " +
        "or ensure prompt=consent + access_type=offline (it is set here).",
    );
  }

  // 5) Persist token + client creds FIRST (0600 JSON, isolated TS data dir), so
  //    a verify hiccup can never cost the single-use consent code.
  mkdirSync(OUT_DIR, { recursive: true });
  const tokenRecord = {
    account: ACCOUNT,
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? null,
    token_type: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? SCOPES.join(" "),
    expiry_date: tokens.expiry_date ?? null,
    obtained_at: new Date().toISOString(),
  };
  writeFileSync(TOKEN_PATH, JSON.stringify(tokenRecord, null, 2) + "\n", { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  // Colocate the client creds so the TS data dir is self-contained for refresh.
  writeFileSync(CLIENT_PATH, JSON.stringify({ installed: client }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CLIENT_PATH, 0o600);

  // 6) Verify the grant actually works (proves readonly access). Best-effort:
  //    the token is already saved, so a verify error only warns.
  let got = null;
  let totalMsgs = null;
  try {
    const api = gmailApi({ version: "v1", auth: oauth });
    const profile = await api.users.getProfile({ userId: "me" });
    got = profile.data.emailAddress;
    totalMsgs = profile.data.messagesTotal;
  } catch (e) {
    console.log(`\n  ⚠ Verify call failed (${e.message}); token is saved regardless.`);
  }

  console.log("\n  ─────────────────────────────────────────────");
  if (got) {
    console.log(`  ✓ Authorized account : ${got}`);
    if (got.toLowerCase() !== ACCOUNT.toLowerCase()) {
      console.log(`  ⚠ WARNING: you consented as ${got}, not ${ACCOUNT}.`);
      console.log(`            Re-run and pick ${ACCOUNT} on the chooser.`);
    }
    console.log(`  ✓ Mailbox total msgs : ${totalMsgs}`);
  }
  console.log(`  ✓ Granted scopes     : ${tokenRecord.scope}`);
  console.log(`  ✓ Refresh token      : stored (${tokenRecord.refresh_token.length} chars)`);
  console.log(`  ✓ Token file (0600)  : ${TOKEN_PATH}`);
  console.log(`  ✓ Client file (0600) : ${CLIENT_PATH}`);
  console.log("  ─────────────────────────────────────────────\n");
}

main().catch((e) => {
  console.error("\n  ✗ Re-consent failed:", e.message, "\n");
  process.exit(1);
});
