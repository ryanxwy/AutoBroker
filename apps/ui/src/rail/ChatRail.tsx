/**
 * ChatRail — the chat-rail container. Renders the projected turns of the
 * App-level chat (UserTurn + AssistantTurn three-zone), the non-skippable
 * IntakeScopeNotice, the PinChip, a top-right HISTORY popover (recent sessions),
 * a collapsible SKILLS tray directly above the composer, and the ChatInput.
 *
 * It is presentational w.r.t. streaming: the SINGLE useChat lives in App (which
 * never unmounts); this component receives the projected TurnViews + the decision
 * controller + the launch callbacks as props. Session history and the skill
 * directory both moved INTO the rail (out of the top bar) in this layout.
 */

import type { ApiClient } from "../api/client.js";
import type { IntakeScopeNotice, SkillManifest } from "../api/wire.js";
import type { BrowserView } from "../chat/browserView.js";
import type { TurnView } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { HistoryIcon } from "../shell/icons.js";
import { Popover } from "../shell/Popover.js";
import { SkillsPopoverList } from "../shell/SkillsPopover.js";
import { AssistantTurn } from "./AssistantTurn.js";
import { ChatInput } from "./ChatInput.js";
import { IntakeScopeNoticeCard } from "./IntakeScopeNotice.js";
import { PinChip } from "./PinChip.js";
import { SessionHistory } from "./SessionHistory.js";

export interface ChatRailProps {
  /** The rail header title (the launch surface names the conversation). */
  title: string;
  /** The projected turns of the single App-level chat. */
  turns: TurnView[];
  /** The run currently driving the rail (its assistant turn is the live one). */
  activeRunId: string | null;
  /** The active run's pending gate, if any. While a gate is pending the rail
   *  input is DISABLED (hazard fix): a typed message cannot spawn a rogue run —
   *  gates stay button-only. Null when nothing is awaiting. */
  activeAwaiting: unknown | null;
  /** The LIVE browser activity for the active run's turn, or null. */
  browserView: BrowserView | null;
  /** The form-decision controller for the active run's pending gate. */
  decision: DecisionController;
  knownSkills: string[];
  /** The typed client (the STOP picker + History list fetch live). */
  client: ApiClient;
  /** The scope notice for a forked session (rendered as the first system part). */
  scopeNotice: IntakeScopeNotice | null;
  /** The session's TRUE pinned profile (hydrated from GET /api/sessions/:id). */
  pinnedProfileId: string | null;
  /** Human label for the pin chip (vehicle name; falls back to the id). */
  pinLabel: string | null;
  /** The rail's current session (History highlights it), or null. */
  currentSessionId: string | null;
  /** The implemented skill manifest (the rail Skills tray directory). */
  skills: SkillManifest[];
  /** Whether at least one ACTIVE profile exists (skill readiness grouping). */
  hasActiveProfile: boolean;
  /** Whether the required DeepSeek key is configured (skill launch gate). */
  deepseekReady: boolean;
  onSlash: (skill: string, args: Record<string, string>, note?: string) => void;
  onFreeform: (text: string) => void;
  onUnpin: () => void;
  /** Start a fresh intake (the 0-active STOP card CTA). */
  onStartIntake: () => void;
  /** Re-launch a STOP-carded turn's skill pinned to the picked profile. */
  onStopPick: (skill: string | null, profileId: string) => void;
  /** Enter an existing session (History row click). */
  onSelectSession: (sessionId: string) => void;
  /** Run a skill from the rail Skills tray. */
  onRunSkill: (skill: SkillManifest) => void;
}

export function ChatRail({
  title,
  turns,
  activeRunId,
  activeAwaiting,
  browserView,
  decision,
  knownSkills,
  client,
  scopeNotice,
  pinnedProfileId,
  pinLabel,
  currentSessionId,
  skills,
  hasActiveProfile,
  deepseekReady,
  onSlash,
  onFreeform,
  onUnpin,
  onStartIntake,
  onStopPick,
  onSelectSession,
  onRunSkill,
}: ChatRailProps): JSX.Element {
  return (
    <aside className="chat-rail" id="chat-rail" data-testid="chat-rail" aria-label="Conversation">
      <div className="rail-header">
        <strong style={{ flex: 1 }}>{title}</strong>
        {pinnedProfileId !== null && (
          <PinChip label={pinLabel ?? pinnedProfileId} title={pinnedProfileId} onUnpin={onUnpin} />
        )}
        <Popover
          label={<HistoryIcon />}
          triggerTestId="rail-history"
          panelTestId="rail-history-popover"
          triggerClassName="icon-btn"
          triggerLabel="Session history"
        >
          {(close) => (
            <SessionHistory
              client={client}
              currentSessionId={currentSessionId}
              onSelect={(id) => {
                close();
                onSelectSession(id);
              }}
            />
          )}
        </Popover>
      </div>

      <div className="conversation" data-testid="conversation">
        {scopeNotice !== null && <IntakeScopeNoticeCard notice={scopeNotice} />}

        {turns.length === 0 && (
          <p className="muted" data-testid="rail-empty">
            Start a search to begin a conversation.
          </p>
        )}

        {turns.map((turn) =>
          turn.kind === "user" ? (
            <div className="turn user" key={turn.id} data-testid="user-turn">
              {turn.text}
            </div>
          ) : (
            <AssistantTurn
              key={turn.id}
              turn={turn.turn}
              submitting={turn.id === activeRunId ? decision.submitting : false}
              onDecision={(action, content) =>
                turn.id === activeRunId ? decision.decide(action, content) : undefined
              }
              client={client}
              onStartIntake={onStartIntake}
              onPickStopProfile={(profileId) => onStopPick(turn.turn.skill, profileId)}
              browser={turn.id === activeRunId ? browserView : null}
            />
          ),
        )}

        {decision.decisionError !== null && (
          <p className="danger-text" data-testid="decision-error" role="alert">
            {decision.decisionError}
          </p>
        )}
      </div>

      {/* Skills tray — the in-context launcher, collapsed by default so the
          composer stays the resting focus. Reuses the SkillsPopoverList directory. */}
      <details className="rail-skills" data-testid="rail-skills">
        <summary data-testid="rail-skills-toggle">Skills</summary>
        <div className="rail-skills-list">
          <SkillsPopoverList
            skills={skills}
            pin={pinnedProfileId}
            hasActiveProfile={hasActiveProfile}
            deepseekReady={deepseekReady}
            onRun={onRunSkill}
          />
        </div>
      </details>

      <ChatInput
        knownSkills={knownSkills}
        disabled={activeAwaiting !== null}
        onSlash={onSlash}
        onFreeform={onFreeform}
      />
    </aside>
  );
}
