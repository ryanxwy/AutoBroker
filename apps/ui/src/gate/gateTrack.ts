/**
 * gateTrack — THE single kind→track routing point for pending gates. Two gate
 * surfaces exist:
 *
 *   - "rail"   — the assistant turn's gate zone in the chat rail (the intake
 *                form + the semantic gate cards: data_collection /
 *                force_override / ambiguous_location (and its client-side
 *                location_failure split) / malformed_tool_call, plus the
 *                unknown-kind fallback card).
 *   - "banner" — the app-level GateBannerHost mounted above the workbench/rail
 *                split, reserved for run-blocking decisions that span both
 *                panes: mutation approvals, per-item batch review, and
 *                typed-YES destructive confirms. None of these kinds are
 *                emitted yet — the banner host mounts empty until they land.
 *
 * BOTH surfaces consult this map and nothing else: adding a gate kind means
 * deciding its track here, exactly once. An unknown or missing kind routes to
 * the rail (its fallback card renders — a gate is never silently hidden).
 *
 * Dependency wall: app/ui layer. Pure — no imports.
 */

export type GateTrack = "rail" | "banner";

/** Gate kinds reserved for the app-level banner surface. The typed-YES
 *  destructive confirm is emitted as `confirmation_gate` (pipeline_reset). */
const BANNER_KINDS: ReadonlySet<string> = new Set(["approval", "batch_review", "confirmation_gate"]);

/** Route a suspend payload's `kind` to the surface that renders it. */
export function gateTrack(kind: string | null): GateTrack {
  return kind !== null && BANNER_KINDS.has(kind) ? "banner" : "rail";
}
