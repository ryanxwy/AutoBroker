# seasoning.md — LLM-driven edge-case discovery (step 6.5)

The half of `e2e-evolve` that uses an LLM to **find the realistic, messy, adversarial
edges a deterministic test cannot manufacture**, and to fold the winners back into the
runner. Loaded at step 6.5. Two jobs: (1) **pair** each fix with a seasoned case; (2)
**generate → soak → triage** a bounded discovery pass.

> **The one rule that governs everything here (do not weaken):** LLM seasoning is the
> *discovery + realism* layer. It rides **ON TOP** of the deterministic floor and **never
> replaces** a `*.func.toml` / forced-fault gate. A bug seasoning surfaces is fixed through
> the SAME full gated machine (`references/fix-machine.md`). The deterministic floor only
> ever GROWS (via graduation-down). This is the safe reading of "prefer LLM seasoning over
> deterministic unit cases": prefer it for *finding edges and reproducing reality*, not for
> *gating merges*.

## Job 1 — pair each shipped fix with a seasoned case

Already specified in `references/fix-machine.md` ("fix → seasoned-case PAIRING rule"):
deterministic-AND-seasoned, never OR. Recap of where a seasoned case is registered:

- a **behavior-axis** on a persona — `e2e-loop/references/ui-lane-personas.md` (the P1–P9
  library + the drawn behavior-axis vector `{terse, skeptical, frustrated, ambiguous,
  incremental-disclosure, types-budget-unprompted, …}`);
- a new **`J##` journey variation** (the J1–J13 table) — a messy multi-turn arc;
- a new **`E##` router edge** (the E1–E13 table) — an under-exercised NL-router branch;
- a **dealer archetype / behavior** — `e2e-loop/references/dealer-brain.md` (the resistant
  archetype mix, ghosting/reverse-induce schedule).

Each seasoned case carries: the spawning **PIC/commit** tag, a **falsifiable expected
outcome** (a live `/__e2e` rows/audit/dataquality delta or a DOM/testid assertion), and the
**invariant it stresses** (e.g. inv #9 budget-redaction, #1244 fail-closed, profile-ASK).
It runs **ADVISORY** in the next `/e2e-loop` (it never blocks CI).

## Job 2 — the generate → soak → triage discovery pass

A bounded round that actively hunts for edges the runner doesn't currently hit. Keep it
SMALL (a handful of candidates per round, not a full 17-skill journey).

### (1) Generate — two adversarial LLM generators

Dispatch an **adversarial-buyer** generator and an **adversarial-dealer** generator. Seed
EACH with:

- the existing library (personas / journeys / router edges / dealer archetypes), so it
  produces something NEW rather than a dup;
- the **new-feature surfaces** this session touched (the testids / routes / dataquality
  fields the fixes added);
- the runner's **known-correct list** (`e2e-loop/references/recording.md`) + the
  harvest-register's realized tail, so it **never re-proposes settled behavior**.

Each generator emits **N candidate edges**, each as `{ description, the messy/adversarial
input or dealer behavior, a falsifiable expected-outcome contract, the invariant it
stresses }`. Bias toward inputs a planted fixture cannot reproduce: live-LLM pages, live
dealer replies, real buyer phrasing, cross-profile collisions.

### (2) Soak — bounded, against a fresh serve-live

Run the handful of candidates against a **fresh serve-live** (isolated tmp DB,
`AUTOBROKER_MODE=test`, **gates live** — never `AUTOBROKER_TEST_AUTO_APPROVE`). This is a
bounded soak, NOT a full journey. Drive each candidate via the same browser/inject control
routes the runner uses; record the live `/__e2e` deltas / DOM against its contract.

### (3) Triage — WINNER / HARDENER / DUD

- **WINNER** (a real bug surfaced) → file a three-bucket entry (blocker / backlog) and fix it
  through the **full gated fix-machine** (`references/fix-machine.md`: research → minimal fix
  in a worktree → fresh-context APPROVE/SAFE → `RUN_UI_FUNCTIONAL=1` green → fresh serve-live
  re-verify → merge), which itself produces a deterministic regression + a paired seasoned
  case. Discovery gets **no shortcut to merge**.
- **HARDENER** (passed, but the edge is real and worth keeping) → promote the candidate into
  the runner library (a persona axis / journey / archetype) as an advisory seasoned case.
- **DUD** (not real / already covered / over-fit) → discard. **Count it** — a `log`-style
  tally of DUDs is honest coverage data, not noise.

Record the round's WINNER/HARDENER/DUD tally in the evolve-report's **Seasoning coverage**
section (`references/evolving.md` step 7).

## First candidates (seed the first discovery round with these)

Drawn from this round's research (the A4 / F-series seeds) — author them as seasoned cases:

**Messy-buyer axes** (adversarial-buyer):

- **trim-as-marketing-name** — the buyer names a trim by feel, not the spec name: "the one
  with leather and the big screen", "the Tech trim", "the sport-looking one". Stresses the
  intake trim-suggestion picker + `sanitizePrefillTrim` (a non-trim qualifier must NOT seed a
  bogus trim, the web-grounded picker must fire).
- **budget-as-monthly / down / trade-equity** — "keep me under $450/mo", "I've got $5k down",
  "I still owe $4k on my trade". Stresses inv #9: a monthly/down/equity figure IS budget — it
  must NEVER render on any surface and must not silently become a profile budget field.
- **contradict-mid-message** — "I want a RAV4… actually make it a CR-V, no wait the hybrid".
  Stresses the 2-active / mid-flow-correction path (`J3` / `E7`) and the profile-ASK picker.

**Adversarial-dealer behaviors** (adversarial-dealer):

- **wrong-vehicle-binding on the negotiation card** — a dealer reply that references a
  DIFFERENT model/trim than the profile's, or a shared CRM relay bound to ≥2 rooftops.
  Stresses same-source routing attribution (the negotiation card must not bind a quote to the
  wrong dealer; see the harvest-register `PIC-20260625-1/-2` routing items).
- **HTML-only reply through the LIVE extract path** — a dealer reply that is HTML-only (no
  text/plain part) carrying an itemized OTD. Stresses the `stripHtmlToText` recovery + the
  `dealer_reply_extract` extraction so the OTD is not silently lost (the buyer-email-probe
  proved this is a real failure class; season it on the live extract path).
- **budget-verbatim / self-contradicting OTD / competitor-name in the body** — a reply that
  embeds the buyer's budget verbatim, or quotes $42k then "$44k out the door", or names a
  competing dealer. Stresses the negotiation-summary `assertNoBudget` belt + the
  no-competing-name redaction + summary coherence (lens 14).

## Over-fit & flakiness guards (load-bearing)

- **Never bias the brand-picker / `METRO_FIXTURES` to force a past fix's metro to fire.** The
  held-out brand/metro randomness IS the generalization guard (`evolving.md`). Use
  **CONDITIONAL** seasoned probes instead: "assert cross-border exclusion ONLY when a border
  metro is independently drawn", "assert the markup modal ONLY when a flagged-markup row is
  present". A seasoned case must generalize to the next random buyer, not over-fit this run.
- **Seasoned/LLM checks are ADVISORY and never block CI** (same posture as `frontend-taste`).
  Back every safety claim with a deterministic surface: assert PRESENCE of a resolved element
  (not LLM prose equality), assert a hard `/[0-9]/` budget absence (vacuously safe on a clean
  run), prove #1244 recovery with a COUNTED forced fault rather than waiting for a rare organic
  malform.
- **#1244 is request-shape/mixing-triggered, not content-triggered** (the 2026-06-04
  107-call probe): do NOT try to engineer a malformed tool call from a dealer email's content
  — a content payload cannot deterministically force #1244. Season the *recovery contract*
  (fail-closed-then-auto-recover, 2 deepseek rows, no retry button), not a content exploit.
