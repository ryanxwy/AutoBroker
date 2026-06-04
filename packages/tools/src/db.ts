/**
 * DB tool — Layer-4 surface over the @autobroker/db connection factory.
 *
 * The REAL connection factory (WAL + busy_timeout=5000 + tilde-expanded
 * AUTOBROKER_DATA_DIR / AUTOBROKER_DB resolution) lives in
 * @autobroker/db/client. This file only re-exports it so higher layers reach
 * the single factory through the tools surface. Do NOT duplicate the factory
 * here — two openDb implementations is how the two-writers risk creeps back.
 *
 * ISOLATION INVARIANT: never touch production ~/.autobroker/autobroker.db. The
 * data dir comes from AUTOBROKER_DATA_DIR (parity period => ~/.autobroker-ts,
 * isolated from the legacy Python repo). Subprocesses inherit and re-resolve it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export { openDb, type Db } from "@autobroker/db";

/** Resolve the active data directory, honoring the isolation env. Used for
 *  non-DB artifacts (fake-mailbox files, logs, exports) that live beside the
 *  two DB files (autobroker.db + mastra.db). Tilde-expanded — Node does not. */
export function resolveDataDir(): string {
  const dir = process.env.AUTOBROKER_DATA_DIR ?? join(homedir(), ".autobroker-ts");
  return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
}
