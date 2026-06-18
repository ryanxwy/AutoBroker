# Data Handling

AutoBroker is a **local-first, single-user** tool. This document describes what
data the app accesses, where it is stored, when it leaves the machine, and how
to delete it.

---

## What data is accessed

| Data type | Source | How accessed |
|---|---|---|
| Gmail inbox (dealer replies, attachments) | The user's own Gmail account | Read-only, via Google's Gmail API using a BYO OAuth2 credential. No write access is requested. |
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

The only time private content leaves the machine is when the LLM extraction
skill (`dealer_reply_extract`) sends dealer reply text to the configured LLM
provider for quote parsing:

- **Default provider: DeepSeek** — your inputs, prompts, and dealer reply
  content are sent to `api.deepseek.com`, stored on servers in the People's
  Republic of China (PRC), and may be used to train DeepSeek's models. See the
  [Privacy section in README.md](../README.md#privacy--read-before-configuring-providers)
  for the full disclosure and opt-out instructions.
- **Alternative providers: Anthropic, OpenAI** — switching to either of these
  routes LLM calls to Western-operated infrastructure. Each provider has its own
  privacy policy and data-retention terms; review them before choosing.

The Gmail API OAuth credential is used only to read emails from the user's own
account. Gmail content is **not** forwarded to Google beyond the scope of the
normal Gmail API read call.

---

## Google API Services User Data Policy

AutoBroker uses Google's Gmail API to read email from **the user's own**
Gmail account. It is not a multi-tenant service:

- Only the minimum required Gmail scopes are requested (read-only inbox access).
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
