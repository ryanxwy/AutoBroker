/**
 * L1 unit tests — the CRM-relay sender detector. Freezes suffix matching over
 * the known CRM/lead-platform host table (a sub-domained relay still matches; a
 * dealer's own mailbox does not). Pure.
 */

import { describe, expect, it } from "vitest";

import { CRM_PLATFORM_HOSTS, detectCrmPlatformSender } from "./crm.js";

describe("detectCrmPlatformSender", () => {
  it("flags a known CRM platform host", () => {
    expect(detectCrmPlatformSender("noreply@podium.email")).toBe(true);
    expect(detectCrmPlatformSender("lead@carleadsup.com")).toBe(true);
  });

  it("flags a sub-domained relay of a known host (suffix match)", () => {
    expect(detectCrmPlatformSender("bounce@mail.podium.email")).toBe(true);
  });

  it("does NOT flag a dealer's own mailbox", () => {
    expect(detectCrmPlatformSender("sales@bobsmithhyundai.com")).toBe(false);
    expect(detectCrmPlatformSender("john@example-dealer.com")).toBe(false);
  });

  it("does NOT flag a host that merely contains a CRM host as a substring (not a suffix)", () => {
    expect(detectCrmPlatformSender("x@podium.email.evil.com")).toBe(false);
  });

  it("returns false on a malformed address", () => {
    expect(detectCrmPlatformSender("not-an-email")).toBe(false);
    expect(detectCrmPlatformSender("trailing@")).toBe(false);
  });

  it("keeps the host table closed and lowercase", () => {
    for (const h of CRM_PLATFORM_HOSTS) expect(h).toBe(h.toLowerCase());
    expect(CRM_PLATFORM_HOSTS.length).toBeGreaterThan(0);
  });
});
