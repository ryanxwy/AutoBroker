# Data Handling

AutoBroker is a **local-first, single-user** tool. This document describes what
data the app accesses, where it is stored, when it leaves the machine, and how
to delete it.

---

## What data is accessed

| Data type | Source | How accessed |
|---|---|---|
| Gmail inbox + send (dealer replies, attachments, outbound follow-ups) | The user's own Gmail account | Via Google's Gmail API using a BYO OAuth2 credential. Four scopes are authorized: `gmail.readonly`, `gmail.send`, `gmail.modify`, `gmail.labels`. Send/modify/labels **capability** is granted but never **used** without a per-action human approval — every real send is L2-gate-blocked and only fires in `buyer` mode. |
| Dealer contact information | Auto-populated from geosearch (Google Maps) and dealer websites | Stored locally in the product database. |
| Dealer quotes and negotiation threads | Extracted from Gmail by the LLM extraction skill | Stored locally. |
| LLM API keys | Provided by the user in Settings or `.env` | Stored locally in the OS keychain or `.env` file. Never committed to the repository. |

---

## Where data is stored

All application data is local to the user's machine:

- **Product database:** `~/.autobroker-ts/autobroker.db` (SQLite, controlled by
  `AUTOBROKER_DATA_DIR`).
- **Mastra runtime state:** `~/.autobroker-ts/mastra.db` — workflow snapshots,
  session memory threads, and durable suspend/resume state. Separate from the
  product DB.
- **OAuth tokens:** The Google OAuth2 refresh token lives only on the local
  machine (path configured during Gmail setup). It is never committed.
- **API keys:** Stored in the local `keys.json` (the UI-canonical store) or in
  a local `.env` file. Both are in `.gitignore` and are never sent anywhere by
  the app itself.

The app does **not** operate a cloud backend, does not phone home, and does not
transmit any of the above to any server other than the configured LLM provider
(see below).

---

## When data leaves the machine

Content leaves the machine at these egress points:

**1. LLM extraction (always).** The LLM-backed skills — chiefly
`dealer_reply_extract` — send dealer reply text and prompts to the configured LLM
provider for parsing:

- **Default provider: DeepSeek** — your inputs, prompts, and dealer reply
  content are sent to `api.deepseek.com`, stored on servers in the People's
  Republic of China (PRC), and may be used to train DeepSeek's models. See the
  [Privacy section in README.md](../README.md#privacy--read-before-configuring-providers)
  for the full disclosure and opt-out instructions.
- **Alternative providers: Anthropic, OpenAI** — switching to either of these
  routes LLM calls to Western-operated infrastructure. Each provider has its own
  privacy policy and data-retention terms; review them before choosing.

**2. Outbound email to dealers (`buyer` mode only).** In `buyer` mode the send
skills (`negotiation_followup`, `dealer_closeout_email`, and the
`dealer_web_lead_submit` email fallback) send real email from the user's own
Gmail account via the `gmail.send` scope — each one behind a per-action L2
human-approval gate. In `test` mode these resolve to a local fake mailbox and
nothing leaves the machine.

**3. Dealer web-form submits (`buyer` mode only).** In `buyer` mode
`dealer_web_lead_submit` submits a lead form on a dealer's website via the
Playwright browser, again only after a per-action human approval. In `test` mode
the submit is faked and never touches the dealer site.

**4. Maps geosearch + public website reads.** `dealer_geosearch` queries Google
Maps to locate in-radius dealers, and the scan skills (`inventory_site_scan`,
`incentive_scrape`) read public dealer / manufacturer web pages. These are
read-only lookups tied to the vehicle and dealers being researched.

---

## Google API Services User Data Policy

AutoBroker uses Google's Gmail API to read email from — and, in `buyer` mode,
send follow-up email from — **the user's own** Gmail account. It is not a
multi-tenant service:

- The four Gmail scopes requested are `gmail.readonly`, `gmail.send`,
  `gmail.modify`, and `gmail.labels`. Send/modify/labels are exercised only
  behind a per-action human-approval gate, and only in `buyer` mode.
- Gmail content is read locally and passed to the configured LLM provider for
  extraction (see above).
- OAuth tokens are stored only on the user's local machine.
- The app does not operate a server that stores users' Gmail credentials or
  messages.

Use of data obtained from Google APIs complies with the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).

---

## How to delete local data

To remove all locally stored application data:

```bash
rm -rf ~/.autobroker-ts/
```

This removes the product database, Mastra runtime state, logs, and any cached
configuration. It does not revoke the Gmail OAuth token (do that from your
[Google Account permissions page](https://myaccount.google.com/permissions)) or
delete your LLM API keys from the provider's dashboard.
