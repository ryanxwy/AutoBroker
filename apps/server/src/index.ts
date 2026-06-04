/**
 * @autobroker/server — Layer 5 backend HTTP + SSE shell. PLACEHOLDER.
 *
 * Phase-0 deliverable (PHASE_0_foundation §2): apps/ holds server + Electron +
 * React SPA placeholders; the server owns the BOOT-RECOVERY routine, because
 * automatic recovery exists only inside `mastra dev` — an embedded library-mode
 * host must re-derive it itself:
 *
 *   1. telemetry kill — set MASTRA_TELEMETRY_DISABLED=1 BEFORE Mastra
 *      construction (zero PostHog egress, network-verified — INVARIANTS);
 *   2. deterministic tool re-registration by toolName (execute closures are
 *      not serialized; they are re-resolved at boot);
 *   3. listWorkflowRuns({status:'suspended'}) → re-attach the approval UI and
 *      resume via createRun({runId}).resume();
 *   4. listActiveWorkflowRuns() → per age policy restart() (per-step
 *      checkpoint resume) or cancel() (the reapStale replacement).
 *
 * The HTTP framework choice is a Phase-0 decision (Fastify v5 per the
 * ts-migration round); SSE drives the dashboard skill-run stream. All side
 * effects stay below, behind the @autobroker/tools L2 gate.
 */

// TODO(phase-0, spike 2): Mastra instance wiring + boot-recovery sequence +
// HTTP/SSE surface. Placeholder so the app layer exists in the build graph.
export {};
