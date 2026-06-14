/**
 * L1 unit tests — the inbox discovery pure engine. Freezes:
 *   - the 4-pass query strings + the contact/token batch sizes (15 / 20);
 *   - dealer token extraction: stop-set drop, >3-char floor, website host stem,
 *     sorted/dedup-stable;
 *   - first-pass-wins thread dedupe (later sightings union messageIds);
 *   - the deterministic quoted/replied classifier.
 *
 * Pure — no DB, no clock, no network.
 */

import { describe, expect, it } from "vitest";

import {
  buildInboxQueries,
  classifyThread,
  CONTACT_BATCH_SIZE,
  dealerTokens,
  DEALER_TOKEN_BATCH_SIZE,
  dedupeThreadHits,
  type ThreadHit,
} from "./discovery.js";

describe("dealerTokens", () => {
  it("keeps alnum name words >3 chars, drops the stop-set, adds the host stem, sorted+dedup", () => {
    const tokens = dealerTokens("Bob Smith Hyundai of Tucson", "https://www.bobsmithhyundai.com/x");
    // "Bob"(3, dropped by >3), "Smith", "Hyundai"(not in stop-set), "Tucson",
    // "of"(too short) — plus the host stem "bobsmithhyundai". "Hyundai" stays
    // (the stop-set is {auto,ford,toyota,honda,dealer}).
    expect(tokens).toContain("smith");
    expect(tokens).toContain("hyundai");
    expect(tokens).toContain("tucson");
    expect(tokens).toContain("bobsmithhyundai");
    expect(tokens).not.toContain("bob"); // 3 chars — not > 3
    expect(tokens).not.toContain("of");
    // sorted + stable
    expect(tokens).toEqual([...tokens].sort());
  });

  it("drops generic stop-set words and a www prefix on the host stem", () => {
    // stop-set word "auto" as a standalone name word is dropped; the compound
    // "autonation" survives. "ford" is in the stop-set → dropped.
    const tokens = dealerTokens("Auto Nation Ford", "https://www.autonationford.net");
    expect(tokens).not.toContain("auto"); // standalone stop-set word
    expect(tokens).toContain("nation");
    expect(tokens).not.toContain("ford"); // stop-set
    expect(tokens).toContain("autonationford"); // host stem (registrable label, www dropped)
  });

  it("tolerates a null / empty website (name tokens only) and drops <=3-char words", () => {
    // "Kia" is exactly 3 chars → dropped by the >3 floor; "Premier" survives.
    expect(dealerTokens("Premier Kia", null)).toEqual(["premier"]);
    expect(dealerTokens("Premier Kia", "")).toEqual(["premier"]);
  });
});

describe("buildInboxQueries", () => {
  const base = {
    make: "Hyundai",
    model: "Tucson",
    year: 2026,
    window: "2d",
  };

  it("emits the 4 passes in order, each carrying the newer_than window clause", () => {
    const qs = buildInboxQueries({
      ...base,
      contactEmails: ["a@dealer.com"],
      dealerTokens: ["smith"],
    });
    expect(qs[0]).toBe("subject:Tucson newer_than:2d"); // pass A
    expect(qs[1]).toBe("Tucson newer_than:2d"); // pass B
    expect(qs[2]).toBe("from:a@dealer.com newer_than:2d"); // pass C
    expect(qs[3]).toBe("smith newer_than:2d"); // pass D
    for (const q of qs) expect(q).toContain("newer_than:2d");
  });

  it("batches known contacts 15 per query", () => {
    const emails = Array.from({ length: 32 }, (_, i) => `c${i}@dealer.com`);
    const qs = buildInboxQueries({ ...base, contactEmails: emails, dealerTokens: [] });
    // passes A + B + ceil(32/15)=3 contact-batch queries.
    const contactQueries = qs.slice(2);
    expect(contactQueries).toHaveLength(Math.ceil(32 / CONTACT_BATCH_SIZE));
    expect((contactQueries[0]!.match(/from:/g) ?? []).length).toBe(CONTACT_BATCH_SIZE);
  });

  it("batches dealer tokens 20 per query", () => {
    const tokens = Array.from({ length: 45 }, (_, i) => `tok${i}`);
    const qs = buildInboxQueries({ ...base, contactEmails: [], dealerTokens: tokens });
    const tokenQueries = qs.slice(2);
    expect(tokenQueries).toHaveLength(Math.ceil(45 / DEALER_TOKEN_BATCH_SIZE));
    expect((tokenQueries[0]!.match(/ OR /g) ?? []).length).toBe(DEALER_TOKEN_BATCH_SIZE - 1);
  });
});

describe("dedupeThreadHits — first-pass-wins", () => {
  it("keeps the first pass's order and unions later messageIds for the same thread", () => {
    const passA: ThreadHit[] = [
      { threadId: "t1", messageIds: ["m1"] },
      { threadId: "t2", messageIds: ["m2"] },
    ];
    const passB: ThreadHit[] = [
      { threadId: "t2", messageIds: ["m2", "m3"] }, // t2 re-seen + a new message
      { threadId: "t3", messageIds: ["m4"] },
    ];
    const out = dedupeThreadHits([passA, passB]);
    expect(out.map((h) => h.threadId)).toEqual(["t1", "t2", "t3"]); // first-seen order
    const t2 = out.find((h) => h.threadId === "t2")!;
    expect(t2.messageIds).toEqual(["m2", "m3"]); // union, no dup
  });

  it("is a no-op on an empty pass list", () => {
    expect(dedupeThreadHits([])).toEqual([]);
    expect(dedupeThreadHits([[]])).toEqual([]);
  });
});

describe("classifyThread", () => {
  it("marks a thread quoted when any message names a price/quote signal", () => {
    expect(
      classifyThread([
        { subject: "Re: availability", bodyText: "Sale price is 33,995 before tax." },
      ]),
    ).toBe("quoted");
    expect(
      classifyThread([{ subject: "OTD quote attached", bodyText: "see the PDF" }]),
    ).toBe("quoted");
    expect(
      classifyThread([{ subject: "hi", bodyText: "still working on it" }, { subject: "", bodyText: "$32,100 out-the-door" }]),
    ).toBe("quoted");
  });

  it("marks a thread replied when no message carries a quote signal", () => {
    expect(
      classifyThread([
        { subject: "Re: your inquiry", bodyText: "Thanks for reaching out, come on in!" },
      ]),
    ).toBe("replied");
    expect(classifyThread([])).toBe("replied");
  });
});
