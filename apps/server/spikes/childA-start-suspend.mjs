/**
 * Spike child A (crash-and-resume) — boot the REAL server on an ephemeral port +
 * tmp data dir, start an intake run, reach the collect suspend
 * (awaiting_user), print RUNID + READY, then idle forever so the parent can
 * SIGKILL this process mid-suspend. The Mastra snapshot is durable in
 * <dataDir>/mastra.db; child B re-attaches from it.
 *
 * Env (inherited from the parent test): AUTOBROKER_DATA_DIR (tmp, isolated),
 * AUTOBROKER_MODE=test, MASTRA_TELEMETRY_DISABLED=1, PORT=0.
 * Imports the BUILT dist (apps/server/dist) — the deterministic step closures are
 * re-registered by module import (runtimeGlue contract).
 */

import { buildServer } from "../dist/index.js";

async function main() {
  const built = await buildServer({ quiet: true });
  // Ephemeral port on 127.0.0.1 (trust boundary; never an external interface).
  await built.app.listen({ host: "127.0.0.1", port: 0 });

  // Start a slash intake (no trim → trimVerify skipped; no geocode/LLM needed to
  // reach the collect suspend). inject() drives the in-process route.
  const start = await built.app.inject({
    method: "POST",
    url: "/api/skill-runs",
    payload: { skill: "search_profile_intake", input_mode: "slash" },
  });
  if (start.statusCode !== 201) {
    console.error(`childA: start failed ${start.statusCode} ${start.body}`);
    process.exit(2);
  }
  const runId = start.json().run_id;

  // Confirm the run is suspended at collect (awaiting_user) before we idle.
  const status = await built.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
  const summary = status.json();
  if (summary.status !== "awaiting_approval" || summary.pending?.step !== "collect") {
    console.error(`childA: unexpected status ${JSON.stringify(summary)}`);
    process.exit(3);
  }

  // Hand the runId to the parent and signal readiness, then idle until SIGKILL.
  console.log(`RUNID=${runId}`);
  console.log("READY");
  // Keep the event loop alive forever (the parent kills us mid-suspend).
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("childA error:", err);
  process.exit(1);
});
