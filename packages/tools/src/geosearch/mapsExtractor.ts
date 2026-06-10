/**
 * Google Maps results-feed extractor for dealer_geosearch.
 *
 * `mapsExtractor` is the page-side function handed to the browser session's
 * `extract`/`extractWithFallback` — it executes INSIDE the page via
 * page.evaluate, so it must be fully self-contained: no closure over module
 * imports, every regex and helper inlined. The DOM-walking is kept thin; the
 * parsing rules it inlines are mirrored by the exported pure helpers
 * (`parseMapsHref`, `parseRatingLabel`, `isServiceCenterTypeLine`) so they
 * stay unit-testable outside a browser.
 *
 * Maps occasionally renames data-tooltip keys / role attributes; when the
 * evaluate path returns incomplete rows the caller falls back to the rendered
 * snapshot (see `needsFallback`) — degraded, voiced, never silent.
 */

import type { DealerCandidate } from "@autobroker/core";

// ---------------------------------------------------------------------------
// Pure parsing helpers (the same rules the page function inlines).
// ---------------------------------------------------------------------------

/** Maps result hrefs encode the place id as `!1s0x…:0x…` and the result
 *  coordinates as `!3d<lat>!4d<lng>`. */
const PLACE_ID_RE = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i;
const LAT_LNG_RE = /!3d(-?[\d.]+)!4d(-?[\d.]+)/;
const RATING_RE = /([\d.]+)\s+stars\s+([\d,]+)\s+Review/i;

/** Extract `google_place_id` + `latitude`/`longitude` from a Maps result
 *  href. Each piece is independently nullable — a feed href may carry either,
 *  both, or neither. */
export function parseMapsHref(href: string): {
  google_place_id: string | null;
  latitude: number | null;
  longitude: number | null;
} {
  const place = PLACE_ID_RE.exec(href);
  const coords = LAT_LNG_RE.exec(href);
  return {
    google_place_id: place === null ? null : place[1]!,
    latitude: coords === null ? null : Number.parseFloat(coords[1]!),
    longitude: coords === null ? null : Number.parseFloat(coords[2]!),
  };
}

/** Parse "<float> stars <int(,int)> Reviews" (the stars-image aria-label, or
 *  the same phrase in card text). Null when the text carries no rating. */
export function parseRatingLabel(text: string): {
  rating: number;
  review_count: number;
} | null {
  const m = RATING_RE.exec(text);
  if (m === null) return null;
  return {
    rating: Number.parseFloat(m[1]!),
    review_count: Number.parseInt(m[2]!.replace(/,/g, ""), 10),
  };
}

/** Service/parts/repair-only category line — names service work and does NOT
 *  name a dealer/dealership. Null (no category found) is conservatively NOT
 *  service-only. */
export function isServiceCenterTypeLine(typeLine: string | null): boolean {
  if (typeLine === null) return false;
  return (
    /service center|parts|repair/i.test(typeLine) &&
    !/dealer|dealership/i.test(typeLine)
  );
}

// ---------------------------------------------------------------------------
// Fallback decision.
// ---------------------------------------------------------------------------

/** A row missing any of these triggers the snapshot fallback — without place
 *  id + coordinates the dedup key and the distance filter have nothing to
 *  work with. This is the `required` list for `extractWithFallback`. */
export const MAPS_EXTRACT_REQUIRED_FIELDS = [
  "latitude",
  "longitude",
  "google_place_id",
] as const;

/**
 * True when the evaluate extraction must fall back to the snapshot: zero rows
 * came back, or any row is missing one of the required fields above. Mirrors
 * the browser session's `rowsComplete` rule (the evaluate path wins only when
 * ≥1 row came back AND every row is complete).
 */
export function needsFallback(rows: readonly DealerCandidate[]): boolean {
  return (
    rows.length === 0 ||
    rows.some((row) =>
      MAPS_EXTRACT_REQUIRED_FIELDS.some((key) => row[key] === null),
    )
  );
}

// ---------------------------------------------------------------------------
// The page-side extractor.
// ---------------------------------------------------------------------------

/** Minimal structural slice of a DOM element the extractor touches — typed
 *  locally because tools is a Node package (no DOM lib in tsconfig). */
export interface MapsDomElement {
  getAttribute(name: string): string | null;
  querySelector(selectors: string): MapsDomElement | null;
  closest(selectors: string): MapsDomElement | null;
  parentElement: MapsDomElement | null;
  textContent: string | null;
  /** Present on HTMLElements in the real DOM; preserves line breaks. */
  innerText?: string;
}

/** Minimal structural slice of `document`. */
export interface MapsDomDocument {
  querySelectorAll(selectors: string): ArrayLike<MapsDomElement>;
}

/**
 * Read every dealer card off the Maps results feed into the 12-field
 * candidate shape (explicit null for anything unreadable). Read-only — it
 * never clicks, fills, or mutates the page.
 */
export function mapsExtractor(): DealerCandidate[] {
  // Inlined twins of the module-level helpers — page.evaluate serializes this
  // function alone, so it cannot reference anything outside its own body.
  const placeIdRe = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i;
  const latLngRe = /!3d(-?[\d.]+)!4d(-?[\d.]+)/;
  const ratingRe = /([\d.]+)\s+stars\s+([\d,]+)\s+Review/i;
  const usPhoneRe = /\(\d{3}\) \d{3}-\d{4}/;
  const serviceRe = /service center|parts|repair/i;
  const dealerRe = /dealer|dealership/i;
  const categoryRe = /dealer|dealership|service center|parts|repair/i;

  const doc = (globalThis as { document?: MapsDomDocument }).document;
  if (doc === undefined) return [];

  const rows: DealerCandidate[] = [];
  const seenCards: MapsDomElement[] = [];
  const anchors = doc.querySelectorAll('a[href*="/maps/place/"]');

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    const href = anchor.getAttribute("href") ?? "";

    // One row per result card; a card may contain several /maps/place/ links.
    const card = anchor.closest('[role="article"]') ?? anchor.parentElement;
    if (card === null || seenCards.indexOf(card) !== -1) continue;
    seenCards.push(card);

    const place = placeIdRe.exec(href);
    const coords = latLngRe.exec(href);

    // Card text, line-split (innerText keeps line breaks; textContent is the
    // single-string fallback for environments without it).
    const text = card.innerText ?? card.textContent ?? "";
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");

    // Name: the main result link's aria-label, else the card heading.
    let name = anchor.getAttribute("aria-label");
    if (name === null || name.trim() === "") {
      const heading = card.querySelector('[role="heading"]');
      name =
        heading === null
          ? null
          : (heading.getAttribute("aria-label") ?? heading.textContent);
    }
    name = name === null || name.trim() === "" ? null : name.trim();

    // Rating + review count: stars-image aria-label, else the card text.
    const starsEl = card.querySelector(
      'img[aria-label*="stars"], [role="img"][aria-label*="stars"]',
    );
    const ratingText =
      (starsEl === null ? null : starsEl.getAttribute("aria-label")) ?? text;
    const ratingMatch = ratingRe.exec(ratingText);
    const rating = ratingMatch === null ? null : Number.parseFloat(ratingMatch[1]!);
    const reviewCount =
      ratingMatch === null
        ? null
        : Number.parseInt(ratingMatch[2]!.replace(/,/g, ""), 10);

    // Website + sponsored. An /aclk href is an ad-click redirect, never a
    // usable site URL: null it and flag the row sponsored.
    let sponsored = lines.indexOf("Sponsored") !== -1;
    let website: string | null = null;
    const siteAnchor = card.querySelector(
      'a[data-tooltip="website"], a[aria-label^="Visit "]',
    );
    if (siteAnchor !== null) {
      const siteHref = siteAnchor.getAttribute("href");
      if (siteHref !== null && siteHref !== "") {
        if (siteHref.indexOf("/aclk") !== -1) {
          sponsored = true;
        } else {
          website = siteHref;
        }
      }
    }

    // type_line: the first "·"-separated text segment naming a business
    // category (e.g. "Hyundai dealer · 123 Auto Center Dr" → "Hyundai dealer").
    let typeLine: string | null = null;
    for (const line of lines) {
      const segments = line.split("·").map((s) => s.trim());
      const hit = segments.find((s) => categoryRe.test(s));
      if (hit !== undefined) {
        typeLine = hit;
        break;
      }
    }

    // Address: explicit tooltip first, else the "·"-segment that starts with
    // a street number.
    const addressEl = card.querySelector('[data-tooltip="address"]');
    let address =
      addressEl === null ? null : (addressEl.textContent ?? "").trim() || null;
    if (address === null) {
      for (const line of lines) {
        const segments = line.split("·").map((s) => s.trim());
        const hit = segments.find((s) => /^\d+\s+\S/.test(s) && !usPhoneRe.test(s));
        if (hit !== undefined) {
          address = hit;
          break;
        }
      }
    }

    // Phone: explicit tooltip first, else the first US-shaped number in text.
    const phoneEl = card.querySelector('[data-tooltip="phone"]');
    let phone =
      phoneEl === null ? null : (phoneEl.textContent ?? "").trim() || null;
    if (phone === null) {
      const phoneMatch = usPhoneRe.exec(text);
      phone = phoneMatch === null ? null : phoneMatch[0];
    }

    rows.push({
      name,
      address,
      phone,
      website,
      google_place_id: place === null ? null : place[1]!,
      latitude: coords === null ? null : Number.parseFloat(coords[1]!),
      longitude: coords === null ? null : Number.parseFloat(coords[2]!),
      rating,
      review_count: reviewCount,
      type_line: typeLine,
      sponsored,
      service_center:
        typeLine !== null && serviceRe.test(typeLine) && !dealerRe.test(typeLine),
    });
  }

  return rows;
}
