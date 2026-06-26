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
 * production path). AUTOBROKER_MODE=test (the sole send-control floor) /
 * MASTRA_TELEMETRY_DISABLED / the provider key are inherited from the runner's env
 * (the runner asserted them in preflight before spawning). AUTOBROKER_TEST_AUTO_APPROVE
 * is never set here.
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

import { __setRouteClassifierForTests, buildServer } from "@autobroker/server";
import { __setSecretsProbeForTests, openDb, resolveDataDir } from "@autobroker/tools";
import {
  __setDealerReplyExtractDepsForTests,
  __setDealerWebLeadSubmitDepsForTests,
  __setIntakeDepsForTests,
  __setNegotiationFollowupDepsForTests,
  resetMastraForTests,
  resetRuntimeGlueForTests,
  type ScoutFormsArgs,
  type ScoutOutcome,
  type SubmitOneArgs,
  type SubmitVerdict,
} from "@autobroker/workflows";

import {
  LEAD_SUBMIT_CAPTCHA_DEALER,
  LEAD_SUBMIT_NOFORM_DEALER,
} from "./fixtures/states/leadSubmitReady.js";

import { harnessGenerateStub, resolveLocationStub, fetchTrimSourcesStub, setScenario, type Scenario } from "./fixtures/stubs.js";
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
  // The harness host must NEVER really send. The product is buyer-by-default, so
  // mark this a harness context and pin test mode — BOTH unconditionally (the
  // LIVE host is not a fixture lane, but is still a harness context).
  // AUTOBROKER_HARNESS=1 makes boot's isHarnessContext() force test mode and the
  // assertTestModeSafe tripwire fire even if a persisted app_mode tried to flip
  // it. AUTOBROKER_MODE is the sole send-control floor; the Gmail backend
  // projects to fake from it.
  process.env.AUTOBROKER_HARNESS = "1";
  process.env.AUTOBROKER_MODE = "test";

  if (FIXTURE_MODE) {
    // Arm the workflows test-only deps seam (it refuses outside a test runner)
    // and give the DeepSeek registry a dummy key so construction never trips and
    // the FIRST-RUN GATE stays satisfied for every case that does NOT opt into
    // the no-keys world — no live call ever fires through the stubs. The
    // keys_setup fixture state CLEARS this default to stage the fresh-install
    // world it proves the save flow against.
    process.env.NODE_ENV = "test";
    process.env.DEEPSEEK_API_KEY ??= "fixture-dummy-not-used";
    // Test mode (pinned above) already projects the Gmail backend to the local
    // fake mailbox, so the functional lane never touches a real inbox and the
    // fake-mailbox-send-only preflight is satisfied — no separate backend var.
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
      fetchTrimSources: fetchTrimSourcesStub as never,
    });
    // Freeform (chat_freeform) cases POST /api/route, which the REAL handler
    // resolves via the NL classifier — a LIVE router LLM call the func lane must
    // NOT make. Keyless (as CI is) that call returns empty tool_calls, so the
    // #1244 output processor fail-closes (MalformedToolCallAbort) before the
    // data_collection gate ever renders and the case hangs on waitForURL. Inject a
    // deterministic classifier that routes the prose straight to intake with the
    // freeform seed — exactly what router.ts mapInput emits for an intake-shaped
    // message. Slash cases bypass /api/route entirely, so this only affects the
    // freeform cases. NOTE: the func corpus has exactly ONE freeform case today
    // (search_profile_intake.ui_humanized) — if a freeform case for a DIFFERENT
    // skill is ever added, branch this stub on the message instead of routing all
    // freeform straight to intake.
    __setRouteClassifierForTests(async (nl: string) => ({
      kind: "launch" as const,
      skillId: "search_profile_intake",
      inputData: { input_mode: "freeform", freeform_text: nl },
      confidence: 0.95,
      reason: "func-lane deterministic intake route (no live router LLM)",
    }));
    // X1 (dealer_web_lead_submit) — inject the browser-touching collaborators so
    // the keystone func cases drive the REAL workflow + REAL suspend/resume gate
    // chain WITHOUT a real chromium. The scout boundary returns the seeded
    // dealers' deterministic form SHAPES (a known-platform web form for the
    // web-form dealer → NO LLM field-map; no form + a contact_email for the
    // no-form dealer → the email fallback; a captcha-gated form for the captcha
    // dealer → the email fallback with reason "captcha_fallback", never
    // submitting the captcha). The gated submit boundary returns
    // `fuse_blocked` for the web-form dealer (the BLOCK=1 fake-submit) and
    // `needs_fallback` for the no-form dealer (defensive — a no-form dealer never
    // reaches submitOne, but the stub mirrors that shape). recordSubmission +
    // sendAndRecord stay REAL (the latter is L1-fuse-blocked under BLOCK=1, so the
    // email fallback writes its lead_submissions row but ZERO messages rows).
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: (args: ScoutFormsArgs): Promise<ScoutOutcome[]> =>
        Promise.resolve(
          args.dealers.map((d): ScoutOutcome => {
            if (d.dealerId === LEAD_SUBMIT_NOFORM_DEALER) {
              // No usable web form, but a harvested contact email → email fallback.
              return {
                dealerId: d.dealerId,
                name: d.name,
                website: d.website,
                form: null,
                platform: "custom",
                fieldMap: null,
                formSnapshot: null,
                contactEmail: "sales@tucsonkia.example.com",
                captcha: false,
              };
            }
            if (d.dealerId === LEAD_SUBMIT_CAPTCHA_DEALER) {
              // A captcha-gated contact form: NO usable form (the captcha is never
              // auto-submitted), but a harvested contact email → the email fallback
              // with reason "captcha_fallback". This is the scout-time detection
              // the X1 captcha follow-on wires up.
              return {
                dealerId: d.dealerId,
                name: d.name,
                website: d.website,
                form: null,
                platform: "custom",
                fieldMap: null,
                formSnapshot: null,
                contactEmail: "sales@captcha-dealer.example.com",
                captcha: true,
              };
            }
            // Default (the web-form dealer): a known DealerFire platform with a
            // usable contact form → the deterministic parity field map, NO LLM.
            return {
              dealerId: d.dealerId,
              name: d.name,
              website: d.website,
              form: { url: `${d.website}/contact.htm`, submitSelector: "button[type=submit]" },
              platform: "dealerfire",
              fieldMap: [
                { name: "Email", role: "email" },
                { name: "Comments", role: "comment" },
              ],
              formSnapshot: null,
              contactEmail: null,
              captcha: false,
            };
          }),
        ),
      submitOne: (args: SubmitOneArgs): Promise<SubmitVerdict> =>
        // The web-form dealer's gated submit hits the armed L1 fuse → fuse_blocked
        // (the fake-submit; recorded as a web_form lead row). A no-form dealer
        // never reaches here (the submit step routes it straight to fallback) —
        // return needs_fallback defensively if it ever does.
        Promise.resolve(
          args.dealerId === LEAD_SUBMIT_NOFORM_DEALER
            ? { kind: "needs_fallback", reason: "no_form" }
            : { kind: "fuse_blocked" },
        ),
    });

    // X2 (negotiation_followup) — stub ONLY the prose draft (the single LLM
    // touch). It returns a fixed, tone-appropriate, BUDGET-FREE body that names
    // NO competing dealer (numbers only — the bare "31,200" carries no `$`, so
    // assertNoBudget passes, and there is no dealer name in the text → the
    // "no competing name" red line holds). Every DB read (candidate threads /
    // quote situation / thread snapshot / reply-target ladder), the send path
    // (sendAndRecord — L1-fuse-blocked under BLOCK=1 → ZERO messages rows), the
    // contact-flip write, and the threads.state='negotiating' LOCAL write all
    // stay REAL against the seeded fixture DB.
    __setNegotiationFollowupDepsForTests({
      draftProse: () =>
        Promise.resolve({
          text:
            "Thanks for the quote. I'm comparing a few out-the-door numbers and another " +
            "dealer is currently at 31,200 OTD. Can you match or beat that on the same " +
            "trim? Happy to move quickly if the numbers work.",
          usage: {
            costUsd: null,
            durationMs: 1,
            pricingSource: "unavailable",
            promptTokens: null,
            completionTokens: null,
          },
        }),
    });
    // X3 (dealer_closeout_email) is zero-LLM + zero-browser — the deterministic
    // body/subject and the atomic close+suppress run REAL against the seeded DB
    // (sendAndRecord is L1-fuse-blocked under BLOCK=1), so there is NOTHING to
    // stub. No __setDealerCloseoutEmailDepsForTests call is needed.

    // dealer_reply_extract — stub ONLY the per-message LLM extraction (the single
    // emit_result call). It returns a fixed, BUDGET-irrelevant recovering quote so
    // a failed message recovers to `succeeded` with one quote row. The stub
    // returns success on the FIRST hop, so it stands in for BOTH same-provider
    // DeepSeek routes (the v4-flash first hop AND the automatic v4-pro+thinking
    // recovery hop) — the func lane makes ZERO real model calls. Every other
    // collaborator (resolver / candidate reader / fake gmail adapter / attachment
    // tree / all-or-nothing persist) stays REAL against the seeded DB.
    __setDealerReplyExtractDepsForTests({
      harnessGenerate: (async () => ({
        object: {
          quotes: [
            {
              financing_mode: "cash",
              vin: null,
              inventory_status: null,
              source_listing_id: null,
              quote_format: "text",
              intent: "real_quote",
              confidence: null,
              quote_received_at: null,
              quote_expires_at: null,
              msrp: null,
              selling_price: null,
              dealer_discount: null,
              doc_fee: null,
              dealer_fee: null,
              sales_tax: null,
              dmv_fees: null,
              title_fee: null,
              registration_fee: null,
              license_fee: null,
              otd_total: 43000,
              rebates_json: null,
              other_fees_json: null,
              add_ons_json: null,
              taxable_rebates_json: null,
              finance_apr: null,
              finance_term_months: null,
              finance_down_payment: null,
              finance_monthly_payment: null,
              finance_amount_financed: null,
              lease_term_months: null,
              lease_money_factor: null,
              lease_residual_pct: null,
              lease_residual_value: null,
              lease_due_at_signing: null,
              lease_monthly_payment: null,
              lease_miles_per_year: null,
              lease_acquisition_fee: null,
              lease_disposition_fee: null,
              lease_cap_cost_gross: null,
              lease_cap_cost_adjusted: null,
              lease_rent_charge: null,
            },
          ],
          message_intent: "real_quote",
        },
        usage: {
          costUsd: null,
          durationMs: 1,
          pricingSource: "unavailable",
          promptTokens: null,
          completionTokens: null,
        },
      })) as never,
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
