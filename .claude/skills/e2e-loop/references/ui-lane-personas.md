# ui-lane-personas — PASS-A buyer subagent + per-tab frontend-taste cadence

Loaded at step 3 (PASS-A generation) and step 3.7 (frontend-taste sweep).
Do NOT load for `--light` runs or before the brand-picker has committed its picks.

---

## PASS-A buyer-subagent brief

Dispatch a Task subagent whose system prompt is:

> You are a **non-technical car buyer**. You have a car in mind, a metro, and a
> payment preference. You do not know what "skills", "workflows", or "slash
> commands" are. Type natural sentences into the chat the same way you would text
> a friend who works at a dealership. Never use a `/` prefix or a skill name.
>
> **You are GOAL-DRIVEN, not a script.** You are given ONE goal and a turn budget
> (e.g. *"get the lowest out-the-door on a Tucson Hybrid near Irvine, ideally
> under $41k; you have ~17 turns"*). Each turn YOU decide what to say next toward
> that goal. Follow these four rules (the τ-bench user-simulator design):
> 1. **Incremental disclosure.** Do not give away all your constraints at once;
>    reveal the metro, then the trim, then the budget only as the step needs it —
>    never a clean one-shot spec.
> 2. **No hallucination.** If asked for something you were not given (a VIN, a
>    stock number, a prior quote you never received), say you don't have it —
>    never invent it to be helpful.
> 3. **Explicit stop signal.** When your goal is met (you have the OTD you wanted)
>    or you decide to give up, emit `###STOP###` as your final line so the
>    orchestrator knows the arc ended.
> 4. **Your own words.** Never echo the goal text or a skill name back; phrase
>    every turn in this persona's voice, with its typos and register.

Feed the subagent the run's committed brand-picker output (persona, brand, city,
finance mode). Drive it toward its goal across up to **~17 turns** (one rough
intent per turn, in loose pipeline order) — PLUS **2-3 journey variations** drawn
from the rotation table below (record which ones in the report). The subagent is
NOT handed a 17-line script; it gets the goal + budget + the four rules above and
decides each turn itself. It may emit fewer turns if it hits `###STOP###` early
(goal met or gave up) — record the stop reason. Each message must be
accompanied by its expected-UI contract (schema below). The subagent hands both
to the main agent, which does the `browser_evaluate` verification.

**Key invariants for the subagent:**

- A correctly-rendered clarify or STOP is a **routing PASS** — count it as an
  exercised edge behavior. **But a routing-correct clarify can still be a UX
  FAIL.** For every clarify turn, run it through `frontend-taste` once: a
  dead-end "try rephrasing?" with no affordance is a usability finding, not a
  silent pass. Track routing-PASS in "edge behaviors hit"; track clarify-UX
  findings in the frontend-taste usability table.
- Gates render BEFORE prose (frontend-taste #4); for any gate-bearing message,
  assert the gate card paints first.
- Intake message expected outcome = **form opens** (email/phone/budget typed by
  hand) — never a silently-created profile. `follow_up_email`/phone/budget are
  excluded from freeform prefill (`intakeContracts.ts:11,43`).
- Tabbed Canvas: click `canvas-tab-<key>` BEFORE reading `canvas-panel-<key>`;
  only the active panel renders.
- Any `destructive: true` message: run the **decline path once** → assert
  `/__e2e/rows` delta = 0.

---

## Persona library (P1–P6) — brand-picker picks ONE per run; record it

### P1 — Impatient price-shopper
**Voice:** clipped, results-only, no pleasantries. Pushes for OTD/bottom-line.
**Sample:** `whats the best out the door price` · `just compare the quotes already`
**Router stress:** terse messages near the **0.6 confidence floor** → must clarify
rather than guess; "send the lowball to all of them" → **0.85 destructive
downgrade** on `negotiation_followup`.

### P2 — Cautious first-timer
**Voice:** hesitant, over-explains, asks permission, phrases actions as questions.
**Sample:** `can you maybe see what dealers are around me` · `is it safe to send this? I don't want to actually buy anything yet`
**Router stress:** question-shaped phrasing → `skill="none"` → clarify, no run.
Good surface for verifying decline = Δ0 on irreversible skills.

### P3 — Spreadsheet / returning power-user
**Voice:** confident, near-correct domain terms, batches intent, references prior
state ("the Tustin quote", "yesterday's search").
**Sample:** `run the full quote pipeline on my Tucson` · `compare finance vs lease OTD`
**Router stress:** explicit phrasing that routes confidently — the *contrast* to P1;
proves the router isn't defensive-clarifying everything.

### P4 — Trade-in haggler
**Voice:** negotiation-minded, mentions trade, fixated on concessions, competitive.
**Sample:** `tell the Phoenix dealer the Dallas one beat them by 800` · `counter their offer, I'm not paying that doc fee`
**Router stress:** `negotiation_followup` intent via NL + **budget-redaction**
invariant (a haggler naturally types a budget — verify it never renders on any
surface; CLAUDE.md inv #9).

### P5 — Lease-vs-finance-confused
**Voice:** genuinely uncertain about modes, conflates terms, mid-message self-corrects.
**Sample:** `is leasing or financing cheaper out the door` · `actually I think I want to lease, redo the compare`
**Router stress:** **off-mode quote surfacing** (FINDING J / A5) — cash & unspecified
folded into the right bucket; `quote_compare` cash bucket. Use a metro with multi-mode
quotes so "Compared 0" is impossible.

### P6 — ESL / terse texter
**Voice:** short, lowercase, dropped articles, occasional misspelling, sms register.
**Sample:** `find car dealer near me` · `compair quote pls` · `delete this search`
**Router stress:** typo robustness + **destructive-confidence downgrade**: bare
"delete this search" / "reset everything" in lowercase must degrade to the
`clarify-run-explicit` button — never a guessed `pipeline_reset` launch.

### P7 — Payment-buyer ($/month tunnel-vision)
**Voice:** frames EVERYTHING as a monthly payment; ignores OTD / selling price.
**Sample:** `i need this under 450 a month make that happen` · `whats the monthly on the tucson` · `can you get the payment down`
**Router stress:** **inv #9 keystone** — a monthly-payment ceiling IS a budget; it
must NEVER render on any surface, and the router must NOT silently convert "under
$450/mo" into a profile budget field. A clean direct probe of `_redact_budget`.

### P8 — Anxious / can't-afford-it
**Voice:** vague, seeks reassurance, conflates fear with questions, may **give up
mid-arc**.
**Sample:** `idk if i can even afford this with rates this high` · `is this gonna sign me up for anything im just browsing`
**Router stress:** pure-emotion turns → `none`→clarify (E1); the assistant stays
calm, does NOT over-promise and does NOT silently create a profile. The give-up
path (`###STOP###` before any skill runs) exercises empty-state / Canvas graceful
degradation. Realism anchor: 52% find car-buying more stressful than home-buying.

### P9 — Undecided cross-shopper (no vehicle picked)
**Voice:** has NOT chosen a car; names two models and asks which.
**Sample:** `rav4 or cr-v which is better` · `should i get the camry or the accord`
**Router stress:** **product-boundary probe** — AutoBroker is a QUOTE tool, not a
recommendation engine. Expected: clarify / redirect to "pin one vehicle to quote",
and it must **NOT fabricate a pick**. Exposes a boundary the P1–P6 rotation never
touched (every prior persona already knew its one car).

> **Behavior-axis vector (stochasticity knob).** A persona may also carry a drawn
> binary axis vector `{terse, skeptical, frustrated, ambiguous,
> incremental-disclosure, types-budget-unprompted}` so two "P1" runs are not
> identical. brand-picker draws the vector when it draws the persona; record it.

> **Persona + metro pairing note.** P5 (confused) needs multi-mode quotes — pick a
> CA/NY/WA metro (cap state) if you want a `DOC_FEE_CAP` flag; a TX/FL metro with a
> high doc fee now fires `DOC_FEE_UNCAPPED` instead (Phase 5 — uncapped states are no
> longer silent above ~$500). P4 (haggler) needs ≥2 dealers with differentiated OTD — the
> dealer-brain step already produces this.

---

## Journey variations — rotate 2-3 per run; record which

| # | Variation | Concrete shape | Expected outcome |
|---|---|---|---|
| J1 | **Typos / shorthand** | ≥2 messages with realistic typo or sms compression (`compair`, `dealrs`, `qoute`, dropped article) | Router classifies on intent, not surface spelling |
| J2 | **Ambiguous → clarify** | One message too vague to route (`do the thing`, `help me with this car`, `what now`) | `skill="none"` or confidence < 0.6 → clarify turn, NO run, NO `clarify-run-explicit` button |
| J3 | **Mid-flow correction → 2-active** | After intake, type `actually I want a RAV4 not a CR-V` | Routes to a second intake → 2nd active profile → `multiple_active_profiles` StopCard with vehicle-name picker |
| J4 | **Returns-next-day cold session** | New session id, immediately type `compare my quotes` | `pin_required` or `no_active_profile` STOP → `stop-pick-option` picker → one click persists session pin (run2 fix) |
| J5 | **Two things at once** | `find dealers near me and tell me whats in stock` | Router picks ONE skill; record which; note the unpicked intent for the frontend-taste "discoverable affordances" check |
| J6 | **Vague destructive (0.85 trap)** | `clear all this` / `start over` / `send it to everyone` | Clarify reason "…run it explicitly…" + `clarify-run-explicit` button (`router.ts:265-270`); then click — skill's OWN gate renders, nothing pre-approved |
| J7 | **Question-not-command** | `how much should I pay for this?` / `is this a good deal?` | `none` → clarify, calm assistant turn, no run |
| J8 | **Re-ask after clarify** | After any clarify, rephrase more directly | Second clearer message launches — proves clarify is recoverable, not a wall |
| J9 | **Multi-intent run-on** | `find dealers, get quotes, tell me which is cheapest, and is leasing better?` | Router picks ONE skill (`router.ts:273-279`); model-extracted `params` are deliberately dropped (`router.ts:143-148`) → assert the **dropped intents are acknowledged/told-back, not silently lost**. The most common real phrasing shape |
| J10 | **Type-while-running** | Send a skill message, then try to send a 2nd freeform message **before the first run reaches a terminal state** | **SOFT-BLOCK** (owner-resolved 2026-06-22): the composer is now disabled whenever a run is ACTIVE (running OR awaiting), so a typed message **cannot** spawn a concurrent run. Assert `chat-input-textarea` + `chat-send` are disabled while the run is `running` (the `runActive` prop drives `disabled`, `ChatRail.tsx:181`; pinned by `ChatRail.test.tsx`). A pass, not just an observation |
| J11 | **Paste a dealer email** | Paste a multi-line quote email into the chat rail | `dealer_reply_extract` reads the DB inbox, NOT pasted text → assert it does **not** mis-route there; if treated as intake prose, budget/phone must be stripped (inv #9) |
| J12 | **Stream-of-consciousness (150+ words)** | One rambling paragraph with budget, phone, trade-in buried inside | Assert intent extracted AND budget/phone stripped from intake prefill (inv #9; the freeform-prefill schema excludes email/phone/budget) |
| J13 | **Ignore the gate** | Open a gate, do NOT decide, click a Canvas tab, come back | Assert composer disabled while gate pending; gate stays pending and decidable; returning lets you decide normally |

---

## Per-message expected-UI contract schema

Every message the subagent emits must carry this block (feeds `browser_evaluate`
verification):

```
- persona: <P1..P6>
- message: "<exact freeform text, typos intact>"
- routes_to: <skillId | intake | clarify>
- expected_outcome:
    LAUNCH  → run starts (run_id present), terminal Done/Error,
              result in named Canvas tab (canvas-panel-<key>)
    CLARIFY → NO run; calm assistant turn; clarify-run-explicit button present
              IFF a destructive skill was detected, absent for bare none/low-confidence
    STOP    → run starts then STOPs; StopCard shows one PROFILE_STOP_CODE;
              for pin_required / no_active_profile / multiple_active_profiles
              a stop-pick-option picker is present
- canvas_region: <dealers | inventory | quotes | replies | incentives | overview | n/a>
- gate_expected: <none | approval-approve | batch-select-all+batch-submit |
                  reset-confirm-token+reset-confirm | hygiene-stage | trim-verify>
- destructive: <true|false>   # if true, run decline path once → assert Δ0
```

---

## E1-E10 NL-router edge behaviors — every run must hit all

The 2-3 journey variations must be chosen so the 17 messages cover all of these.
If the chosen persona doesn't naturally trigger one, add a targeted message.

| # | Edge behavior | Concrete trigger | Expected (source) |
|---|---|---|---|
| E1 | `none`→clarify (question/greeting/vague) | `is this a good deal?` / `do the thing` | Clarify turn, no run, NO `clarify-run-explicit` button (`router.ts:251,254`) |
| E2 | <0.6 confidence floor→clarify | `prices` / `the car` / `compair` alone | Clarify with candidate hint, no launch (`router.ts:259-263`) |
| E3 | 0.85 destructive downgrade | `clear all this` / `start over` / `send it to everyone` | Clarify "…run it explicitly…" + `clarify-run-explicit` button (`router.ts:265-270`, `AssistantTurn.tsx:108`) |
| E4 | run-explicit button → still gated | Click `clarify-run-explicit` after E3 | Skill's OWN typed-YES / approval / batch gate renders; nothing pre-approved |
| E5 | `pin_required` (1 profile, unpinned) | New session + `compare my quotes` | StopCard `pin_required`, `stop-pick-option` picker; pick once → session pin persists |
| E6 | `no_active_profile` (0 profiles) | Clean DB + `audit my quotes` | StopCard `no_active_profile` → points to intake |
| E7 | `multiple_active_profiles` (2-active) | After J3 mid-flow correction + `run the pipeline` | StopCard `multiple_active_profiles`, picker asks by vehicle name |
| E8 | Off-mode quote surfacing | P5: `show me cash too` / `compare finance vs lease vs cash` | Cash/unspecified folded into right bucket, no "Compared 0" (FINDING J/A5) |
| E9 | `no_lead_submitted` anchor | Ask `check my inbox` before any lead_submit | StopCard `no_lead_submitted` "submit a lead first" (`messageModel.ts:266`) |
| E10 | Re-ask recovery | After any clarify, rephrase directly | Second message launches — clarify is not a wall |
| E11 | Out-of-scope: financing advice | `can you finance this?` / `should i put more down` | `none`→clarify; assistant does NOT give loan advice or fabricate terms (product boundary) |
| E12 | Out-of-scope: ranking rationale | `why does this dealer rank #1?` | `none`→clarify or a calm explanation of the existing rank; NO new run, NO fabricated reason |
| E13 | Out-of-scope: trade-in / negative equity | `i still owe 4k on my trade, does that change anything` | `none`→clarify; gracefully "trade-in not handled" (boundary), NO run, no invented math |

The single happy-path naive-buyer generation reliably hits only LAUNCH. E1–E10 are the
under-exercised half that this persona+journey rotation is designed to cover.

---

## Per-tab frontend-taste invocation cadence (step 3.7)

Run this sweep **per data tab** after a skill with `Done` + badge count > 0 has
populated it. Empty tabs: one cheap empty-state read only (heuristic #7).

**Invoke the `frontend-taste` skill by name — do NOT re-paste its rubric here.**
One call per tab, fed only that tab's `browser_evaluate` output.

**Activate-then-read protocol (token-safe):**

1. `browser_click` on `canvas-tab-<key>` to make the panel active.
2. `browser_evaluate` the region — query the committed testids and visible
   text/attributes. **Never `browser_snapshot` the whole page.**
3. Pass the scraped output to one `frontend-taste` invocation.

Six tabs → six small reads, not one giant DOM.

| Tab | Activate | Read (key testids) | Tab-specific watch |
|---|---|---|---|
| overview | `canvas-tab-overview` | `canvas-feed`, `canvas-next-actions`, `canvas-summary-best-otd`, `canvas-summary-headline` | Plain-language copy; one-number-one-home vs digest line (FINDING G precedent) |
| dealers | `canvas-tab-dealers` | `canvas-dealer-tile`, `canvas-pager`, `canvas-dealers-empty`, `dealer-lead-submitted` | Pagination past 12; empty-state actionable; rank/distance legible |
| inventory | `canvas-tab-inventory` | `inventory-candidate-row`, `inventory-listing-link`, `canvas-pager`, `inventory-empty-hint` | **#1 load-bearing:** `inventory-listing-link` `<a target=_blank rel=noopener>` present; scanned-0 vs never-scanned copy (A2) |
| quotes | `canvas-tab-quotes` | `canvas-quotes-foldout` (`<details>`), `quote-audit-pill-<code>` | Audit pills on off-mode quotes in foldout (FINDING C); no budget number |
| replies | `canvas-tab-replies` | `canvas-thread-row`, `thread-class-chip`, `message-extract-failed-badge`, `canvas-pager`, `canvas-threads-empty` | Pagination at 10/page; relative-date copy; failed-extract badge legible |
| incentives | `canvas-tab-incentives` | `canvas-incentive-row`, `-type`, `-amount`, `-eligibility`, `-expiry`, `-source`, `canvas-incentives-empty` | Provenance readable; empty-state actionable; **no Pager today — watch for unbounded list** (`Incentives.tsx:92`; pending backlog item) |

**Cross-cutting (judge once, not per tab):**

- Destructive gates render BEFORE prose: `hygiene-review-card`, `gate-*`,
  `stop-pick-option`, `reset-confirm`, `approval-approve`. Gate names blast radius
  in plain words.
- Workbench layout is ONE always-on split (there is NO canvas/chat MODE toggle —
  no `topbar-mode-canvas`/`topbar-mode-conversation`): drag `rail-resizer` (the
  rail's left boundary), confirm the width persists + re-clamps, Canvas reflows at
  narrow and wide.
- Top-bar right cluster: the app-mode LAMP (`mode-toggle` — ONE `role=switch`,
  GREEN=buyer / AMBER=test via `data-mode`/`aria-checked`; clicking flips, but
  switching TO buyer still opens the `mode-confirm-*` danger dialog — never auto-arm)
  + the settings GEAR (`topbar-settings` now POPS UP `settings-overlay`, suppressed
  on the `/settings` route — it does NOT navigate). The 巡检 pins `AUTOBROKER_MODE`
  via env, not by clicking the lamp.
- Rail header pinned title: when a search is pinned the title IS the search identity
  (`rail-pin-title` → vehicle + ZIP, with `pin-chip-label`/`pin-chip-unpin`), not the
  skill name. It is a profile-data surface, so the budget-never-leaks check applies
  here too.
- Budget never leaks: only the "internal-only" lock chip is permitted; any budget
  number is a BLOCKER (CLAUDE.md inv #9).
- Two-active-profile switcher: if ≥2 active profiles exist, verify both are
  reachable from the Canvas surface (`Canvas.tsx:435` currently shows only `[0]`
  — this is an open MED backlog item; flag if it traps the buyer).

**frontend-taste emits a ranked `[SEVERITY] <testid> — <experience> (file:line).
Suggested direction:` list per tab.** The loop folds these into the S0 enumeration
(backlog state machine step 4) and the report's "frontend-taste 可用性发现" table.
BLOCKER/HIGH → fix this round; MED/POLISH → "本轮新 backlog".
