/**
 * freezeToCorpus — the minimizer + corpus emitter (discovery → freeze → gate).
 *
 * The soak is the DISCOVERY engine; the *.toml corpus is the GATE. When a
 * scenario fails a DETERMINISTIC assertion, this module:
 *  (1) MINIMIZES the exact generated freeform text — a deterministic shrink loop
 *      that drops sentences (then tokens) while the failure predicate still holds,
 *      bounded by a max-iteration budget; if it cannot shrink, it freezes the
 *      full text (plan-0 open-question: "could not minimize, freeze full text").
 *  (2) EMITS a fixed `*.ui_*.toml` in the EXISTING cases.ts grammar: a [narrative]
 *      input_mode=freeform case + [steps.input_inline].prompt = the frozen text +
 *      the failing anchor as a [[steps.anchors]] entry + (when present) dealer
 *      replies as [[seed.dealer_replies]]. The frozen case is then a deterministic
 *      regression `pnpm harness` / ui:functional can run.
 *
 * Only DETERMINISTIC failures freeze (a judge-dim flip does NOT — plan-0 ruling).
 * The minimizer is PURE given a predicate; emitCorpusToml is a pure string build.
 *
 * Dependency wall: harness layer. node:fs only (writeFileSync for the emit) —
 * no DB, no framework, no provider. Reuses the cases.ts grammar by EMITTING it,
 * never by importing a writer (cases.ts is read-only).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// the deterministic shrink loop (pure given a predicate)
// ---------------------------------------------------------------------------

/** The shrink predicate: returns true when `candidate` STILL reproduces the
 *  failure (so the candidate is a valid smaller reproduction). In the live lane
 *  this re-runs the scenario with the candidate text and checks the deterministic
 *  assertion still fails; in tests it is a pure stub. */
export type FailsPredicate = (candidate: string) => boolean;

export interface MinimizeOpts {
  /** Max shrink iterations before giving up + freezing the full text. */
  maxIterations?: number;
}

export interface MinimizeResult {
  /** The smallest text that still reproduces the failure. */
  minimized: string;
  /** True when the loop shrank below the input (false → froze the full text). */
  shrank: boolean;
  /** Iterations actually spent. */
  iterations: number;
}

/** Split prose into sentence-ish chunks for the coarse first pass (keeps the
 *  delimiters' meaning by splitting on sentence enders + newlines). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Minimize a failing input deterministically: greedily drop sentences (coarse),
 * then whitespace-delimited tokens (fine), keeping any drop that STILL fails the
 * predicate. Bounded by maxIterations — on exhaustion it returns the smallest
 * reproduction found so far (or the full text if nothing shrank: the "could not
 * minimize, freeze full text" fallback). Pure given the predicate.
 */
export function minimizeFailingInput(
  input: string,
  fails: FailsPredicate,
  opts: MinimizeOpts = {},
): MinimizeResult {
  const maxIterations = opts.maxIterations ?? 200;
  // Guard: the predicate must hold on the full input, else there is nothing to
  // minimize (a caller bug — fail loud rather than emit a bogus corpus case).
  if (!fails(input)) {
    throw new Error("minimizeFailingInput: the predicate does not fail on the full input");
  }

  let current = input;
  let iterations = 0;

  // Pass 1: drop whole sentences.
  let changed = true;
  while (changed && iterations < maxIterations) {
    changed = false;
    const sentences = splitSentences(current);
    if (sentences.length <= 1) break;
    for (let i = 0; i < sentences.length && iterations < maxIterations; i += 1) {
      iterations += 1;
      const candidate = sentences.filter((_, j) => j !== i).join(" ").trim();
      if (candidate.length > 0 && fails(candidate)) {
        current = candidate;
        changed = true;
        break; // restart the pass on the smaller text.
      }
    }
  }

  // Pass 2: ddmin over whitespace tokens — remove ever-finer COMPLEMENT chunks
  // (the classic Zeller/Hildebrandt delta-debugging reduce-to-subset), then a
  // final 1-minimality verify pass that guarantees no single token can be dropped.
  let tokens = current.split(/\s+/).filter((t) => t.length > 0);
  let n = 2; // granularity: number of chunks the token list is split into.
  while (tokens.length > 1 && iterations < maxIterations) {
    const size = Math.ceil(tokens.length / n);
    let reduced = false;
    for (let start = 0; start < tokens.length && iterations < maxIterations; start += size) {
      iterations += 1;
      // try the COMPLEMENT (everything except this chunk) — the ddmin step.
      const complement = [...tokens.slice(0, start), ...tokens.slice(start + size)];
      const candidate = complement.join(" ").trim();
      if (candidate.length > 0 && fails(candidate)) {
        tokens = complement;
        n = Math.max(n - 1, 2); // a removal shrinks the list → coarsen granularity.
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= tokens.length) break; // granularity is at single tokens → done.
      n = Math.min(tokens.length, n * 2); // refine granularity.
    }
  }

  // 1-minimality verify pass: after ddmin, sweep dropping each remaining single
  // token; if any drop still fails, ddmin missed it — keep dropping until a full
  // clean sweep proves no single token is removable (the 1-minimal guarantee).
  let singleChanged = true;
  while (singleChanged && iterations < maxIterations) {
    singleChanged = false;
    for (let i = 0; i < tokens.length && iterations < maxIterations; i += 1) {
      if (tokens.length <= 1) break;
      iterations += 1;
      const candidate = tokens.filter((_, j) => j !== i).join(" ").trim();
      if (candidate.length > 0 && fails(candidate)) {
        tokens = tokens.filter((_, j) => j !== i);
        singleChanged = true;
        break;
      }
    }
  }
  current = tokens.join(" ").trim();

  return { minimized: current, shrank: current.length < input.length, iterations };
}

// ---------------------------------------------------------------------------
// the corpus TOML emit (pure string build in the cases.ts grammar)
// ---------------------------------------------------------------------------

/** One dealer reply to fold into [[seed.dealer_replies]] for a multi-round freeze. */
export interface FrozenDealerReply {
  dealerName: string;
  dealerWebsite: string;
  from: string;
  subject: string;
  body: string;
}

export interface EmitCorpusTomlInput {
  /** The frozen case [meta].id (unique, stable). */
  caseId: string;
  /** The product skill the frozen case exercises (the cell key). */
  skill: string;
  /** The provider the regression runs under (deepseek by default — the corpus gate). */
  provider?: "deepseek" | "anthropic" | "openai";
  /** The minimized freeform text the user types. */
  frozenText: string;
  /** The deterministic assertion that failed (mapped to a [[steps.anchors]] kind;
   *  an unmapped per-skill id falls back to the keystone floor). */
  failingAssertion: string;
  /** Multi-round dealer replies to seed (optional). */
  dealerReplies?: FrozenDealerReply[];
}

/** A double-quoted TOML string literal with the case grammar's supported escapes
 *  (\" \\ \n \t — see toml.ts unescapeString). */
function tomlString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Map a failed deterministic assertion to the [[steps.anchors]] block the frozen
 * corpus case asserts. The keystone + safety assertions map to the existing
 * evaluator anchor kinds so `pnpm harness` scores the regression with the SAME
 * deterministic machinery the soak used.
 */
function anchorBlockFor(assertion: string): string {
  switch (assertion) {
    case "no_external_mutation":
    case "l1_fuse_armed":
    case "gate_decline_zero_write":
    case "irreversible_fake_send":
    case "session_no_fork":
    case "budget_redaction":
      // All of these are anchored by the keystone in the existing corpus grammar
      // (the harness evaluator scores no_external_mutation on every step; the
      // table deltas ride table_min_rows in the per-skill case the operator then
      // tunes). Freeze the keystone — the non-negotiable floor.
      return ['[[steps.anchors]]', 'kind = "no_external_mutation"'].join("\n");
    case "malformed_extraction_fail_closed":
      return ['[[steps.anchors]]', 'kind = "malformed_tool_call"', 'expect = "fail_closed"'].join("\n");
    case "cost_and_time_attributable":
      return ['[[steps.anchors]]', 'kind = "cost_and_time"'].join("\n");
    case "profile_ask_branch":
      // The profile-ASK branch terminates in a typed STOP — the frozen case
      // asserts run_status=error (the STOP terminal) + the keystone.
      return ['[[steps.anchors]]', 'kind = "run_status"', 'expect = ["error"]'].join("\n");
    default:
      // A per-skill assertion id with no generic anchor mapping relies on the
      // always-emitted run_status + keystone anchors (the non-negotiable floor);
      // the per-skill plan emits a richer case when its assertion needs one.
      return "";
  }
}

/**
 * Emit a frozen *.ui_*.toml string in the cases.ts grammar: a freeform UI-lane
 * intake case whose input_inline.prompt is the minimized text + the failing
 * anchor + the always-on keystone + (when present) dealer replies. The output
 * parses through loadCase() without error and `pnpm harness` can run it.
 */
export function emitCorpusToml(input: EmitCorpusTomlInput): string {
  const provider = input.provider ?? "deepseek";
  const lines: string[] = [];
  lines.push(`# FROZEN by soak freezeToCorpus — deterministic regression for "${input.caseId}".`);
  lines.push(`# Failing assertion: ${input.failingAssertion}. Re-run via \`pnpm harness\`.`);
  lines.push("");
  lines.push("[meta]");
  lines.push(`id = ${tomlString(input.caseId)}`);
  lines.push('archetype = "B"');
  lines.push(`skills = [${tomlString(input.skill)}]`);
  lines.push('risk_group = "soak_frozen"');
  lines.push("");
  lines.push("[narrative]");
  lines.push('session_origin = "fresh_unpinned"');
  lines.push('input_mode = "freeform"');
  lines.push(`provider = ${tomlString(provider)}`);
  lines.push('lane = "ui"');
  lines.push("");

  if (input.dealerReplies !== undefined && input.dealerReplies.length > 0) {
    for (const r of input.dealerReplies) {
      lines.push("[[seed.dealer_replies]]");
      lines.push(`dealer_name = ${tomlString(r.dealerName)}`);
      lines.push(`dealer_website = ${tomlString(r.dealerWebsite)}`);
      lines.push(`from = ${tomlString(r.from)}`);
      lines.push(`subject = ${tomlString(r.subject)}`);
      lines.push(`body = ${tomlString(r.body)}`);
      lines.push("");
    }
  }

  lines.push("[[steps]]");
  lines.push('id = "frozen_freeform"');
  lines.push(`skill = ${tomlString(input.skill)}`);
  lines.push('purpose = "Frozen soak regression — the minimized freeform that broke an invariant."');
  lines.push('gate_policy = "approve_safe"');
  lines.push('launch = "chat_freeform"');
  lines.push("");
  lines.push("[steps.input_inline]");
  lines.push(`prompt = ${tomlString(input.frozenText)}`);
  lines.push("");
  // The frozen case types the minimized freeform (the prefill extraction runs +
  // the form renders), then DECLINES at the data_collection gate — a terminal,
  // zero-write confirm. The regression is the discovered invariant (the keystone
  // + the failing anchor below), not a successful persist, so no [narrative.profile]
  // content is needed (the soak captured the generated TEXT, not a confirmed form).
  lines.push("[[steps.resume]]");
  lines.push('on = "data_collection"');
  lines.push('action = "decline"');
  lines.push("");
  lines.push("[[steps.anchors]]");
  lines.push('kind = "run_status"');
  lines.push('expect = ["done", "error", "declined"]');
  lines.push("");
  // The failing assertion's anchor (the regression the soak discovered).
  lines.push(anchorBlockFor(input.failingAssertion));
  // The always-on keystone (every soak step asserts it).
  if (input.failingAssertion !== "no_external_mutation" && input.failingAssertion !== "l1_fuse_armed") {
    lines.push("");
    lines.push("[[steps.anchors]]");
    lines.push('kind = "no_external_mutation"');
  }
  lines.push("");
  return lines.join("\n");
}

/** Write a frozen corpus case to disk (creates parent dirs). Returns the path. */
export function writeCorpusCase(outPath: string, toml: string): string {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, toml, "utf8");
  return outPath;
}
