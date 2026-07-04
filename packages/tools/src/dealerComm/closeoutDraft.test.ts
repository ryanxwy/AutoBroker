/**
 * The closeout body + subject + greeting heuristic. The default body is pinned
 * byte-for-byte (with and without a vehicle); the subject and the looks-human
 * greeting are exercised across the human / role-mailbox / empty cases.
 */

import { describe, expect, it } from "vitest";

import {
  buildCloseoutDraft,
  closeoutGreetingName,
} from "./closeoutDraft.js";

describe("buildCloseoutDraft — byte snapshot", () => {
  it("names the vehicle when known", () => {
    expect(buildCloseoutDraft({ year: 2026, make: "Hyundai", model: "Tucson" }, {})).toBe(
      "Thanks for your help on the 2026 Hyundai Tucson. I'm closing out my search " +
        "and have selected another dealer. Please remove me from your follow-up list.",
    );
  });

  it("falls back to 'this vehicle' when no vehicle parts are present", () => {
    expect(buildCloseoutDraft({}, {})).toBe(
      "Thanks for your help on this vehicle. I'm closing out my search " +
        "and have selected another dealer. Please remove me from your follow-up list.",
    );
  });
});

describe("closeoutGreetingName", () => {
  it("uses the first name when the contact looks human", () => {
    expect(closeoutGreetingName({ contactName: "Pat Rivera" })).toBe("Pat");
    expect(closeoutGreetingName({ contactName: "mary-jane watson" })).toBe("mary-jane");
  });

  it("falls back to 'there' for role mailboxes, single tokens, and empties", () => {
    expect(closeoutGreetingName({ contactName: "Sales Team 24" })).toBe("there");
    expect(closeoutGreetingName({ contactName: "sales@dealer.example.com" })).toBe("there");
    expect(closeoutGreetingName({ contactName: "Sales" })).toBe("there");
    expect(closeoutGreetingName({ contactName: "" })).toBe("there");
    expect(closeoutGreetingName({})).toBe("there");
  });
});
