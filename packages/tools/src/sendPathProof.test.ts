/**
 * Single-side-effect-path lint proof. This is a STRUCTURAL test, not a behavior
 * test: it scans the tools source tree and asserts there is exactly ONE lexical
 * path to each physical side effect, and that every such site is funnelled
 * through the L2 gate.
 *
 * The two physical side effects in this package are:
 *   - a Gmail adapter `.send(...)` call (the email irreversible boundary);
 *   - the dealer-form submit click (`page.click(form.submitSelector)`).
 *
 * The proof:
 *   1. The set of source files that CALL `adapter.send(` is EXACTLY
 *      { gmail.ts, gmail/sendRecord.ts }.
 *   2. The set of source files that perform the gated form submit is EXACTLY
 *      { browser.ts }.
 *   3. Each of those files imports the gate (`gate/index.js`).
 * A new file that introduces a second send/submit path — or removes the gate
 * import from one of these — turns this test RED, so the "no second code path to
 * a side effect" invariant cannot rot silently.
 *
 * Scans real source files (excludes *.test.ts so the spies/fakes in test files
 * never count as a side-effect site). No DB, no network.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = here;

/** All non-test .ts source files under src, as paths relative to src. */
async function listSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      // Normalize to forward slashes so the asserted set is platform-stable.
      out.push(relative(SRC_ROOT, full).split(/[\\/]/).join("/"));
    }
  }
  await walk(SRC_ROOT);
  return out;
}

/** True when `file` calls a Gmail adapter's `.send(` (a real call site, e.g.
 *  `await adapter.send(raw)` — matches `adapter.send(`). */
function callsAdapterSend(text: string): boolean {
  return /\badapter\.send\s*\(/.test(text);
}

/** True when `file` performs the gated dealer-form submit click. */
function performsFormSubmit(text: string): boolean {
  return /page\.click\(\s*form\.submitSelector\s*\)/.test(text);
}

/** True when `file` calls the RAW Gmail network primitive (`users.messages.send(`
 *  / `messages.send(`) — the only legitimate site is the real adapter, which the
 *  abstract `adapter.send(` funnels through. This catches a future file that
 *  reaches the network directly, bypassing the named-`adapter.send` surface. */
function callsRawMessagesSend(text: string): boolean {
  return /\bmessages\.send\s*\(/.test(text);
}

/** True when `file` imports from the L2 gate (`./gate/index.js` or
 *  `../gate/index.js`). */
function importsGate(text: string): boolean {
  return /from\s+["'](?:\.\.?\/)+gate\/index\.js["']/.test(text);
}

describe("single side-effect path (lint proof)", () => {
  it("only { gmail.ts, gmail/sendRecord.ts } call an adapter's .send(, both via the gate", async () => {
    const files = await listSourceFiles();
    const senders: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      if (callsAdapterSend(text)) senders.push(rel);
    }
    expect(new Set(senders)).toEqual(new Set(["gmail.ts", "gmail/sendRecord.ts"]));
    // Every send site must funnel through the gate — there is no ungated send.
    for (const rel of senders) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      expect(importsGate(text), `${rel} must import the gate`).toBe(true);
    }
  });

  it("only the real adapter touches the raw Gmail send primitive (messages.send)", async () => {
    const files = await listSourceFiles();
    const rawCallers: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      if (callsRawMessagesSend(text)) rawCallers.push(rel);
    }
    // The raw network primitive lives ONLY in the real adapter; every other send
    // goes through the gate-funnelled abstract `adapter.send(`. A new file calling
    // `messages.send(` directly (an ungated second path) turns this RED.
    expect(new Set(rawCallers)).toEqual(new Set(["gmail/adapter.ts"]));
  });

  it("only { browser.ts } performs the gated form submit, via the gate", async () => {
    const files = await listSourceFiles();
    const submitters: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      if (performsFormSubmit(text)) submitters.push(rel);
    }
    expect(new Set(submitters)).toEqual(new Set(["browser.ts"]));
    for (const rel of submitters) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      expect(importsGate(text), `${rel} must import the gate`).toBe(true);
    }
  });
});
