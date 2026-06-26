# AutoBroker — Credential Setup (manual, human-only)

This is the **human** companion to the [Agent Setup Guide](AGENT_GUIDE.md). It
gives precise, step-by-step instructions for obtaining and installing every
credential AutoBroker can use.

**Why a separate manual guide?** A setup agent can automate the mechanical work
(install, build, launch the keyless demo, verify), but it **cannot** mint an API
key, enter billing, or click the Google OAuth "Allow" button — those require a
logged-in human, a payment method, or a browser-consent click that exists
specifically to stop automation. "The agent can't do it for you" does **not**
mean "you're on your own": each credential below has a complete manual
procedure. The agent's job at each of these gates is to point you at the right
section here, wait, and then **verify** the result — it never handles the secret
itself.

> **Security — read once.** Paste every secret **into the app's own Settings
> field** (or hand-edit the local files below). **Never paste a key into a chat
> with an AI agent** and never commit one. Keys live in `keys.json` (mode
> `0600`, under your data dir) or `.env` (gitignored) and are read from the
> environment at the network boundary — they are never put into a prompt. An
> agent setting AutoBroker up should only ever read the **pass/fail** result of
> the Test-connection probe, never the key value.

---

## Which credentials do you need?

| Credential | Required? | What it unlocks |
|---|---|---|
| **DeepSeek** *or* Anthropic *or* OpenAI | **One is required** | The LLM that drives extraction/negotiation. DeepSeek is the default. |
| **Google Places (Geocoding)** | Required for dealer search | Turns your city/zip into coordinates so `dealer_geosearch` can run. |
| **Gmail OAuth** | Required for the email pipeline | Reading dealer replies and (in `buyer` mode) sending. |

**Where to paste keys:** open **Settings** (top-bar button,
`data-testid="topbar-settings"`) → the **API keys** section has one row per
provider. Each row is **paste → Test connection → Save**. After a good save the
`settings-setup-strip` notice disappears and the skills tray unlocks.

**No keys yet? Try the demo first.** You do not need any of this to look around —
run the zero-config demo (`AUTOBROKER_DEMO_SEED=1`, see the
[README Quickstart](../../README.md#quickstart)) to explore a populated
dashboard with seeded data, then come back here when you want it to do real work.

---

## 1. DeepSeek API key  <a id="deepseek"></a>

The default LLM provider. **Prepaid** — an authenticated key with a zero balance
will pass the connection test but fail on the first real call, so you must top
up.

> **Privacy.** DeepSeek stores your inputs, prompts, and uploaded files on
> servers in the PRC and may use them to train its models — and AutoBroker sends
> dealer email/PII to the LLM. If that is not acceptable, skip this and set
> **Anthropic** or **OpenAI** instead (§2 / §3) and leave the DeepSeek row empty.

**Get it:**
1. Go to [platform.deepseek.com](https://platform.deepseek.com) and sign in (or
   create an account; email/phone verification may be required).
2. Open **Top up / Billing** and add a small balance (a typical search costs a
   few cents; an unfunded key will not work).
3. Open **API Keys → Create new API key** and copy it.

**Install it:** Settings → **DeepSeek** row (`key-row-deepseek`) → paste into
`key-input-deepseek` → **Test connection** (`key-test-deepseek`) → **Save**
(`key-save-deepseek`).

**Verify:** `key-test-result-deepseek` shows `data-state="pass"` ("Connected —
…"), the setup strip disappears, and the chat-rail Skills tray shows runnable
skills (no `skills-locked-notice`). **A pass proves the key authenticates, not
that it is funded** — if real skill runs error with a billing/quota message,
top up the balance.

**If it fails:** a `401`/`Unauthorized` means the key is wrong or expired —
re-copy the full key and Test again.

---

## 2. Anthropic API key (optional)  <a id="anthropic"></a>

Set this to route LLM calls to Anthropic (Claude) — a Western provider — instead
of DeepSeek. Provider selection is policy-driven; just saving the key routes
there, no other change needed.

**Get it:**
1. Go to [console.anthropic.com](https://console.anthropic.com) and sign in.
2. Under **Plans & Billing**, add credit (a small amount, e.g. ≥ $5).
3. Under **API keys → Create Key**, copy the `sk-ant-…` value.

**Install it:** Settings → **Anthropic** row (`key-row-anthropic`) → paste into
`key-input-anthropic` → **Test connection** → **Save**. Leave the DeepSeek row
empty if you want to use Anthropic exclusively.

**Verify:** `key-test-result-anthropic` shows `pass`; after a skill run the
`driver_kind` in the SSE `init` frame matches Anthropic.

---

## 3. OpenAI API key (optional)  <a id="openai"></a>

Same role as Anthropic — an alternate Western provider.

**Get it:**
1. Go to [platform.openai.com](https://platform.openai.com) and sign in.
   **Phone verification is mandatory** for new accounts.
2. Under **Settings → Billing**, add a payment method / prepaid credit.
3. Under **API keys → Create new secret key**, copy the `sk-proj-…` value.

**Install it:** Settings → **OpenAI** row (`key-row-openai`) → paste into
`key-input-openai` → **Test connection** → **Save**.

**Verify:** `key-test-result-openai` shows `pass`; `driver_kind` matches OpenAI
on the next run.

---

## 4. Google Places (Geocoding) API key  <a id="google-places"></a>

Required before you can search for dealers — `dealer_geosearch` converts your
free-text location into coordinates via the Google Geocoding API. Without it,
intake suspends at the location step with `GOOGLE_PLACES_API_KEY is not set`.

**Get it:**
1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   or select a **project** (CAPTCHA / phone challenge may apply to a new account).
2. **APIs & Services → Library** → search **Geocoding API** → **Enable**.
3. **Enable billing** on the project (a card is required; the legacy $200/mo
   Maps credit ended in 2025).
4. **APIs & Services → Credentials → Create credentials → API key**, then copy
   the key.
5. Recommended: edit the key → **API restrictions → Restrict key → Geocoding
   API** so it cannot be used for anything else.

**Install it:** Settings → **Google Places** row (`key-row-google_places`) →
paste into `key-input-google_places` → **Test connection**
(`key-test-google_places`, runs a trial geocode) → **Save**.

**Verify:** `key-test-result-google_places` shows `pass`; starting an intake
search and entering a city/state no longer suspends at the location step.

---

## 5. Gmail (OAuth 2.0, Desktop client)  <a id="gmail-oauth"></a>

The Gmail **backend is fully shipped** — a real loopback OAuth flow plus a
`@googleapis/gmail` adapter that reads dealer replies and (in `buyer` mode)
sends, every send still behind the per-action approval gate. The **in-app
"Connect Gmail" button in Settings is still a disabled placeholder**; the
supported way to connect today is the one-time command-line consent flow below.

This is the most involved credential because Google requires you to stand up
your **own** OAuth client. Do it once per machine. AutoBroker is single-user and
local-first, so you keep your own Cloud project in **Testing** mode (see the
7-day note at the end) rather than publishing a shared production app.

### 5a. Create the OAuth client in Google Cloud (human, console UI)

1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a
   **project**.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → choose **External** → fill the
   app name + your email → **add your own Gmail address as a Test user**. Leave
   it in **Testing** mode (do not publish).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Desktop app** → Create.
5. **Download the client JSON** (the "Download JSON" button on the client you
   just made). It contains an `installed` block with your `client_id` and
   `client_secret`.

### 5b. Place the client JSON where AutoBroker reads it

Move the downloaded file to **exactly** this path (create the folders if needed):

```
~/.autobroker/oauth/credentials.json
```

> Note the path is `~/.autobroker/oauth/` (no `-ts`). The consent helper reads
> your client creds from here; the resulting **token** is written separately
> into the isolated TS data dir (below).

### 5c. Tell AutoBroker which mailbox to authorize

Set your Gmail address once, via any of (checked in this order):
- argument: `node packages/tools/scripts/gmail-reconsent.mjs you@example.com`, or
- environment: `AUTOBROKER_GMAIL_ACCOUNT=you@example.com`, or
- in the app: **Settings → Environment → Gmail account** (writes
  `settings/env.json`).

### 5d. Run the one-time consent flow

From the repo root:

```bash
node packages/tools/scripts/gmail-reconsent.mjs you@example.com
```

Your browser opens the Google consent page (if it doesn't, the script prints the
URL to paste). Sign in as **the account you specified**, click through the
"unverified app" notice (expected for a Testing-mode app — it's your own
project), and click **Allow**. The scopes requested are
`gmail.readonly`, `gmail.send`, `gmail.modify`, `gmail.labels` — send capability
is granted but **never used without the per-action approval gate**.

### 5e. Verify

The script prints the authorized account, mailbox message total, granted scopes,
and the token path. Confirm the token exists with the right permissions:

```bash
ls -l ~/.autobroker-ts/gmail/token.json   # should be -rw------- (0600)
```

(The token lands under `$AUTOBROKER_DATA_DIR/gmail/`, default
`~/.autobroker-ts/gmail/`.)

### 5f. The 7-day re-consent (Testing mode)

Because the project stays in **Testing** mode, Google **expires the refresh
token after 7 days**. This is expected and the trade-off for not publishing a
verified production app (which would require Google's sensitive/restricted-scope
review and an annual security assessment). When email actions start failing with
an auth error, simply **re-run the same command** to re-consent:

```bash
node packages/tools/scripts/gmail-reconsent.mjs you@example.com
```

---

## After setup

Run the read-only doctor to confirm the environment is healthy (it checks
**presence** of keys, never their values):

```bash
pnpm doctor
```

To remove all local data and credentials later, see
[DATA_HANDLING.md](../DATA_HANDLING.md). Revoke the Gmail grant from your
[Google Account permissions page](https://myaccount.google.com/permissions);
delete LLM keys from each provider's dashboard.
