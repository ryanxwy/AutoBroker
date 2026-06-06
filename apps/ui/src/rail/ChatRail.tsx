/**
 * ChatRail — the chat-rail container. Renders the active
 * session's turns (UserTurn + AssistantTurn three-zone), the non-skippable
 * IntakeScopeNotice as the forked session's FIRST part (intake-from-pinned fork
 * rule), the PinChip when the session has a pin, and the ChatInput (slash +
 * freeform launch). It binds exactly ONE run controller for the active run (the
 * single-SSE-consumer rule).
 *
 * The decision dispatcher flows from the run controller into the active
 * AssistantTurn so the gate/form resumes the SAME run. Launch wiring
 * (slash/freeform → start → navigate) is the parent's (App), passed as onLaunch.
 */

import { ApiClient } from "../api/client.js";
import type { IntakeScopeNotice } from "../api/wire.js";
import { useChat, type Session, type Turn } from "../store/useChat.js";
import { AssistantTurn } from "./AssistantTurn.js";
import { ChatInput } from "./ChatInput.js";
import { IntakeScopeNoticeCard } from "./IntakeScopeNotice.js";
import { PinChip } from "./PinChip.js";
import { useRunController } from "./useRunController.js";

export interface ChatRailProps {
  client: ApiClient;
  knownSkills: string[];
  /** The run currently driving the rail (its assistant turn is the live one). */
  activeRunId: string | null;
  /** The scope notice for a forked session (rendered as the first system part). */
  scopeNotice: IntakeScopeNotice | null;
  onSlash: (skill: string, args: Record<string, string>, note?: string) => void;
  onFreeform: (text: string) => void;
  onUnpin: () => void;
}

function isAssistantTurnForRun(turn: Turn, runId: string | null): boolean {
  return turn.role === "assistant" && runId !== null && turn.runId === runId;
}

export function ChatRail({
  client,
  knownSkills,
  activeRunId,
  scopeNotice,
  onSlash,
  onFreeform,
  onUnpin,
}: ChatRailProps): JSX.Element {
  const activeSessionId = useChat((s) => s.activeSessionId);
  const session: Session | undefined = useChat((s) =>
    activeSessionId !== null ? s.sessions[activeSessionId] : undefined,
  );
  const controller = useRunController(client, activeRunId);

  return (
    <aside className="chat-rail" data-testid="chat-rail" aria-label="Conversation">
      <div className="rail-header">
        <strong style={{ flex: 1 }}>{session?.title ?? "New search"}</strong>
        {session?.pinnedProfileId != null && (
          <PinChip label={session.pinnedProfileId} onUnpin={onUnpin} />
        )}
      </div>

      <div className="conversation" data-testid="conversation">
        {scopeNotice !== null && <IntakeScopeNoticeCard notice={scopeNotice} />}

        {session === undefined && (
          <p className="muted" data-testid="rail-empty">
            Start a search to begin a conversation.
          </p>
        )}

        {session?.turns.map((turn) =>
          turn.role === "user" ? (
            <div className="turn user" key={turn.clientId} data-testid="user-turn">
              {turn.text}
            </div>
          ) : (
            <AssistantTurn
              key={turn.clientId}
              turn={turn}
              submitting={isAssistantTurnForRun(turn, activeRunId) ? controller.submitting : false}
              onDecision={(action, content) =>
                isAssistantTurnForRun(turn, activeRunId)
                  ? controller.decide(action, content)
                  : undefined
              }
            />
          ),
        )}

        {controller.decisionError !== null && (
          <p className="danger-text" data-testid="decision-error" role="alert">
            {controller.decisionError}
          </p>
        )}
      </div>

      <ChatInput knownSkills={knownSkills} onSlash={onSlash} onFreeform={onFreeform} />
    </aside>
  );
}
