/**
 * The submit-classification precedence and the retry state machine. Pins each
 * bucket's trigger (captcha ignores status; accepted needs a 2xx/3xx; email_only
 * needs mailto without a form) and the retry table edges (captcha/email_only
 * never retried; unknown retries until the bound then falls back to email).
 */

import { describe, expect, it } from "vitest";

import {
  classifySubmitOutcome,
  hasCaptcha,
  normalizeFormFieldName,
  requiredFieldSet,
  retryStrategy,
} from "./submitOutcome.js";

describe("hasCaptcha", () => {
  it("is true for each captcha marker (case-insensitive)", () => {
    expect(hasCaptcha('<div class="g-recaptcha"></div>')).toBe(true);
    expect(hasCaptcha('<div class="H-Captcha">')).toBe(true);
    expect(hasCaptcha("Please Verify You Are Human")).toBe(true);
  });

  it("is false for a clean contact form with no captcha", () => {
    expect(
      hasCaptcha('<form><input name="email"/><textarea name="message"></textarea></form>'),
    ).toBe(false);
  });
});

describe("classifySubmitOutcome", () => {
  it("captcha wins regardless of status", () => {
    expect(classifySubmitOutcome('<div class="g-recaptcha"></div>', 200)).toBe("captcha");
    expect(classifySubmitOutcome('<div class="h-captcha">', 500)).toBe("captcha");
    expect(classifySubmitOutcome("Please Verify You Are Human", 403)).toBe("captcha");
  });

  it("accepted needs a thank-you marker AND a 2xx/3xx status", () => {
    expect(classifySubmitOutcome("<h1>Thank you for your inquiry</h1>", 200)).toBe("accepted");
    expect(classifySubmitOutcome("thanks for reaching out", 302)).toBe("accepted");
    expect(classifySubmitOutcome("thank-you", 399)).toBe("accepted");
    // a thank-you at a non-2xx status is NOT accepted.
    expect(classifySubmitOutcome("Thank you", 500)).toBe("unknown");
  });

  it("email_only needs mailto without a form", () => {
    expect(classifySubmitOutcome('contact <a href="mailto:sales@example.com">us</a>', 200)).toBe(
      "email_only",
    );
    // a mailto alongside a form is not email_only.
    expect(
      classifySubmitOutcome('<form></form> <a href="mailto:sales@example.com">', 200),
    ).toBe("unknown");
  });

  it("falls through to unknown", () => {
    expect(classifySubmitOutcome("<html><body>ok</body></html>", 200)).toBe("unknown");
  });
});

describe("retryStrategy", () => {
  it("accepted always stops", () => {
    expect(retryStrategy(1, "accepted")).toBe("stop");
    expect(retryStrategy(9, "accepted")).toBe("stop");
  });

  it("captcha and email_only fall back to email and are never retried", () => {
    expect(retryStrategy(1, "captcha")).toBe("email_fallback");
    expect(retryStrategy(1, "email_only")).toBe("email_fallback");
  });

  it("unknown retries while attempt < MAX_RETRIES then falls back", () => {
    expect(retryStrategy(1, "unknown")).toBe("retry");
    expect(retryStrategy(2, "unknown")).toBe("email_fallback");
    expect(retryStrategy(3, "unknown")).toBe("email_fallback");
  });
});

describe("normalizeFormFieldName", () => {
  it("snake-cases and strips punctuation", () => {
    expect(normalizeFormFieldName("First Name*")).toBe("first_name");
    expect(normalizeFormFieldName("phone  †")).toBe("phone");
    expect(normalizeFormFieldName("")).toBe("");
    expect(normalizeFormFieldName("  E-Mail Address  ")).toBe("e_mail_address");
  });
});

describe("requiredFieldSet", () => {
  it("collects normalized names of required fields only", () => {
    const set = requiredFieldSet([
      { name: "First Name*", required: true },
      { name: "Phone", required: true },
      { name: "Comments", required: false },
    ]);
    expect(set).toEqual(new Set(["first_name", "phone"]));
  });
});
