/**
 * Path resolution for the reset's two on-disk DBs.
 *
 * The product DB path mirrors @autobroker/db's client resolution: AUTOBROKER_DB
 * (an explicit file path) overrides everything; otherwise it is
 * `<dataDir>/autobroker.db`. The mastra runtime DB is always `<dataDir>/mastra.db`
 * (the @mastra/libsql store path — see the workflows-layer mastra instance).
 *
 * Resolving these HERE (rather than re-reading the env inside reset.ts) keeps the
 * destructive path's targets explicit and testable: a test points dataDir at a
 * tmp dir and these two functions name exactly the files the reset touches.
 */

import { join } from "node:path";

/** The product DB file for `dataDir`. AUTOBROKER_DB (explicit path) wins so the
 *  reset deletes the SAME file the app opens. */
export function resolveProductDbPath(dataDir: string): string {
  const explicit = process.env.AUTOBROKER_DB;
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(dataDir, "autobroker.db");
}

/** The mastra runtime DB file for `dataDir` (workflow snapshots + Memory). */
export function resolveMastraDbPath(dataDir: string): string {
  return join(dataDir, "mastra.db");
}
