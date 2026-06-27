# buyer-email-probe.md — optional read-only buyer-mode Gmail probe

**Scope:** an owner-run, standalone script that validates the REAL Gmail I/O layer
end-to-end without sending anything. It complements the 17-skill e2e journey but is
separate from it — not a replacement and not part of `green.sh`.

---

## What this probe validates that the test-mode journey cannot

The serve-live 17-skill journey is hard-pinned to `AUTOBROKER_MODE=test` at boot
(`NODE_ENV=test → forceTestMode → assertTestModeSafe`). In test mode every send goes
to the fake mailbox — the real Gmail adapter is never exercised. That means the
journey is permanently blind to:

- OAuth token refresh against the real Google token endpoint
- Real `messages.list` search (quota, pagination, filter syntax)
- Real multipart MIME parse, including the **HTML-only path** where the email carries
  only a `text/html` part and `mapMessage` must recover `bodyText` from
  `stripHtmlToText(bodyHtml)` (the adapter fix on this branch)
- Real attachment download + `extractAttachmentText` over actual bytes
- The real `getCurrentHistoryId` watermark (the full-resync anchor for inbox sync)

The zero-network real-MIME regression suite in `green.sh` guards the HTML-only
recovery path deterministically in CI. But it runs against synthetic MIME fixtures —
it cannot confirm the live Gmail API returns the expected shape. The probe does.

---

## How to run

Build first (imports resolve to built `@autobroker/tools` dist):

```bash
pnpm -r build
pnpm e2e:buyer-email-probe           # defaults to 365-day window
pnpm e2e:buyer-email-probe 90        # optional: windowDays argument
```

On success the probe writes one JSON object to **stdout** and progress notes to
**stderr**:

```json
{
  "account": "<mailbox@example.com>",
  "window": 365,
  "matched": 42,
  "scanned": 20,
  "withBodyText": 19,
  "attachmentsParsed": 3,
  "deterministicQuoteSignals": 5,
  "currentHistoryId": "12345678"
}
```

`withBodyText` counts messages whose `bodyText` is non-empty after `mapMessage`; it
is the closest proxy for HTML-only recovery available from the `Message` struct (the
HTML-only path populates `bodyText` when the `text/plain` part is absent, but the
field cannot distinguish that case from a normal text-part message).

Exits non-zero on any unrecoverable failure. Never writes to the product DB.

**Owner-run only.** Do NOT add to `green.sh`. Do NOT run in CI.

---

## Safety envelope

| Property | Value |
|---|---|
| Sends | **none — structurally impossible.** `ReadOnlyGmailAdapter` wraps the real adapter; its `send()` unconditionally throws with no condition, no env flag. The probe never imports the send seam. |
| HTTP route | **none.** It is a standalone `node` script — not serve-live, not the product server. The boot-only `assertTestModeSafe` tripwire has no runtime PUT-/api/settings/env flip vector. |
| Pre-flight | `assertReadProbeEnvelope()` is fail-closed: (1) refuses if `isHarnessContext()` is true (NODE\_ENV=test / AUTOBROKER\_HARNESS=1 / AUTOBROKER\_HARNESS\_FIXTURE=1); (2) refuses if the data dir is under the production `~/.autobroker` tree; (3) refuses if the token record is absent or has no account. |
| Mode | `AUTOBROKER_MODE=buyer` set explicitly in the script before any adapter call. |
| Auto-approve | `AUTOBROKER_TEST_AUTO_APPROVE` is **never set** (CLAUDE.md inv #11). |
| Data dir | `~/.autobroker-ts` (isolated parity tree, not production). |
| Leg B | Deterministic by default: `classifyMessageQuoteClass` + `parseQuoteFromBody` — no LLM, no network egress of mailbox content. |

---

## Honest limits

- **Reads the operator's own real mailbox** (owner-authorized via the stored OAuth
  token). The Google account that authorized the token is the one whose inbox is read.
- **Leg B is deterministic and offline.** No LLM is called and no mailbox content
  leaves the machine. A future opt-in LLM extraction leg would egress mailbox content
  to the configured provider (DeepSeek by default — the README PRC data-storage
  disclosure applies). That leg is **not** enabled by default.
- **Does NOT exercise the real send path.** The owner chose read-only; a full
  send+receive self-test (e.g. send a test email to yourself and confirm receipt) is a
  documented future opt-in and is not part of this script.
- **Consumes real Gmail read quota.** The sample cap (`MAX_SAMPLE = 20` threads) bounds
  the impact; for most mailboxes this is negligible.
- The HTML-only regression coverage is guarded deterministically by the zero-network
  real-MIME suite in `green.sh` (`packages/tools/src/gmail/adapter.realmime.test.ts`).
  The test-mode journey remains blind to HTML-only messages until a future
  fake-seed-HTML-only option lands in the serve-live host.

---

## How findings flow into the e2e-loop report

Probe findings slot into the runner's **three-bucket** scheme exactly like any other
journey finding — use the same classification criteria from `SKILL.md` ("How to
classify what you find"):

- A missing or broken real-read capability (e.g. `health ok: false`, zero `withBodyText`
  when the mailbox is known to have HTML-only emails, attachment download fails on
  every message) → **BLOCKER** or **BACKLOG** depending on whether it blocks the
  buyer journey.
- A lower-than-expected `deterministicQuoteSignals` ratio → **BACKLOG** with a
  falsifiable fix idea.
- Minor cosmetic output oddity → **POLISH**.

Mirror backlog items to `harvest-register.md` (semantic dedup, bump recurrence on
re-discovery) so `e2e-evolve` picks them up. Use the same `evidence_ref` shape:
`probe-<date>` + the JSON coverage object as the snapshot.

The probe is **not** a journey step in the main 17-skill spine, so its findings do not
appear in the `逐技能表` per-skill table. Record them in a separate **"Buyer-email
probe"** sub-section inside **本轮发现** when the probe was run this session.
