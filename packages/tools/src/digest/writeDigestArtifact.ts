/**
 * writeDigestArtifact — the durable local digest archive. The rendered digest
 * text is written atomically (temp file + rename) into
 * `<dataDir>/digests/digest-<nowMs>.md`, mkdir -p'ing the `digests/` dir first.
 * Mirrors the temp-then-rename discipline the incentive registry writer uses
 * so a crashed write never leaves a half-written artifact in place.
 *
 * The data dir is the caller-supplied isolated dir (always resolved through
 * AUTOBROKER_DATA_DIR upstream), so a harness run's artifact lives and dies
 * with its throwaway dir. Returns the absolute artifact path.
 *
 * BUDGET RED-LINE: this writer does NOT inspect the text — the caller MUST run
 * `assertNoBudget(text)` BEFORE calling this (the workflow's writeArtifact step
 * does exactly that). The writer is a dumb, safe file sink.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WriteDigestArtifactArgs {
  /** The isolated data dir (env-resolved upstream). */
  dataDir: string;
  /** Epoch-ms "now" — the artifact filename stamp. */
  nowMs: number;
}

/**
 * Write `text` atomically into `<dataDir>/digests/digest-<nowMs>.md`. Returns
 * the absolute path of the landed artifact.
 */
export function writeDigestArtifact(text: string, args: WriteDigestArtifactArgs): string {
  const digestsDir = join(args.dataDir, "digests");
  mkdirSync(digestsDir, { recursive: true });
  const finalPath = join(digestsDir, `digest-${args.nowMs}.md`);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, text, "utf8");
  renameSync(tmpPath, finalPath);
  return finalPath;
}
