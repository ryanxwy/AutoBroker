/**
 * daily_digest — skill #O0 (the windowed read-only pipeline digest). ONE flat
 * linear Mastra `createWorkflow`: 6 named steps chained with `.then()`, no
 * nested workflow, NO suspend, NO HITL, NO LLM. The whole digest is
 * deterministic — counts aggregated from upstream output rows → a 7-section
 * template → a local file artifact + a per-profile watermark + a headline +
 * deep-link target in the step output (surfaced by the in-app read views — the
 * SSE stream, Canvas, and the /digest page — never a native OS notification).
 *
 * STEP MAP:
 *   0 resolveScope  — explicit pin (start body) scopes to that one search;
 *                     unpinned → ALL active profiles enumerated (the documented
 *                     multi-active exception — NO ASK). Zero active → a GRACEFUL
 *                     SKIP outcome (points at intake), never a hard STOP.
 *   1 gather        — the ONE consolidated `generateDigest` read (no SQL in the
 *                     workflow). Returns the typed payload: per-profile dealer /
 *                     thread / needs-response / question counts, OTD-ascending
 *                     offers (best-first, trimmed), freshness mix, and the
 *                     deterministic Next Actions.
 *   2 writeArtifact — render the 7-section text, `assertNoBudget(text)` BEFORE
 *                     the write; render + check the static HTML from the SAME
 *                     payload, then atomically replace digests/latest.html.
 *   3 notify        — compute the one-line headline in CODE, `assertNoBudget`
 *                     it, and produce `{ headline, deepLink: "/digest" }` in the
 *                     step output. Does NOT call `new Notification()` — the
 *                     headline/deep-link ride the step output for the in-app
 *                     read views (SSE + Canvas + the /digest page) to surface.
 *   4 setWatermark  — advance the PRODUCT `digest.last_at.<profileId>` watermark
 *                     for EACH summarized profile (distinct from the scheduler's
 *                     own `scheduler.last_success.daily_digest` key — keep both).
 *   5 confirm       — deterministic ZERO-LLM template over the digest counts;
 *                     emits the typed `generated` | `skipped` output.
 *
 * KEYSTONE: read + local-file/watermark write only. No browser, no Gmail, no
 * gate Approver, no external mutation. Budget is structurally absent — the
 * payload never carries it and both the artifact text and the headline pass
 * through `assertNoBudget` before they leave this file.
 *
 * Dependency wall: imports @mastra/* (legal only here), zod, the skill
 * contracts module, and @autobroker/tools (the digest readers + the file/
 * watermark writers + the budget validator — the ONLY DB/side-effect paths).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  assertNoBudget,
  generateDigest as generateDigestImpl,
  getDb,
  renderDigestText as renderDigestTextImpl,
  renderDigestHtml as renderDigestHtmlImpl,
  digestHeadline as digestHeadlineImpl,
  resolveDataDir as resolveDataDirImpl,
  writeDigestArtifact as writeDigestArtifactImpl,
  writeDigestHtmlSnapshot as writeDigestHtmlSnapshotImpl,
  writeLastDigestAt as writeLastDigestAtImpl,
  type DigestPayload,
} from "@autobroker/tools";

import {
  DailyDigestInputSchema,
  DailyDigestOutputSchema,
} from "./dailyDigestContracts.js";

// ---------------------------------------------------------------------------
// the digest's fixed section count (the 7 named slots the renderer fills:
// profile / dealers / quotes / needs-response / unanswered-question /
// freshness / next-actions — surfaced as sectionsCount on the output).
// ---------------------------------------------------------------------------

export const DIGEST_SECTIONS_COUNT = 7;

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/** The runtime collaborators the workflow steps call. Injectable so the
 *  offline tests drive the REAL flat Mastra workflow against deterministic
 *  stubs and an isolated tmp DB, WITHOUT module mocks. */
export interface DailyDigestWorkflowDeps {
  generateDigest: typeof generateDigestImpl;
  renderDigestText: typeof renderDigestTextImpl;
  renderDigestHtml: typeof renderDigestHtmlImpl;
  digestHeadline: typeof digestHeadlineImpl;
  writeDigestArtifact: typeof writeDigestArtifactImpl;
  writeDigestHtmlSnapshot: typeof writeDigestHtmlSnapshotImpl;
  writeLastDigestAt: typeof writeLastDigestAtImpl;
  resolveDataDir: typeof resolveDataDirImpl;
  getDb: typeof getDb;
  /** "now" provider — injectable so tests freeze the freshness window + stamp. */
  now: () => number;
}

const realDeps: DailyDigestWorkflowDeps = {
  generateDigest: generateDigestImpl,
  renderDigestText: renderDigestTextImpl,
  renderDigestHtml: renderDigestHtmlImpl,
  digestHeadline: digestHeadlineImpl,
  writeDigestArtifact: writeDigestArtifactImpl,
  writeDigestHtmlSnapshot: writeDigestHtmlSnapshotImpl,
  writeLastDigestAt: writeLastDigestAtImpl,
  resolveDataDir: resolveDataDirImpl,
  getDb,
  now: () => Date.now(),
};

let injectedDeps: DailyDigestWorkflowDeps | undefined;

function deps(): DailyDigestWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner. */
export function __setDailyDigestDepsForTests(partial: Partial<DailyDigestWorkflowDeps>): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setDailyDigestDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetDailyDigestDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

const DigestStateSchema = z.object({
  /** The explicit pin, or null on the multi-active enumerate. */
  searchProfileId: z.string().nullable(),
  sinceHours: z.number().nullable(),
  /** Epoch-ms "now" — captured once at resolveScope so every step agrees. */
  nowMs: z.number(),
  /** True when zero active profiles resolved → the graceful skip. */
  skipped: z.boolean(),
  /** The summarized profile ids (the watermark advance set). */
  profileIds: z.array(z.string()),
  /** The render-ready payload (rides the state as loose JSON; re-typed by the
   *  steps that consume it — small, all-numeric, no snapshots). */
  payload: z.unknown().nullable(),
  /** The landed artifact path (writeArtifact → confirm). */
  artifactPath: z.string().nullable(),
  /** The notification headline + deep-link target (notify → confirm). */
  headline: z.string().nullable(),
  deepLink: z.string().nullable(),
});
type DigestState = z.infer<typeof DigestStateSchema>;

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): DigestState {
  return DigestStateSchema.parse(inputData);
}

/** Narrow the loose `payload` field back to the typed DigestPayload. */
function asPayload(value: unknown): DigestPayload {
  return value as DigestPayload;
}

// ---------------------------------------------------------------------------
// step 0 — resolveScope (the documented multi-active enumerate; zero → skip)
// ---------------------------------------------------------------------------

const resolveScopeStep = createStep({
  id: "resolveScope",
  inputSchema: DailyDigestInputSchema,
  outputSchema: DigestStateSchema,
  execute: async ({ inputData }) => {
    const nowMs = deps().now();
    const searchProfileId = inputData.search_profile_id;
    const sinceHours = inputData.since_hours ?? null;

    // The ONE consolidated read does the scope resolution too (explicit pin or
    // all-active enumerate); a zero-profile payload carries the skip sentinel.
    const payload = deps().generateDigest(deps().getDb(), {
      profileIds: searchProfileId !== null ? [searchProfileId] : null,
      nowMs,
      sinceHours,
    });

    const skipped = payload.state === "_NO_ACTIVE_SEARCHES" || payload.profiles.length === 0;
    const profileIds = payload.profiles.map((p) => p.searchProfileId);

    return {
      searchProfileId,
      sinceHours,
      nowMs,
      skipped,
      profileIds,
      payload,
      artifactPath: null,
      headline: null,
      deepLink: null,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — gather (pass-through: the read already happened at resolveScope;
// this step exists as the named gather slot in the flat chain and is the place
// a future windowed refresh would re-aggregate)
// ---------------------------------------------------------------------------

const gatherStep = createStep({
  id: "gather",
  inputSchema: DigestStateSchema,
  outputSchema: DigestStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    return state; // payload already gathered; nothing to add on the skip path.
  },
});

// ---------------------------------------------------------------------------
// step 2 — writeArtifact (render → assertNoBudget BEFORE write → atomic file)
// ---------------------------------------------------------------------------

const writeArtifactStep = createStep({
  id: "writeArtifact",
  inputSchema: DigestStateSchema,
  outputSchema: DigestStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.skipped) return state; // nothing to render/write on the skip path.

    const text = deps().renderDigestText(asPayload(state.payload));
    const html = deps().renderDigestHtml(asPayload(state.payload));
    // Budget red-line: check BOTH representations before either touches disk.
    assertNoBudget(text);
    assertNoBudget(html);

    const dataDir = deps().resolveDataDir();
    const artifactPath = deps().writeDigestArtifact(text, {
      dataDir,
      nowMs: state.nowMs,
    });
    deps().writeDigestHtmlSnapshot(html, { dataDir });
    return { ...state, artifactPath };
  },
});

// ---------------------------------------------------------------------------
// step 3 — notify (headline in CODE + assertNoBudget + deep-link target;
// the headline/deep-link ride the step output for the in-app read views,
// NOT new Notification() here)
// ---------------------------------------------------------------------------

const notifyStep = createStep({
  id: "notify",
  inputSchema: DigestStateSchema,
  outputSchema: DigestStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.skipped) return state;

    const headline = deps().digestHeadline(asPayload(state.payload));
    assertNoBudget(headline); // the headline is outbound too.
    return { ...state, headline, deepLink: "/digest" };
  },
});

// ---------------------------------------------------------------------------
// step 4 — setWatermark (advance the PRODUCT digest.last_at.<profileId> for
// each summarized profile; distinct from the scheduler's last-success key)
// ---------------------------------------------------------------------------

const setWatermarkStep = createStep({
  id: "setWatermark",
  inputSchema: DigestStateSchema,
  outputSchema: DigestStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.skipped) return state; // a skip advances NO watermark.

    const db = deps().getDb();
    for (const profileId of state.profileIds) {
      deps().writeLastDigestAt(db, profileId, state.nowMs);
    }
    return state;
  },
});

// ---------------------------------------------------------------------------
// step 5 — confirm (deterministic ZERO-LLM template → the typed output)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: DigestStateSchema,
  outputSchema: DailyDigestOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);

    if (state.skipped) {
      return {
        outcome: "skipped" as const,
        reason: "no_active_profile" as const,
        summary:
          "No active search to summarize — run /search_profile_intake to start one, " +
          "then re-run /daily_digest.",
      };
    }

    const payload = asPayload(state.payload);
    const profilesSummarized = payload.profiles.length;
    const totalQuotes = payload.profiles.reduce((n, g) => n + g.totalQuotes, 0);
    const totalNeeds = payload.profiles.reduce((n, g) => n + g.needsResponseCount, 0);
    const totalQuestions = payload.profiles.reduce((n, g) => n + g.unansweredQuestionCount, 0);

    const summary =
      `Digest ready for ${profilesSummarized} active search(es): ` +
      `${totalQuotes} quote(s)` +
      (payload.overallBestOtd !== null
        ? `, lowest out-the-door $${Math.round(payload.overallBestOtd).toLocaleString("en-US")}`
        : "") +
      `. ${totalNeeds} reply(ies) awaiting your response, ${totalQuestions} open question(s). ` +
      "Saved to your local digest archive.";

    return {
      outcome: "generated" as const,
      searchProfileId: state.searchProfileId,
      artifactPath: state.artifactPath ?? "",
      sectionsCount: DIGEST_SECTIONS_COUNT,
      profilesSummarized,
      bestOtd: payload.overallBestOtd,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (6 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const dailyDigestWorkflow = createWorkflow({
  id: "daily_digest",
  inputSchema: DailyDigestInputSchema,
  outputSchema: DailyDigestOutputSchema,
})
  .then(resolveScopeStep)
  .then(gatherStep)
  .then(writeArtifactStep)
  .then(notifyStep)
  .then(setWatermarkStep)
  .then(confirmStep)
  .commit();

/** The workflow id, exported for registration + the server descriptor. */
export const DAILY_DIGEST_WORKFLOW_ID = "daily_digest" as const;
