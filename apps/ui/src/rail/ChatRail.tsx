/**
 * ChatRail — the chat-rail container. Renders the projected turns of the
 * App-level chat (UserTurn + AssistantTurn three-zone), the non-skippable
 * IntakeScopeNotice as the forked session's FIRST part (intake-from-pinned fork
 * rule), the PinChip when the session has a pin, and the ChatInput (slash +
 * freeform launch). It is presentational w.r.t. streaming: the SINGLE useChat
 * lives in App (which never unmounts); this component receives the projected
 * TurnViews and the decision controller as props.
 *
 * The decision dispatcher flows into the ACTIVE assistant turn only, so the
 * gate/form resumes the SAME run via POST /form-decision. Launch wiring
 * (slash/freeform → start → navigate) is the parent's (App).
 */

import type { IntakeScopeNotice } from "../api/wire.js";
import type { TurnView } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { AssistantTurn } from "./AssistantTurn.js";
import { ChatInput } from "./ChatInput.js";
import { IntakeScopeNoticeCard } from "./IntakeScopeNotice.js";
import { PinChip } from "./PinChip.js";

export interface ChatRailProps {
  /** The rail header title (the launch surface names the conversation). */
  title: string;
  /** The projected turns of the single App-level chat. */
  turns: TurnView[];
  /** The run currently driving the rail (its assistant turn is the live one). */
  activeRunId: string | null;
  /** The form-decision controller for the active run's pending gate. */
  decision: DecisionController;
  knownSkills: string[];
  /** The scope notice for a forked session (rendered as the first system part). */
  scopeNotice: IntakeScopeNotice | null;
  /** The session's pinned profile, when pin hydration lands (null today). */
  pinnedProfileId: string | null;
  onSlash: (skill: string, args: Record<string, string>, note?: string) => void;
  onFreeform: (text: string) => void;
  onUnpin: () => void;
}

export function ChatRail({
  title,
  turns,
  activeRunId,
  decision,
  knownSkills,
  scopeNotice,
  pinnedProfileId,
  onSlash,
  onFreeform,
  onUnpin,
}: ChatRailProps): JSX.Element {
  return (
    <aside className="chat-rail" data-testid="chat-rail" aria-label="Conversation">
      <div className="rail-header">
        <strong style={{ flex: 1 }}>{title}</strong>
        {pinnedProfileId !== null && <PinChip label={pinnedProfileId} onUnpin={onUnpin} />}
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
            />
          ),
        )}

        {decision.decisionError !== null && (
          <p className="danger-text" data-testid="decision-error" role="alert">
            {decision.decisionError}
          </p>
        )}
      </div>

      <ChatInput knownSkills={knownSkills} onSlash={onSlash} onFreeform={onFreeform} />
    </aside>
  );
}
