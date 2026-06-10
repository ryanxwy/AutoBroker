/**
 * sessions — the app-side chat-rail session service. Sessions ARE Mastra Memory
 * threads; this service drives the workflows-layer RailSessionStore (the ONLY
 * @mastra/memory construction) and owns the WIRE-CASE projection + the
 * intake-from-pinned fork contract. It never imports @mastra directly (the
 * RailSession product shape flows in from the workflows export) and never opens
 * the product DB.
 *
 * WIRE CASE (load-bearing): request bodies are camelCase (`pinnedProfileId`);
 * response bodies are snake_case (`pinned_profile_id`). The edge never
 * normalizes — the UI store consumes the server's raw shape. The SessionResponse
 * projection is centralized here.
 *
 * PATCH null-vs-omitted (the load-bearing PATCH semantic): the route hands this
 * service a discriminator that distinguishes "field omitted" (leave as-is) from
 * "field present and null/empty" (clear the pin). An omitted pin NEVER silently
 * clears.
 *
 * INTAKE FORK (intake-from-pinned fork rule): starting intake from a PINNED
 * session forks a NEW UNPINNED session and renders a non-skippable
 * IntakeScopeNotice as that new session's first system part; intake itself never
 * inherits or sets a pin. The original session is left UNTOUCHED. Starting from an
 * unpinned session (or first-launch) forks a fresh unpinned session with NO notice
 * (nothing to confuse).
 *
 * Dependency wall: app layer. Imports workflows (RailSessionStore) and skills
 * (the intake skill id) — never @mastra, never the product DB.
 */

import { INTAKE_SKILL_ID } from "@autobroker/skills";
import {
  RailSessionStore,
  type RailSession,
} from "@autobroker/workflows";

/** The snake_case SessionResponse wire shape. */
export interface SessionResponse {
  id: string;
  title: string | null;
  created_at: string;
  last_activity_at: string;
  pinned_profile_id: string | null;
  archived: boolean;
}

/** Project a product RailSession onto the snake_case wire SessionResponse. The
 *  product never writes the frozen `sessions` table, so `archived` has no Mastra
 *  thread backing yet — it is always false today (the wire field is preserved
 *  for shape compatibility; an archive lane is a later lifecycle skill). */
export function toSessionResponse(s: RailSession): SessionResponse {
  return {
    id: s.threadId,
    title: s.title,
    created_at: s.createdAt,
    last_activity_at: s.lastActivityAt,
    pinned_profile_id: s.pinnedProfileId,
    archived: false,
  };
}

/**
 * The IntakeScopeNotice structured part (intake-from-pinned fork rule). A
 * non-skippable system notice rendered as the forked session's FIRST message when
 * intake is started from a pinned session. Three-point content; `kind` lets a
 * single SSE/transcript consumer switch on it, and `[data-intake-scope-notice]`
 * is the UI selector.
 */
export interface IntakeScopeNotice {
  kind: "intake_scope_notice";
  /** The pinned profile id of the SOURCE session this fork came from. */
  source_pinned_profile_id: string;
  /** The new unpinned session intake will run in. */
  forked_session_id: string;
  /** The three non-skippable points. */
  points: [string, string, string];
}

/** Build the three-point IntakeScopeNotice content. The pinned-profile label is
 *  left to the UI (it has the make/model); the backend carries the ids + the
 *  structural three points. */
function buildIntakeScopeNotice(
  sourcePinnedProfileId: string,
  forkedSessionId: string,
): IntakeScopeNotice {
  return {
    kind: "intake_scope_notice",
    source_pinned_profile_id: sourcePinnedProfileId,
    forked_session_id: forkedSessionId,
    points: [
      "Creating a NEW search profile — this does not modify the profile pinned to the current session.",
      "Pin and work on the new profile in this new session; intake auto-binds the pin when it lands at the new profile's workspace.",
      "The original session stays pinned to its profile and can only act on that profile (1 session = 1 profile).",
    ],
  };
}

/** The result of forking an intake session. `scopeNotice` is present ONLY when
 *  the fork came from a pinned source session. */
export interface IntakeForkResult {
  /** The new unpinned session intake will run in. */
  sessionId: string;
  /** The non-skippable scope notice (pinned source only), else null. */
  scopeNotice: IntakeScopeNotice | null;
}

/**
 * SessionService — the app-side facade over the rail Memory thread store. Owns
 * the wire-case projection, the PATCH null-vs-omitted pin semantics, and the
 * intake-from-pinned fork rule.
 */
export class SessionService {
  constructor(private readonly store: RailSessionStore) {}

  /** POST /api/sessions — create a thread; an optional pin lands in metadata. */
  async create(args: {
    title?: string | null;
    pinnedProfileId?: string | null;
  }): Promise<SessionResponse> {
    const session = await this.store.createSession({
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.pinnedProfileId !== undefined ? { pinnedProfileId: args.pinnedProfileId } : {}),
    });
    return toSessionResponse(session);
  }

  /** GET /api/sessions/:id — read one, or null (route maps to 404). */
  async get(threadId: string): Promise<SessionResponse | null> {
    const session = await this.store.getSession(threadId);
    return session === null ? null : toSessionResponse(session);
  }

  /**
   * GET /api/sessions — list newest-first; an optional pinned_profile_id filters
   * to that profile's sessions (list-by-pin, the 0/1/2+ count driver).
   */
  async list(filter?: { pinnedProfileId?: string }): Promise<SessionResponse[]> {
    const sessions = await this.store.listSessions(
      filter?.pinnedProfileId !== undefined ? { pinnedProfileId: filter.pinnedProfileId } : undefined,
    );
    return sessions.map(toSessionResponse);
  }

  /**
   * PATCH /api/sessions/:id — title and/or pin, with null-vs-omitted semantics.
   * The CALLER passes discriminators ({value} present iff the field was sent); an
   * omitted field is left as-is, a present null/empty clears the pin. Returns null
   * when the thread is absent (route → 404).
   */
  async patch(
    threadId: string,
    changes: { title?: { value: string | null }; pin?: { value: string | null } },
  ): Promise<SessionResponse | null> {
    const updated = await this.store.patchSession(threadId, changes);
    return updated === null ? null : toSessionResponse(updated);
  }

  /** DELETE /api/sessions/:id — remove the thread (cascades messages). */
  async delete(threadId: string): Promise<void> {
    await this.store.deleteSession(threadId);
  }

  /**
   * Fork an UNPINNED session to start intake (intake-from-pinned fork rule).
   * `fromSessionId` is the session the user triggered intake from
   * (slash/freeform), if any:
   *   - source session is PINNED → fork a fresh unpinned session AND build a
   *     non-skippable IntakeScopeNotice (the new session's first system part).
   *   - source session is unpinned, absent, or none (first-launch) → fork a
   *     fresh unpinned session with NO notice (nothing to confuse).
   * The source session is NEVER mutated; intake never inherits or sets a pin.
   */
  async forkForIntake(fromSessionId?: string | null): Promise<IntakeForkResult> {
    let sourcePin: string | null = null;
    if (fromSessionId != null && fromSessionId.length > 0) {
      const source = await this.store.getSession(fromSessionId);
      sourcePin = source?.pinnedProfileId ?? null;
    }

    // Always a FRESH unpinned session (pinnedProfileId: null) — intake creates a
    // new profile and must not inherit the old pin.
    const forked = await this.store.createSession({
      title: `New ${INTAKE_SKILL_ID}`,
      pinnedProfileId: null,
    });

    const scopeNotice =
      sourcePin !== null ? buildIntakeScopeNotice(sourcePin, forked.threadId) : null;
    return { sessionId: forked.threadId, scopeNotice };
  }
}
