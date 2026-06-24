/**
 * SagaCoordinator — owns the per-profile {@link ProfileSagaStack}s and wires them to
 * the run lifecycle. As a profile's pipeline commits steps it pushes compensations
 * onto its stack (via stackFor); when a run reaches a terminal:
 *   - COMPLETED  → the work stood; drop the stack (nothing to undo).
 *   - declined / error / canceled (ABORT) → compensate the stack LIFO, idempotently
 *     and conditionally, and route every committed-send retraction task into the
 *     ApprovalInbox (a real send is NEVER silently undone — the human decides).
 *
 * It is a RunLifecycleListener, so SkillRunService fires it on every terminal.
 *
 * NOTE (scope): the per-step saga.push registration from inside each workflow's
 * commit points is incremental future wiring; this coordinator is the live seam that
 * turns those pushes into compensations + inbox retractions the moment they land.
 */

import type { RunLifecycleListener, RunTerminalEvent } from "../skillRuns.js";
import { ProfileSagaStack } from "./sagaStack.js";

interface RetractionSink {
  enqueueRetraction(task: {
    profileId: string;
    runId?: string;
    kind: string;
    reason: string;
    summary: { heading: string; lines: Array<{ label: string; value: string }> };
  }): void;
}

export class SagaCoordinator implements RunLifecycleListener {
  private readonly stacks = new Map<string, ProfileSagaStack>();

  constructor(private readonly inbox: RetractionSink) {}

  /** Get-or-create a profile's saga stack (pipeline steps push compensations here). */
  stackFor(profileId: string): ProfileSagaStack {
    let stack = this.stacks.get(profileId);
    if (stack === undefined) {
      stack = new ProfileSagaStack(profileId);
      this.stacks.set(profileId, stack);
    }
    return stack;
  }

  /** RunLifecycleListener: fire-and-forget the async compensation on terminal. */
  onRunTerminal(event: RunTerminalEvent): void {
    void this.handleTerminal(event);
  }

  /** Compensate (or drop) a profile's saga stack on a terminal. Awaitable for tests. */
  async handleTerminal(event: RunTerminalEvent): Promise<void> {
    if (event.profileId === null) return;
    const stack = this.stacks.get(event.profileId);
    if (stack === undefined) return;
    this.stacks.delete(event.profileId);
    if (event.terminalKind === "completed") return; // success: the work stood
    const { retractions } = await stack.compensate(event.terminalKind);
    for (const r of retractions) this.inbox.enqueueRetraction(r);
  }
}
