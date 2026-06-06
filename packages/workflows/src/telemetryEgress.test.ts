/**
 * Telemetry zero-egress verification (CI-able).
 *
 * Verifies MASTRA_TELEMETRY_DISABLED=1 produces zero PostHog egress at the
 * packet level — i.e. no telemetry leaves the process.
 *
 * STRATEGY. We can't run tcpdump (sudo, unavailable in the sandbox), so this is
 * PROCESS-LEVEL egress verification: a CommonJS preload
 * (spikes/egressRecorderPreload.cjs) monkey-patches dns.lookup /
 * dns.promises.* / dns.resolve* / net.Socket.prototype.connect / tls.connect /
 * globalThis.fetch BEFORE any app code, appending one JSON line per outbound
 * attempt to EGRESS_LOG. This test spawns the real library-mode Mastra child
 * workload (spikes/telemetryEgressChild.test.ts) in a separate process with
 * that preload armed via NODE_OPTIONS, then asserts:
 *
 *   1. the "preload-armed" marker line is present  → recorder really ran first;
 *   2. the set of EXTERNAL hostnames is empty       → no telemetry phone-home.
 *
 * "External" = anything that is not loopback / a UNIX-socket path / a file: DB
 * op. The assertion fails (and prints the full external set) if anything
 * telemetry-shaped (posthog|segment|sentry|amplitude|telemetry) — or indeed any
 * external host at all — appears while MASTRA_TELEMETRY_DISABLED=1.
 *
 * Isolation: a fresh os.tmpdir() mkdtemp data dir per run; env is saved/restored
 * by spawning a child process (this parent's own env is untouched).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/workflows/src
const PKG_ROOT = resolve(HERE, ".."); // packages/workflows
const PRELOAD = join(PKG_ROOT, "spikes", "egressRecorderPreload.cjs");
const CHILD_TEST = "spikes/telemetryEgressChild.test.ts"; // relative to PKG_ROOT

const TELEMETRY_HOST_RE = /posthog|segment|sentry|amplitude|telemetry|mixpanel/i;

interface EgressEvent {
  kind: string;
  host?: string | null;
  port?: number | null;
  path?: string | null;
  url?: string | null;
  servername?: string | null;
  hostname?: string;
  pid?: number;
}

/** A host counts as loopback (not external) if it resolves to local. */
function isLoopback(host: string | null | undefined): boolean {
  if (!host) return true; // null host = UNIX socket / fd connect, not a remote host
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.startsWith("127.") ||
    h === "[::1]"
  );
}

/** Run the child vitest workload with the recorder preload armed. */
function runChild(opts: {
  dataDir: string;
  egressLog: string;
  disableTelemetry: boolean;
}): { status: number | null; stdout: string; stderr: string } {
  // Build child env from a COPY of ours, then mutate the copy only.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.AUTOBROKER_DATA_DIR = opts.dataDir;
  env.EGRESS_LOG = opts.egressLog;
  // Sentinel: tells the child test it was launched by us (it skips otherwise so
  // a bare CI `vitest run` never executes the real workload without a preload).
  env.SPIKE6_CHILD = "1";
  // Inherit the preload into the vitest worker.
  const existingNodeOptions = env.NODE_OPTIONS ? env.NODE_OPTIONS + " " : "";
  env.NODE_OPTIONS = `${existingNodeOptions}--require ${PRELOAD}`;
  if (opts.disableTelemetry) {
    env.MASTRA_TELEMETRY_DISABLED = "1";
  } else {
    delete env.MASTRA_TELEMETRY_DISABLED;
  }
  // Prevent recursion: the child must not re-enter this parent test. We run an
  // explicit single file path, so vitest only runs that file.
  const res = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", CHILD_TEST, "--no-coverage"],
    {
      cwd: PKG_ROOT,
      env,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Parse EGRESS_LOG into events; missing file => []. */
function readEgress(logPath: string): EgressEvent[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EgressEvent);
}

/** The set of distinct EXTERNAL host identifiers seen in the events. */
function externalHosts(events: EgressEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.kind === "preload-armed") continue;
    // host-bearing fields across the patched call kinds
    const candidates = [e.host, e.hostname, e.servername].filter(
      (h): h is string => typeof h === "string" && h.length > 0,
    );
    // fetch records a url too; its host field already extracted, but keep url host
    for (const h of candidates) {
      if (!isLoopback(h)) set.add(`${e.kind}:${h}`);
    }
  }
  return [...set].sort();
}

describe("spike-6: telemetry zero-egress (process-level)", () => {
  it("records ZERO external egress with MASTRA_TELEMETRY_DISABLED=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-spike6-disabled-"));
    const egressLog = join(dir, "egress.jsonl");
    try {
      const child = runChild({
        dataDir: dir,
        egressLog,
        disableTelemetry: true,
      });

      // The child workload itself must pass (storage round-trip succeeded).
      expect(
        child.status,
        `child failed.\nSTDOUT:\n${child.stdout}\nSTDERR:\n${child.stderr}`,
      ).toBe(0);

      const events = readEgress(egressLog);

      // (1) preload armed proof — the recorder ran before app code.
      const armed = events.filter((e) => e.kind === "preload-armed");
      expect(
        armed.length,
        `no preload-armed marker — recorder did NOT load. Events: ${JSON.stringify(events)}`,
      ).toBeGreaterThan(0);

      // (2) zero external hosts.
      const external = externalHosts(events);
      const telemetry = external.filter((h) => TELEMETRY_HOST_RE.test(h));

      // Surface the full recorded set in the failure message AND on success
      // (via the assertion args) for the evidence quote.
      expect(
        telemetry,
        `telemetry-shaped egress detected: ${JSON.stringify(telemetry)}`,
      ).toEqual([]);
      expect(
        external,
        `external egress (any) detected with telemetry disabled: ${JSON.stringify(external)}`,
      ).toEqual([]);

      // Emit the full recorded kind-summary for the transcript.
      const summary = events.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});
      // eslint-disable-next-line no-console
      console.log(
        "[spike-6 disabled] recorded-kinds=" +
          JSON.stringify(summary) +
          " external-set=" +
          JSON.stringify(external),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Negative control: run WITHOUT MASTRA_TELEMETRY_DISABLED. Either outcome is
  // acceptable (core 1.41 in library mode may never phone home); we only record
  // the observation — this case does NOT gate the verdict.
  it("negative control: observe egress with telemetry NOT disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-spike6-control-"));
    const egressLog = join(dir, "egress.jsonl");
    try {
      const child = runChild({
        dataDir: dir,
        egressLog,
        disableTelemetry: false,
      });
      const events = readEgress(egressLog);
      const armed = events.some((e) => e.kind === "preload-armed");
      const external = externalHosts(events);
      const telemetry = external.filter((h) => TELEMETRY_HOST_RE.test(h));
      // eslint-disable-next-line no-console
      console.log(
        "[spike-6 control] child.status=" +
          child.status +
          " armed=" +
          armed +
          " external-set=" +
          JSON.stringify(external) +
          " telemetry-set=" +
          JSON.stringify(telemetry),
      );
      // Non-gating: assert only that the recorder armed so the observation is trustworthy.
      expect(armed, "recorder did not arm in control run").toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
