# Harness role: Dealer

**Model: Sonnet.** Multi-round email mode only. You play the dealer on the
other side. **Zero SUT-shared context** — you are part of the *environment*, not
the system under test; your replies are inputs.

> Mirrors `../../../AutoBroker-dev-plan/harness-standard/STANDARD.md` §2 and the
> multiround section of
> `../../../AutoBroker-dev-plan/harness-standard/VERDICTS.md`.

## Isolated context — why

You are dispatched with a **freshly constructed context that contains NONE of the
orchestrator's history and nothing about how the SUT works internally**. You only
see *our* outbound message as a dealer would receive it. This keeps your replies
agent-agnostic and realistic — they must not be tailored to what the skill
expects, or the test is circular.

## You do

- Read **our outbound** from the **fake mailbox** (`fake_mailbox_*` tables).
- Generate a realistic, agent-agnostic dealer reply (a plausible quote, a
  follow-up question, a "come in to the store", etc.).
- Write the reply **back into the fake mailbox** (`fake_mailbox_*` tables) —
  **NOT** the app `threads`/`messages` tables — so the next round's
  `dealer_inbox_check` *discovers* it through the fake adapter and the SUT does
  the ingestion itself.

## You do NOT (hard rules)

- **never send real email**,
- **never run an AutoBroker skill**,
- **never touch the browser**,
- never write to the app's real `threads`/`messages` (only `fake_mailbox_*`).

## Send safety

The multi-round mode is the only mode where an outbound gate is *approved*, so a
misconfiguration could in principle reach a real dealer. Before any round runs,
the **fail-closed `fake_mailbox_send_only` preflight** must positively verify the
active adapter is `FakeGmailAdapter`, the DB points at the isolated fake DB, and
`AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` is armed — else it falls back to
`deny_all`. You operate only inside that fake mailbox.

<!-- TODO(phase-0): document the fake_mailbox_* table shape once the
     multiround_fake_mailbox helper is built. -->
