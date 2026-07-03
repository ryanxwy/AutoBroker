/**
 * runner.retention.test.ts — the PURE date-filter behind the harness-runs
 * evidence retention sweep. FS-free by construction: it exercises
 * expiredRunDirNames over a fixed name list + a fixed `now`, asserting the
 * timestamp-name scope and the age cutoff. It never touches the real FS.
 */

import { describe, expect, it } from "vitest";

import { expiredRunDirNames } from "./runner.js";

// Midnight UTC so the day-bucket cutoff lands on clean date boundaries.
const NOW = new Date("2026-07-03T00:00:00Z");

describe("expiredRunDirNames", () => {
  it("returns timestamp run dirs strictly older than the window", () => {
    const names = [
      "2026-06-01T01-00-00-000Z", // 32 days old → expired
      "2026-06-30T09-00-00-000Z", // 3 days old → keep
      "2026-07-03T00-00-00-000Z", // today → keep
    ];
    expect(expiredRunDirNames(names, NOW, 14)).toEqual(["2026-06-01T01-00-00-000Z"]);
  });

  it("never returns a non-timestamped entry (root autobroker.db* stays)", () => {
    const names = ["autobroker.db", "autobroker.db-wal", "autobroker.db-shm", "2025-01-01T00-00-00-000Z"];
    expect(expiredRunDirNames(names, NOW, 14)).toEqual(["2025-01-01T00-00-00-000Z"]);
  });

  it("boundary: exactly maxAgeDays old is kept, one day past is expired", () => {
    // NOW day-bucket - 14d = 2026-06-19 (kept); 2026-06-18 (expired).
    expect(expiredRunDirNames(["2026-06-19T23-59-00-000Z"], NOW, 14)).toEqual([]);
    expect(expiredRunDirNames(["2026-06-18T00-00-00-000Z"], NOW, 14)).toEqual(["2026-06-18T00-00-00-000Z"]);
  });

  it("ignores names that start with digits but are not the timestamp shape", () => {
    expect(expiredRunDirNames(["2026-06-01", "2026-06-01-run", "20260601T00"], NOW, 14)).toEqual([]);
  });
});
