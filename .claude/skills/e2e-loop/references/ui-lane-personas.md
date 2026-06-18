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

Feed the subagent the run's committed brand-picker output (persona, brand, city,
finance mode). Have it emit **17 freeform natural-language messages** — one per
skill, in rough pipeline order — PLUS **2-3 journey variations** drawn from the
rotation table below (record which ones in the report). Each message must be
accompanied by its expected-UI contract (schema below). The subagent hands both
to the main agent, which does the `browser_evaluate` verification.

**Key invariants for the subagent:**

- A correctly-rendered clarify or STOP is a **PASS** — count it as an exercised
  edge behavior, not a miss. Track these in the report's "edge behaviors hit"
  column.
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

> **Persona + metro pairing note.** P5 (confused) needs multi-mode quotes — pick a
> CA/NY/WA metro if you also want a `DOC_FEE_CAP` flag (TX/FL metros won't flag; that
> is correct behavior). P4 (haggler) needs ≥2 dealers with differentiated OTD — the
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
- Chat rail resizer: drag `RailResizer`, confirm width persists, Canvas reflows at
  narrow and wide.
- Budget never leaks: only the "internal-only" lock chip is permitted; any budget
  number is a BLOCKER (CLAUDE.md inv #9).
- Two-active-profile switcher: if ≥2 active profiles exist, verify both are
  reachable from the Canvas surface (`Canvas.tsx:435` currently shows only `[0]`
  — this is an open MED backlog item; flag if it traps the buyer).

**frontend-taste emits a ranked `[SEVERITY] <testid> — <experience> (file:line).
Suggested direction:` list per tab.** The loop folds these into the S0 enumeration
(backlog state machine step 4) and the report's "frontend-taste 可用性发现" table.
BLOCKER/HIGH → fix this round; MED/POLISH → "本轮新 backlog".
