/**
 * serverHost — boot the REAL @autobroker/server on an ephemeral 127.0.0.1 port for
 * the live harness. Spawned as a CHILD PROCESS by runner.ts
 * (the e2e serve.mjs pattern) so the harness drives a genuine HTTP/SSE server in a
 * separate process — black-box, exactly the SUT a user runs.
 *
 * KEY DIFFERENCE FROM apps/ui/e2e/serve.mjs: the live harness boots WITHOUT the DI
 * stubs — `live = real geocode + real DeepSeek`. The two external
 * collaborators (resolveLocation / harnessGenerate) keep their REAL implementations.
 * The only thing this host arranges is ISOLATION (a throwaway DB under
 * ~/.autobroker-ts) + the migration + a seed account, and it prints the port.
 *
 * DRY-RUN MODE (--dry-run): boot the server with the test DI seam
 * DISABLED (NOT stubbed) but STOP before the first live call — i.e. boot, print the
 * port, and let the runner prove the wiring end-to-end MINUS spend (the runner runs
 * preflight + driver_kind self-check + a no-LLM read of /api/mode and exits before
 * POSTing a turn that would call DeepSeek). This host itself makes no live call; it
 * just refuses to inject stubs so the wiring is the real one.
 *
 * FIXTURE MODE (AUTOBROKER_HARNESS_FIXTURE=1, set by the functional lane): boot
 * with the DETERMINISTIC DI stubs injected (resolveLocation + harnessGenerate —
 * NO live geocode, NO live LLM) and register three test-only routes OUTSIDE /api
 * (mirroring apps/ui/e2e/serve.mjs): POST /__e2e/scenario (flip the stub
 * scenario), POST /__e2e/apply-fixture (install a named FixtureState — its seed +
 * scenario), GET /__e2e/audit (count audit_log rows). The live path is unchanged:
 * when the flag is absent NONE of this runs (no stubs, no extra routes).
 *
 * ISOLATION: AUTOBROKER_DATA_DIR is set by the INVOKING runner (under
 * ~/.autobroker-ts/harness-runs/<ts>/); this host honors it (never overrides to a
 * production path). AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS / MASTRA_TELEMETRY_DISABLED /
 * the provider key are inherited from the runner's env (the runner asserted them in
 * preflight before spawning). AUTOBROKER_TEST_AUTO_APPROVE is never set here.
 *
 * Output: a single JSON line on stdout once listening: { harness_host:"listening",
 * port, dataDir } — the runner parses it (mirrors serve.mjs's contract).
 *
 * Run: node --import tsx/esm harness/serverHost.ts  (the runner spawns it).
 *
 * Dependency wall: harness layer. Imports @autobroker/server (buildServer) +
 * @autobroker/tools (openDb for the one-time migration apply — the tools closure is
 * the only DB owner) + @autobroker/workflows reset helpers. The migration APPLY is a
 * boot-time schema bootstrap on an isolated tmp DB, not a product write path. NEVER
 * imports better-sqlite3/drizzle/playwright directly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildServer } from "@autobroker/server";
import { __setSecretsProbeForTests, openDb, resolveDataDir } from "@autobroker/tools";
import {
  __setIntakeDepsForTests,
  resetMastraForTests,
  resetRuntimeGlueForTests,
} from "@autobroker/workflows";

import { harnessGenerateStub, resolveLocationStub, setScenario, type Scenario } from "./fixtures/stubs.js";
import { getFixtureState } from "./fixtures/states/index.js";

/** Fixture mode is on only when the functional lane sets the env flag. The live
 *  + dry-run paths leave it unset, so they boot EXACTLY as before. */
const FIXTURE_MODE = process.env["AUTOBROKER_HARNESS_FIXTURE"] === "1";

const here = dirname(fileURLToPath(import.meta.url));
// harness/ → repo-root packages/db/drizzle/ (the committed migration set)
const MIGRATIONS_DIR = join(here, "..", "packages", "db", "drizzle");

/** Every committed migration file, in journal order. A fresh DB must receive
 *  the WHOLE set, not just the 0000 baseline — a later migration can carry a
 *  unique index that an ON CONFLICT upsert depends on. */
function migrationFiles(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  return journal.entries.map((e) => join(MIGRATIONS_DIR, `${e.tag}.sql`));
}

/** Apply the committed migrations + seed account to the isolated DB (idempotent-ish:
 *  a fresh tmp DB each run, so the migrations always land on an empty file). */
function bootstrapDb(): void {
  const db = openDb(); // resolves <AUTOBROKER_DATA_DIR>/autobroker.db (the tools closure).
  try {
    for (const file of migrationFiles()) db.$client.exec(readFileSync(file, "utf8"));
    // Seed the single account the active-slot uniqueness + intake persist need.
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-harness-1", "harness@example.com");
  } finally {
    db.$client.close();
  }
}

/** A minimal structural view of the RunPubSub the emit-data-changed route uses
 *  — the host imports @autobroker/server's buildServer (which OWNS the pubsub
 *  type); this avoids importing the class type just for the route signature. */
interface FixturePubSub {
  has(runId: string): boolean;
  append(runId: string, ev: { kind: string; payload?: Record<string, unknown> }): boolean;
}

/** Register the test-only /__e2e/* routes (fixture mode only), OUTSIDE /api so
 *  the product wall is untouched. The runner POSTs these to install a fixture
 *  world + flip the stub scenario; the audit read lets a case prove a row landed
 *  in the isolated product DB; emit-data-changed deterministically pushes a
 *  data.changed pulse onto an OPEN run channel (the SSE→refetch proof). */
function registerFixtureRoutes(
  app: {
    post: (path: string, handler: (req: { body?: unknown }, reply: { code: (n: number) => void }) => unknown) => void;
    get: (path: string, handler: (req: { query?: unknown }, reply: { code: (n: number) => void }) => unknown) => void;
  },
  pubsub: FixturePubSub,
): void {
  // Flip the stub scenario (geocode outcome + trim verdict).
  app.post("/__e2e/scenario", async (req, reply) => {
    setScenario((req.body ?? {}) as Partial<Scenario>);
    reply.code(200);
    return { ok: true };
  });

  // Install a named FixtureState: resolve it (fail-loud on unknown), flip the
  // scenario, then run its seed against a FRESH openDb handle (the tools closure
  // is the only DB owner — the seed writes through it, then we close).
  app.post("/__e2e/apply-fixture", async (req, reply) => {
    const body = (req.body ?? {}) as { state?: unknown };
    const stateField = body.state;
    // The runner may send the FixtureState object or a bare id string; resolve
    // either to the registered state (the registry is the authority, never the
    // wire — a wire-supplied seed would breach the harness's no-arbitrary-write).
    const id =
      typeof stateField === "string"
        ? stateField
        : typeof (stateField as { id?: unknown })?.id === "string"
          ? (stateField as { id: string }).id
          : undefined;
    if (id === undefined) {
      reply.code(400);
      return { ok: false, error: "apply-fixture requires { state: <id|FixtureState> }" };
    }
    const state = getFixtureState(id);
    setScenario(state.scenario);
    const db = openDb();
    try {
      state.seed(db);
    } finally {
      db.$client.close();
    }
    reply.code(200);
    return { ok: true, state: id };
  });

  // Count audit_log rows (optionally for one action) through the tools openDb
  // closure — the product DB read channel a functional case uses to prove a row.
  app.get("/__e2e/audit", async (req, reply) => {
    const action = (req.query as { action?: unknown } | undefined)?.action;
    const adb = openDb();
    try {
      const sql =
        typeof action === "string" && action.length > 0
          ? "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?"
          : "SELECT COUNT(*) AS n FROM audit_log";
      const stmt = adb.$client.prepare(sql);
      const row = (typeof action === "string" && action.length > 0 ? stmt.get(action) : stmt.get()) as {
        n: number;
      };
      reply.code(200);
      return { action: typeof action === "string" ? action : null, count: row.n };
    } finally {
      adb.$client.close();
    }
  });

  // Deterministically emit a NON-terminal data.changed pulse onto an OPEN run
  // channel — the functional proof that the dashboard auto-refreshes a stale
  // view from an SSE pulse WITHOUT a reload. This mirrors the product emit
  // (skillRuns.translate appends data.changed before the terminal done) without
  // running a real skill: the case opens a run stream in the rail, seeds new
  // rows, then POSTs here so the SSE pulse reaches the live SPA. Refuses an
  // unknown/closed run (the channel must be live for the pulse to fan out).
  app.post("/__e2e/emit-data-changed", async (req, reply) => {
    const body = (req.body ?? {}) as { run_id?: unknown; kinds?: unknown; profile_id?: unknown };
    const runId = typeof body.run_id === "string" ? body.run_id : "";
    if (runId === "" || !pubsub.has(runId)) {
      reply.code(400);
      return { ok: false, error: `emit-data-changed needs an OPEN run_id (got "${runId}")` };
    }
    const kinds = Array.isArray(body.kinds)
      ? body.kinds.filter((k): k is string => typeof k === "string")
      : ["profiles", "sessions", "dealers", "listings", "incentives"];
    const profileId = typeof body.profile_id === "string" ? body.profile_id : null;
    const appended = pubsub.append(runId, {
      kind: "data.changed",
      payload: { profile_id: profileId, kinds },
    });
    reply.code(200);
    return { ok: appended, run_id: runId, kinds };
  });
}

async function main(): Promise<void> {
  // Telemetry belt before any Mastra construction (preflight already required "1").
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";
  // Never auto-approve — keep the decline path live (the runner asserted this too).
  delete process.env.AUTOBROKER_TEST_AUTO_APPROVE;

  if (FIXTURE_MODE) {
    // Arm the workflows test-only deps seam (it refuses outside a test runner)
    // and give the DeepSeek registry a dummy key so construction never trips and
    // the FIRST-RUN GATE stays satisfied for every case that does NOT opt into
    // the no-keys world — no live call ever fires through the stubs. The
    // keys_setup fixture state CLEARS this default to stage the fresh-install
    // world it proves the save flow against.
    process.env.NODE_ENV = "test";
    process.env.DEEPSEEK_API_KEY ??= "fixture-dummy-not-used";
    // STUB THE KEY PROBE: the "Test connection" verb must make ZERO real external
    // calls in the functional lane. Inject a deterministic pass for every id (the
    // candidate is never inspected) so the keys_setup case's Test → pass → Save
    // flow is fully offline. The seam refuses outside a test runner (set above).
    __setSecretsProbeForTests({
      probeLlm: async (id) => ({ ok: true, detail: `${id} key accepted (stub)` }),
      probeGeocode: async () => ({ ok: true, detail: "google_places key accepted (stub)" }),
    });
  }

  const dataDir = resolveDataDir();
  bootstrapDb();

  if (FIXTURE_MODE) {
    // FIXTURE: inject the deterministic stubs (NO live geocode, NO live LLM).
    __setIntakeDepsForTests({
      harnessGenerate: harnessGenerateStub as never,
      resolveLocation: resolveLocationStub as never,
    });
  }

  // LIVE: do NOT inject the DI stubs — real geocode + real DeepSeek. We still reset
  // the Mastra singleton + glue ownership so a fresh process starts clean. (The
  // dry-run mode is identical at the host level: it ALSO does not stub; the runner
  // is what stops before the first live call.)
  resetMastraForTests();
  resetRuntimeGlueForTests();

  const built = await buildServer({ quiet: true });

  if (FIXTURE_MODE) {
    // Test-only control + read routes, OUTSIDE /api (the product wall is untouched).
    registerFixtureRoutes(built.app as never, built.pubsub as unknown as FixturePubSub);
  }
  const listenAddr = await built.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = built.app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  // The machine-readable line the runner parses.
  console.log(JSON.stringify({ harness_host: "listening", url: listenAddr, port, dataDir }));

  const shutdown = async (): Promise<void> => {
    try {
      await built.app.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  console.error(`serverHost FAILED: ${(err as Error).message}`);
  process.exit(1);
});
