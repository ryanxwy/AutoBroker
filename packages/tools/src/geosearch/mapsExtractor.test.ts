/**
 * L1 unit tests — Maps feed extraction. The pure helpers are pinned against
 * realistic Maps hrefs/labels; `mapsExtractor` itself (the page.evaluate
 * function) is exercised against a minimal structural fake DOM so its walking
 * logic and inlined parsing rules stay covered without a browser.
 */

import { describe, expect, it } from "vitest";
import type { DealerCandidate } from "@autobroker/core";
import {
  MAPS_EXTRACT_REQUIRED_FIELDS,
  isServiceCenterTypeLine,
  mapsExtractor,
  needsFallback,
  parseMapsHref,
  parseRatingLabel,
  type MapsDomDocument,
  type MapsDomElement,
} from "./mapsExtractor.js";

// A realistic Maps result href: place id (!1s…), coordinates (!3d…!4d…).
const REAL_HREF =
  "https://www.google.com/maps/place/Tustin+Hyundai/data=!4m7!3m6" +
  "!1s0x80dcd9410d57bedb:0x71fe9c4831b56b1!8m2!3d33.7421199!4d-117.820848" +
  "!16s%2Fg%2F1tdsh21q?authuser=0&hl=en&rclk=1";

describe("parseMapsHref", () => {
  it("extracts the place id and coordinates from a real-shaped href", () => {
    expect(parseMapsHref(REAL_HREF)).toEqual({
      google_place_id: "0x80dcd9410d57bedb:0x71fe9c4831b56b1",
      latitude: 33.7421199,
      longitude: -117.820848,
    });
  });

  it("each piece is independently nullable", () => {
    expect(parseMapsHref("https://www.google.com/maps/place/X/data=!8m2!3d47.6!4d-122.3")).toEqual({
      google_place_id: null,
      latitude: 47.6,
      longitude: -122.3,
    });
    expect(parseMapsHref("https://www.google.com/maps/place/X/data=!1s0xab:0xcd")).toEqual({
      google_place_id: "0xab:0xcd",
      latitude: null,
      longitude: null,
    });
    expect(parseMapsHref("https://example.com/")).toEqual({
      google_place_id: null,
      latitude: null,
      longitude: null,
    });
  });
});

describe("parseRatingLabel", () => {
  it('parses the stars aria-label shape "4.5 stars 1,234 Reviews"', () => {
    expect(parseRatingLabel("4.5 stars 1,234 Reviews")).toEqual({
      rating: 4.5,
      review_count: 1234,
    });
  });

  it("returns null when no rating phrase is present", () => {
    expect(parseRatingLabel("Open ⋅ Closes 9 PM")).toBeNull();
  });
});

describe("isServiceCenterTypeLine", () => {
  it("service/parts/repair without dealer → true", () => {
    expect(isServiceCenterTypeLine("Auto repair shop")).toBe(true);
    expect(isServiceCenterTypeLine("Hyundai service center")).toBe(true);
    expect(isServiceCenterTypeLine("Auto parts store")).toBe(true);
  });

  it("a dealer category is never service-only, even when it names service", () => {
    expect(isServiceCenterTypeLine("Hyundai dealer")).toBe(false);
    expect(isServiceCenterTypeLine("Car dealer & repair")).toBe(false);
  });

  it("null category (nothing found) is conservatively NOT service-only", () => {
    expect(isServiceCenterTypeLine(null)).toBe(false);
  });
});

describe("needsFallback", () => {
  const complete: DealerCandidate = {
    name: "X",
    address: null,
    phone: null,
    website: null,
    google_place_id: "0xa:0x1",
    latitude: 33.7,
    longitude: -117.8,
    rating: null,
    review_count: null,
    type_line: null,
    sponsored: false,
    service_center: false,
  };

  it("zero rows → fallback", () => {
    expect(needsFallback([])).toBe(true);
  });

  it("all rows complete on {latitude, longitude, google_place_id} → no fallback", () => {
    expect(MAPS_EXTRACT_REQUIRED_FIELDS).toEqual(["latitude", "longitude", "google_place_id"]);
    expect(needsFallback([complete, complete])).toBe(false);
  });

  it("any row missing any required field → fallback", () => {
    expect(needsFallback([complete, { ...complete, google_place_id: null }])).toBe(true);
    expect(needsFallback([{ ...complete, latitude: null }])).toBe(true);
    expect(needsFallback([{ ...complete, longitude: null }])).toBe(true);
  });

  it("missing narration-only fields do NOT trigger fallback", () => {
    expect(needsFallback([{ ...complete, name: null, website: null }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapsExtractor against a minimal structural fake DOM.
// ---------------------------------------------------------------------------

interface FakeElOpts {
  attrs?: Record<string, string>;
  /** Used for both innerText and textContent. */
  text?: string;
  /** Exact selector string → element (the extractor uses fixed selectors). */
  selectorHits?: Record<string, FakeEl | null>;
  closestHits?: Record<string, FakeEl | null>;
  parent?: FakeEl | null;
}

class FakeEl implements MapsDomElement {
  private readonly attrs: Record<string, string>;
  private readonly selectorHits: Record<string, FakeEl | null>;
  private readonly closestHits: Record<string, FakeEl | null>;
  readonly parentElement: FakeEl | null;
  readonly textContent: string | null;
  readonly innerText?: string;

  constructor(opts: FakeElOpts = {}) {
    this.attrs = opts.attrs ?? {};
    this.selectorHits = opts.selectorHits ?? {};
    this.closestHits = opts.closestHits ?? {};
    this.parentElement = opts.parent ?? null;
    this.textContent = opts.text ?? null;
    if (opts.text !== undefined) this.innerText = opts.text;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
  }
  querySelector(selectors: string): MapsDomElement | null {
    return this.selectorHits[selectors] ?? null;
  }
  closest(selectors: string): MapsDomElement | null {
    return this.closestHits[selectors] ?? null;
  }
}

const STARS_SELECTOR = 'img[aria-label*="stars"], [role="img"][aria-label*="stars"]';
const WEBSITE_SELECTOR = 'a[data-tooltip="website"], a[aria-label^="Visit "]';

function runWithDocument(anchors: FakeEl[]): DealerCandidate[] {
  const doc: MapsDomDocument = { querySelectorAll: () => anchors };
  const g = globalThis as { document?: MapsDomDocument };
  g.document = doc;
  try {
    return mapsExtractor();
  } finally {
    delete g.document;
  }
}

/** A fully-populated organic dealer card + its main result anchor. */
function dealerCard(): { anchor: FakeEl; card: FakeEl } {
  const card = new FakeEl({
    text: [
      "Tustin Hyundai",
      "4.5(1,234)",
      "Hyundai dealer · 16 Auto Center Dr",
      "Open ⋅ Closes 9 PM · (714) 555-0188",
      "Visit website",
    ].join("\n"),
    selectorHits: {
      [STARS_SELECTOR]: new FakeEl({
        attrs: { "aria-label": "4.5 stars 1,234 Reviews" },
      }),
      [WEBSITE_SELECTOR]: new FakeEl({
        attrs: { href: "https://www.tustinhyundai.com/", "data-tooltip": "website" },
      }),
    },
  });
  const anchor = new FakeEl({
    attrs: { href: REAL_HREF, "aria-label": "Tustin Hyundai" },
    closestHits: { '[role="article"]': card },
  });
  return { anchor, card };
}

describe("mapsExtractor (fake DOM)", () => {
  it("returns [] when no document exists (defensive, never throws)", () => {
    expect(mapsExtractor()).toEqual([]);
  });

  it("reads a complete organic card into the 12-field shape", () => {
    const { anchor } = dealerCard();
    const rows = runWithDocument([anchor]);
    expect(rows).toEqual([
      {
        name: "Tustin Hyundai",
        address: "16 Auto Center Dr",
        phone: "(714) 555-0188",
        website: "https://www.tustinhyundai.com/",
        google_place_id: "0x80dcd9410d57bedb:0x71fe9c4831b56b1",
        latitude: 33.7421199,
        longitude: -117.820848,
        rating: 4.5,
        review_count: 1234,
        type_line: "Hyundai dealer",
        sponsored: false,
        service_center: false,
      },
    ]);
  });

  it("emits ONE row per card even when a card has several place links", () => {
    const { anchor, card } = dealerCard();
    const secondLink = new FakeEl({
      attrs: { href: REAL_HREF },
      closestHits: { '[role="article"]': card },
    });
    expect(runWithDocument([anchor, secondLink])).toHaveLength(1);
  });

  it("/aclk website href → sponsored=true and website=null", () => {
    const card = new FakeEl({
      text: "Ad Dealer\nHyundai dealer · 1 Ad Way",
      selectorHits: {
        [WEBSITE_SELECTOR]: new FakeEl({
          attrs: { href: "https://www.google.com/aclk?sa=l&ai=xyz" },
        }),
      },
    });
    const anchor = new FakeEl({
      attrs: { href: REAL_HREF, "aria-label": "Ad Dealer" },
      closestHits: { '[role="article"]': card },
    });
    const rows = runWithDocument([anchor]);
    expect(rows[0]!.sponsored).toBe(true);
    expect(rows[0]!.website).toBeNull();
  });

  it('a "Sponsored" card label flags the row even with a clean website', () => {
    const card = new FakeEl({
      text: "Sponsored\nPaid Dealer\nHyundai dealer",
      selectorHits: {
        [WEBSITE_SELECTOR]: new FakeEl({ attrs: { href: "https://paid.example.com" } }),
      },
    });
    const anchor = new FakeEl({
      attrs: { href: REAL_HREF, "aria-label": "Paid Dealer" },
      closestHits: { '[role="article"]': card },
    });
    const rows = runWithDocument([anchor]);
    expect(rows[0]!.sponsored).toBe(true);
    expect(rows[0]!.website).toBe("https://paid.example.com");
  });

  it("classifies a repair-only category as service_center", () => {
    const card = new FakeEl({ text: "Quick Fix\nAuto repair shop · 12 Wrench St" });
    const anchor = new FakeEl({
      attrs: { href: REAL_HREF, "aria-label": "Quick Fix" },
      closestHits: { '[role="article"]': card },
    });
    const rows = runWithDocument([anchor]);
    expect(rows[0]!.type_line).toBe("Auto repair shop");
    expect(rows[0]!.service_center).toBe(true);
  });

  it("falls back to the card heading when the anchor has no aria-label", () => {
    const card = new FakeEl({
      text: "Heading Dealer\nHyundai dealer",
      selectorHits: {
        '[role="heading"]': new FakeEl({ text: "Heading Dealer" }),
      },
    });
    const anchor = new FakeEl({
      attrs: { href: REAL_HREF },
      closestHits: { '[role="article"]': card },
    });
    expect(runWithDocument([anchor])[0]!.name).toBe("Heading Dealer");
  });

  it("emits explicit nulls (never undefined) for unreadable fields", () => {
    // "Motors", not "Dealer" — a name containing a category keyword would
    // legitimately be picked up as the type_line.
    const card = new FakeEl({ text: "Bare Motors" });
    const anchor = new FakeEl({
      attrs: { href: "https://www.google.com/maps/place/bare" },
      closestHits: { '[role="article"]': card },
    });
    const rows = runWithDocument([anchor]);
    expect(rows[0]).toEqual({
      name: null,
      address: null,
      phone: null,
      website: null,
      google_place_id: null,
      latitude: null,
      longitude: null,
      rating: null,
      review_count: null,
      type_line: null,
      sponsored: false,
      service_center: false,
    });
    // A row this bare is exactly what trips the snapshot fallback.
    expect(needsFallback(rows)).toBe(true);
  });
});
