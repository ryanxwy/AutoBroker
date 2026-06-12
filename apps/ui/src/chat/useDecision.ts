/**
 * useDecision — the KEPT decide() path: HITL decisions post through the typed
 * client to POST /api/skill-runs/:id/form-decision (the three-phase claim),
 * echoing the pending gate's decision_id verbatim. The chat transport is NEVER
 * used to submit a decision; the resumed run's frames flow back down the
 * already-open /stream-v2 connection on their own.
 *
 * Dependency wall: app/ui. react + the typed client only.
 */

import { useCallback, useState } from "react";

import { ApiError, type ApiClient } from "../api/client.js";
import type { DecisionAction } from "../intake/IntakeForm.js";

export interface DecisionController {
  submitting: boolean;
  decisionError: string | null;
  /** Post a form-decision for the run's pending suspend. */
  decide: (action: DecisionAction, content?: Record<string, unknown>) => void;
}

export function useDecision(
  client: ApiClient,
  runId: string | null,
  decisionId: string | null,
): DecisionController {
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const decide = useCallback(
    (action: DecisionAction, content?: Record<string, unknown>) => {
      if (runId === null) return;
      if (decisionId === null) {
        setDecisionError("No pending decision to respond to.");
        return;
      }
      setSubmitting(true);
      setDecisionError(null);
      client
        .formDecision(runId, {
          decision_id: decisionId,
          decision: action === "accept" ? { action, content: content ?? {} } : { action },
        })
        .then(() => {
          setSubmitting(false);
        })
        .catch((err: unknown) => {
          setSubmitting(false);
          setDecisionError(
            err instanceof ApiError ? `${err.code}: ${err.message}` : "Decision failed.",
          );
        });
    },
    [client, runId, decisionId],
  );

  return { submitting, decisionError, decide };
}
