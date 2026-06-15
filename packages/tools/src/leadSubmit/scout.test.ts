/**
 * leadSubmit/scout tests — pure module, no I/O. Covers the platform fingerprint
 * + contact-path probe set, the payload assembler's safety locks (fake phone,
 * consent checked, SMS omitted, budget redacted, byte-stable), and the US gate
 * partition.
 */

import { describe, expect, it } from "vitest";

import { FAKE_PHONE_DEFAULT } from "../dealerComm/constants.js";
import {
  buildLeadPayload,
  contactPathFor,
  CONTACT_PATHS,
  partitionUsDealers,
  platformOf,
  type FormFieldRole,
  type LeadPayloadProfile,
  type ScoutDealerRow,
} from "./scout.js";

// ---------------------------------------------------------------------------
// platformOf
// ---------------------------------------------------------------------------

describe("platformOf", () => {
  it("fingerprints DealerFire from its HTML attribution", () => {
    expect(platformOf('<footer>Powered by DealerFire</footer>')).toBe("dealerfire");
    expect(platformOf("<meta name=generator content=DealerFire>")).toBe("dealerfire");
  });

  it("fingerprints DealerFire from its /contact.htm path", () => {
    expect(platformOf("https://jimclickhyundai.com/contact.htm")).toBe("dealerfire");
  });

  it("fingerprints DealerOn v1 from attribution and from /contact-us/", () => {
    expect(platformOf("<!-- site built on DealerOn -->")).toBe("dealeron_v1");
    expect(platformOf("https://example-ford.com/contact-us/")).toBe("dealeron_v1");
  });

  it("fingerprints DealerOn v2 from the .aspx contact endpoint before v1", () => {
    // The .aspx path is the v2 token and must win over the broader v1 "DealerOn".
    expect(platformOf("https://example-ford.com/contactus.aspx")).toBe("dealeron_v2");
  });

  it("falls back to custom when no known marker hits", () => {
    expect(platformOf("<html><body>just a homepage</body></html>")).toBe("custom");
    expect(platformOf("https://boutique-dealer.com/get-in-touch")).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// contactPathFor
// ---------------------------------------------------------------------------

describe("contactPathFor", () => {
  const origin = "https://dealer.example.com";

  it("puts the fingerprinted platform's path FIRST, then the other known paths", () => {
    expect(contactPathFor("dealeron_v2", origin)).toEqual([
      `${origin}/contactus.aspx`,
      `${origin}/contact.htm`,
      `${origin}/contact-us/`,
    ]);
  });

  it("returns the three known paths (declared order) for a custom platform", () => {
    expect(contactPathFor("custom", origin)).toEqual([
      `${origin}/contact.htm`,
      `${origin}/contact-us/`,
      `${origin}/contactus.aspx`,
    ]);
  });

  it("resolves paths against the given origin, dropping any origin path component", () => {
    const probes = contactPathFor("dealerfire", "https://d.example.com/home/");
    expect(probes[0]).toBe("https://d.example.com/contact.htm");
  });

  it("never repeats a path", () => {
    const probes = contactPathFor("dealerfire", origin);
    expect(new Set(probes).size).toBe(probes.length);
    expect(probes.length).toBe(3);
  });

  it("the custom contact path is empty (LLM-mapped, no canned probe of its own)", () => {
    expect(CONTACT_PATHS.custom).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildLeadPayload
// ---------------------------------------------------------------------------

const FIELD_MAP: FormFieldRole[] = [
  { name: "first_name", role: "name" },
  { name: "email_address", role: "email" },
  { name: "phone_number", role: "phone" },
  { name: "zip", role: "zip" },
  { name: "comments", role: "comment" },
  { name: "tcpa_consent", role: "consent" },
  { name: "sms_optin", role: "sms_optin" },
  { name: "honeypot", role: "other" },
];

const PROFILE: LeadPayloadProfile = {
  year: 2024,
  make: "Hyundai",
  model: "Tucson",
  trim: "SEL",
  financingPreference: "finance",
  followUpEmail: "jordan.buyer@example.com",
  postalCode: "92614",
};

function build(profile: LeadPayloadProfile = PROFILE) {
  return buildLeadPayload({
    formUrl: "https://dealer.example.com/contact.htm",
    profile,
    fieldMap: FIELD_MAP,
    submitSelector: "button[type=submit]",
  });
}

describe("buildLeadPayload", () => {
  it("LOCKS the phone field to the fake phone, never the buyer's real number", () => {
    const form = build();
    expect(form.fields.phone_number).toBe(FAKE_PHONE_DEFAULT);
    expect(form.fields.phone_number).toBe("(555) 010-0000");
  });

  it("CHECKS the consent field with 'on'", () => {
    expect(build().fields.tcpa_consent).toBe("on");
  });

  it("OMITS the sms_optin field entirely (unchecked)", () => {
    const form = build();
    expect(form.fields).not.toHaveProperty("sms_optin");
    expect("sms_optin" in form.fields).toBe(false);
  });

  it("never fills an 'other' field", () => {
    expect(build().fields).not.toHaveProperty("honeypot");
  });

  it("fills email and zip from the profile", () => {
    const form = build();
    expect(form.fields.email_address).toBe("jordan.buyer@example.com");
    expect(form.fields.zip).toBe("92614");
  });

  it("fills the comment with the redacted first-touch body and the name with the signature", () => {
    const form = build();
    const comment = form.fields.comments ?? "";
    expect(comment).toContain("out-the-door (OTD) quote");
    // The signature is the body's sign-off line (capitalized email local part).
    expect(form.fields.first_name).toBe("Jordan");
    expect(comment.trimEnd().endsWith("Jordan")).toBe(true);
  });

  it("carries the form URL and submit selector through unchanged", () => {
    const form = build();
    expect(form.url).toBe("https://dealer.example.com/contact.htm");
    expect(form.submitSelector).toBe("button[type=submit]");
  });

  it("redacts any budget figure out of the comment (no $-amount reaches the dealer)", () => {
    // A budget figure smuggled in via a free-text field must be redacted, and
    // the belt assertNoBudget must not fire (the value is already redacted).
    const form = build({
      ...PROFILE,
      tradeInDescription: "2018 Civic, my budget is $30,000",
    });
    const comment = form.fields.comments ?? "";
    expect(comment).not.toMatch(/\$\s?\d/);
    expect(comment.toLowerCase()).not.toContain("$30,000");
    expect(comment).toContain("[redacted]");
  });

  it("is byte-stable for the same profile + field map", () => {
    expect(build()).toEqual(build());
    expect(build().fields.comments).toBe(build().fields.comments);
  });
});

// ---------------------------------------------------------------------------
// partitionUsDealers
// ---------------------------------------------------------------------------

describe("partitionUsDealers", () => {
  it("splits US dealers from non-US (the hard gate, in one batched call)", () => {
    const rows: ScoutDealerRow[] = [
      { dealer_id: "us-country", country: "US" },
      { dealer_id: "ca-country", country: "CA" },
      { dealer_id: "ca-tld", website: "https://example-motors.ca" },
      { dealer_id: "us-state", state: "AZ" },
      { dealer_id: "ca-province", state: "BC" },
      { dealer_id: "ca-city", name: "Bannister Kia Chilliwack" },
      { dealer_id: "sparse-default-us" }, // all-null → default-trust US.
    ];
    const { us, nonUs } = partitionUsDealers(rows);
    expect(us.map((r) => r.dealer_id).sort()).toEqual(
      ["sparse-default-us", "us-country", "us-state"].sort(),
    );
    expect(nonUs.map((r) => r.dealer_id).sort()).toEqual(
      ["ca-city", "ca-country", "ca-province", "ca-tld"].sort(),
    );
  });

  it("preserves extra row fields through the partition", () => {
    const rows = [
      { dealer_id: "d1", country: "US", website: "https://a.com", extra: 1 },
      { dealer_id: "d2", country: "CA", extra: 2 },
    ];
    const { us, nonUs } = partitionUsDealers(rows);
    expect(us[0]?.extra).toBe(1);
    expect(nonUs[0]?.extra).toBe(2);
  });

  it("handles an empty batch", () => {
    expect(partitionUsDealers([])).toEqual({ us: [], nonUs: [] });
  });
});
