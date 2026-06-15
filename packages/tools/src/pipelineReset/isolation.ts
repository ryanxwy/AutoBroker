/**
 * The prod-DB-reject guard for the DESTRUCTIVE reset.
 *
 * A full backup-and-wipe must NEVER touch the production tree ~/.autobroker.
 * This mirrors the gmail.ts real-backend denylist EXACTLY: the one forbidden
 * subtree is ~/.autobroker; everything else — the
 * isolated parity tree ~/.autobroker-ts AND any dev / throwaway / tmp dir —
 * passes. Denylist not allowlist, so a mis-set data dir defaults SAFE only for
 * the prod tree; the reset is otherwise scoped to whatever isolated dir the run
 * envelope points at.
 *
 * Pure (resolves paths only).
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Thrown when a reset targets the production data tree. */
export class PipelineResetRefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PipelineResetRefusedError";
  }
}

/** True iff `dataDir` is the production tree ~/.autobroker (or under it). */
export function isProductionDataDir(dataDir: string): boolean {
  const resolved = resolve(dataDir);
  const productionDir = join(homedir(), ".autobroker");
  return resolved === productionDir || resolved.startsWith(productionDir + sep);
}

/**
 * Assert the reset target is an ISOLATED data dir (NOT the production tree).
 * Throws {@link PipelineResetRefusedError} when the dir is ~/.autobroker or
 * under it — the single forbidden subtree. The isolated parity tree
 * ~/.autobroker-ts and any throwaway dir pass.
 */
export function assertIsolatedDataDir(dataDir: string): void {
  if (isProductionDataDir(dataDir)) {
    throw new PipelineResetRefusedError(
      `refuse: pipeline reset against the production data dir ~/.autobroker (${resolve(dataDir)})`,
    );
  }
}
