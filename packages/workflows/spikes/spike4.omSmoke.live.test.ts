/**
 * SPIKE-4 — Observational Memory (OM) × DeepSeek smoke (PHASE_0_foundation).
 *
 * Goal (from the spike brief): run deepseek-v4-flash as the OM Observer/Reflector
 * over a LONG Tucson-corpus negotiation thread and answer two questions:
 *   1. Compression fidelity — do the HARD FACTS (dealer identities + OTD dollar
 *      figures + VIN-ish tokens + dates) survive compaction verbatim?
 *   2. Blocking behaviour — does the #14598-class tool-heavy blocking bite OUR
 *      profile? (issue closed as a tuning matter; we probe anyway and report the
 *      wall-clock ms of the OM operations.)
 *
 * LIVE spike. DeepSeek ONLY. Gated behind AUTOBROKER_SPIKE_LIVE=1 so it never
 * runs in CI. Fully isolated: a fresh os.tmpdir() data dir per run, never
 * ~/.autobroker-ts. No budget/currency-as-budget anywhere in the corpus
 * (communication-never-includes-budget invariant): every dollar figure is an
 * out-the-door QUOTE from a dealer, not the buyer's private budget.
 *
 * API surface used (researched in @mastra/memory@1.20.2 + @mastra/core@1.41.0
 * .d.ts — see api_findings in the spike report):
 *   - new Memory({ storage, options: { observationalMemory: { model, observation,
 *     reflection, scope } } })  — Memory wrapper owns store extraction.
 *   - memory.createThread({ resourceId, threadId, title })  (MastraMemory base).
 *   - convertMessages([{role, content}, ...]).to('Mastra.V2')  -> MastraDBMessage[].
 *   - memory.saveMessages({ messages })  — persist the seeded corpus.
 *   - const om = await memory.omEngine  — the shared ObservationalMemory engine.
 *   - om.getStatus({ threadId })  -> { shouldObserve, pendingTokens, threshold }.
 *   - om.observe({ threadId })  -> { observed, reflected, record }  (fires Observer LLM).
 *   - om.getObservations(threadId) / memory.getContext({ threadId })  — read back.
 *
 * Model: resolveModel('deepseek.chat') from @autobroker/model returns the AI SDK
 * deepseek-v4-flash LanguageModel (registry.ts, committed). We pass that instance
 * directly as the OM `model` (OM's `model` accepts AgentConfig['model'], i.e. a
 * LanguageModel). We force thinking OFF via providerOptions (named tool_choice is
 * not used by OM, but flash defaults thinking ON; OM does a structured-ish extract
 * so we keep it deterministic and cheap).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, convertMessages } from "@mastra/core/agent";
import type { MastraDBMessage } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { resolveModel } from "@autobroker/model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The repo's committed bridge for the AI-SDK-v6 ↔ Mastra provider-version skew:
// `resolveModel()` returns an `ai@6` `LanguageModel`, structurally a valid AI SDK
// model at runtime but compile-time-distinct from Mastra's bundled provider
// types. harness.ts uses exactly this cast (`model as AgentModelConfig`); we
// mirror it. NOT an any-cast — it is the precise Mastra model-config type. OM's
// model field is a superset of AgentConfig['model'].
type AgentModelConfig = ConstructorParameters<typeof Agent>[0]["model"];

// convertMessages accepts a wide MessageListInput; an array of mixed-role
// {role, content} literals widens to a union the overload can't narrow, so we
// type the corpus input precisely here.
type CorpusInput = Parameters<typeof convertMessages>[0];

const LIVE = process.env.AUTOBROKER_SPIKE_LIVE === "1";

// ---------------------------------------------------------------------------
// HARD FACTS that MUST survive compaction. Each is asserted verbatim against the
// compacted observation text. Dollar figures are dealer OTD QUOTES, never a buyer
// budget (redact-budget invariant). VIN-ish tokens and dates are short, easy to
// drop tokens — exactly what we want to stress.
// ---------------------------------------------------------------------------
const DEALERS = [
  "Tustin Hyundai",
  "Russell Westbrook Hyundai of Garden Grove",
  "Tucson Hyundai of Orange",
] as const;

const QUOTES = ["$31,250", "$30,800", "$32,400"] as const;

const VIN_TOKENS = ["KM8J3CAL4PU123456", "KM8J3CAL9PU987654"] as const;

const DATES = ["May 28", "June 2", "June 9"] as const;

const ALL_FACTS: string[] = [...DEALERS, ...QUOTES, ...VIN_TOKENS, ...DATES];

// ---------------------------------------------------------------------------
// The corpus: a long, realistic Tucson (2025 Hyundai Tucson SEL AWD) new-car
// negotiation thread between the AutoBroker assistant and the user, 44 turns.
// Fixed INPUT corpus is fine for a spike (the LLM trace is NOT fixed — the
// Observer output is generated live). Facts are sprinkled so that compaction has
// to carry them across the whole conversation, not just the tail.
// ---------------------------------------------------------------------------
function buildCorpus(): Array<{ role: "user" | "assistant"; content: string }> {
  return [
    { role: "user", content: "I'm shopping for a 2025 Hyundai Tucson SEL AWD here in Orange County. Can you help me get out-the-door quotes from a few dealers?" },
    { role: "assistant", content: "Absolutely. For the 2025 Tucson SEL AWD I'd start with the three closest Hyundai stores: Tustin Hyundai, Russell Westbrook Hyundai of Garden Grove, and Tucson Hyundai of Orange. I'll request OTD (out-the-door) pricing including all fees and California tax. Want me to send identical spec requests to all three?" },
    { role: "user", content: "Yes, same spec to all three. Convenience package, no tow hitch, Amazon Gray exterior." },
    { role: "assistant", content: "Sent. Spec locked: 2025 Tucson SEL AWD, Convenience package, Amazon Gray, no tow hitch. I'll log each dealer's first OTD number as it comes back so we can compare apples to apples." },
    { role: "user", content: "Great. How long do these usually take?" },
    { role: "assistant", content: "Typically a few hours to a day. Internet sales managers tend to reply fastest. I'll ping you the moment the first OTD quote lands." },
    { role: "user", content: "Perfect." },
    { role: "assistant", content: "First one is in. Tustin Hyundai came back on May 28 with an out-the-door quote of $31,250 for the exact spec — Convenience package, Amazon Gray, AWD. That includes doc fee, tax, title, and license. VIN on the unit they're quoting is KM8J3CAL4PU123456." },
    { role: "user", content: "Okay, $31,250 from Tustin Hyundai. Is that a good starting point?" },
    { role: "assistant", content: "It's a reasonable opener but not aggressive — there's room. Let's hold it as the baseline and see what Russell Westbrook Hyundai of Garden Grove and Tucson Hyundai of Orange return before we counter." },
    { role: "user", content: "Sounds good. Any word from the other two?" },
    { role: "assistant", content: "Russell Westbrook Hyundai of Garden Grove just replied on May 28 as well: their out-the-door quote is $30,800 for the same Convenience-package Amazon Gray AWD build. That's $450 under Tustin Hyundai's number." },
    { role: "user", content: "Nice, $30,800 is better. What VIN is Garden Grove quoting?" },
    { role: "assistant", content: "Garden Grove's quoted unit is VIN KM8J3CAL9PU987654 — also a Convenience-package Amazon Gray AWD. So right now Russell Westbrook Hyundai of Garden Grove leads at $30,800, Tustin Hyundai sits at $31,250." },
    { role: "user", content: "Got it. And the third dealer?" },
    { role: "assistant", content: "Tucson Hyundai of Orange came in last, on June 2: their out-the-door quote is $32,400 — the highest of the three. They cited low AWD inventory. Same Amazon Gray Convenience-package spec." },
    { role: "user", content: "So Garden Grove at $30,800, Tustin at $31,250, Orange at $32,400. The Orange store is way off." },
    { role: "assistant", content: "Correct. Standings: Russell Westbrook Hyundai of Garden Grove $30,800, Tustin Hyundai $31,250, Tucson Hyundai of Orange $32,400. I'd use Garden Grove's $30,800 as leverage against Tustin Hyundai and let the Orange store drop on its own if it wants in." },
    { role: "user", content: "Let's push Tustin Hyundai to beat $30,800." },
    { role: "assistant", content: "Drafting a counter to Tustin Hyundai now: I'll tell them Russell Westbrook Hyundai of Garden Grove quoted $30,800 out-the-door on an identical Convenience-package Amazon Gray AWD Tucson, and ask if they can come under it. I won't share any personal budget — only the competing dealer quote." },
    { role: "user", content: "Good — never mention my budget to any of them." },
    { role: "assistant", content: "Understood and that's a hard rule on my side: dealers only ever see competing OTD quotes, never your budget. Counter sent to Tustin Hyundai referencing the $30,800 figure." },
    { role: "user", content: "When should I expect Tustin to respond?" },
    { role: "assistant", content: "Likely within the day. If Tustin Hyundai beats $30,800 we take it back to Garden Grove. This ping-pong usually nets a few hundred more dollars off." },
    { role: "user", content: "Makes sense. What about financing — should I tell them I'm financing?" },
    { role: "assistant", content: "Keep the financing question separate from the OTD price. Lock the out-the-door number first; we negotiate the price of the car independent of how you pay. I'll keep all three quotes — $31,250, $30,800, $32,400 — pinned for reference." },
    { role: "user", content: "Okay. Did Tustin Hyundai reply yet?" },
    { role: "assistant", content: "Tustin Hyundai responded on June 9: they'll match $30,800 out-the-door but say they can't go under it on VIN KM8J3CAL4PU123456 due to allocation. So now Tustin Hyundai and Garden Grove are tied at $30,800." },
    { role: "user", content: "A tie at $30,800. How do we break it?" },
    { role: "assistant", content: "Tie-breakers: which store has the exact Amazon Gray unit on the ground, accessory throw-ins (all-weather mats, cargo tray), and how clean the paperwork is. Russell Westbrook Hyundai of Garden Grove already has VIN KM8J3CAL9PU987654 in stock; Tustin Hyundai's KM8J3CAL4PU123456 is in-transit." },
    { role: "user", content: "I'd rather have the car in stock. Lean Garden Grove." },
    { role: "assistant", content: "Agreed. I'll go back to Russell Westbrook Hyundai of Garden Grove, confirm $30,800 out-the-door on in-stock VIN KM8J3CAL9PU987654, and ask them to include all-weather floor mats at no charge to close it." },
    { role: "user", content: "Perfect. Ask for the mats and a full tank." },
    { role: "assistant", content: "Done — requesting all-weather mats and a full tank of gas on top of the $30,800 out-the-door from Garden Grove. Tustin Hyundai stays as our backup at $30,800, Tucson Hyundai of Orange remains the outlier at $32,400." },
    { role: "user", content: "What's the timeline to actually pick it up?" },
    { role: "assistant", content: "Once Garden Grove confirms the $30,800 OTD plus mats in writing, you can usually schedule pickup within 48 hours. I'll get the buyer's order emailed so every line item is documented before you drive over." },
    { role: "user", content: "Great. Remind me of the final standings once more?" },
    { role: "assistant", content: "Final standings as of June 9: Russell Westbrook Hyundai of Garden Grove $30,800 (in-stock VIN KM8J3CAL9PU987654, leading), Tustin Hyundai $30,800 (in-transit VIN KM8J3CAL4PU123456, backup), Tucson Hyundai of Orange $32,400 (outlier). First quotes were May 28 (Tustin, Garden Grove) and June 2 (Orange)." },
    { role: "user", content: "Awesome. Let's lock Garden Grove." },
    { role: "assistant", content: "Locking Russell Westbrook Hyundai of Garden Grove at $30,800 out-the-door on VIN KM8J3CAL9PU987654, with all-weather mats and a full tank requested. I'll send the confirmation request and bring back their written buyer's order." },
    { role: "user", content: "One more — can you double check the Orange store can't do better?" },
    { role: "assistant", content: "I'll give Tucson Hyundai of Orange one last shot from their $32,400 starting point, telling them the winning out-the-door number to beat is $30,800. If they don't move meaningfully, we proceed with Garden Grove." },
    { role: "user", content: "Good. That's everything for now." },
    { role: "assistant", content: "Summary pinned: 2025 Tucson SEL AWD Convenience, Amazon Gray. Garden Grove $30,800 (VIN KM8J3CAL9PU987654, in stock, chosen), Tustin Hyundai $30,800 (VIN KM8J3CAL4PU123456, backup), Tucson Hyundai of Orange $32,400. Quote dates May 28, June 2, June 9. I'll alert you the moment Garden Grove confirms in writing." },
  ];
}

interface SpikeResult {
  observeMs: number;
  observed: boolean;
  reflected: boolean;
  statusBefore: { shouldObserve: boolean; pendingTokens: number; threshold: number };
  observationsText: string;
  contextSystemMessage: string | undefined;
  survived: string[];
  lost: string[];
}

let result: SpikeResult | undefined;
let tmpDir: string | undefined;

describe.skipIf(!LIVE)("spike4 — OM × deepseek-v4-flash compaction smoke", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobroker-spike4-"));
    const dbPath = join(tmpDir, "mastra.db");

    // Isolated LibSQL store. The Memory wrapper extracts its memory sub-store
    // internally (getMemoryStore()), so we hand it the LibSQLStore directly.
    const storage = new LibSQLStore({
      id: "autobroker-spike4",
      url: `file:${dbPath}`,
    });
    await storage.init();

    // deepseek-v4-flash via the committed registry. thinking OFF for a cheap,
    // deterministic extract (flash defaults thinking ON; OM doesn't need it).
    const model = resolveModel("deepseek.chat");

    const memory = new Memory({
      storage,
      options: {
        // Low messageTokens so our ~3-4k-token corpus blows past the threshold
        // and the Observer is guaranteed to fire on one observe() pass.
        observationalMemory: {
          model: model as AgentModelConfig,
          scope: "thread",
          observation: {
            messageTokens: 800,
            modelSettings: { temperature: 0 },
            // flash thinking defaults ON; turn it off for the observer step.
            // `providerOptions` is a sibling of `modelSettings` on ObservationConfig
            // (NOT nested inside it); OM's ProviderOptions accepts a `deepseek` key
            // via its index signature.
            providerOptions: { deepseek: { thinking: { type: "disabled" } } },
          },
          reflection: {
            observationTokens: 40_000,
          },
        },
      },
    });

    const resourceId = "spike4-user";
    const threadId = "spike4-thread";
    await memory.createThread({ resourceId, threadId, title: "Tucson OTD negotiation" });

    // Seed the corpus. convertMessages(...).to('Mastra.V2') yields full
    // MastraDBMessage objects; we stamp threadId/resourceId and stagger
    // createdAt so OM's cursor sees a strictly ordered history.
    const base = Date.now() - buildCorpus().length * 60_000;
    const dbMessages: MastraDBMessage[] = convertMessages(buildCorpus() as CorpusInput)
      .to("Mastra.V2")
      .map((m, i) => ({
        ...m,
        threadId,
        resourceId,
        createdAt: new Date(base + i * 60_000),
      }));

    await memory.saveMessages({ messages: dbMessages });

    const om = await memory.omEngine;
    if (!om) {
      throw new Error(
        "memory.omEngine returned null — observationalMemory was not enabled. " +
          "Check the Memory options shape.",
      );
    }

    const statusBeforeRaw = await om.getStatus({ threadId });
    const statusBefore = {
      shouldObserve: statusBeforeRaw.shouldObserve,
      pendingTokens: statusBeforeRaw.pendingTokens,
      threshold: statusBeforeRaw.threshold,
    };

    // ---- THE PROBE: time the (potentially blocking) Observer LLM call. ----
    const t0 = performance.now();
    const observeRes = await om.observe({ threadId });
    const observeMs = Math.round(performance.now() - t0);

    // Read back the compacted state two ways.
    const observationsText = (await om.getObservations(threadId)) ?? "";
    const ctx = await memory.getContext({ threadId });

    const haystack = `${observationsText}\n${ctx.systemMessage ?? ""}`;
    const survived = ALL_FACTS.filter((f) => haystack.includes(f));
    const lost = ALL_FACTS.filter((f) => !haystack.includes(f));

    result = {
      observeMs,
      observed: observeRes.observed,
      reflected: observeRes.reflected,
      statusBefore,
      observationsText,
      contextSystemMessage: ctx.systemMessage,
      survived,
      lost,
    };

    // Human-readable probe output (shows in vitest stdout).
    // eslint-disable-next-line no-console
    console.log(
      "\n[spike4] ===== OM × deepseek-v4-flash result =====\n" +
        `  status before observe: shouldObserve=${statusBefore.shouldObserve} ` +
        `pendingTokens=${statusBefore.pendingTokens} threshold=${statusBefore.threshold}\n` +
        `  observe(): observed=${observeRes.observed} reflected=${observeRes.reflected}\n` +
        `  observe() wall-clock: ${observeMs} ms  (<-- #14598 blocking probe)\n` +
        `  observation chars: ${observationsText.length}\n` +
        `  facts SURVIVED (${survived.length}/${ALL_FACTS.length}): ${survived.join(" | ")}\n` +
        `  facts LOST    (${lost.length}/${ALL_FACTS.length}): ${lost.join(" | ") || "(none)"}\n` +
        "  ---- compacted observations ----\n" +
        observationsText +
        "\n[spike4] ==========================================\n",
    );
  }, 180_000);

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fired the Observer live on deepseek-v4-flash (observe() produced observations)", () => {
    expect(result).toBeDefined();
    expect(result!.statusBefore.shouldObserve).toBe(true);
    expect(result!.observed).toBe(true);
    expect(result!.observationsText.length).toBeGreaterThan(0);
  });

  it("captured an observe() wall-clock timing (#14598 blocking probe)", () => {
    expect(result!.observeMs).toBeGreaterThan(0);
    // No hard upper bound — we REPORT the number; the spike's job is to surface
    // it, not to gate on it. A multi-minute block would still pass here but be
    // visible in the logged ms.
  });

  it("never leaks a buyer budget into the compacted state (redact-budget invariant)", () => {
    // The corpus contains only dealer OTD quotes; assert no budget-framed phrase
    // sneaks into observations (defensive — corpus is clean by construction).
    const hay = `${result!.observationsText}\n${result!.contextSystemMessage ?? ""}`.toLowerCase();
    expect(hay).not.toContain("my budget");
    expect(hay).not.toContain("buyer budget");
    expect(hay).not.toContain("can afford");
  });

  it("preserves every hard fact verbatim through compaction (dealers, OTD quotes, VINs, dates)", () => {
    // THIS is the fidelity gate. Partial loss => test fails, and result.lost is
    // the exact loss list (that finding is the spike's payload, reported straight).
    expect(result!.lost, `lost facts: ${result!.lost.join(" | ")}`).toEqual([]);
    expect(result!.survived).toEqual(ALL_FACTS);
  });
});
