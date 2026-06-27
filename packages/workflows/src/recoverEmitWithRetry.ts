/**
 * recoverEmitWithRetry — the SHARED, OPT-IN, no-HITL malformed-class recovery hop.
 *
 * Generalizes the proven inline `extractWithRecovery` template from
 * dealerReplyExtract.ts: a skill's emit_result generation runs its default
 * DeepSeek useCase (first hop). If THAT hop fails the MALFORMED class (#1244 —
 * the deterministic serialization defect a thinking-OFF retry can't fix), retry
 * EXACTLY ONCE on the same provider's strong tier WITH thinking
 * (tool_choice:"auto"). Every other behavior is unchanged — a non-malformed
 * failure, a blob-only malformed signal, or a SECOND failure all fail closed at
 * the identical terminus.
 *
 * Design constraints (each one is load-bearing — violating any re-opens the
 * #1244 closure):
 *   - Skill-CALLED helper, NOT lifted into harness.generate. The suspend decision
 *     stays in harness.generate (it RETURNS a HarnessSuspend on the HITL lane);
 *     recovery stays here (it catches a THROW). The harness never auto-retries.
 *   - no-HITL ONLY. A #1244 on a HITL-bearing path MUST reach the human
 *     (suspend-first), never be silently auto-recovered → assert hitlAvailable
 *     === false.
 *   - Same provider only. The recovery hop must never egress to a Western
 *     provider → assert policy(retryUseCase).provider === "deepseek".
 *   - FRESH generation over the ORIGINAL prompt. The retry is a fresh
 *     harnessGenerate({ ...input, useCase: retryUseCase }, ledger). NEVER resume
 *     the malformed conversation, NEVER retry:true, NEVER
 *     experimental_repairToolCall (inv #4). The second failure is NOT caught — it
 *     propagates to the identical fail-closed terminus.
 *   - Precision-signal gate. Only the high-precision malformed signals
 *     (finish_reason_not_tool_calls / empty_tool_calls), or the no-signal
 *     AI_InvalidToolInputError (#1069-class), retry. A blob-only
 *     MalformedToolCallAbort does NOT retry — a fresh generation of clean prose
 *     would just trip the blob detector again (slow AND broken).
 *   - Bounded one hop + per-run budget. Exactly one retry hop per call, plus a
 *     module-level per-run budget cap (K). Once exhausted, do NOT retry — rethrow
 *     (the first-hop malformed ledger row already recorded the trip).
 *
 * Ledgering is owned entirely by the injected harnessGenerate (it writes its own
 * row per call — the first hop's malformed row is written BEFORE it throws; the
 * retry hop writes its own). This helper writes NO ledger rows and touches no DB.
 */

import type { z } from "zod";

import {
  MalformedToolCallAbort,
  policy,
  type HarnessGenerateInput,
  type HarnessGenerateResult,
  type HarnessSuspend,
  type UseCase,
} from "@autobroker/model";

import type { harness, HarnessLedgerContext } from "./harness.js";

/** Max malformed-class recovery retries per run window. Once a run consumes K
 *  retries, further malformed hops fail closed WITHOUT another retry (the trip is
 *  already ledgered). */
const RECOVERY_BUDGET_PER_RUN = 8;

/** Hard ceiling on how many distinct runIds the budget Map retains. apps/server
 *  runs many pipelines per boot — one distinct runId each — so without eviction
 *  this Map grows monotonically (a slow leak). When a NEW run would push past
 *  this ceiling we evict the OLDEST-inserted entry first. */
const RECOVERY_BUDGET_MAX_RUNS = 1024;

/** Module-level per-run retry budget: runId → retries consumed so far. Bounded by
 *  RECOVERY_BUDGET_MAX_RUNS with oldest-inserted eviction. */
const recoveryBudget = new Map<string, number>();

/**
 * The MALFORMED-tool-call failure class — the ONLY class the recovery hop fires
 * on. Keyed on the STABLE `err.name` (never a message string-match):
 *   - `MalformedToolCallAbort` — the harness's typed #1244 fail-closed abort.
 *   - `AI_InvalidToolInputError` — the AI SDK's own un-parseable-tool-args throw
 *     (a serialization defect), re-thrown verbatim by the harness after ledgering.
 * A ZodError (a structurally-valid tool call carrying schema-rejected values) or
 * any transport/provider throw is NOT this class — re-running it is not recovery.
 */
function isMalformedToolCallError(err: unknown): boolean {
  if (err instanceof MalformedToolCallAbort) return true;
  return (
    err instanceof Error &&
    (err.name === "MalformedToolCallAbort" || err.name === "AI_InvalidToolInputError")
  );
}

/**
 * Precision-signal gate. Retry UNLESS the error is a MalformedToolCallAbort whose
 * signals are EXACTLY ["tool_shaped_blob_in_content"] (blob-only → no retry: a
 * fresh clean-prose generation would just trip the same blob detector). The
 * no-signal AI_InvalidToolInputError is allowed to retry.
 */
function shouldRetrySignals(err: unknown): boolean {
  if (err instanceof MalformedToolCallAbort) {
    return !(err.signals.length === 1 && err.signals[0] === "tool_shaped_blob_in_content");
  }
  return true;
}

/**
 * Narrow a harnessGenerate result to the success branch. With hitlAvailable:false
 * the harness THROWS rather than returns a suspend, so this branch is defensive
 * (mirrors the skills) — a suspend-shaped return still fail-closes identically.
 */
function narrow<T>(r: HarnessGenerateResult<T> | HarnessSuspend): HarnessGenerateResult<T> {
  if ("suspended" in r) {
    throw new MalformedToolCallAbort(r.signals);
  }
  return r;
}

/**
 * Run one emit_result generation with the bounded one-hop, same-provider,
 * no-HITL malformed-class recovery. See the file header for the full constraint
 * list. Returns the Zod-validated result of whichever hop served it; a
 * non-recoverable failure (non-malformed, blob-only, budget-exhausted, or a
 * SECOND malformed) propagates to the identical fail-closed terminus.
 */
export async function recoverEmitWithRetry<TSchema extends z.ZodTypeAny>(args: {
  harnessGenerate: typeof harness.generate;
  input: HarnessGenerateInput<TSchema>;
  retryUseCase: UseCase;
  ledger: HarnessLedgerContext;
}): Promise<HarnessGenerateResult<z.infer<TSchema>>> {
  const { harnessGenerate, input, retryUseCase, ledger } = args;

  // Guard 1 — no-HITL ONLY. A #1244 on a HITL-bearing path must reach the human
  // (suspend-first), never be silently auto-recovered. Asserted BEFORE any hop.
  if (input.hitlAvailable !== false) {
    throw new Error(
      "recoverEmitWithRetry: refusing a HITL-available input — the malformed-class " +
        "recovery hop is no-HITL ONLY (a #1244 on a HITL path must suspend to the human).",
    );
  }

  // Guard 2 — stay on the DeepSeek key. The recovery hop must never egress to a
  // Western provider; same-provider keeps it privacy-clean. Asserted BEFORE any
  // hop so a misrouted retryUseCase throws immediately (no first hop, no retry).
  const retryProvider = policy(retryUseCase).provider;
  if (retryProvider !== "deepseek") {
    throw new Error(
      `recoverEmitWithRetry: retryUseCase "${retryUseCase}" routes to provider ` +
        `"${retryProvider}", not deepseek — refusing a cross-provider recovery hop.`,
    );
  }

  try {
    const first = await harnessGenerate(input, ledger);
    return narrow(first);
  } catch (err) {
    // Only the malformed class triggers the bounded recovery hop. A ZodError or a
    // transport throw is not recoverable by re-running on the strong+thinking lane.
    if (!isMalformedToolCallError(err)) throw err;
    // A blob-only malformed signal would just trip again on a fresh clean-prose
    // generation — slow AND broken — so do not retry.
    if (!shouldRetrySignals(err)) throw err;
    // Per-run budget: once a run has consumed K retries, fail closed WITHOUT
    // another retry (the first-hop malformed row is already ledgered).
    const used = recoveryBudget.get(ledger.runId) ?? 0;
    if (used >= RECOVERY_BUDGET_PER_RUN) {
      console.warn(
        `recoverEmitWithRetry: per-run recovery budget exhausted for runId "${ledger.runId}" ` +
          `(${RECOVERY_BUDGET_PER_RUN} retries) — failing closed without another retry.`,
      );
      throw err;
    }
    // Bound the Map's footprint with oldest-inserted eviction: when a NEW run
    // would push us past the ceiling, drop the oldest entry first. SAFETY
    // DIRECTION: eviction can only LOOSEN the cost cap (an evicted-but-still-
    // active run could earn up to K more retries before it is re-evicted) — it
    // can NEVER weaken #1244 fail-closed, because every hop independently
    // fail-closes and the budget bounds ONLY the number of retries, never whether
    // a malformed hop aborts.
    if (!recoveryBudget.has(ledger.runId) && recoveryBudget.size >= RECOVERY_BUDGET_MAX_RUNS) {
      const oldest = recoveryBudget.keys().next().value;
      if (oldest !== undefined) recoveryBudget.delete(oldest);
    }
    recoveryBudget.set(ledger.runId, used + 1);
    // Bounded ONE-hop retry: a FRESH generation over the ORIGINAL prompt on the
    // same provider's recovery useCase. Its throw is NOT re-caught — a second
    // malformed (or any) failure propagates to the identical fail-closed terminus.
    const retried = await harnessGenerate({ ...input, useCase: retryUseCase }, ledger);
    return narrow(retried);
  }
}

/**
 * TEST-ONLY seam — clears the per-run retry budget so a budget test is
 * deterministic. Refused outside a test runner (the same guard rule as
 * `__setHarnessGenerateFaultForTests` in @autobroker/model).
 */
export function __resetRecoveryBudgetForTests(): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__resetRecoveryBudgetForTests is a test-only seam (refused outside a test runner)",
    );
  }
  recoveryBudget.clear();
}

/** TEST-ONLY — observe the budget Map's current size (proves eviction keeps it
 *  bounded). Refused outside a test runner, same guard rule as the reset seam. */
export function __recoveryBudgetSizeForTests(): number {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__recoveryBudgetSizeForTests is a test-only seam (refused outside a test runner)",
    );
  }
  return recoveryBudget.size;
}
