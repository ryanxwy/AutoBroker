/**
 * Spike child B (crash-and-resume) — boot a FRESH server on the SAME tmp data dir
 * after child A was SIGKILLed mid-suspend. recoverOnBoot finds the
 * suspended run in mastra.db and re-attaches it; we then POST form-decision
 * decline on the recovered decisionId → terminal declined → ZERO writes.
 *
 * Proof points (decline avoids needing geocode/LLM):
 *   - the run started in a DEAD process A is re-attachable in fresh process B
 *     purely from the durable Mastra snapshot (deterministic re-registration);
 *   - resume(decline) → {outcome:'declined'} → status projects `declined`;
 *   - zero search_profiles + zero audit_log rows.
 *
 * argv[2] = the runId child A printed. Prints a single RESULT=<json> line the
 * parent asserts on, then exits 0.
 */

import { buildServer } from "../dist/index.js";
import { openDb } from "@autobroker/tools";

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("childB: missing runId argv");
    process.exit(2);
  }

  // Fresh boot on the SAME data dir → recoverOnBoot re-attaches the suspended run.
  const built = await buildServer({ quiet: true });
  await built.app.listen({ host: "127.0.0.1", port: 0 });

  const recovered = built.recovery.suspended.some((r) => r.runId === runId);

  // GET the re-attached run to read the FRESH decisionId child B minted on reattach.
  const status = await built.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
  const summary = status.json();
  const decisionId = summary.pending?.decision_id;
  if (!decisionId) {
    console.log(
      `RESULT=${JSON.stringify({ recovered, reattached: false, status: summary.status })}`,
    );
    await built.app.close();
    process.exit(0);
  }

  // Decline the recovered suspend → terminal declined, zero writes.
  const decline = await built.app.inject({
    method: "POST",
    url: `/api/skill-runs/${runId}/form-decision`,
    payload: { decision_id: decisionId, decision: { action: "decline" } },
  });

  const after = await built.app.inject({ method: "GET", url: `/api/skill-runs/${runId}` });
  const afterStatus = after.json().status;

  // Read row counts straight from the product DB (tools openDb).
  const db = openDb();
  const profiles = db.$client.prepare("SELECT COUNT(*) AS n FROM search_profiles").get().n;
  const audits = db.$client.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  db.$client.close();

  console.log(
    `RESULT=${JSON.stringify({
      recovered,
      reattached: true,
      declineCode: decline.statusCode,
      status: afterStatus,
      profiles,
      audits,
    })}`,
  );
  await built.app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("childB error:", err);
  process.exit(1);
});
