/** Atomic writer for the single local file:// digest snapshot. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WriteDigestHtmlSnapshotArgs {
  dataDir: string;
}
/** Replace `<dataDir>/digests/latest.html` via a same-directory temp file. */
export function writeDigestHtmlSnapshot(
  html: string,
  args: WriteDigestHtmlSnapshotArgs,
): string {
  const digestsDir = join(args.dataDir, "digests");
  mkdirSync(digestsDir, { recursive: true });
  const finalPath = join(digestsDir, "latest.html");
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, html, "utf8");
  renameSync(tmpPath, finalPath);
  return finalPath;
}
