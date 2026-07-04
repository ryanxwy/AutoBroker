/**
 * ChatRail — the chat-rail container. Renders the projected turns of the
 * App-level chat (UserTurn + AssistantTurn three-zone), the non-skippable
 * IntakeScopeNotice, a top-right HISTORY popover (recent sessions), a
 * collapsible SKILLS tray directly above the composer, and the ChatInput. When a
 * search is pinned, the header title becomes the pinned-search identity
 * (vehicle + ZIP) with a folded unpin, instead of the launch/skill title.
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
import { gateKindOf, gateTrack } from "../gate/gateTrack.js";
import { HistoryIcon, MinimizeIcon, PinIcon } from "../shell/icons.js";
import { Popover } from "../shell/Popover.js";
import { SearchPicker } from "../shell/SearchPicker.js";
import { SkillsPopoverList, type ServerSuggestion } from "../shell/SkillsPopover.js";
import { AgentBar, type AgentPresence, type AgentUiSelection } from "./AgentBar.js";
import { AssistantTurn } from "./AssistantTurn.js";
import { ChatInput } from "./ChatInput.js";
import { IntakeScopeNoticeCard } from "./IntakeScopeNotice.js";
import { SessionHistory } from "./SessionHistory.js";

export interface ChatRailProps {
  /** The rail header title (the launch surface names the conversation). */
  title: string;
  /** The projected turns of the single App-level chat. */
  turns: TurnView[];
  /** The run currently driving the rail (its assistant turn is the live one). */
  activeRunId: string | null;
  /** Whether a run is ACTIVE (running OR awaiting_approval, i.e. NOT terminal).
   *  While a run is in flight the composer is SOFT-BLOCKED so a typed message
   *  cannot spawn a concurrent run — this supersedes the older gate-only lock (a
   *  pending gate is always also an active run, and a merely-running run now
   *  locks the composer too). Gates stay button-only. */
  runActive: boolean;
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
  /** Human label for the pinned search (vehicle name; falls back to the id). */
  pinLabel: string | null;
  /** The pinned search's ZIP (rendered after the vehicle in the rail title), or null. */
  pinZip: string | null;
  /** The rail's current session (History highlights it), or null. */
  currentSessionId: string | null;
  /** The implemented skill manifest (the rail Skills tray directory). */
  skills: SkillManifest[];
  /** OPTIONAL Hybrid-layer re-rank of the deterministic top-3 (LLM order +
   *  reasons); empty when no run has completed / in the deterministic lane. */
  serverSuggested?: ServerSuggestion[];
  /** Whether at least one ACTIVE profile exists (skill readiness grouping). */
  hasActiveProfile: boolean;
  /** Whether the required DeepSeek key is configured (skill launch gate). */
  deepseekReady: boolean;
  /** The AgentBar's current selection (App owns it; the bar reconciles for display). */
  agentSelection: AgentUiSelection;
  /** Credential presence the AgentBar gates its options on. */
  agentPresence: AgentPresence;
  /** Fired on an explicit AgentBar pick (App marks dirty + persists). */
  onAgentChange: (next: AgentUiSelection) => void;
  onSlash: (skill: string, args: Record<string, string>, note?: string) => void;
  onFreeform: (text: string) => void;
  onUnpin: () => void;
  /** Pin the CURRENT session to a profile (the per-session pin toggle). */
  onPin: (profileId: string) => void;
  /** Open the view/edit modal for a profile (the picker row title). */
  onViewProfile: (profileId: string, name: string) => void;
  /** Start a fresh intake (the 0-active STOP card CTA). */
  onStartIntake: () => void;
  /** Re-launch a STOP-carded turn's skill pinned to the picked profile. */
  onStopPick: (skill: string | null, profileId: string) => void;
  /** Enter an existing session (History row click). */
  onSelectSession: (sessionId: string) => void;
  /** Run a skill from the rail Skills tray. */
  onRunSkill: (skill: SkillManifest) => void;
  /** Launch a clarify turn's suggested skill ("Run it explicitly"; gates downstream). */
  onRunSuggested: (skill: string) => void;
  /** Minimize the rail to the floating launcher (App owns the state). */
  onMinimize: () => void;
}

export function ChatRail({
  title,
  turns,
  activeRunId,
  runActive,
  browserView,
  decision,
  knownSkills,
  client,
  scopeNotice,
  pinnedProfileId,
  pinLabel,
  pinZip,
  currentSessionId,
  skills,
  serverSuggested,
  hasActiveProfile,
  deepseekReady,
  agentSelection,
  agentPresence,
  onAgentChange,
  onSlash,
  onFreeform,
  onUnpin,
  onPin,
  onViewProfile,
  onStartIntake,
  onStopPick,
  onSelectSession,
  onRunSkill,
  onRunSuggested,
  onMinimize,
}: ChatRailProps): JSX.Element {
  // The most-recently-run skill drives the Skills-tray suggested-set window:
  // the last turn's skill if the last turn is an assistant run, else null.
  const lastTurn = turns[turns.length - 1];
  const lastSkill = lastTurn?.kind === "assistant" ? lastTurn.turn.skill : null;

  // The rail-level decision error is the ONLY error surface for the IntakeForm
  // family (rail-tracked, non-batch_review gates render no per-card error line).
  // For the batch_review family (GateCardSwitch) and the banner-tracked approval/
  // confirmation gates (GateBannerHost) the per-card error already shows — so
  // suppress the rail-level duplicate there. Shown too when no gate is pending
  // (the decisionId-less "nothing to respond to" fallback).
  const activeTurn = turns.find(
    (t): t is Extract<TurnView, { kind: "assistant" }> => t.kind === "assistant" && t.id === activeRunId,
  );
  const activeAwaiting = activeTurn?.turn.status === "awaiting_approval" ? activeTurn.turn.awaitingUser : null;
  const activeGateKind = gateKindOf(activeAwaiting?.specInline);
  const railErrorVisible =
    activeAwaiting === null || (gateTrack(activeGateKind) === "rail" && activeGateKind !== "batch_review");
  return (
    <aside className="chat-rail" id="chat-rail" data-testid="chat-rail" aria-label="Conversation">
      <div className="rail-header">
        {/* When a search is PINNED the title IS the pinned search identity —
            ● year make model trim · ZIP — with the unpin folded in (so every
            skill in this session reads as acting on that one search). Unpinned,
            it falls back to the launch/skill title. */}
        {pinnedProfileId !== null ? (
          <span
            className="rail-pin-title"
            data-testid="rail-pin-title"
            title={pinnedProfileId}
            style={{ flex: 1, minWidth: 0 }}
          >
            <span className="rail-pin-dot" aria-hidden="true" />
            <span className="rail-pin-id" data-testid="pin-chip-label">
              {pinLabel ?? pinnedProfileId}
              {pinZip !== null && <span className="rail-pin-zip"> · {pinZip}</span>}
            </span>
            <button
              type="button"
              className="rail-pin-unpin"
              data-testid="pin-chip-unpin"
              aria-label="Unpin profile"
              title="Unpin this search"
              onClick={onUnpin}
            >
              ✕
            </button>
          </span>
        ) : (
          <span className="rail-pin-toggle-wrap" style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {/* Per-session pin toggle (ruling #6): a pin icon at the TOP of the
                session opens the SAME Searches picker; picking a search flips
                THIS session into focused pinned mode. Reuses SearchPicker. */}
            <Popover
              label={<PinIcon filled={false} />}
              triggerTestId="session-pin"
              panelTestId="session-pin-popover"
              triggerClassName="icon-btn"
              triggerLabel="Pin a search to this session"
            >
              {(close) => (
                <SearchPicker
                  client={client}
                  pinnedProfileId={pinnedProfileId}
                  onPin={(id) => {
                    close();
                    onPin(id);
                  }}
                  onUnpin={onUnpin}
                  onViewProfile={onViewProfile}
                  onStartIntake={() => {
                    close();
                    onStartIntake();
                  }}
                  close={close}
                />
              )}
            </Popover>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
          </span>
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
        <button
          type="button"
          className="icon-btn"
          data-testid="rail-minimize"
          aria-label="Minimize chat"
          title="Minimize chat"
          onClick={onMinimize}
        >
          <MinimizeIcon />
        </button>
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
              // The batch-review family card posts through the live decide()
              // controller — but ONLY for the active turn (a stale turn's gate
              // is never live; AssistantTurn defaults to an inert controller).
              decision={turn.id === activeRunId ? decision : undefined}
              client={client}
              onStartIntake={onStartIntake}
              onPickStopProfile={(profileId) => onStopPick(turn.turn.skill, profileId)}
              onRunSuggested={onRunSuggested}
              browser={turn.id === activeRunId ? browserView : null}
            />
          ),
        )}

        {decision.decisionError !== null && railErrorVisible && (
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
            lastSkill={lastSkill}
            serverSuggested={serverSuggested ?? []}
            onRun={onRunSkill}
          />
        </div>
      </details>

      {/* The agent selector — Provider · Method · Model · Effort — rides directly
          above the composer; its selection rides the next run/route when dirty. */}
      <AgentBar selection={agentSelection} presence={agentPresence} onChange={onAgentChange} />

      <ChatInput
        knownSkills={knownSkills}
        disabled={runActive}
        onSlash={onSlash}
        onFreeform={onFreeform}
      />
    </aside>
  );
}
