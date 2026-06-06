/**
 * The Mastra instance (LIBRARY MODE), storage on disk.
 *
 * A Mastra instance in library mode, persisting runtime state to mastra.db. The
 * instance runs as a plain in-process library — NO `mastra dev`, NO Hono/Cloud
 * server, NO bundler/deployer. It exists only so skill `createWorkflow`s and the
 * chat-rail Memory can persist durable state (suspend/resume snapshots, threads).
 *
 * Dual-DB never-co-write: framework runtime state lives in its OWN
 * `mastra.db` (a dedicated @mastra/libsql file in ~/.autobroker-ts), beside —
 * never inside — the product `autobroker.db`. Mastra's `mastra_*` tables must
 * never appear in autobroker.db. We get the data dir from @autobroker/tools'
 * `resolveDataDir()` (the single tilde-expansion owner) so we cannot drift from
 * where the product DB lives; we never re-implement that resolution here, and
 * (per the dependency wall) workflows never opens a SQLite connection itself —
 * @mastra/libsql owns mastra.db; the product DB stays behind the tools layer.
 *
 * Telemetry: this is library mode, so we keep Mastra's OTEL/telemetry boot path
 * off. `MASTRA_TELEMETRY_DISABLED=1` is honored by @mastra/core since 1.37.0;
 * we set it (defensively, with ??=) as the FIRST line of construction. See the
 * api-finding note below: @mastra/core@1.41 has NO in-`Config` telemetry-disable
 * flag — its tracing entrypoint is the optional `observability` field (needs
 * @mastra/observability, which we do not install), so leaving `observability`
 * unset already means no exporter runs. The env var is belt, not load-bearing.
 *
 * Dependency wall: this file imports @mastra/* (legal only in workflows) and
 * @autobroker/tools (for resolveDataDir) — never @autobroker/db, never SQLite.
 */

import { join } from "node:path";

import { Mastra } from "@mastra/core";
import type { Workflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { resolveDataDir } from "@autobroker/tools";

/** Options for {@link createMastraInstance}. */
export interface CreateMastraInstanceOptions {
  /**
   * Skill workflows to register, keyed by id. The Mastra constructor key is
   * `workflows` (NOT `vNext` — that pre-1.x split was unified). Each value is a
   * `Workflow` from `@mastra/core/workflows` (`createWorkflow(...)`).
   */
  workflows?: Record<string, Workflow>;
}

/**
 * Construct a library-mode Mastra instance with @mastra/libsql storage pointed
 * at `<dataDir>/mastra.db`. No server, no Cloud — just durable persistence.
 */
export function createMastraInstance(
  options?: CreateMastraInstanceOptions,
): Mastra {
  // Boot-sequence step 1 (defensive belt; see header). Honored since core
  // 1.37.0. ??= so an explicit operator override (e.g. '0') is respected.
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";

  const mastraDbPath = join(resolveDataDir(), "mastra.db");

  // LibSQLConfig requires `id` and (for a local file) a `url` with the `file:`
  // scheme. We do NOT set `disableInit`: auto-init (table creation/migration)
  // stays on so the first read/write — or an explicit storage.init() — lands the
  // mastra_* tables in mastra.db.
  const storage = new LibSQLStore({
    id: "autobroker-mastra",
    url: `file:${mastraDbPath}`,
  });

  // `storage` and `workflows` are the real @mastra/core@1.41 Config keys.
  // No `telemetry` key exists on Config (see api-finding); tracing would be the
  // optional `observability` entrypoint, left unset → no exporter runs.
  return new Mastra({
    storage,
    ...(options?.workflows ? { workflows: options.workflows } : {}),
  });
}

let singleton: Mastra | undefined;

/**
 * Lazy process-wide singleton over {@link createMastraInstance}. First call
 * constructs and pins the instance (resolving the data dir at that moment);
 * later calls return the same instance.
 */
export function getMastra(): Mastra {
  singleton ??= createMastraInstance();
  return singleton;
}

/**
 * Drop the cached singleton so the next {@link getMastra} re-constructs. Needed
 * by tests that re-point AUTOBROKER_DATA_DIR between cases; not for production
 * use (the data dir is fixed for a process lifetime in normal operation).
 */
export function resetMastraForTests(): void {
  singleton = undefined;
}
