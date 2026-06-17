---
name: e2e-inspect
description: Drive a live-LLM end-to-end 巡检 (inspection) of the skills against the real provider via the serve-live harness + a browser, two-pass (natural-language then /slash), then refresh the plan-repo live-status box and write the run report. Use to run a full-skill e2e sweep on the AutoBroker TS repo.
disable-model-invocation: true
---

You run a **live end-to-end inspection** of the AutoBroker (TS) skills against the
real DeepSeek lane, through the dashboard, and record what you found. This is the
deliberate, heavyweight ritual — it starts a server, drives a browser, and calls a
real provider — so it is user-invoked only.

## Setup

1. **Isolated data dir.** Always run against a throwaway dir, never the legacy
   production one: `AUTOBROKER_DATA_DIR=~/.autobroker-ts` (or a `/tmp` throwaway).
   Keep the approval gate live — **never** set `AUTOBROKER_TEST_AUTO_APPROVE`.
2. **Start the live server.** `pnpm e2e:serve-live` (`apps/ui/e2e/serve-live.mjs`).
   It applies the migrations and exposes **control routes OUTSIDE `/api`** (the
   product wall is untouched) — confirm the current set by reading the top of
   `serve-live.mjs`; today they are:
   - `POST /__e2e/inject_replies` — seed dealer replies for a profile. Echoes
     `applied.threadIds[]` (`{dealerName, from, threadId}`) so a live dealer-brain
     can target an existing thread for a multi-round counter.
   - `POST /__e2e/inject_reply_to_thread` — append a dealer COUNTER (a new inbound
     reply, re-arming extraction) into an existing `threadId` from the line above.
     This is what makes live multi-round negotiation → closeout exercisable.
   - `POST /__e2e/inject_crm_threads` — seed CRM-only threads (writes
     `message_analysis`) so **`dealer_hygiene`'s 3-stage gate is exercisable**.
     Call this BEFORE inspecting `dealer_hygiene`, or it has nothing to triage.
   - `GET /__e2e/audit?action=` and `GET /__e2e/rows?table=` — row-count
     verification.
   Note: SQLite writes done by an external process are invisible to the already-
   running server — seed via these routes, not by writing the DB underneath it.
3. **Open the dashboard** in the browser (Playwright/Chrome MCP) and pin a
   profile first — most skills act on one profile (the 1/0/2 ASK contract).

## The sweep

For each skill, do a **two-pass** trigger and verify the UI outcome:
- **Pass 1 — natural language:** type a naive freeform request and confirm the
  NL→skill router launches the right skill (this is the real-user path).
- **Pass 2 — `/slash`:** trigger the same skill explicitly and confirm parity.

Verification gotchas that have cost time before:
- **Tabbed Canvas DOM:** only the ACTIVE panel renders. Click `canvas-tab-<key>`
  first, THEN read `canvas-panel-<key>` — reading a panel whose tab isn't active
  returns nothing.
- **Gates render before prose.** Every fallback/approval must show its gate card;
  approve AND decline at least the destructive/irreversible skills, and confirm
  decline = Δ0 (use `/__e2e/rows` / `/__e2e/audit` to prove zero writes).
- **Order:** seed `inject_crm_threads` before `dealer_hygiene`; run profile-closing
  skills (e.g. `dealer_closeout_email`) LAST so they don't end the profile mid-sweep.
- Watch for the #1244 fail-closed path on the largest live extractions — it should
  fail closed (no corrupt data), never silently fall back.

## After the sweep

1. **Refresh the live-status box.** Update the `CURRENT STATE (live)` block atop
   `../AutoBroker-dev-plan/ts-rebuild/index.html` so other sessions read the latest
   — that box is canonical; the dated reports are the history.
2. **Write the run report** under `../AutoBroker-dev-plan/ts-rebuild/<date>-…/`
   (self-contained HTML, inline CSS): which skills passed two-pass, any findings,
   and the backlog. Present it; **do not auto-commit** the plan repo — that's a
   separate deliberate step.
3. **Code findings are separate.** If the sweep surfaces a code bug, report it and
   stop — fixing it is its own task (and goes through `/green` + review). Check the
   memory backlog first so you don't re-fix something already handled.

## Guardrails

- Read-only on the product DB except through the documented control routes.
- Real email/lead-submit stays fake-send; the approval gate stays live.
- Keep every absolute date as `YYYY-MM-DD`; keep the report self-contained.
