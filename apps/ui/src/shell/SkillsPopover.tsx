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

/**
 * The suggested next-available subset of the ready skills — the small set the
 * rail surfaces by default so the popover is not a 17-row wall. With no
 * profile/pin only `search_profile_intake` is suggested (it is the only thing
 * that can run). Otherwise the window is the stage the `lastSkill` belongs to
 * PLUS the next stage (a sliding window over PIPELINE_STAGES), narrowed to
 * skills whose pin posture is satisfied. If that window is empty (e.g. lastSkill
 * is unknown and the next stage is all-blocked) we fall back to the full ready
 * list, so a suggested set is NEVER smaller than nothing actionable.
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
  const suggested = ready.filter((s) => windowNames.has(s.name));
  // Empty window → fall back to the full ready list (always actionable).
  return suggested.length > 0 ? suggested : ready;
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
  onRun: (skill: SkillManifest) => void;
}

function SkillRows({
  skills,
  disabled,
  tip,
  tipFor,
  onRun,
}: {
  skills: SkillManifest[];
  disabled: boolean;
  /** A static tip applied to every row (the locked-list / ready cases). */
  tip?: string;
  /** A per-skill tip (the blocked group, where the reason varies by posture). */
  tipFor?: (skill: SkillManifest) => string;
  onRun: (skill: SkillManifest) => void;
}): JSX.Element {
  return (
    <>
      {skills.map((skill) => (
        <div className="skills-row" key={skill.name} data-testid={`skills-row-${skill.name}`}>
          <span className="skills-row-text">
            <strong>{skill.name}</strong> — {skill.summary}
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
  const suggestedNames = new Set(suggested.map((s) => s.name));
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
      <SkillRows skills={suggested} disabled={false} onRun={onRun} />
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
