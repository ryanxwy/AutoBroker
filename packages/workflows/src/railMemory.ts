/**
 * railMemory — the chat-rail Mastra Memory thread store (M2; BACKEND_SERVICES §3.1
 * + §6 "sessions = Mastra Memory threads", AI_ORCHESTRATION §8/§9 + D-AI-6).
 *
 * A dashboard chat-rail session IS a Mastra Memory thread (BACKEND_SERVICES §6,
 * 2026-06-03 ruling: 1 rail = 1 Memory thread = 1 search profile). The pinned
 * profile lives in thread metadata (`pinnedProfileId`) — NOT in the product
 * `sessions` table (that table is parity-frozen in schema; the new product never
 * writes it). This module owns the ONLY construction of `@mastra/memory` Memory
 * in the codebase, so the app layer can do session CRUD through a product-shaped
 * facade (RailSessionStore) without ever importing `@mastra/*` (the dependency
 * wall: Mastra is invisible outside `@autobroker/workflows`).
 *
 * SAME mastra.db (D1 dual-DB): the Memory store points at `<dataDir>/mastra.db`
 * — the SAME @mastra/libsql file the Mastra workflow instance uses (createMastra
 * Instance) — never the product autobroker.db. Threads + working memory persist
 * beside the workflow snapshots; both are framework runtime state, not product
 * schema. resolveDataDir() (the single tilde-expansion owner, in tools) keeps
 * this from drifting from where mastra.db lives.
 *
 * OM (observational memory) — RAIL-ONLY, model EXPLICIT (USER DIRECTIVE
 * 2026-06-05, HARD REQUIREMENT): wherever Memory/observationalMemory is
 * configured, the OM model MUST be set explicitly to the DeepSeek model via
 * resolveModel from @autobroker/model — NEVER the @mastra/memory default. The
 * library default model is google/gemini-2.5-flash, which would SILENTLY call
 * Gemini (a different provider, off-policy spend, and an undisclosed egress).
 * We pin it to the deepseek.chat tier (deepseek-v4-flash — the rail chat model
 * per AI_ORCHESTRATION §8.1, where OM runs ON only on the chat-rail thread).
 * OM is NEVER enabled inside a skill workflow run (mastra#14598 residue, load-
 * bearing constraint, AI_ORCHESTRATION §8.1) — this Memory is the chat rail's,
 * not the intake workflow's. For M2 scope OM is CONFIGURED but NOT exercised
 * against a live LLM (no live calls this run; live OM was spike-4-proven).
 *
 * Dependency wall: imports @mastra/* (legal only here) + @autobroker/model
 * (resolveModel — the LanguageModel type flows in by inference, no `ai` import)
 * + @autobroker/tools (resolveDataDir). Never opens the product DB.
 */

import { join } from "node:path";

import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { resolveModel } from "@autobroker/model";
import { resolveDataDir } from "@autobroker/tools";

/**
 * The exact `observationalMemory.model` field type the Memory constructor wants,
 * derived from its own signature (no deep @mastra/memory subpath import). The
 * resolveModel() result is cast to this — see createRailMemory for the api-finding
 * on why the cast is faithful (cross-copy @ai-sdk/provider type skew).
 */
type RailMemoryOptions = NonNullable<NonNullable<ConstructorParameters<typeof Memory>[0]>["options"]>;
type RailObservationalMemoryModel = Extract<
  RailMemoryOptions["observationalMemory"],
  { model?: unknown }
>["model"];

/** The single-user product's Memory resourceId (one local user). The thread's
 *  resourceId scopes a session to this user; listThreads filters on it. */
export const RAIL_RESOURCE_ID = "local-user" as const;

/** The thread-metadata key carrying the pinned search profile (BACKEND_SERVICES
 *  §6.1: legacy `sessions.pinned_profile_id` → thread metadata `pinnedProfileId`). */
export const PIN_METADATA_KEY = "pinnedProfileId" as const;

/**
 * A product-shaped session, projected from a Mastra Memory thread. The route
 * layer maps this to the snake_case SessionResponse wire shape (BACKEND_SERVICES
 * §6.2); this facade stays product-neutral (camelCase, no wire concern) so the
 * app never touches a Mastra StorageThreadType.
 */
export interface RailSession {
  /** The Memory thread id = the session identity (SessionResponse.id). */
  threadId: string;
  /** Human-facing rail title; null until the first user turn names it. */
  title: string | null;
  /** The pinned search profile id from thread metadata, or null (unpinned). */
  pinnedProfileId: string | null;
  /** Thread creation timestamp (ISO-8601 UTC). */
  createdAt: string;
  /** Thread last-activity timestamp (ISO-8601 UTC) — list sort key DESC. */
  lastActivityAt: string;
}

/** Read `pinnedProfileId` out of thread metadata, normalizing absent/empty to
 *  null. An empty string is a cleared pin (BACKEND_SERVICES §3.1 PATCH: pin ∈
 *  (null,"") → clear). */
function pinFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const raw = metadata?.[PIN_METADATA_KEY];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

/** Coerce a thread timestamp (Date | string | undefined) to an ISO string. */
function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

/** The minimal StorageThreadType surface this facade reads (decoupled from the
 *  exact @mastra/core type so the projection is explicit and testable). */
interface ThreadLike {
  id: string;
  title?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Project a Mastra thread onto the product RailSession shape. */
function projectThread(thread: ThreadLike): RailSession {
  return {
    threadId: thread.id,
    title: thread.title ?? null,
    pinnedProfileId: pinFromMetadata(thread.metadata),
    createdAt: isoOf(thread.createdAt),
    lastActivityAt: isoOf(thread.updatedAt),
  };
}

/**
 * Construct the chat-rail Memory instance (the ONLY Memory construction in the
 * codebase). Storage = the SAME `<dataDir>/mastra.db` the workflow instance uses
 * (D1). OM is configured (rail-only) with its model PINNED EXPLICITLY to the
 * DeepSeek tier via resolveModel — see the USER DIRECTIVE in the header: never
 * the @mastra/memory default (google/gemini-2.5-flash) which would silently call
 * Gemini.
 */
export function createRailMemory(): Memory {
  // Belt: keep Mastra's telemetry boot path off (honored since core 1.37.0),
  // mirroring createMastraInstance — Memory may construct collaborators that
  // touch the same telemetry init.
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";

  const mastraDbPath = join(resolveDataDir(), "mastra.db");
  const storage = new LibSQLStore({
    id: "autobroker-rail-memory",
    url: `file:${mastraDbPath}`,
  });

  return new Memory({
    storage,
    options: {
      // OM ON for the chat rail (rail-only; never a skill workflow run). The
      // model is the LOAD-BEARING explicit set (USER DIRECTIVE 2026-06-05): pin
      // to deepseek.chat (deepseek-v4-flash) so OM never silently routes to the
      // library-default Gemini. resolveModel returns the AI SDK LanguageModel;
      // the `as` is the SAME faithful cast harness.ts uses for `new Agent({
      // model })` (api-finding: `ai`'s LanguageModelV2 and @mastra's resolution
      // of the provider spec are the SAME runtime shape but skew at the type
      // level across the two @ai-sdk/provider copies — a type-only mismatch).
      observationalMemory: {
        model: resolveModel("deepseek.chat") as unknown as RailObservationalMemoryModel,
      },
      // No vector store installed → semantic recall stays OFF (AI_ORCHESTRATION
      // §8.1: "semantic recall 也始终关 (无向量库)"). Leaving `vector` unset on
      // the Memory ctor means RAG recall does not run.
    },
  });
}

/**
 * RailSessionStore — the product-shaped session CRUD facade over a rail Memory
 * instance. The app's session routes call these methods; they never import
 * `@mastra/memory`. Every method projects to/from the RailSession shape so the
 * wall stays intact and the wire-case projection lives in the route layer.
 *
 * pin semantics live HERE in product terms: create/patch set or clear
 * `pinnedProfileId` in thread metadata (BACKEND_SERVICES §6.1); list-by-pin
 * filters on it (§3.1 / D-B5: 0/1/2+ counts come from this query, no count
 * endpoint).
 */
export class RailSessionStore {
  constructor(private readonly memory: Memory) {}

  /**
   * Create a new session (Mastra thread) for the single local user. `pinned
   * ProfileId` (when given) lands in thread metadata; null/absent → unpinned.
   * Intake forks an unpinned session (D-AI-6) by passing pinnedProfileId: null.
   */
  async createSession(args: {
    title?: string | null;
    pinnedProfileId?: string | null;
  }): Promise<RailSession> {
    const metadata: Record<string, unknown> =
      args.pinnedProfileId != null && args.pinnedProfileId.length > 0
        ? { [PIN_METADATA_KEY]: args.pinnedProfileId }
        : {};
    const thread = await this.memory.createThread({
      resourceId: RAIL_RESOURCE_ID,
      ...(args.title != null ? { title: args.title } : {}),
      metadata,
      saveThread: true,
    });
    return projectThread(thread as ThreadLike);
  }

  /** Read one session by thread id, or null when absent. */
  async getSession(threadId: string): Promise<RailSession | null> {
    const thread = await this.memory.getThreadById({ threadId });
    return thread === null ? null : projectThread(thread as ThreadLike);
  }

  /**
   * List the local user's sessions, newest-first by last-activity (BACKEND_
   * SERVICES §3.1: last_activity_at DESC). `pinnedProfileId` filters to the
   * sessions bound to that profile (list-by-pin, the 0/1/2+ count driver).
   */
  async listSessions(filter?: { pinnedProfileId?: string }): Promise<RailSession[]> {
    const out = await this.memory.listThreads({
      perPage: false,
      orderBy: { field: "updatedAt", direction: "DESC" },
      filter: {
        resourceId: RAIL_RESOURCE_ID,
        ...(filter?.pinnedProfileId !== undefined
          ? { metadata: { [PIN_METADATA_KEY]: filter.pinnedProfileId } }
          : {}),
      },
    });
    return out.threads.map((t) => projectThread(t as ThreadLike));
  }

  /**
   * Patch a session's pin and/or title. Returns the updated session, or null
   * when the thread is absent.
   *
   * api-finding (live-probed @mastra/libsql@1.12.1 updateThread): metadata is
   * SHALLOW-MERGED — `metadata: {...existing, ...patch}`. Deleting a key from
   * the patch object does NOT remove it from storage. So CLEARING the pin sets
   * `pinnedProfileId` to "" (empty string), which projectThread/pinFromMetadata
   * read back as null. We pass ONLY the changed keys (the merge keeps the rest);
   * title must always be passed (updateThread replaces it), so we read-modify it.
   *
   * PIN null-vs-omitted (BACKEND_SERVICES §3.1, the load-bearing PATCH
   * semantic): the CALLER distinguishes "field omitted" (leave the pin as-is)
   * from "field present and null/empty" (clear the pin) — an omitted field never
   * silently clears, a present null/"" clears.
   */
  async patchSession(
    threadId: string,
    changes: {
      /** Present iff the title field was sent (null → clears to ""). */
      title?: { value: string | null };
      /** Present iff the pin field was sent (value null/"" clears the pin). */
      pin?: { value: string | null };
    },
  ): Promise<RailSession | null> {
    const current = await this.memory.getThreadById({ threadId });
    if (current === null) return null;
    const cur = current as ThreadLike;

    // Title: updateThread REPLACES title (not merge), so pass the new value when
    // sent else carry the current one forward.
    const nextTitle =
      changes.title !== undefined ? (changes.title.value ?? "") : (cur.title ?? "");

    // Pin: only the pin key goes in the patch (shallow-merge keeps other keys).
    // A present null/empty CLEARS by writing "" (read back as null); a real id
    // sets it. Omitted → no pin key in the patch → unchanged.
    const metadataPatch: Record<string, unknown> = {};
    if (changes.pin !== undefined) {
      const v = changes.pin.value;
      metadataPatch[PIN_METADATA_KEY] = v == null || v.length === 0 ? "" : v;
    }

    const updated = await this.memory.updateThread({
      id: threadId,
      title: nextTitle,
      metadata: metadataPatch,
    });
    return projectThread(updated as ThreadLike);
  }

  /** Delete a session (cascades the thread's Memory messages). */
  async deleteSession(threadId: string): Promise<void> {
    await this.memory.deleteThread(threadId);
  }
}
