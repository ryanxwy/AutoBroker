# ADR stub — per-profile skill-pipeline status contract

> Status: Phase 3 · 2026-06-14. Code-local stub. Canonical write-up + the full
> misalignment analysis live in the plan repo:
> [`ts-rebuild/20260614-skill-pipeline-alignment/index.html`](../../AutoBroker-dev-plan/ts-rebuild/20260614-skill-pipeline-alignment/index.html).

Every skill runs against ONE `search_profile`. A new skill run must derive its
inputs from the profile + the relevant prior-skill status, not from blind
defaults. This stub records the three rulings the code enforces.

## 1. Input-derivation precedence (every skill)

Resolve each input in this order; never skip to a fixed default when a recorded
upstream fact exists:

1. **Explicit pin / start-body input** (e.g. `search_profile_id`).
2. **Per-profile prior-skill facts** — read from `pipeline_state` watermarks or
   the upstream skill's own output rows (`dealers`, `inventory_*`,
   `lead_submissions`, `dealer_quotes`).
3. **Fixed default** — only when 1 and 2 are absent.

The first concrete realization: `dealer_inbox_check` anchors its first-run mail
window to `MIN(lead_submissions.submitted_at) WHERE outcome='submitted'` for the
pinned profile (not a blind 2-day lookback), and STOPs `no_lead_submitted` when
no lead exists yet — read straight from `lead_submissions` (the XOR-checked
authoritative table), NOT a `pipeline_state` mirror (a second writer would drift).

## 2. Status store: `pipeline_state`, not `skill_runs`

- **`pipeline_state`** (per-profile KV, key convention `<stage>.<fact>.<profileId>`,
  e.g. `inbox.last_check_at.<pid>`) is the status/watermark store. Reach for a
  watermark only when a skill is *windowed* (needs "since when"); otherwise expose
  status as queryable **output rows**.
- **`skill_runs` stays dormant** — no product writer. Run-lifecycle truth is
  Mastra's `mastra.db`; promoting `skill_runs` would recreate the coupling that
  the dormant-guard cleanup removed. (See the `skill_runs`-guard removal ADR /
  debt note.)
- The Gmail `historyId` watermark stays **global** (`gmail.history.<mailbox>`) —
  one mailbox, one server delta — separate from the per-profile windows.

## 3. `profilePin` posture (per-skill, typed in the registry)

`SkillDef.profilePin ∈ { exempt | pin_required | infer_ok }` drives the UI
pre-launch gate (and, for `pin_required`, the workflow STOP):

- **exempt** — `search_profile_intake` (creates the profile).
- **pin_required** — mutating/destructive/sequence-dependent skills:
  `dealer_inbox_check`, the 3 irreversibles (`dealer_web_lead_submit`,
  `negotiation_followup`, `dealer_closeout_email`), the 2 destructives
  (`dealer_hygiene`, `pipeline_reset`), the 2 orchestrators (`quote_pipeline`,
  `daily_digest`). No default pin: an unpinned launch STOPs and asks
  (`pin_required`), never silently runs newest-active.
- **infer_ok** — read-only / re-runnable scans + comparisons (`dealer_geosearch`,
  `inventory_site_scan`, `inventory_link_scan`, `incentive_scrape`, `quote_audit`,
  `quote_compare`, `inventory_compare`, `dealer_reply_extract`).

The shared `resolveActiveProfile` resolver keeps its three branches; the
pin-required carve-out is enforced at the **skill boundary** (the workflow rejects
a non-`pinned` result) — no global `STRICT_PROFILE_PIN`, no resolver rewrite.

## Open item (not a blocker)

`dealer_hygiene` carries `profilePin:"pin_required"` (drives the UI gate) but its
*detection* is still global-mailbox; scoping its cleanup to the pinned profile
changes its semantics (global → per-search cleanup) — a Phase-5 product decision
to confirm when hygiene is next touched.
