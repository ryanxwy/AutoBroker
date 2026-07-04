/**
 * profileView.test — the pure label helpers (snapshot projection, ZIP
 * distillation) the rail pin chip and canvas strip render from.
 */

import { describe, expect, it } from "vitest";

import type { ProfileRow } from "../api/wire.js";
import { toSnapshot, zipOf } from "./profileView.js";

describe("zipOf — the rail pinned-search ZIP", () => {
  it("prefers a clean postal_code column", () => {
    const snap = toSnapshot({ postal_code: "92614", location_query: "Irvine, CA" } as ProfileRow);
    expect(snap.postalCode).toBe("92614");
    expect(zipOf(snap)).toBe("92614");
  });

  it("parses a 5-digit ZIP out of location_query when postal_code is absent", () => {
    const snap = toSnapshot({ location_query: "Irvine, CA 92614" } as ProfileRow);
    expect(snap.postalCode).toBeNull();
    expect(zipOf(snap)).toBe("92614");
  });

  it("falls back to location_query when postal_code is not a bare ZIP", () => {
    const snap = toSnapshot({ postal_code: "not-a-zip", location_query: "Brooklyn, NY 11201" } as ProfileRow);
    expect(zipOf(snap)).toBe("11201");
  });

  it("drops a +4 suffix, returning the bare 5-digit ZIP", () => {
    const snap = toSnapshot({ postal_code: "92614-1234" } as ProfileRow);
    expect(zipOf(snap)).toBe("92614");
  });

  it("does NOT grab a leading street number from location_query (end-anchored)", () => {
    const snap = toSnapshot({ location_query: "12345 Main St, New York" } as ProfileRow);
    expect(zipOf(snap)).toBeNull();
  });

  it("returns null when neither yields a ZIP", () => {
    const snap = toSnapshot({ location_query: "New York" } as ProfileRow);
    expect(zipOf(snap)).toBeNull();
  });
});
