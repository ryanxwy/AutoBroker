import { describe, expect, it } from "vitest";
import { stripHtmlToText } from "./htmlToText.js";

describe("stripHtmlToText", () => {
  it("strips plain tags", () => {
    const result = stripHtmlToText("<p>Hello <b>world</b></p>");
    expect(result).toBe("Hello world");
  });

  it("drops script blocks including their content", () => {
    const result = stripHtmlToText('<script type="text/javascript">alert("xss")</script>visible');
    expect(result).toContain("visible");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("xss");
  });

  it("drops style blocks including their content", () => {
    const result = stripHtmlToText("<style>.foo{color:red}</style>visible");
    expect(result).toContain("visible");
    expect(result).not.toContain(".foo");
    expect(result).not.toContain("color");
  });

  it("decodes &nbsp;", () => {
    expect(stripHtmlToText("a&nbsp;b")).toBe("a b");
  });

  it("decodes &amp;", () => {
    expect(stripHtmlToText("a&amp;b")).toBe("a&b");
  });

  it("decodes &apos; &#x27; &#39;", () => {
    expect(stripHtmlToText("it&apos;s")).toBe("it's");
    expect(stripHtmlToText("it&#x27;s")).toBe("it's");
    expect(stripHtmlToText("it&#39;s")).toBe("it's");
  });

  it("decodes &quot;", () => {
    expect(stripHtmlToText("say &quot;hi&quot;")).toBe('say "hi"');
  });

  it("replaces unknown named entities with a space", () => {
    const result = stripHtmlToText("foo&mdash;bar");
    // &mdash; is replaced by a space, whitespace is collapsed
    expect(result).toBe("foo bar");
  });

  it("collapses internal whitespace to a single space", () => {
    expect(stripHtmlToText("a   \t\n  b")).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripHtmlToText("  hello  ")).toBe("hello");
  });

  it("respects the cap parameter", () => {
    const long = "abcdefghij".repeat(20); // 200 chars
    const result = stripHtmlToText(long, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toBe("abcdefghij");
  });

  it("uses the default cap of 100_000 — does not truncate a 50k string", () => {
    const long = "x".repeat(50_000);
    expect(stripHtmlToText(long).length).toBe(50_000);
  });

  it("does not leave a lone high surrogate when the cap falls between a surrogate pair", () => {
    // Build a string that ends with a surrogate pair just past the cap boundary.
    // U+1F600 (😀) encodes as two UTF-16 code units: 0xD83D (high) 0xDE00 (low).
    const emoji = "\u{1F600}"; // two UTF-16 code units
    expect(emoji.length).toBe(2); // sanity: it IS a surrogate pair

    // 3 regular chars + emoji = 5 code units total.
    // cap=4 lands on the high surrogate at index 3.
    const input = "abc" + emoji;
    const result = stripHtmlToText(input, 4);

    // The high surrogate must have been dropped — result is "abc" (3 chars).
    expect(result.length).toBe(3);
    expect(result).toBe("abc");

    // Confirm no lone surrogate: spreading to code points must not throw and
    // must not produce the replacement character U+FFFD.
    const codePoints = [...result];
    expect(codePoints.every((cp) => cp !== "�")).toBe(true);
  });

  it("replaces numeric character references (decimal and hex) with a space", () => {
    // &#8217; = right single quotation mark, &#x2019; = same, &#8212; = em dash
    const result = stripHtmlToText("don&#8217;t&#x2019;stop&#8212;go");
    expect(result).not.toMatch(/&#8217;|&#x2019;|&#8212;/i);
    // whitespace-collapsed so the spaces are merged
    expect(result).toBe("don t stop go");
  });

  it("handles an empty string", () => {
    expect(stripHtmlToText("")).toBe("");
  });

  it("strips a realistic HTML snippet to its visible text", () => {
    const html = `
      <!DOCTYPE html>
      <html><head><title>Test</title>
      <style>body{font-size:16px}</style>
      <script>var x=1;</script>
      </head><body>
        <h1>Dealer &amp; Quote</h1>
        <p>Price: &nbsp;$35,000</p>
      </body></html>
    `;
    const result = stripHtmlToText(html);
    expect(result).toContain("Dealer & Quote");
    expect(result).toContain("Price:");
    expect(result).toContain("$35,000");
    expect(result).not.toContain("font-size");
    expect(result).not.toContain("var x");
  });
});
