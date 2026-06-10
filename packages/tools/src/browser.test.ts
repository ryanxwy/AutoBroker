/**
 * Browser service unit tests — NO real browser. Covers the pure, load-bearing
 * pieces: the personal-page isolation denylist, the robots.txt Disallow parse,
 * the backoff/politeness math (with injected rand), the snapshot cap, the
 * extract-vs-snapshot completeness decision, and the opened-once emitter
 * wrapper. Real-chromium coverage lives in browser.smoke.test.ts behind
 * AUTOBROKER_BROWSER_SMOKE=1.
 */

import { describe, expect, it } from "vitest";

import {
  assertIsolated,
  BrowserIsolationError,
  capSnapshot,
  computeBackoffMs,
  gatedSubmitForm,
  NULL_EMITTER,
  openedOnce,
  parseRobotsDisallow,
  politenessDelayMs,
  rowsComplete,
  SNAPSHOT_CAP_CHARS,
  type BrowserEmitter,
  type FormPage,
} from "./browser.js";
import { ExternalMutationsBlockedError, type Approver } from "./gate/index.js";

const BLOCKED_PREFIX =
  /^BLOCKED: detected personal-profile Chrome page in the controlled browser\./;

describe("assertIsolated — personal-page denylist", () => {
  it("clean URLs pass", () => {
    expect(() =>
      assertIsolated([
        "https://www.tustinhyundai.com/new-inventory/",
        "https://example.com/?q=settings",
        "data:text/html,<p>hi</p>",
        "about:blank",
      ]),
    ).not.toThrow();
  });

  it.each([
    "chrome://history",
    "chrome://settings/passwords",
    "https://mail.google.com/mail/u/0/#inbox",
    "https://accounts.google.com/signin/v2",
  ])("denylisted URL %s throws with the BLOCKED: prefix", (url) => {
    expect(() => assertIsolated([url])).toThrow(BrowserIsolationError);
    expect(() => assertIsolated([url])).toThrow(BLOCKED_PREFIX);
  });

  it("one bad URL among clean ones still throws", () => {
    expect(() =>
      assertIsolated(["https://dealer.example/", "chrome://settings", "https://ok.example/"]),
    ).toThrow(BrowserIsolationError);
  });
});

describe("parseRobotsDisallow — star group only, longest prefix", () => {
  it("a * group Disallow prefix matches", () => {
    const robots = "User-agent: *\nDisallow: /search";
    expect(parseRobotsDisallow(robots, "/search/cars")).toBe(true);
    expect(parseRobotsDisallow(robots, "/inventory")).toBe(false);
  });

  it("specific-UA groups are ignored", () => {
    const robots = "User-agent: Googlebot\nDisallow: /";
    expect(parseRobotsDisallow(robots, "/anything")).toBe(false);
  });

  it("a shared group listing * among other agents applies", () => {
    const robots = "User-agent: Googlebot\nUser-agent: *\nDisallow: /private";
    expect(parseRobotsDisallow(robots, "/private/x")).toBe(true);
  });

  it("rules after a NEW specific-UA group do not leak into the * group", () => {
    const robots =
      "User-agent: *\nDisallow: /a\n\nUser-agent: Googlebot\nDisallow: /b";
    expect(parseRobotsDisallow(robots, "/a/page")).toBe(true);
    expect(parseRobotsDisallow(robots, "/b/page")).toBe(false);
  });

  it("empty Disallow means allow", () => {
    const robots = "User-agent: *\nDisallow:";
    expect(parseRobotsDisallow(robots, "/anything")).toBe(false);
  });

  it("comments and blank lines are tolerated; longest prefix decides", () => {
    const robots =
      "# dealer robots\n\nUser-agent: *\nDisallow: /a # inline comment\nDisallow: /a/b\n";
    expect(parseRobotsDisallow(robots, "/a/b/c")).toBe(true);
    expect(parseRobotsDisallow(robots, "/a")).toBe(true);
    expect(parseRobotsDisallow(robots, "/z")).toBe(false);
  });

  it("empty robots.txt allows everything (fetch failure → caller passes nothing)", () => {
    expect(parseRobotsDisallow("", "/")).toBe(false);
  });
});

describe("computeBackoffMs — full jitter", () => {
  it("rand=1 yields the full window: base*2^attempt up to the cap", () => {
    const one = () => 1;
    expect(computeBackoffMs(0, 1000, 8000, one)).toBe(1000);
    expect(computeBackoffMs(1, 1000, 8000, one)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 8000, one)).toBe(8000); // 8000 exactly
    expect(computeBackoffMs(10, 1000, 8000, one)).toBe(8000); // capped
  });

  it("rand=0 yields 0 (full-jitter floor)", () => {
    expect(computeBackoffMs(5, 1000, 8000, () => 0)).toBe(0);
  });

  it("rand=0.5 yields half the window", () => {
    expect(computeBackoffMs(2, 1000, 8000, () => 0.5)).toBe(2000);
  });
});

describe("politenessDelayMs — min interval ± 0.5s jitter", () => {
  it("rand=0.5 (zero jitter): waits out the remaining interval", () => {
    const half = () => 0.5;
    expect(politenessDelayMs(0, 500, 2000, half)).toBe(1500);
    expect(politenessDelayMs(0, 2000, 2000, half)).toBe(0);
  });

  it("jitter bounds: rand=1 adds +500ms, rand=0 subtracts 500ms", () => {
    expect(politenessDelayMs(0, 0, 2000, () => 1)).toBe(2500);
    expect(politenessDelayMs(0, 0, 2000, () => 0)).toBe(1500);
  });

  it("never negative once the interval has long elapsed", () => {
    expect(politenessDelayMs(0, 60_000, 2000, () => 1)).toBe(0);
    expect(politenessDelayMs(0, 60_000, 2000, () => 0)).toBe(0);
  });
});

describe("capSnapshot — 120k char cap", () => {
  it("short text is unchanged", () => {
    expect(capSnapshot("hello")).toBe("hello");
  });

  it("text exactly at the cap is unchanged", () => {
    const text = "x".repeat(SNAPSHOT_CAP_CHARS);
    expect(capSnapshot(text)).toBe(text);
  });

  it("over-cap text is truncated to the cap and is a prefix", () => {
    const text = "a".repeat(SNAPSHOT_CAP_CHARS) + "TAIL";
    const capped = capSnapshot(text);
    expect(capped.length).toBe(SNAPSHOT_CAP_CHARS);
    expect(text.startsWith(capped)).toBe(true);
  });
});

describe("rowsComplete — the extract-vs-snapshot decision", () => {
  type Row = { name: string | null; price: number | null; note?: string };
  const required: ("name" | "price")[] = ["name", "price"];

  it("zero rows is NOT complete (snapshot fallback)", () => {
    const r = rowsComplete<Row>([], required);
    expect(r.allComplete).toBe(false);
    expect(r.completeRows).toEqual([]);
  });

  it("all rows with every required key non-null → evaluate path", () => {
    const rows: Row[] = [
      { name: "Tucson SEL", price: 31000 },
      { name: "Tucson XRT", price: 33000 },
    ];
    const r = rowsComplete(rows, required);
    expect(r.allComplete).toBe(true);
    expect(r.completeRows).toEqual(rows);
  });

  it("a null/undefined required key makes the row incomplete; complete rows are kept in order", () => {
    const rows: Row[] = [
      { name: "Tucson SEL", price: 31000 },
      { name: null, price: 33000 },
      { name: "Tucson XRT", price: null },
    ];
    const r = rowsComplete(rows, required);
    expect(r.allComplete).toBe(false);
    expect(r.completeRows).toEqual([{ name: "Tucson SEL", price: 31000 }]);
  });

  it("a missing NON-required key does not break completeness", () => {
    const rows: Row[] = [{ name: "Tucson SEL", price: 31000 }];
    expect(rowsComplete(rows, required).allComplete).toBe(true);
  });
});

describe("openedOnce — opened fires at most once per session", () => {
  function recording(): { calls: (string | undefined)[]; emitter: BrowserEmitter } {
    const calls: (string | undefined)[] = [];
    return {
      calls,
      emitter: {
        opened: (url?: string) => {
          calls.push(url);
        },
        action: () => undefined,
        error: () => undefined,
        closed: () => undefined,
      },
    };
  }

  it("multiple calls forward only the first (with its url)", () => {
    const { calls, emitter } = recording();
    const open = openedOnce(emitter);
    expect(open.didOpen()).toBe(false);
    open.opened("https://first.example/");
    open.opened("https://second.example/");
    open.opened();
    expect(calls).toEqual(["https://first.example/"]);
    expect(open.didOpen()).toBe(true);
  });

  it("didOpen stays false when never opened (no closed() pairing in cleanup)", () => {
    const open = openedOnce(NULL_EMITTER);
    expect(open.didOpen()).toBe(false);
  });
});

describe("gatedSubmitForm — the gate/decline/fuse safety branches", () => {
  const FORM = {
    url: "https://dealer.example/contact",
    fields: { first_name: "Ada", phone: "(949) 555-0100" },
    submitSelector: "button[type=submit]",
  };

  function fakePage(): { page: FormPage; ops: string[] } {
    const ops: string[] = [];
    return {
      ops,
      page: {
        fill: async (selector, value) => {
          ops.push(`fill:${selector}=${value}`);
        },
        click: async (selector) => {
          ops.push(`click:${selector}`);
        },
      },
    };
  }

  const approve: Approver = { decide: async () => true };
  const decline: Approver = { decide: async () => false };

  it("a declined approver returns {declined} without ever touching the page", async () => {
    const { page, ops } = fakePage();
    const result = await gatedSubmitForm({
      runId: "run-1",
      page,
      form: FORM,
      approver: decline,
      emitter: NULL_EMITTER,
    });
    expect(result).toEqual({ declined: true });
    expect(ops).toEqual([]); // no fill, no click — zero side effects on decline
  });

  it("an approver that THROWS is treated as a decline (fail-closed)", async () => {
    const { page, ops } = fakePage();
    const result = await gatedSubmitForm({
      runId: "run-1",
      page,
      form: FORM,
      approver: {
        decide: async () => {
          throw new Error("approver crashed");
        },
      },
      emitter: NULL_EMITTER,
    });
    expect(result).toEqual({ declined: true });
    expect(ops).toEqual([]);
  });

  it("the armed L1 env fuse blocks the click even when the approver approves", async () => {
    const { page, ops } = fakePage();
    const prev = process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
    process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "1";
    try {
      await expect(
        gatedSubmitForm({
          runId: "run-1",
          page,
          form: FORM,
          approver: approve,
          emitter: NULL_EMITTER,
        }),
      ).rejects.toThrow(ExternalMutationsBlockedError);
    } finally {
      if (prev === undefined) delete process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
      else process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = prev;
    }
    expect(ops.some((op) => op.startsWith("click:"))).toBe(false); // never reached the click
  });

  it("an approved gate fills then clicks, and announces the submit", async () => {
    const { page, ops } = fakePage();
    const actions: string[] = [];
    const emitter: BrowserEmitter = {
      ...NULL_EMITTER,
      action: (type, target) => {
        actions.push(`${type}:${target}`);
      },
    };
    const result = await gatedSubmitForm({
      runId: "run-1",
      page,
      form: FORM,
      approver: approve,
      emitter,
    });
    expect(result).toEqual({ submitted: true });
    expect(ops).toEqual([
      'fill:[name="first_name"]=Ada',
      'fill:[name="phone"]=(949) 555-0100',
      "click:button[type=submit]",
    ]);
    expect(actions).toEqual([`submit:${FORM.url}`]);
  });
});
