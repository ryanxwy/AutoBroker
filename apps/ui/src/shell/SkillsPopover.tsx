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
 *     profile — the lone exemption); every other skill is ready only when an
 *     active profile exists.
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
export const PIN_TIP = "Pin a search first (run /search_profile_intake).";

/** Group skills by run-readiness: intake always ready; others need an active profile. */
export function groupSkillsByReadiness(
  skills: SkillManifest[],
  activePin: string | null,
): SkillReadinessGroups {
  const ready: SkillManifest[] = [];
  const blocked: SkillManifest[] = [];
  for (const skill of skills) {
    if (skill.name === INTAKE_SKILL || activePin !== null) ready.push(skill);
    else blocked.push(skill);
  }
  return { ready, blocked };
}

export interface SkillsPopoverProps {
  skills: SkillManifest[];
  /** The active profile id (newest active row), or null when none exists. */
  activePin: string | null;
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

export function SkillsPopoverList({ skills, activePin, onRun }: SkillsPopoverProps): JSX.Element {
  const groups = groupSkillsByReadiness(skills, activePin);
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
