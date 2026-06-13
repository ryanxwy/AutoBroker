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

const INTAKE_SKILL = "search_profile_intake";

/** The blocked-group hint (shown on the disabled Run controls). */
export const PIN_TIP = "Create a search first (run /search_profile_intake).";

/** Group skills by run-readiness: intake always ready; others need the
 *  session's true pin or at least one active profile (0-active blocks). */
export function groupSkillsByReadiness(
  skills: SkillManifest[],
  state: { pin: string | null; hasActiveProfile: boolean },
): SkillReadinessGroups {
  const ready: SkillManifest[] = [];
  const blocked: SkillManifest[] = [];
  const launchable = state.pin !== null || state.hasActiveProfile;
  for (const skill of skills) {
    if (skill.name === INTAKE_SKILL || launchable) ready.push(skill);
    else blocked.push(skill);
  }
  return { ready, blocked };
}

/** The first-run lock pointer: with no DeepSeek key NOTHING can launch (even
 *  intake needs the model), so the whole list is disabled with this hint. */
export const DEEPSEEK_LOCK_TIP = "Add your DeepSeek key in Settings first.";

export interface SkillsPopoverProps {
  skills: SkillManifest[];
  /** The session's TRUE pinned profile id (hydrated), or null when unpinned. */
  pin: string | null;
  /** Whether at least one ACTIVE profile exists (popover-open refetch). */
  hasActiveProfile: boolean;
  /** Whether the required DeepSeek key is configured. When false, EVERY skill is
   *  locked (no model = nothing runs) with the Settings pointer. */
  deepseekReady: boolean;
  onRun: (skill: SkillManifest) => void;
}

function SkillRows({
  skills,
  disabled,
  tip,
  onRun,
}: {
  skills: SkillManifest[];
  disabled: boolean;
  tip?: string;
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
            title={tip}
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

  const groups = groupSkillsByReadiness(skills, { pin, hasActiveProfile });
  return (
    <div data-testid="skills-list">
      <h3 className="skills-group-title">Ready</h3>
      <SkillRows skills={groups.ready} disabled={false} onRun={onRun} />
      {groups.blocked.length > 0 && (
        <>
          <h3 className="skills-group-title">Needs an active search</h3>
          <p className="muted">{PIN_TIP}</p>
          <SkillRows skills={groups.blocked} disabled tip={PIN_TIP} onRun={onRun} />
        </>
      )}
    </div>
  );
}
