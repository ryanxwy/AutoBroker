# ui-monitor — the dedicated UI watchdog subagent

A per-checkpoint, dispatch-and-wait subagent that hunts the layout defects and
console errors the journey driver's task-focused eyes miss. It is an
INVESTIGATOR — advisory, non-blocking, never steers the journey. Its findings
fold into the run's three buckets with a `monitor` provenance tag
(`references/recording.md`). Deterministic sweep first, screenshot judging second.

---

## Checkpoints

- **Full run — 6 checkpoints:** after step-2 PASS-A · after step-2 PASS-B ·
  after step 3 (deep negotiation) · after step 4 (cross-shop — include the
  `/portfolio` board) · at step 5 · pre-teardown final.
- **`--light`:** exactly ONE final checkpoint.
- Dispatch SYNCHRONOUSLY at the checkpoint while the driver is idle — never
  concurrent with driver actions. Subagent model: **fable**.

---

## Coordination rules (load-bearing)

- **SINGLE browser context — the driver's session.** A second context/browser
  cannot see the driver's session state (the chat rail and gate cards are
  session-local); never open one.
- **Allowed interactions (no-side-effect whitelist):** click `canvas-tab-<key>`
  tabs; open/close detail modals (`canvas-negotiation-card` →
  `negotiation-detail-modal`, `inventory-detail-modal`) incl. Escape/backdrop
  dismiss; `canvas-pager` next/prev; scroll. RESTORE the previously-active tab
  before returning.
- **FORBIDDEN (blacklist):** any gate decision (`approval-*`, `batch-*`,
  `hygiene-*`, `reset-*`, `stop-pick-option`); the app-mode control
  (`mode-toggle`, `mode-confirm-*` — the single most dangerous control in the
  app; mode is launch-time-immutable); typing into
  `chat-input-textarea` or any composer; navigating away from the app origin;
  any process management (NEVER `pkill` — it kills the MCP browser); any
  mutating HTTP request to ANY route (`/__e2e/*` or product `/api/*`).

---

## The deterministic sweep

Run per tab via one `browser_evaluate` (activate the tab first — only the
active panel renders):

```js
(() => {
  const docW = document.documentElement.clientWidth;
  const els = [...document.querySelectorAll('body *')];
  const id = el => el.getAttribute('data-testid') || el.tagName + '.' + (el.className||'').toString().slice(0,40);
  const overflow = els.filter(el => { const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > docW + 1 || r.left < -1); }).map(id);
  const clipped = els.filter(el => (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    && !['auto','scroll'].includes(getComputedStyle(el).overflowY)
    && getComputedStyle(el).overflow !== 'hidden').map(id);
  const collapsed = [...document.querySelectorAll('[data-testid], main, section')]
    .filter(el => el.childElementCount > 0 && el.getBoundingClientRect().height < 2).map(id);
  const covered = [...document.querySelectorAll('[data-testid]')].filter(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return hit && !el.contains(hit) && !hit.contains(el);
  }).map(id);
  const deadScroll = [...document.querySelectorAll('[role=tabpanel]')].filter(el =>
    getComputedStyle(el).overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 4
    && (el.scrollTop = 1, el.scrollTop === 0)).map(id);
  const brokenImgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src.slice(0,80));
  const pageOverflows = document.documentElement.scrollWidth > docW;
  return { docW, pageOverflows, overflow, clipped, collapsed, covered, deadScroll, brokenImgs };
})()
```

The sweep flags CANDIDATES — modals/toasts legitimately cover content; a `hidden`-overflow
container is often by design; the judge classifies, the sweep triggers. Harvest console via
the console-messages tool (filter noisy patterns); `pageerror`/hydration/chunk-load errors are free signal.

---

## Screenshots

Full-page screenshot of EVERY canvas tab at EVERY checkpoint (plus `/portfolio`
when ≥2 profiles are active) → `<report-dir>/shots/<checkpoint>-<tab>.png`.
Generous by design (owner directive: do not save cost on snapshots). Screenshots
are report artifacts and judge input — never the verdict (the verification
ladder in `SKILL.md`, rung 3).

---

## Judging

Feed each tab's sweep JSON + its screenshot TOGETHER; classify each candidate
`{overflow | clip | collapse | overlap | dead-scroll | console | visual}`;
confirm-or-dismiss, don't free-hunt (multimodal judges over-trust plausible
text — anchor on the sweep + pixels). Every finding:
`{surface (testid/selector), class, what the buyer sees, evidence (shot name /
console line), suggested bucket}`.

---

## Return contract + fold-back

Return three-bucket JSON `{blocker: [], backlog: [], polish: []}` — empty arrays
are legal. The DRIVER (main agent) merges into 本轮发现 with the `monitor`
provenance tag, dedups against its own findings by surface, and applies the
standard rules: any budget digit on any surface/screenshot = **BLOCKER**
(inv #9); known-correct behaviors (the `references/recording.md` list) are
filtered, not re-flagged; a layout finding never excuses or blocks anything
(advisory).

---

## Dispatch brief template (copy into the Task prompt; fill the `<>`)

```
You are the ui-monitor watchdog for a live e2e run.

App: http://127.0.0.1:8131 — the driver's live session. Use the EXISTING
browser context; NEVER open a second context/browser (session state is
context-local).
Checkpoint: <checkpoint-name>
Shots dir: <absolute-report-dir>/shots/

ALLOWED: click canvas-tab-<key> tabs; open/close detail modals
(canvas-negotiation-card → negotiation-detail-modal, inventory-detail-modal,
Escape/backdrop dismiss); canvas-pager next/prev; scroll. Restore the
previously-active tab before returning.
FORBIDDEN: any gate decision (approval-*, batch-*, hygiene-*, reset-*,
stop-pick-option); the app-mode control (mode-toggle, mode-confirm-*); typing
into chat-input-textarea or any composer; navigating off the app origin; pkill
or any process management; any mutating HTTP request to ANY route (/__e2e/* or
product /api/*).

Per canvas tab (plus /portfolio when >=2 active profiles):
1. Activate the tab, then run the sweep JS from
   .claude/skills/e2e-loop/references/ui-monitor.md via one browser_evaluate.
2. Full-page screenshot -> <shots-dir>/<checkpoint>-<tab>.png.
3. Harvest console messages (filter known-noisy patterns).
Judge each tab's sweep JSON + screenshot together; confirm-or-dismiss, don't free-hunt.

Return ONLY three-bucket JSON: {"blocker": [], "backlog": [], "polish": []} —
each item {surface, class, what_the_buyer_sees, evidence, suggested_bucket};
empty arrays are legal. You are advisory: report, never fix, never decide gates.
```
