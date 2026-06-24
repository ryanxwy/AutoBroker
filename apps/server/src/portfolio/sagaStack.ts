/**
 * sagaStack — a per-profile LIFO compensation stack. As a profile's pipeline
 * commits steps it pushes a compensation; on an abort/decline the stack unwinds in
 * reverse, idempotently and conditionally.
 *
 * THE BOUNDARY = the send seam (load-bearing). A `local` step (a local DB write) is
 * safely undone. A `send` step (a COMMITTED real outbound — a real dealer email /
 * web-form submit) is NEVER silently undone: instead it surfaces a human-facing
 * RETRACTION TASK that the ApprovalInbox shows as action-required. You cannot
 * un-send an email; the only honest compensation is to ask the human to retract it.
 * In test mode no real send is committed (the fake mailbox), so the send-boundary
 * path is a buyer-mode safety property; the keystone (`portfolioTotal === 0`) proves
 * no real send happened under test.
 */

export type SagaBoundary = "local" | "send";

/** A human-facing retraction task — what the inbox shows for a committed real send
 *  that a later abort would otherwise want to undo. Budget is NEVER included (#9). */
export interface RetractionTask {
  profileId: string;
  runId?: string;
  kind: string;
  reason: string;
  summary: { heading: string; lines: Array<{ label: string; value: string }> };
}

export interface SagaStep {
  /** Idempotency key — a step is compensated at most once. */
  key: string;
  /** `local` = undoable DB write; `send` = committed real send (never auto-undone). */
  boundary: SagaBoundary;
  /** The compensating action for a `local` step (ignored for `send`). */
  undo?: () => void | Promise<void>;
  /** Conditional guard: return false to SKIP compensation (the precondition is
   *  already gone — e.g. the row was deleted). Absent = always compensate. */
  shouldCompensate?: () => boolean;
  /** For a `send` step: the retraction task surfaced to the human. */
  retraction?: RetractionTask;
}

export interface CompensationResult {
  /** Keys of the local steps actually compensated, in LIFO order. */
  undone: string[];
  /** Retraction tasks raised for committed sends (never silently undone). */
  retractions: RetractionTask[];
}

export class ProfileSagaStack {
  private readonly steps: SagaStep[] = [];
  private readonly compensated = new Set<string>();

  constructor(readonly profileId: string) {}

  /** Push a compensation as the pipeline commits a step. */
  push(step: SagaStep): void {
    this.steps.push(step);
  }

  /** Unwind the stack LIFO. Idempotent (a step compensated once is never re-run);
   *  conditional (shouldCompensate()===false skips); a `send` step is surfaced as a
   *  retraction task, never undone. Safe to call more than once. */
  async compensate(_reason: string): Promise<CompensationResult> {
    const undone: string[] = [];
    const retractions: RetractionTask[] = [];
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i]!;
      if (this.compensated.has(step.key)) continue; // idempotent
      if (step.shouldCompensate !== undefined && !step.shouldCompensate()) continue; // conditional
      this.compensated.add(step.key);
      if (step.boundary === "send") {
        if (step.retraction !== undefined) retractions.push(step.retraction);
        continue; // a committed real send is a human-facing retraction, never a silent undo
      }
      if (step.undo !== undefined) await step.undo();
      undone.push(step.key);
    }
    return { undone, retractions };
  }
}
