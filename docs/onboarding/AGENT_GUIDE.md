# AutoBroker — Agent Setup Guide

This guide is for an AI agent setting up AutoBroker on the user's behalf,
step by step from a fresh install to a fully configured, running instance.

---

## Prerequisites

- **Node.js** >= 20 and **pnpm** >= 9 installed on the machine.
- The repository cloned and dependencies installed:
  ```bash
  pnpm install
  ```
- A writable home directory (`~/.autobroker-ts/` is created automatically on
  first run).

---

## How to reach Settings

The Settings panel lives at the `/settings` route. Reach it by clicking the
**Settings** button (`data-testid="topbar-settings"`) in the top bar. The
panel (`data-testid="settings-page"`) renders four key rows and a Gmail card.

---

## Step 1 — DeepSeek key (REQUIRED)

DeepSeek is the default LLM provider. Without this key no skill will run.

**Privacy note:** DeepSeek stores inputs, prompts, and uploaded files on servers
in the PRC and may use them for training. This includes private Gmail content
and dealer PII that AutoBroker processes. If this is not acceptable, use
Anthropic or OpenAI instead (Step 3) and leave the DeepSeek row empty.

### How to obtain

1. Go to [platform.deepseek.com](https://platform.deepseek.com), sign in,
   and create an API key under **API Keys**.

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
- Opening the Skills popover (`data-testid="topbar-skills"`) shows skill rows
  instead of the "Add your DeepSeek key in Settings first." lock notice
  (`data-testid="skills-locked-notice"`).

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
route LLM calls to a Western provider or wants the ability to switch.

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

## Step 4 — Gmail [AVAILABLE AFTER THE EMAIL MILESTONE]

The **Gmail** card (`data-testid="gmail-card"`) is currently a disabled
"Coming soon" shell. The **Connect Gmail** button is visually present but
inactive. No action is needed or possible here until the email milestone ships.

When it ships: the user grants OAuth access via the in-app connect flow.
AutoBroker reads dealer reply threads and writes outbound emails to a
fake-mailbox DB row (real sends remain gated behind explicit approval). Verify
by confirming the OAuth token file appears under `~/.autobroker-ts/gmail/`
with mode `0600`.

---

## Step 5 — GCP / loopback OAuth [AVAILABLE AFTER THE EMAIL MILESTONE]

The Gmail integration requires a Google Cloud project with the **Gmail API**
enabled and an OAuth 2.0 **Desktop application** client ID. The OAuth consent
screen must be published **In production** (not left in Testing mode) —
Testing mode issues tokens that expire after 7 days. The loopback redirect
(`localhost`) is used for the initial consent flow; a helper script
(`packages/tools/scripts/gmail-reconsent.mjs`) handles re-consent when the
token expires.

Until the email milestone is released, ignore this step.

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

## Failure-mode reference table

| Symptom | Likely cause | Fix |
|---|---|---|
| `key-test-result-deepseek` shows `data-state="fail"` citing `401` or `Unauthorized` | Wrong or expired DeepSeek key | Re-paste the correct key and Test again |
| Skills popover shows `data-testid="skills-locked-notice"` | DeepSeek key not configured | Complete Step 1 |
| `settings-setup-strip` still visible after saving | Save did not complete (check `key-error-deepseek`) | Fix the error and Save again |
| Intake suspends at the location step with `GOOGLE_PLACES_API_KEY is not set` | No Google Places key configured | Complete Step 2 |
| `key-test-result-google_places` shows `data-state="fail"` | Wrong key or Geocoding API not enabled | Check the GCP project and re-paste |
| `pnpm install` fails | Node.js < 20 or pnpm < 9 | Upgrade the runtime, then retry |
| Backend banner (`data-testid="backend-banner"`) visible | Server not running or unreachable | Start the server with `pnpm -F @autobroker/server start` |

---

## Confirm full setup

Work through this checklist in order:

- [ ] `pnpm install` completes without errors.
- [ ] Server starts; the Diagnostics fold in the top bar shows a valid
      `active_db` path (or `GET /api/mode` returns JSON with `"active_db"` set).
- [ ] `data-testid="key-test-result-deepseek"` shows `data-state="pass"` after
      clicking Test connection (Step 1).
- [ ] `settings-setup-strip` is absent from the Settings page.
- [ ] Skills popover shows runnable skill rows (no `skills-locked-notice`).
- [ ] `data-testid="key-test-result-google_places"` shows `data-state="pass"`
      after clicking Test connection (Step 2).
- [ ] Starting an intake search proceeds past the location step without a
      geocode suspension error.
- [ ] *(Post-email milestone)* Gmail card shows "Connected" and the OAuth token
      file exists at `~/.autobroker-ts/gmail/` with mode `0600`.
