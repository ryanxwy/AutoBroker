/**
 * scanChain — the app-layer auto-chain: when an /inventory_site_scan run
 * completes, AUTO-TRIGGER an /inventory_aggregator_scan run for the SAME
 * profile so the buyer sees dealer-site inventory AND shopping-site inventory
 * (Cars.com/Edmunds) in one journey. Both scans are READ-ONLY (no send/submit),
 * so there is no approval gate — the sibling just starts.
 *
 * It is a RunLifecycleListener (the PortfolioScheduler precedent), NOT a
 * workflow step: the five-layer wall + the flat-workflow doctrine keep
 * cross-skill orchestration in the app layer. The sibling starts as a TOP-LEVEL
 * run (its own channel + its own rail turn), not a nested child.
 *
 * LIVE VISIBILITY: before the parent's terminal `done` frame lands (post-`done`
 * appends are discarded), the listener pre-mints the sibling runId and appends
 * an announce frame onto the PARENT channel carrying a voiced line + the
 * sibling {run_id, skill}. The client reacts by streaming the sibling as its own
 * assistant turn. This is why the terminal fan-out now runs before `done`.
 *
 * RECURSION is structurally impossible: the filter fires ONLY for
 * inventory_site_scan, and the sibling is inventory_aggregator_scan — so the
 * sibling's own terminal never re-enters this branch.
 *
 * KILL SWITCH: AUTOBROKER_SITESCAN_CHAIN="0" disables the chain (read at FIRE
 * time, not module load — default = on). Any other value keeps it on.
 *
 * Dependency wall: app layer. Uses only the SkillRunService / SessionService
 * seams + the shared skill ids; no @mastra, no DB, no external I/O.
 */

import { randomUUID } from "node:crypto";

import {
  INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
} from "@autobroker/skills";

import { SkillRunService, inventoryAggregatorScanDescriptor, type RunTerminalEvent } from "./skillRuns.js";
import { SessionService } from "./sessions.js";

/** The voiced line the buyer sees on the parent turn when the sibling starts —
 *  the auto-allowed follow-up must be VOICED (fallback classification). */
const CHAIN_ANNOUNCE_TEXT = "Also checking shopping sites (Cars.com, Edmunds)…";

/**
 * Register the site_scan → aggregator_scan auto-chain on the run-lifecycle
 * stream. Product default ON; the env knob is the only gate.
 */
export function installScanChain(skillRuns: SkillRunService, sessions: SessionService): void {
  skillRuns.addLifecycleListener({
    onRunTerminal(event: RunTerminalEvent): void {
      // Fire ONLY for a completed site_scan carrying a profile. This filter is
      // what makes recursion structurally impossible: the sibling is an
      // aggregator_scan, so its terminal never matches site_scan here.
      if (event.skill !== INVENTORY_SITE_SCAN_SKILL_ID) return;
      if (event.terminalKind !== "completed") return;
      if (event.profileId === null) return;
      // Kill switch, read at fire time (default = on; only the exact "0" disables).
      if (process.env.AUTOBROKER_SITESCAN_CHAIN === "0") return;

      const parentRunId = event.runId;
      const profileId = event.profileId;
      const chainRunId = randomUUID();
      // The sibling links to the parent's session (may be null → headless run).
      const sessionId = skillRuns.sessionOf(parentRunId);

      // Announce SYNCHRONOUSLY on the parent channel BEFORE its `done` frame
      // (this runs inside the terminal fan-out, which precedes `done`).
      skillRuns.appendChainedRunAnnounce(parentRunId, {
        text: CHAIN_ANNOUNCE_TEXT,
        chainRunId,
        chainSkill: INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
      });

      // Two rapid site_scans on the SAME profile each chain their OWN aggregator
      // sibling independently — by design. This is the same risk class as two
      // manual aggregator starts: the in-run / persist-time / read-time VIN-dedup
      // belts bound the duplicate damage, and the activation registry stays
      // advisory (it does not serialize starts here — there is no cross-run lock).
      //
      // Fire-and-forget: the sibling run must NEVER fail the parent terminal. The
      // start and the session-link are reported SEPARATELY so a log tells the
      // truth about which one failed.
      void skillRuns
        .start({
          skill: INVENTORY_AGGREGATOR_SCAN_SKILL_ID,
          runId: chainRunId,
          input: inventoryAggregatorScanDescriptor.buildInput({ search_profile_id: profileId }),
          sessionId,
        })
        .then(
          () => {
            // Start SUCCEEDED. Bind the sibling to the parent's session (the
            // durable rail turn) — only when the parent had a session. A failed
            // link is non-fatal and reported as a link failure, NOT a start one.
            if (sessionId === null) return undefined;
            return sessions.recordRun(sessionId, chainRunId).catch((err: unknown) => {
              console.error(
                `scanChain: aggregator sibling ${chainRunId} started but linking it to session ${sessionId} failed`,
                err,
              );
            });
          },
          (err: unknown) => {
            // The sibling START itself failed — the chain never ran.
            console.error(
              `scanChain: aggregator sibling ${chainRunId} for site_scan ${parentRunId} failed to start`,
              err,
            );
          },
        );
    },
  });
}
