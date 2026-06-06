/**
 * PipelineLedger — one numbered row per skill with an expandable body + a Run
 * button. THE load-bearing rule: the Run button is
 * DISABLED when there is no pinned profile (profile-ASK 0-active branch, UI
 * projection) — EXCEPT search_profile_intake, which is NEVER disabled (it CREATES
 * a profile; the lone exemption). `runDisabled` encodes exactly
 * that. Stable data-testid per row + Run button.
 */

import type { SkillManifest } from "../api/wire.js";

/** Run-button gating: only intake is always enabled; everything else needs a pin. */
export function runDisabled(
  skillName: string,
  activePin: string | null,
): { disabled: boolean; tip?: string } {
  if (skillName === "search_profile_intake") return { disabled: false }; // intake alone is never disabled.
  if (activePin === null) return { disabled: true, tip: "Pin a search first (run /search_profile_intake)." };
  return { disabled: false };
}

export interface PipelineLedgerProps {
  skills: SkillManifest[];
  activePin: string | null;
  onRun: (skill: SkillManifest) => void;
}

export function PipelineLedger({ skills, activePin, onRun }: PipelineLedgerProps): JSX.Element {
  return (
    <section data-testid="pipeline-ledger">
      <h2>Pipeline</h2>
      {skills.map((skill, i) => {
        const gate = runDisabled(skill.name, activePin);
        return (
          <details className="ledger-row" key={skill.name} data-testid={`ledger-row-${skill.name}`}>
            <summary>
              <span className="stage-num">{i + 1}</span>
              <span style={{ flex: 1 }}>
                <strong>{skill.name}</strong> — {skill.summary}
              </span>
              <button
                type="button"
                className="btn-primary"
                data-testid={`ledger-run-${skill.name}`}
                disabled={gate.disabled}
                title={gate.tip}
                onClick={(e) => {
                  e.preventDefault();
                  onRun(skill);
                }}
              >
                Run
              </button>
            </summary>
            <div className="row-body">
              <div>Inputs: {skill.inputs.join(", ") || "—"}</div>
              <div>Outputs: {skill.outputs}</div>
              {gate.tip !== undefined && <div className="muted" data-testid={`ledger-tip-${skill.name}`}>{gate.tip}</div>}
            </div>
          </details>
        );
      })}
    </section>
  );
}
