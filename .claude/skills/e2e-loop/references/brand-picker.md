# brand-picker — step 2.5 random profile recipe

Loaded at step 2.5 only. Make and record four decisions: **metro, vehicle,
finance mode, persona**. Log them before PASS-A begins.

**`--light` mode (pin-or-bootstrap):** if serve-live already has a profile, PIN
it and skip the random pick. If its DB is empty (a fresh serve-live has 0
profiles — nothing to pin), do a **minimal intake first to bootstrap ONE
profile** (a quick metro+vehicle+persona pick below + a manually-typed email);
this also exercises the intake skill live. Either way, log the picks.

---

## 1. Metro — MUST be in METRO_FIXTURES

The geocoder is hermetic (no Geocoding entitlement). `resolveMetro` matches
`location_query`: (1) ZIP `\b\d{5}\b`; (2) city-name substring; (3) **silent
fallback to Irvine**. Nothing errors on fallback — the run just silently
searches Irvine.

**THE TRAP:** `location_query` must contain the whitelisted city name or its
ZIP (e.g. `"Dallas, TX 75201"`). A state abbreviation alone or a misspelled
city falls through silently.

Leave **search radius blank** — intake defaults to 125 mi.

**METRO_FIXTURES** (19 metros; keep in lock-step with `serve-live.mjs`):

Irvine 92602 · Los Angeles 90012 · San Diego 92101 · Dallas 75201 ·
Houston 77002 · Austin 78701 · Phoenix 85004 · Denver 80202 · Seattle 98101 ·
Portland 97204 · Chicago 60601 · Atlanta 30303 · Miami 33130 · Tampa 33602 ·
Charlotte 28202 · Nashville 37203 · New York 10007 · Philadelphia 19107 ·
Boston 02110.

**DOC_FEE_CAP / DOC_FEE_UNCAPPED note.** `quote_audit` fires `DOC_FEE_CAP` for an
over-cap doc fee in a **capped** state (CA/NY/WA + MN/MI/OH/MD). As of Phase 5 an
**uncapped** state (TX/FL/OR…) is no longer silent: a doc fee over ~$500 fires the
new `DOC_FEE_UNCAPPED` flag. So pick a CA/NY/WA metro (Irvine/LA/San Diego/New
York/Seattle) for the cap path; a TX/FL metro with a high doc fee now exercises the
uncapped path instead of producing nothing.

---

## 2. Vehicle

Rotation pool (avoid repeating the prior run's pick — check the last report):

Toyota RAV4 · Honda CR-V · Toyota Camry · Honda Accord · Hyundai Tucson ·
Hyundai Elantra · Kia Sportage · Subaru Outback · Mazda CX-5 · Ford Escape ·
Chevrolet Equinox · Nissan Rogue · Volkswagen Tiguan · Tesla Model 3 ·
Toyota Corolla.

Year: current or current+1. A trim mismatch surfaces as a trim-verify HITL
gate — that is a pass, not a bug.

---

## 3. Finance mode

`finance` / `lease` / `cash`. For persona P5, start with `finance` and let the
persona request all three modes mid-sweep to exercise off-mode surfacing
(edge behavior E8 defined in `ui-lane-personas.md`).

---

## 4. Persona — ONE of P1–P9

Full definitions, voice, stress, and the E1–E13 edge-behavior table live in
`references/ui-lane-personas.md` — do not redefine here. Record the persona ID
(and, if drawn, the behavior-axis vector) in the report.

| Persona | Stress exercised |
|---|---|
| P1 impatient price-shopper | terse → 0.6 floor; 0.85 destructive downgrade |
| P2 cautious first-timer | question-shaped → `none`→clarify; gate-before-prose |
| P3 spreadsheet power-user | explicit phrasings prove router not over-clarifying |
| P4 trade-in haggler | negotiation NL; budget-redaction inv #9; use ≥2-dealer metro |
| P5 lease-vs-finance confused | off-mode surfacing E8; all three finance modes |
| P6 ESL/terse texter | typo robustness; destructive downgrade |
| P7 payment-buyer | $/mo tunnel-vision; inv #9 (monthly cap = budget, never render) |
| P8 anxious/can't-afford | emotion→`none`→clarify; give-up→empty-state graceful |
| P9 undecided cross-shopper | product boundary: quote tool not recommender; no fabricated pick |

Buyer email: `<firstname>.buyer@example.com`. Phone is fake-by-default (inv #9).

---

## 5. Optional: 2nd active profile (2-active branch)

To exercise `multiple_active_profiles` (edge behavior E7 in
`ui-lane-personas.md`), intake a second profile with a different vehicle.
Cheapest path: mid-sweep the persona says "actually I want a RAV4 not a CR-V"
(journey variation 3).

---

## 6. Record picks before PASS-A (reproducibility anchor)

Log in the report's "本轮随机选择" section and TodoWrite:

```
metro:    <city>, <state> <ZIP>
vehicle:  <year> <brand> <model> <trim>
finance:  <finance | lease | cash>
persona:  <P1–P9>
email:    <buyer email>
2nd profile (opt): <year brand model>
```
