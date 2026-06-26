/**
 * SkillsPopover — THE skill directory (the only one): the top-bar popover
 * listing every implemented skill grouped by readiness, each row carrying the
 * REAL Run <button>. Two load-bearing rules:
 *
 *   - the Run control is a real <button> using the `disabled` ATTRIBUTE (the
 *     test driver waits on `:not([disabled])` — never swap it for aria-only
 *     disabling or a non-button element).
 *   - readiness grouping is the profile-ASK 0-active branch as a UI
 *     projection: search_profile_intake is ALWAYS ready (it CREATES the
 *     profile — the lone exemption); every other skill is ready when the
 *     session carries a TRUE pin (hydrated from the session, never inferred
 *     from the profile list) OR at least one active profile exists (the
 *     resolver's exactly-1 → run / 2+ → answerable STOP branches both need a
 *     launchable button; only the 0-active world blocks).
 *
 * The PARENT must refetch profiles + skills on every popover open (the top bar
 * never remounts; without the refetch a skill enabled by a just-finished
 * intake would never flip enabled).
 */

import type { SkillManifest } from "../api/wire.js";

export interface SkillReadinessGroups {
  ready: SkillManifest[];
  blocked: SkillManifest[];
}

/** The 0-active blocked-group hint (an infer_ok skill blocked because no search
 *  exists yet). */
export const PIN_TIP = "Create a search first (run /search_profile_intake).";

/** The pin-required blocked hint (a pin_required skill blocked because no search
 *  is pinned, even though an active one exists). */
export const PIN_REQUIRED_TIP = "Pin a search first (Searches list → Pin).";

/** Whether a skill's pin posture is SATISFIED by the current session state —
 *  the ADDITIONAL gate layered over the DeepSeek-key lock:
 *    - exempt       → always (it creates the profile).
 *    - pin_required → only with a TRUE session pin.
 *    - infer_ok     → a pin OR at least one active profile (today's behavior).
 */
function pinPostureSatisfied(
  skill: SkillManifest,
  state: { pin: string | null; hasActiveProfile: boolean },
): boolean {
  switch (skill.profile_pin) {
    case "exempt":
      return true;
    case "pin_required":
      return state.pin !== null;
    case "infer_ok":
      return state.pin !== null || state.hasActiveProfile;
  }
}

/** The blocked-row hint for a skill whose pin posture is NOT satisfied: a
 *  pin_required skill blocked WITH an active search wants "pin a search"; any
 *  skill blocked because no search exists yet wants "create a search". */
export function blockedTipFor(
  skill: SkillManifest,
  state: { pin: string | null; hasActiveProfile: boolean },
): string {
  if (skill.profile_pin === "pin_required" && state.hasActiveProfile) return PIN_REQUIRED_TIP;
  return PIN_TIP;
}

/** Group skills by run-readiness: each skill is Ready only when its pin posture
 *  is satisfied (exempt always; pin_required needs a true pin; infer_ok needs a
 *  pin or an active profile). This is an ADDITIONAL gate over the DeepSeek-key
 *  lock applied in the rendering. */
export function groupSkillsByReadiness(
  skills: SkillManifest[],
  state: { pin: string | null; hasActiveProfile: boolean },
): SkillReadinessGroups {
  const ready: SkillManifest[] = [];
  const blocked: SkillManifest[] = [];
  for (const skill of skills) {
    if (pinPostureSatisfied(skill, state)) ready.push(skill);
    else blocked.push(skill);
  }
  return { ready, blocked };
}

/** The first-run lock pointer: with no DeepSeek key NOTHING can launch (even
 *  intake needs the model), so the whole list is disabled with this hint. */
export const DEEPSEEK_LOCK_TIP = "Add your DeepSeek key in Settings first.";

/** The canonical pipeline stages, in order. Each skill belongs to exactly one
 *  stage; the suggested-set window is the stage the last-run skill belongs to
 *  PLUS the next stage. This models the natural new-car quote flow:
 *  intake → discover dealers → scan inventory → lead → read replies →
 *  negotiate/report → close out. */
export const PIPELINE_STAGES: string[][] = [
  ["search_profile_intake"],
  ["dealer_geosearch"],
  ["inventory_site_scan", "inventory_link_scan", "incentive_scrape", "inventory_compare"],
  ["dealer_web_lead_submit"],
  ["dealer_inbox_check", "dealer_reply_extract", "quote_audit", "quote_compare"],
  ["negotiation_followup", "quote_pipeline", "daily_digest"],
  ["dealer_hygiene", "dealer_closeout_email", "pipeline_reset"],
];

/** The stage index a skill name belongs to, or -1 if it is not in any stage. */
function stageIndexOf(skillName: string): number {
  return PIPELINE_STAGES.findIndex((stage) => stage.includes(skillName));
}

/** The visible suggested-set cap. The popover surfaces at most this many "next
 *  step" skills by default; everything else stays reachable behind the "More
 *  skills" disclosure (the cap shrinks the VISIBLE set, never the REACHABLE set
 *  — the uiDriver depends on that). Owner-directed (2026-06-25): a top-3,
 *  reason-carrying set, not a whole-stage wall. */
export const MAX_SUGGESTED = 3;

/** A short, action-oriented reason rendered beside each suggested skill — the
 *  deterministic DEFAULT. The Hybrid layer's LLM may override these per-skill
 *  from the live conversation (see `serverSuggested`), but this map is always
 *  the instant, offline, test-safe fallback. */
export const SKILL_REASON: Record<string, string> = {
  search_profile_intake: "Start a new car search",
  dealer_geosearch: "Find dealers in range of your search",
  inventory_site_scan: "Scan dealer sites for matching cars",
  inventory_link_scan: "Pull cars from links you paste",
  incentive_scrape: "Check manufacturer rebates & APR offers",
  inventory_compare: "Rank the cars you've found",
  dealer_web_lead_submit: "Send quote requests to dealers",
  dealer_inbox_check: "Check for new dealer replies",
  dealer_reply_extract: "Pull quotes out of dealer emails",
  quote_audit: "Sanity-check a quote's math & fees",
  quote_compare: "Compare quotes side by side",
  negotiation_followup: "Push dealers for a better price",
  quote_pipeline: "Run the full quote pipeline",
  daily_digest: "Summarize where every search stands",
  dealer_hygiene: "Clean up stale dealer threads",
  dealer_closeout_email: "Tell the other dealers you're done",
  pipeline_reset: "Wipe this search and start over",
};

/** The default one-line reason for a skill (its curated reason, else its
 *  summary). */
export function defaultSuggestionReason(skill: SkillManifest): string {
  return SKILL_REASON[skill.name] ?? skill.summary;
}

/**
 * The suggested next-step subset — at most MAX_SUGGESTED (3) ready skills, so
 * the popover is a short "what's next" list, not a 17-row wall. With no
 * profile/pin only `search_profile_intake` is suggested (the only launchable
 * thing). Otherwise the CANDIDATE window is the stage the `lastSkill` belongs to
 * PLUS the next stage (a sliding window over PIPELINE_STAGES), narrowed to
 * pin-posture-satisfied skills, ordered current-stage-before-next, then capped
 * to 3. If that window is empty (e.g. an out-of-pipeline lastSkill whose stages
 * are all blocked) we fall back to the (capped) ready list so the set is never
 * empty when something is actionable.
 */
export function nextSuggestedSkills(
  skills: SkillManifest[],
  state: { pin: string | null; hasActiveProfile: boolean; lastSkill?: string | null },
): SkillManifest[] {
  const ready = skills.filter((s) => pinPostureSatisfied(s, state));
  // No profile and no pin: intake is the only launchable thing — suggest it alone.
  if (state.pin === null && !state.hasActiveProfile) {
    return ready.filter((s) => s.name === "search_profile_intake");
  }
  // Window = the lastSkill's stage + the next stage. With no lastSkill (or an
  // unknown one) we open from the FIRST pipeline stage so the post-intake user
  // sees the start of the flow.
  const baseStage = state.lastSkill != null ? stageIndexOf(state.lastSkill) : -1;
  const fromStage = baseStage >= 0 ? baseStage : 0;
  const windowNames = new Set([
    ...(PIPELINE_STAGES[fromStage] ?? []),
    ...(PIPELINE_STAGES[fromStage + 1] ?? []),
  ]);
  const inWindow = ready.filter((s) => windowNames.has(s.name));
  // Order current-stage skills before next-stage ones (stable within a stage),
  // then cap to the top MAX_SUGGESTED — the visible "next step" set. Empty
  // window → fall back to the ready list (always actionable), capped the same.
  const ordered = inWindow
    .map((s, i) => ({ s, i, stage: stageIndexOf(s.name) }))
    .sort((a, b) => a.stage - b.stage || a.i - b.i)
    .map((x) => x.s);
  return (ordered.length > 0 ? ordered : ready).slice(0, MAX_SUGGESTED);
}

/** One LLM-written suggestion: a skill id from the deterministic candidate set
 *  plus a conversation-aware reason. The Hybrid layer passes an ordered list of
 *  these; it can RE-ORDER and RE-WORD the visible top-3 but never introduce a
 *  skill outside the deterministic candidates (safety + reachability). */
export interface ServerSuggestion {
  skillId: string;
  reason: string;
}

/** Apply an optional server (LLM) re-rank to the deterministic suggested set:
 *  keep ONLY the deterministic candidates (never widen the visible set), order
 *  them by the server's order where present, and attach the server reason; any
 *  candidate the server omitted keeps its default reason and trails after. */
export function applyServerSuggestions(
  suggested: SkillManifest[],
  serverSuggested: ServerSuggestion[] | undefined,
): { skill: SkillManifest; reason: string }[] {
  const byName = new Map(suggested.map((s) => [s.name, s] as const));
  if (serverSuggested === undefined || serverSuggested.length === 0) {
    return suggested.map((s) => ({ skill: s, reason: defaultSuggestionReason(s) }));
  }
  const out: { skill: SkillManifest; reason: string }[] = [];
  const used = new Set<string>();
  for (const sug of serverSuggested) {
    const skill = byName.get(sug.skillId);
    if (skill === undefined || used.has(skill.name)) continue; // ignore non-candidates
    used.add(skill.name);
    out.push({ skill, reason: sug.reason.trim() || defaultSuggestionReason(skill) });
  }
  for (const s of suggested) {
    if (!used.has(s.name)) out.push({ skill: s, reason: defaultSuggestionReason(s) });
  }
  return out;
}

export interface SkillsPopoverProps {
  skills: SkillManifest[];
  /** The session's TRUE pinned profile id (hydrated), or null when unpinned. */
  pin: string | null;
  /** Whether at least one ACTIVE profile exists (popover-open refetch). */
  hasActiveProfile: boolean;
  /** Whether the required DeepSeek key is configured. When false, EVERY skill is
   *  locked (no model = nothing runs) with the Settings pointer. */
  deepseekReady: boolean;
  /** The most-recently-run skill id (drives the suggested-set sliding window),
   *  or null when no run has happened yet. */
  lastSkill?: string | null;
  /** OPTIONAL Hybrid-layer re-rank of the deterministic top-3: the LLM's
   *  conversation-aware ordering + reasons. Absent (the default, and ALWAYS in
   *  test/CI/no-key) → the deterministic order + curated reasons render. It may
   *  re-order/re-word the visible top-3 but never widen it. */
  serverSuggested?: ServerSuggestion[];
  onRun: (skill: SkillManifest) => void;
}

function SkillRows({
  skills,
  disabled,
  tip,
  tipFor,
  reasonFor,
  onRun,
}: {
  skills: SkillManifest[];
  disabled: boolean;
  /** A static tip applied to every row (the locked-list / ready cases). */
  tip?: string;
  /** A per-skill tip (the blocked group, where the reason varies by posture). */
  tipFor?: (skill: SkillManifest) => string;
  /** A per-skill "why this next" reason (the suggested set). When present the
   *  row shows the reason in place of the generic summary. */
  reasonFor?: (skill: SkillManifest) => string;
  onRun: (skill: SkillManifest) => void;
}): JSX.Element {
  return (
    <>
      {skills.map((skill) => (
        <div className="skills-row" key={skill.name} data-testid={`skills-row-${skill.name}`}>
          <span className="skills-row-text">
            <strong>{skill.name}</strong>
            {reasonFor ? (
              <>
                {" "}
                <span className="skills-row-reason" data-testid={`skills-reason-${skill.name}`}>
                  {reasonFor(skill)}
                </span>
              </>
            ) : (
              <> — {skill.summary}</>
            )}
          </span>
          <button
            type="button"
            className="btn-primary"
            data-testid={`ledger-run-${skill.name}`}
            disabled={disabled}
            title={tipFor ? tipFor(skill) : tip}
            onClick={() => onRun(skill)}
          >
            Run
          </button>
        </div>
      ))}
    </>
  );
}

export function SkillsPopoverList({
  skills,
  pin,
  hasActiveProfile,
  deepseekReady,
  lastSkill = null,
  serverSuggested,
  onRun,
}: SkillsPopoverProps): JSX.Element {
  // First-run gate wins over the readiness grouping: with no DeepSeek key no
  // skill (intake included) can run, so the whole list is disabled and points
  // the owner to Settings — the gate must render before any launchable row.
  if (!deepseekReady) {
    return (
      <div data-testid="skills-list">
        <p className="muted" data-testid="skills-locked-notice">
          {DEEPSEEK_LOCK_TIP}
        </p>
        <SkillRows skills={skills} disabled tip={DEEPSEEK_LOCK_TIP} onRun={onRun} />
      </div>
    );
  }

  const state = { pin, hasActiveProfile };
  const groups = groupSkillsByReadiness(skills, state);
  // The Ready group is split: the suggested next-available subset surfaces by
  // default (so the popover is not a 17-row wall), the rest of the ready skills
  // hide behind a collapsed "More skills" disclosure (still reachable).
  const suggested = nextSuggestedSkills(skills, { ...state, lastSkill });
  // Hybrid layer: an optional LLM re-rank (order + reasons) of THESE candidates
  // only — never widens the visible set, so `moreReady` (= ready \ suggested)
  // still holds every other ready skill and the uiDriver stays able to reach it.
  const suggestedWithReasons = applyServerSuggestions(suggested, serverSuggested);
  const suggestedSkills = suggestedWithReasons.map((x) => x.skill);
  const reasonByName = new Map(suggestedWithReasons.map((x) => [x.skill.name, x.reason] as const));
  const suggestedNames = new Set(suggestedSkills.map((s) => s.name));
  const moreReady = groups.ready.filter((s) => !suggestedNames.has(s.name));
  // The blocked group mixes two reasons (no search vs no pin); the group header
  // shows the pin-required hint when ANY blocked skill is pin-required with an
  // active search, else the create-a-search hint. Each row still carries its
  // own precise tip.
  const groupHint = groups.blocked.some(
    (s) => s.profile_pin === "pin_required" && hasActiveProfile,
  )
    ? PIN_REQUIRED_TIP
    : PIN_TIP;
  return (
    <div data-testid="skills-list">
      <h3 className="skills-group-title">Ready</h3>
      <SkillRows
        skills={suggestedSkills}
        disabled={false}
        reasonFor={(s) => reasonByName.get(s.name) ?? defaultSuggestionReason(s)}
        onRun={onRun}
      />
      {moreReady.length > 0 && (
        <details data-testid="skills-more">
          <summary data-testid="skills-more-toggle">More skills</summary>
          <SkillRows skills={moreReady} disabled={false} onRun={onRun} />
        </details>
      )}
      {groups.blocked.length > 0 && (
        <>
          <h3 className="skills-group-title">Needs an active search</h3>
          <p className="muted">{groupHint}</p>
          <SkillRows
            skills={groups.blocked}
            disabled
            tipFor={(s) => blockedTipFor(s, state)}
            onRun={onRun}
          />
        </>
      )}
    </div>
  );
}
