# AutoBroker — Agent Setup Guide

This guide is for an AI agent setting up AutoBroker on the user's behalf,
step by step from a fresh install to a fully configured, running instance.

---

## Prerequisites

- **Node.js >= 24.13.0** (`engine-strict` — `pnpm install` hard-fails below it).
  Note `.nvmrc` pins only the major `24`, so `nvm use` can land below 24.13 and
  still fail; install the exact floor with `nvm install 24.13`. (After a Node
  upgrade, a `better-sqlite3` ABI rebuild may be needed — `pnpm doctor` checks
  this and prints the rebuild command.)
- **pnpm >= 9** (`corepack use pnpm@9` or `npm i -g pnpm@9`).
- The repository cloned and dependencies installed:
  ```bash
  pnpm install
  ```
- A writable home directory (`~/.autobroker-ts/` is created automatically on
  first run).

**Run the read-only doctor first.** `pnpm doctor` self-checks the environment
(Node floor, pnpm, `better-sqlite3`, data-dir isolation, key **presence**,
resolved `AUTOBROKER_MODE`, telemetry-disabled, `/api/mode`) and prints the
literal fix for each failure. It is read-only — it never writes config, starts
the server, or reads a key value.

**Credentials are human-gated — see the manual guide.** You (the agent) can run
all the mechanical setup, but you **cannot** mint an API key, enter billing, or
click the Google OAuth "Allow" button. Those steps each have a complete
step-by-step procedure in **[CREDENTIALS_SETUP.md](CREDENTIALS_SETUP.md)** — at
each credential gate below, point the user at the matching section, wait, then
verify. **Never handle the secret yourself**: the user pastes it into the app's
own Settings field; you only read the pass/fail probe result.

---

## Quick-start runbook (two tracks)

Run setup as **two interleaved tracks**. You own the mechanical track end to end;
at each human-gated credential you **park**, hand the user the matching
[CREDENTIALS_SETUP.md](CREDENTIALS_SETUP.md) section, wait, then verify. **You
never receive a raw secret** — the user pastes it into the app's own Settings
field (the browser POSTs it); you read only the pass/fail probe.

**Autonomous track (you run it; each step gated by exit code / HTTP / DOM):**

1. `pnpm install` — verify it exits 0 (engine-strict passing ⇒ Node is OK).
2. `pnpm doctor` — verify exit 0, or act on the printed remediation.
3. `pnpm --filter @autobroker/server build` — verify `apps/server/dist/index.js` exists.
4. Launch the keyless demo — `pnpm demo` (server) plus, in a second terminal,
   `pnpm --filter @autobroker/ui dev` — verify stdout shows
   `{"server":"listening",...,"port":8100}` and `GET /api/mode` returns
   `{demo:true, mode:"test", active_db:…}`.
5. Demo health in the DOM — verify `data-testid="backend-banner"` is **absent**
   and `data-testid="demo-banner"` is **present**.

This brings the user to a populated, keyless demo with **no credentials at all**.
Everything below is the human-gated remainder needed for real (non-demo) work.

**STOP-and-ask checkpoints (you park, hand over the guide, wait, then verify):**

| Credential | Hand the user | Resume verify (you read only the result) |
|---|---|---|
| LLM provider key (Step 1 / Step 3) | [CREDENTIALS_SETUP.md §1–§3](CREDENTIALS_SETUP.md#deepseek) — get key, **top up**, paste into the Settings field | trigger the probe; `key-test-result-<provider>` `data-state="pass"`. Probe-pass ≠ funded — if real runs hit a billing error, the user must top up. |
| Google Places key (Step 2) | [CREDENTIALS_SETUP.md §4](CREDENTIALS_SETUP.md#google-places) — enable Geocoding API + billing, mint key, paste into the Settings field | `key-test-result-google_places` `data-state="pass"`. |
| Gmail OAuth (Step 5) | [CREDENTIALS_SETUP.md §5](CREDENTIALS_SETUP.md#gmail-oauth) — GCP project → consent screen (Testing) → Desktop client → `gmail-reconsent.mjs` → click Allow | `~/.autobroker-ts/gmail/token.json` exists at `0600`; a `buyer`-mode inbox read succeeds. |

You **may** open the relevant console / consent URL in the user's own browser
(`open <url>`) as a convenience, but the user does the clicking and pasting —
opening the URL is best-effort, never a gate, and moves nothing from human to
agent.

---

## How to reach Settings

The Settings panel lives at the `/settings` route. Reach it by clicking the
**Settings** button (`data-testid="topbar-settings"`) in the top bar. The
panel (`data-testid="settings-page"`) renders **five** key rows (DeepSeek, Google
Places, Anthropic, OpenAI, and Claude subscription (OAuth)) and a Gmail card. The
Claude-subscription row (`key-row-claude_oauth`) is **presence-only** — it has no
Test-connection button (`testKind: "none"`), so verify its presence and never
trigger a probe for it (see Step 3b).

---

## Step 1 — DeepSeek key (REQUIRED)

DeepSeek is the default LLM provider. Without this key no skill will run.

**Privacy note:** DeepSeek stores inputs, prompts, and uploaded files on servers
in the PRC and may use them for training. This includes private Gmail content
and dealer PII that AutoBroker processes. If this is not acceptable, use
Anthropic or OpenAI instead (Step 3) and leave the DeepSeek row empty.

### How to obtain

The user does this — see **[CREDENTIALS_SETUP.md §1](CREDENTIALS_SETUP.md#deepseek)**
for the full procedure. In short: sign in at
[platform.deepseek.com](https://platform.deepseek.com), **top up a balance**
(prepaid — an unfunded key passes the test but fails on the first real call),
and create an API key under **API Keys**. The user pastes it into the Settings
field; you never receive the value.

### How to configure

In the Settings panel, locate the **DeepSeek** row
(`data-testid="key-row-deepseek"`):

1. Paste the key into the password input (`data-testid="key-input-deepseek"`).
   The placeholder reads `required` on a fresh install.
2. Click **Test connection** (`data-testid="key-test-deepseek"`) to probe the
   key against the DeepSeek API before saving.
3. Click **Save** (`data-testid="key-save-deepseek"`).

### Verify success

After a successful save:

- `data-testid="key-test-result-deepseek"` shows `data-state="pass"` and the
  text "Connected — …" (the detail is the model-list response from DeepSeek).
- The setup strip (`data-testid="settings-setup-strip"`) disappears — the
  required-key notice is gone.
- Opening the chat-rail Skills tray (`data-testid="rail-skills-toggle"`) shows
  skill rows instead of the "Add your DeepSeek key in Settings first." lock notice
  (`data-testid="skills-locked-notice"`).

> **A pass proves the key authenticates, not that it is funded.** DeepSeek is
> prepaid; a valid key with a zero balance still passes the probe but errors on
> the first billable call. If real skill runs fail with a quota/billing message,
> have the user top up (CREDENTIALS_SETUP.md §1).

**Expected failure modes:**

| Test result | Likely cause | Fix |
|---|---|---|
| `data-state="fail"` citing `401` or `Unauthorized` | Key is wrong or expired | Re-paste the correct key and Test again |
| Test button stays disabled | No value typed in the input | Type the key first |

---

## Step 2 — Google Places (Geocoding) key (REQUIRED for dealer search)

The `dealer_geosearch` skill uses the Google Geocoding API to convert the
user's free-text location into coordinates. Without this key the intake
workflow suspends at the location step and cannot proceed.

### How to obtain

Full human steps: **[CREDENTIALS_SETUP.md §4](CREDENTIALS_SETUP.md#google-places)**.
In short (the user does this, with billing enabled on the project):

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create
   or select a project.
2. Navigate to **APIs & Services → Library**, search for **Geocoding API**,
   and click **Enable**.
3. Go to **APIs & Services → Credentials**, click **Create Credentials →
   API key**, and copy the generated key.
4. Restrict the key to the Geocoding API (recommended): in the key's settings
   set **API restrictions → Restrict key → Geocoding API**.

### How to configure

In the Settings panel, locate the **Google Places** row
(`data-testid="key-row-google_places"`):

1. Paste the key into the input (`data-testid="key-input-google_places"`).
2. Click **Test connection** (`data-testid="key-test-google_places"`) — the
   probe runs a trial geocode against the Geocoding API.
3. Click **Save** (`data-testid="key-save-google_places"`).

### Verify success

- `data-testid="key-test-result-google_places"` shows `data-state="pass"`.
- Starting an intake search and entering a city and state no longer suspends
  at the location step with a `GOOGLE_PLACES_API_KEY is not set` error.

---

## Step 3 — Optional providers: Anthropic and OpenAI

Leave these rows empty to use DeepSeek. Set one (or both) if the user wants to
route LLM calls to a Western provider or wants the ability to switch. Human
steps: **[CREDENTIALS_SETUP.md §2](CREDENTIALS_SETUP.md#anthropic)** (Anthropic)
/ **[§3](CREDENTIALS_SETUP.md#openai)** (OpenAI — note OpenAI mandates phone
verification).

- **Anthropic** row: `data-testid="key-row-anthropic"` / input
  `key-input-anthropic` / test `key-test-anthropic`
- **OpenAI** row: `data-testid="key-row-openai"` / input `key-input-openai` /
  test `key-test-openai`

The same paste → Test → Save flow applies. Provider selection is policy-driven:
once the key is saved the provider registry routes there automatically. No
workflow code is touched.

**Verify:** After saving an Anthropic or OpenAI key and starting a skill run,
the `driver_kind` in the SSE `init` frame matches the expected provider.

---

## Step 3b — Claude subscription (OAuth), presence-only (optional)

A fifth Settings row, **Claude subscription (OAuth)**
(`data-testid="key-row-claude_oauth"`), is backed by `CLAUDE_CODE_OAUTH_TOKEN`. It
lets the chat-rail AgentBar run Claude on the user's Pro/Max **subscription**
(lane B, via Anthropic's Agent SDK) instead of the per-token `ANTHROPIC_API_KEY`
(lane A). Human steps: **[CREDENTIALS_SETUP.md §2b](CREDENTIALS_SETUP.md#claude-oauth)**
— run `claude setup-token`, paste the token into the row, Save.

This row is unique: **presence-only** (`testKind: "none"`), so it has **no
Test-connection button** and the backend runs no probe. Verify only that the token
is present — do **not** look for or trigger a `key-test-*` result for it. It is for
personal, single-user use of the user's own token; a multi-user deployment must use
`ANTHROPIC_API_KEY` instead.

---

## Step 4 — Gmail (required for the email pipeline)

The Gmail **backend is fully shipped and live**: a real loopback OAuth flow plus
a `@googleapis/gmail` adapter that reads dealer reply threads and, in `buyer`
mode, sends — every real send still passing the per-action L2 approval gate. In
`test` mode all sends resolve to a local fake mailbox.

> The **in-app "Connect Gmail" button** in Settings (`data-testid="gmail-connect"`)
> is still a **disabled placeholder** ("Coming soon"); `/api/settings/keys`
> reports `gmail.connected: false` because that UI wiring is a later slice. **The
> supported way to connect today is the command-line consent flow** (Step 5) —
> do not tell the user to wait for the in-app button.

## Step 5 — Connect Gmail (GCP project + loopback OAuth, human-gated)

This is human-gated end to end (Google Cloud Console UI + an OAuth "Allow"
click). **Full step-by-step: [CREDENTIALS_SETUP.md §5](CREDENTIALS_SETUP.md#gmail-oauth).**
Point the user there; you cannot do these steps for them. The shape:

1. The user creates a Google Cloud project, enables the **Gmail API**, and
   configures an **External** OAuth consent screen — left in **Testing** mode
   (add their own address as a Test user). **Do not publish to "In production"**:
   a published Gmail-scope app triggers Google's sensitive/restricted-scope
   verification plus an annual security assessment. The trade-off for staying in
   Testing is a **7-day refresh-token expiry** (re-run the consent command to
   refresh).
2. They create an OAuth 2.0 **Desktop app** client and download its JSON to
   `~/.autobroker/oauth/credentials.json` (the path the consent helper reads).
3. They set the mailbox (Settings → Environment → Gmail account, or
   `AUTOBROKER_GMAIL_ACCOUNT`) and run the consent flow, clicking **Allow** in
   the browser:
   ```bash
   node packages/tools/scripts/gmail-reconsent.mjs you@example.com
   ```

**Verify:** the OAuth token file exists at `~/.autobroker-ts/gmail/token.json`
with mode `0600` (the script also prints the authorized account and mailbox
total). A `buyer`-mode inbox read then succeeds.

---

## Demo mode (Electron only)

On a fresh Electron install — defined as: no DeepSeek key saved AND no product
database yet — the app shows a native dialog before starting:

> **No API key found**
> "Try AutoBroker with sample demo data, or set up your keys first?"
> Buttons: **Try demo data** | **Set up keys**

- **Try demo data**: boots into an isolated sample database under
  `~/.autobroker-ts/demo/`. The UI shows a persistent **"DEMO DATA"** banner
  (`data-testid="demo-banner"`). No keys are needed; nothing is real.
- **Set up keys**: boots normally and the SPA's first-run gate routes to
  `/settings`.

An agent running with an explicit `AUTOBROKER_DATA_DIR` or `AUTOBROKER_DB`
environment variable never sees this dialog (deliberate boot target).

---

## Desktop app — install & auto-fresh (macOS, optional)

If the user wants the Electron app installed to `/Applications` with automatic
build-on-change, run these two commands once in order:

```bash
pnpm desktop:install          # builds and installs /Applications/AutoBroker.app
pnpm desktop:hooks:install    # arms the git hooks that pre-warm rebuilds on commit/merge/checkout
```

**Freshness is eventually-consistent, not instantaneous.** The app opens immediately
on the last-installed build; a non-blocking "Update ready — Relaunch" notification
appears within seconds when a newer build is ready. An uncommitted edit is fresh only
after the background build completes; edits committed while the app was closed are
fresh on the next launch.

The launch-time check in `apps/desktop/src/freshness.ts` is the actual guarantee —
not the git hooks. GUI/IDE commits give the hook a minimal PATH with no `node`, so
the hook silently skips; the packaged launch check fires regardless and catches it.

**Kill switch:** `AUTOBROKER_DESKTOP_REFRESH=0` disables the auto-rebuild.

**Scope and coupling:** macOS-only; requires `mac.identity: null` (unsigned local
build). The stamp marker lives outside the `.app` bundle at
`~/.autobroker-ts/desktop-refresh/<hash>.json`, so a copied or shipped `.app` is a
normal frozen build with no self-rebuild. Only the checkout where
`desktop:hooks:install` ran warms `/Applications`; other worktrees are inert.

**Safety unchanged:** send-mode stays buyer-by-default, the in-app TopBar toggle is
authoritative, the refresh build performs no sends, and the relaunch is env-clean.

---

## Failure-mode reference table

| Symptom | Likely cause | Fix |
|---|---|---|
| `key-test-result-deepseek` shows `data-state="fail"` citing `401` or `Unauthorized` | Wrong or expired DeepSeek key | Re-paste the correct key and Test again |
| Chat-rail Skills tray shows `data-testid="skills-locked-notice"` | DeepSeek key not configured | Complete Step 1 |
| `settings-setup-strip` still visible after saving | Save did not complete (check `key-error-deepseek`) | Fix the error and Save again |
| Intake suspends at the location step with `GOOGLE_PLACES_API_KEY is not set` | No Google Places key configured | Complete Step 2 |
| `key-test-result-google_places` shows `data-state="fail"` | Wrong key or Geocoding API not enabled | Check the GCP project and re-paste |
| `pnpm install` fails (engine-strict) | Node.js < 24.13.0 or pnpm < 9 | Install Node >= 24.13.0 (`nvm install 24.13` — `.nvmrc` pins only `24`) + pnpm 9, then retry. `pnpm doctor` pinpoints which. |
| Backend banner (`data-testid="backend-banner"`) visible | Server not running or unreachable | Build (`pnpm --filter @autobroker/server build`) then run `node apps/server/dist/index.js` — there is no `start` script (see Step 3 / line 51). `pnpm demo` boots the seeded demo the same way. |

---

## Confirm full setup

Work through this checklist in order:

- [ ] `pnpm install` completes without errors.
- [ ] Server starts; the Diagnostics fold in the top bar shows a valid
      `active_db` path (or `GET /api/mode` returns JSON with `"active_db"` set).
- [ ] `data-testid="key-test-result-deepseek"` shows `data-state="pass"` after
      clicking Test connection (Step 1).
- [ ] `settings-setup-strip` is absent from the Settings page.
- [ ] Chat-rail Skills tray shows runnable skill rows (no `skills-locked-notice`).
- [ ] `data-testid="key-test-result-google_places"` shows `data-state="pass"`
      after clicking Test connection (Step 2).
- [ ] Starting an intake search proceeds past the location step without a
      geocode suspension error.
- [ ] *(For the email pipeline)* after the Step 5 consent flow, the OAuth token
      file exists at `~/.autobroker-ts/gmail/token.json` with mode `0600`
      (the in-app Connect button stays a placeholder — the CLI flow is the path).
