# AutoBroker — Getting Started

Welcome to AutoBroker. This guide walks you through everything you need to do
before your first search — written for the owner, no technical background
required.

---

## What you need to get started

You need two things before you can run your first search:

1. **A DeepSeek API key** — the AI brain that drives the pipeline. It's free
   to sign up and the usage cost for a typical search is very small.
2. **A Google Maps key** — so AutoBroker can turn your city and zip code into
   dealer coordinates. Required before you search for dealers.

That's it. Everything else is optional.

**Want to look around first, with no keys?** Run the built-in demo
(`AUTOBROKER_DEMO_SEED=1`, or `pnpm demo`) to explore a populated dashboard with
sample data — nothing real, no keys needed. See the
[README Quickstart](../../README.md#quickstart).

**Need the exact click-by-click steps for any key (including Gmail)?** Every
credential has a full manual walk-through in
**[CREDENTIALS_SETUP.md](CREDENTIALS_SETUP.md)**.

---

## A note on privacy before you begin

**DeepSeek (the default AI provider) routes your data through servers in
China.** AutoBroker reads your Gmail dealer replies and dealer contact details
and sends that text to DeepSeek for analysis. DeepSeek may store and train on
it.

If that's not acceptable to you, you can use **Anthropic (Claude)** or
**OpenAI** instead — both are Western providers. The steps below cover this
option. AutoBroker works identically regardless of which provider you choose.

---

## Opening Settings

Click the **Settings** button in the top-right corner of the app. This opens
the Settings page, which has a dedicated **API keys** section with one row per
provider. You manage all your keys here — no config file to edit.

---

## Adding your DeepSeek key

1. Go to [platform.deepseek.com](https://platform.deepseek.com) and sign in
   (or create a free account).
2. In your account dashboard, navigate to **API Keys** and create a new key.
   Copy it.
3. In the Settings page, find the **DeepSeek** row (marked with a star — it's
   required).
4. Paste your key into the input field in that row.
5. Click **Test connection**. You should see a green "Connected" message appear.
   If it fails, double-check that you copied the full key and try again.
6. Click **Save**.

> **Remember to top up your DeepSeek balance.** DeepSeek is pay-as-you-go and
> prepaid: a brand-new key will pass the connection test but real searches will
> fail until you add a small balance in your DeepSeek account.

**How do you know it worked?** After saving, the setup notice at the top of the
Settings page disappears and all skills become available. Opening the Skills
menu in the top bar shows runnable searches instead of a lock message.

---

## Adding your Google Maps key

AutoBroker needs this to convert a city or zip code into map coordinates for
the dealer search. Without it, starting a search will get stuck at the location
step.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and sign in.
2. Create a new project (or pick an existing one).
3. Go to **APIs & Services → Library**, search for **Geocoding API**, and click
   **Enable**.
4. Go to **APIs & Services → Credentials**, click **Create Credentials → API
   key**, and copy the key shown.
5. In the Settings page, find the **Google Places** row (also marked required).
6. Paste your key, click **Test connection**, and confirm the green "Connected"
   message appears.
7. Click **Save**.

**How do you know it worked?** Start an intake search, enter your city and
state in the location field, and continue. If the search profile saves
successfully, the key is working.

---

## Optional: using Claude or OpenAI instead of DeepSeek

If you'd rather not send your data through DeepSeek, you can use Anthropic
(Claude) or OpenAI. Both have rows in the Settings panel — just paste and save
your key there. Leave the DeepSeek row empty if you want to use one of the
other providers exclusively.

AutoBroker will automatically route to whichever key is set. You don't need
to change anything else.

---

## Demo mode (Electron app only)

When you first open the Electron app on a machine with no keys configured, a
dialog appears:

> **"Try AutoBroker with sample demo data, or set up your keys first?"**
> Two buttons: **Try demo data** and **Set up keys**

- **Try demo data** — opens AutoBroker against an isolated sample database. A
  blue **"DEMO DATA"** banner appears across the top of the app throughout the
  session. Everything you see is example data; nothing is real and no keys are
  needed. This is the fastest way to explore the UI before committing to a key.
- **Set up keys** — opens normally and takes you straight to the Settings page
  so you can add your keys. The demo dialog will not appear again once a
  DeepSeek key is saved.

---

## Desktop app — install & keep fresh

If you're running the Electron desktop app (macOS only), two one-time commands
build and install it — then keep it current automatically:

```bash
pnpm desktop:install          # builds and installs /Applications/AutoBroker.app
pnpm desktop:hooks:install    # arms the git hooks that warm up rebuilds on each commit
```

**What "fresh" means:** the app always opens immediately on the last-installed build.
Within seconds a non-blocking **"Update ready — Relaunch"** prompt appears if a newer
build is ready. Freshness is *eventually consistent*: an uncommitted edit is fresh only
after the background build finishes; an edit committed while the app was closed is fresh
on the next launch.

**Kill switch:** set `AUTOBROKER_DESKTOP_REFRESH=0` to turn off auto-rebuilds.

**Safety is unchanged.** Send-mode stays buyer-by-default and the in-app TopBar toggle
stays authoritative. The refresh build performs no sends and the relaunch is env-clean.

> A distributed `.dmg` or a copied app is a normal frozen build — auto-refresh applies
> only to the checkout where you ran `desktop:hooks:install`.

---

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| "Failed" after clicking Test connection on the DeepSeek row | Your key is wrong or expired | Re-paste the correct key and test again |
| "Connected" on test but the Setup notice is still visible | You haven't clicked Save yet | Click Save in the DeepSeek row |
| Skills menu shows a lock message ("Add your DeepSeek key in Settings first") | No DeepSeek key is saved | Follow the "Adding your DeepSeek key" steps above |
| Search gets stuck at the location step | Google Maps key is missing or wrong | Follow the "Adding your Google Maps key" steps above |
| The app shows a red "Backend unreachable" banner | The server isn't running | Start the server: build once with `pnpm --filter @autobroker/server build`, then run `node apps/server/dist/index.js` (or `pnpm demo` for the seeded demo). Run both from the repo folder. |

---

## Connecting Gmail

AutoBroker can read your dealer email replies and send follow-ups on your behalf.
Send mode is **buyer-by-default** (real send), but the shipped `.env.example`
starts you in safe **test** mode (a local fake mailbox); the TopBar toggle is
authoritative, and each real send still waits for your per-action approval. The Gmail
**backend is ready today**; the one-click **Connect Gmail** button in Settings is
still a placeholder ("Coming soon"), so for now you connect with a short one-time
command-line step.

Because Google requires you to set up your own access, this is the most involved
credential. The full click-by-click walk-through (create a Google Cloud project,
turn on the Gmail API, make a Desktop OAuth client, and run the one-line consent
command) is in **[CREDENTIALS_SETUP.md §5](CREDENTIALS_SETUP.md#gmail-oauth)**.

> One quirk to expect: while your Google project stays in "Testing" mode, Google
> expires the connection every **7 days**. When email actions stop working, just
> re-run the same consent command to reconnect — the guide explains how.
