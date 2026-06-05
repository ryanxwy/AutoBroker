/**
 * useRunController — binds the single SSE hook to the chat store for one run, and
 * exposes the form-decision dispatcher (FRONTEND_LAYOUT §9.2/§9.5). It is the one
 * place that:
 *
 *   - subscribes useRunStream(runId) (the ONLY EventSource per run) and writes
 *     each decoded frame into the bound assistant turn via applyRunFrame.
 *   - posts a form-decision (accept|decline|cancel) through the typed client to
 *     resume the SAME run (§5.7 — one path, no respawn), echoing the part's
 *     decision_id verbatim.
 *
 * Reconnect/refresh recovery is inherited from useRunStream (replay-on-subscribe
 * + content dedupe); a fresh mount with a known runId re-subscribes and the server
 * replays the full backlog (M2 exit).
 *
 * Dependency wall: app/ui. react + the SSE hook + the typed client + the store.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type ApiClient } from "../api/client.js";
import { useRunStream } from "../api/useRunStream.js";
import type { SseEvent } from "../api/wire.js";
import { useChat } from "../store/useChat.js";
import type { DecisionAction } from "../intake/IntakeForm.js";

export interface RunController {
  submitting: boolean;
  decisionError: string | null;
  /** Post a form-decision for the run's pending suspend. */
  decide: (action: DecisionAction, content?: Record<string, unknown>) => void;
}

export function useRunController(client: ApiClient, runId: string | null): RunController {
  const stream = useRunStream(runId);
  const applyRunFrame = useChat((s) => s.applyRunFrame);

  // Pipe every newly-seen frame into the bound turn. The store reducer is the
  // three-zone projection; the hook already de-duplicates replayed frames, so we
  // forward the full ordered list and rely on the store ignoring frames for a
  // turn it does not know (unknown runId → dropped).
  const forwarded = useRef(0);
  useEffect(() => {
    if (runId === null) {
      forwarded.current = 0;
      return;
    }
    const events = stream.events;
    for (let i = forwarded.current; i < events.length; i += 1) {
      const ev: SseEvent = events[i]!;
      applyRunFrame(runId, ev);
    }
    forwarded.current = events.length;
  }, [runId, stream.events, applyRunFrame]);

  // Reset the forward cursor when the run changes (new backlog from scratch).
  useEffect(() => {
    forwarded.current = 0;
  }, [runId]);

  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const decide = useCallback(
    (action: DecisionAction, content?: Record<string, unknown>) => {
      if (runId === null) return;
      const decisionId = stream.currentSuspend?.decisionId;
      if (decisionId === null || decisionId === undefined) {
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
          setDecisionError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Decision failed.");
        });
    },
    [client, runId, stream.currentSuspend],
  );

  return { submitting, decisionError, decide };
}
