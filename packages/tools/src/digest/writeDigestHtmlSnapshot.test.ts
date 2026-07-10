import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeDigestHtmlSnapshot } from "./writeDigestHtmlSnapshot.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "autobroker-digest-html-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("writeDigestHtmlSnapshot", () => {
  it("atomically replaces digests/latest.html without a temp-file remainder", () => {
    const first = writeDigestHtmlSnapshot("<p>first</p>", { dataDir });
    const second = writeDigestHtmlSnapshot("<p>second</p>", { dataDir });

    expect(first).toBe(join(dataDir, "digests", "latest.html"));
    expect(second).toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("<p>second</p>");
    expect(readdirSync(join(dataDir, "digests"))).toEqual(["latest.html"]);
  });
});
