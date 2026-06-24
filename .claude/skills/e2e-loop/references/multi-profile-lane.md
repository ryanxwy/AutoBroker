# multi-profile-lane — step 3.9 reference

Runs AFTER the pinned single-brand pass (steps 3/3.5) reaches terminal+green.
The pinned lane is frozen and first; step 3.9 never runs concurrently with it.

---

## WHEN

Only start once the pinned pass is terminal+green (rulings #4/#7). The pinned
single-brand spine stays the primary 全技能巡检 pass; 3.9 is an additional
escalating-chaos validation layer driven after it finishes.

---

## SEED

Use the `multiActive` fixture (`harness/fixtures/states/multiActive.ts`) to
seed a **different-brand** world — e.g. Accord + Camry + Mazda6 — with multiple
active profiles. Loop `POST /__e2e/inject_replies` per active `profileId`, each
time passing a **shared `dealer_key`** that maps to a serve-live B2 dealer
(`live-dealer-<key>`, status `'candidate'`) so all profiles compete for the same
real rooftop. This forces a genuine cross-profile dealership collision where
`claimDealer` must pick a winner.

---

## ASSERT — collision

After the interleaved skill runs, verify via `/__e2e/rows` + the product DB:

- **Exactly one profile** binds the rooftop (`threads.dealer_status = 'claimed'`
  or `bound`).
- **Every other profile** that tried the same rooftop gets `'conflict'` →
  `'excluded_conflict'` with a non-null `exclusion_reason` and `heldByVehicle`
  surfaced to the user.
- **ZERO web-form sends** and **ZERO email sends** for the losing profile(s)
  (`/__e2e/audit` Δ0 on send actions for losers).
- An engage-then-abort sequence releases the lock (no permanent claim left
  behind after an aborted flow).

---

## ASSERT — metamorphic invariants

After each interleaved step call `runAllInvariants` from
`harness/soak/multiprofile/invariants.ts`. The invariants checked:

| invariant | description |
|---|---|
| dealership exclusivity | one rooftop bound to at most one profile |
| budget-never-leaks | `_redact_budget` — budget absent from all dealer-facing sends (#9) |
| follow-up cap | no profile exceeds `MAX_UNANSWERED_FOLLOWUPS=2` consecutive ghost FUs |
| L2-gate-before-send | every outbound send preceded by a human-approval gate event |
| profile-ASK 1/0/2 | resolver stops at 0 or 2+ active (profile-ASK contract) |
| monotonic best-OTD | per-profile best OTD never increases across rounds |
| zero cross-profile bleed | no message, quote, or thread row references the wrong `search_profile_id` |
| historyId continuity | no profile's inbound `historyId` skips a message (all replies discovered) |

A failing invariant freezes the run immediately (see CHAOS below).

---

## REPRODUCIBILITY

One seeded PRNG drives the **skeleton**: which profiles run, reply ordering, and
the ghost/chaos schedule. The Sonnet dealer (`dealer.md` via `spawnClaudeAgent`)
writes reply bodies at temperature > 0 — the prose is non-deterministic. The
SUT's LLM calls are captured through the **record/replay seam**:

- `AUTOBROKER_RECORD_TRANSCRIPT=<path>` — record a live run's LLM traffic to a
  JSONL file.
- `AUTOBROKER_REPLAY_TRANSCRIPT=<path>` — replay from that file with **no
  provider call** (fully deterministic, zero cost).
- `pnpm soak mp-replay` — replay the frozen corpus cases one by one; used as the
  deterministic gate (no provider needed).

---

## CHAOS

`pnpm soak mp --until-dry` starts small and **escalates per round**: more
ghosting, bad-faith concessions/raises, "send me your budget" probes
(dealer-side aggression directive from `harness/soak/multiprofile/chaos.ts`
`aggressionDirectiveText`), more concurrent profiles, and dealer-group
collisions that pit more profiles against the same rooftop.

On any `runAllInvariants` violation the soak runner **freezes immediately**:
it writes the seed, the JSONL transcript, and the chaos config into a new case
directory under `harness/multiprofile-corpus.txt` as a deterministic,
no-provider replay case. The sync trap applies: a case directory and its
manifest line in `harness/multiprofile-corpus.txt` live and die together — never
delete one without the other.

---

## DETERMINISTIC GATE

`pnpm soak mp-replay` (and the `green.sh` `freeze.test.ts` vitest suite)
re-run every frozen corpus case with **no provider**, forever after. A case is
only removed from the corpus when the underlying invariant violation is proven
fixed and the replay passes clean.
