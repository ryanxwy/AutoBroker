/**
 * L1 unit tests — the digest artifact writer. Freezes the atomic write into
 * `<dataDir>/digests/digest-<nowMs>.md`, the mkdir -p of the digests dir, the
 * absolute-path return, and a clean directory after the write (no leftover
 * .tmp file). Isolated under an os.tmpdir() throwaway dir.
 */

import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeDigestArtifact } from "./writeDigestArtifact.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "autobroker-digestart-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("writeDigestArtifact", () => {
  it("writes to <dataDir>/digests/digest-<nowMs>.md and returns the absolute path", () => {
    const path = writeDigestArtifact("# Daily digest\n\nbody\n", { dataDir, nowMs: 1_750_000_000_000 });
    expect(path).toBe(join(dataDir, "digests", "digest-1750000000000.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("# Daily digest\n\nbody\n");
  });

  it("mkdir -p's the digests dir on first write", () => {
    expect(existsSync(join(dataDir, "digests"))).toBe(false);
    writeDigestArtifact("x", { dataDir, nowMs: 1 });
    expect(existsSync(join(dataDir, "digests"))).toBe(true);
  });

  it("leaves no .tmp leftover after the atomic rename", () => {
    writeDigestArtifact("x", { dataDir, nowMs: 42 });
    const entries = readdirSync(join(dataDir, "digests"));
    expect(entries).toEqual(["digest-42.md"]);
  });
});
