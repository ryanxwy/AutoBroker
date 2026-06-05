/**
 * serverHost — boot the REAL @autobroker/server on an ephemeral 127.0.0.1 port for
 * the live harness (HARNESS_FRAMEWORK §1/§3). Spawned as a CHILD PROCESS by runner.ts
 * (the e2e serve.mjs pattern) so the harness drives a genuine HTTP/SSE server in a
 * separate process — black-box, exactly the SUT a user runs.
 *
 * KEY DIFFERENCE FROM apps/ui/e2e/serve.mjs: the live harness boots WITHOUT the DI
 * stubs — `live = real geocode + real DeepSeek` (task BUILD). The two external
 * collaborators (resolveLocation / harnessGenerate) keep their REAL implementations.
 * The only thing this host arranges is ISOLATION (a throwaway DB under
 * ~/.autobroker-ts) + the migration + a seed account, and it prints the port.
 *
 * DRY-RUN MODE (--dry-run, task BUILD §7): boot the server with the test DI seam
 * DISABLED (NOT stubbed) but STOP before the first live call — i.e. boot, print the
 * port, and let the runner prove the wiring end-to-end MINUS spend (the runner runs
 * preflight + driver_kind self-check + a no-LLM read of /api/mode and exits before
 * POSTing a turn that would call DeepSeek). This host itself makes no live call; it
 * just refuses to inject stubs so the wiring is the real one.
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
import { openDb, resolveDataDir } from "@autobroker/tools";
import { resetMastraForTests, resetRuntimeGlueForTests } from "@autobroker/workflows";

const here = dirname(fileURLToPath(import.meta.url));
// harness/ → repo-root packages/db/drizzle/<migration>.sql
const MIGRATION_SQL = join(here, "..", "packages", "db", "drizzle", "0000_military_red_skull.sql");

/** Apply the committed migration + seed account to the isolated DB (idempotent-ish:
 *  a fresh tmp DB each run, so the migration always lands on an empty file). */
function bootstrapDb(): void {
  const db = openDb(); // resolves <AUTOBROKER_DATA_DIR>/autobroker.db (the tools closure).
  try {
    db.$client.exec(readFileSync(MIGRATION_SQL, "utf8"));
    // Seed the single account the active-slot uniqueness + intake persist need.
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-harness-1", "harness@example.com");
  } finally {
    db.$client.close();
  }
}

async function main(): Promise<void> {
  // Telemetry belt before any Mastra construction (preflight already required "1").
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";
  // Never auto-approve — keep the decline path live (the runner asserted this too).
  delete process.env.AUTOBROKER_TEST_AUTO_APPROVE;

  const dataDir = resolveDataDir();
  bootstrapDb();

  // LIVE: do NOT inject the DI stubs — real geocode + real DeepSeek. We still reset
  // the Mastra singleton + glue ownership so a fresh process starts clean. (The
  // dry-run mode is identical at the host level: it ALSO does not stub; the runner
  // is what stops before the first live call.)
  resetMastraForTests();
  resetRuntimeGlueForTests();

  const built = await buildServer({ quiet: true });
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
