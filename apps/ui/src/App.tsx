/**
 * App — the app shell. TopBar + routed main + the docked ChatRail + a
 * backend-unreachable banner. It owns:
 *
 *   - routing (the tiny hand-rolled router): '/' → Home, '/runs/:id' → run view,
 *     '/profiles/:id' → ProfileWorkspace placeholder, '*' → NotFound.
 *   - the four intake entries → launchIntake (fresh unpinned session):
 *     POST start → capture {run_id, session_id, scope_notice} → create a client
 *     session + assistant turn bound to run_id → render the scope notice as the
 *     fork's first part → navigate to /runs/:run_id.
 *   - REFRESH RECOVERY: on mount at /runs/:id with no in-store turn,
 *     re-create the session+turn for that run so the single SSE hook re-subscribes
 *     (server replays the full backlog) and the form draft restores from
 *     localStorage — a mid-form refresh loses nothing but the stripped PII.
 *
 * The ChatRail binds exactly one run controller (the single-SSE-consumer rule).
 */

import { useEffect, useRef, useState } from "react";

import { ApiClient, apiClient } from "./api/client.js";
import { useAsync } from "./api/useApi.js";
import type { IntakeScopeNotice, Mode, SkillManifest, SkillList, StartAck } from "./api/wire.js";
import { launchIntake, launchSkill, type LaunchMode } from "./launch.js";
import { ChatRail } from "./rail/ChatRail.js";
import { Home } from "./routes/Home.js";
import { NotFound } from "./routes/NotFound.js";
import { ProfileWorkspace } from "./routes/ProfileWorkspace.js";
import { navigate, useRoute } from "./router.js";
import { useChat } from "./store/useChat.js";

// Pre-load fallback only: the live skill list comes from GET /api/skills
// (knownSkills below). This literal is used until that fetch resolves; the UI
// does not import @autobroker/skills (it would pull the manifest into the
// browser bundle for no runtime gain — the server already serves it).
const INTAKE_SKILL = "search_profile_intake";

export function App({ client = apiClient }: { client?: ApiClient } = {}): JSX.Element {
  const route = useRoute();
  const mode = useAsync<Mode>(() => client.getMode(), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);

  const createSession = useChat((s) => s.createSession);
  const appendUserTurn = useChat((s) => s.appendUserTurn);
  const appendAssistantTurn = useChat((s) => s.appendAssistantTurn);
  const sessions = useChat((s) => s.sessions);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<IntakeScopeNotice | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const knownSkills = skills.kind === "ok" ? skills.data.map((s) => s.name) : [INTAKE_SKILL];

  // ---- launch (the four intake entries + slash/freeform) -------------------
  // Bind a StartAck to the rail: create the session (the fork's id when the
  // server forked one), append the turns, and navigate to the run view.
  const bindAck = (ack: StartAck, title: string, userText?: string): void => {
    createSession(
      ack.session_id !== null ? { sessionId: ack.session_id, title } : { title },
    );
    if (userText !== undefined) appendUserTurn(userText);
    appendAssistantTurn(ack.run_id);
    setScopeNotice(ack.scope_notice);
    setActiveRunId(ack.run_id);
    navigate(`/runs/${ack.run_id}`);
  };

  const doLaunch = (mode: LaunchMode, userText?: string): void => {
    setLaunchError(null);
    // Always fork a fresh unpinned session from the current one.
    const fromSessionId = useChat.getState().activeSessionId;
    launchIntake(client, { mode, fromSessionId })
      .then((ack) => bindAck(ack, "New search", userText))
      .catch((err: unknown) => {
        setLaunchError(err instanceof Error ? err.message : "Could not start intake.");
      });
  };

  // Generic NON-intake start (slash mode, no fork — only intake forces the
  // fresh-unpinned fork semantics). The server's RunDescriptor registry
  // validates the skill; an unknown skill surfaces as a launch error.
  const doLaunchSkill = (skill: string, userText?: string): void => {
    setLaunchError(null);
    launchSkill(client, { skill })
      .then((ack) => bindAck(ack, `/${skill}`, userText))
      .catch((err: unknown) => {
        setLaunchError(err instanceof Error ? err.message : `Could not start ${skill}.`);
      });
  };

  const startIntakeFresh = (): void => doLaunch({ kind: "slash" });
  // A ready slash for intake keeps the special launchIntake path (fresh-unpinned
  // fork); a ready slash for ANY other skill starts THAT skill generically.
  // Freeform stays intake-scoped (the ratified scope-notice behavior).
  const onSlash = (skill: string): void => {
    if (skill === INTAKE_SKILL) doLaunch({ kind: "slash" }, `/${skill}`);
    else doLaunchSkill(skill, `/${skill}`);
  };
  const onFreeform = (text: string): void => doLaunch({ kind: "freeform", freeformText: text }, text);

  // ---- refresh recovery: /runs/:id with no in-store turn -> re-bind ---------
  const recoveredRef = useRef<string | null>(null);
  useEffect(() => {
    if (route.name !== "run") return;
    const runId = route.runId;
    if (recoveredRef.current === runId) return;
    setActiveRunId(runId);
    // Is there already an assistant turn for this run? (just launched in-session)
    const known = Object.values(sessions).some((sess) =>
      sess.turns.some((t) => t.role === "assistant" && t.runId === runId),
    );
    if (!known) {
      // Cold refresh: re-create a session + turn so the SSE hook re-subscribes and
      // the server replays the backlog. The draft restores from localStorage in
      // the SchemaForm (keyed by this runId).
      createSession({ title: "Recovered search" });
      appendAssistantTurn(runId);
    }
    recoveredRef.current = runId;
  }, [route, sessions, createSession, appendAssistantTurn]);

  const backendDown =
    mode.kind === "error" ? mode.message : skills.kind === "error" ? skills.message : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="wordmark">AutoBroker</span>
        {activeRunId !== null && (
          <span className="running-pill" data-testid="running-pill">
            ● run active
          </span>
        )}
        <span className="spacer" />
        {mode.kind === "ok" && (
          <span className="muted" data-testid="mode-banner" title={mode.data.data_dir}>
            {mode.data.active_db}
          </span>
        )}
      </header>

      {backendDown !== null && (
        <div className="backend-banner" data-testid="backend-banner" role="alert">
          Backend unreachable: {backendDown}
        </div>
      )}

      <div className="app-body">
        <main className="app-main" data-testid="app-main">
          {launchError !== null && (
            <p className="danger-text" role="alert" data-testid="launch-error">
              {launchError}
            </p>
          )}
          {route.name === "home" && (
            <Home
              client={client}
              onStartIntake={startIntakeFresh}
              onRunSkill={(skill: SkillManifest) => {
                // The manifest only lists implemented skills; intake keeps its
                // special fork path, every other skill starts generically.
                if (skill.name === INTAKE_SKILL) startIntakeFresh();
                else doLaunchSkill(skill.name);
              }}
            />
          )}
          {route.name === "run" && (
            <div data-testid="run-view">
              <h1>Your search</h1>
              <p className="muted">
                Run <code data-testid="run-view-id">{route.runId}</code> — follow along in the
                conversation on the right.
              </p>
            </div>
          )}
          {route.name === "profile" && <ProfileWorkspace client={client} profileId={route.profileId} />}
          {route.name === "not_found" && <NotFound path={route.path} />}
        </main>

        <ChatRail
          client={client}
          knownSkills={knownSkills}
          activeRunId={activeRunId}
          scopeNotice={scopeNotice}
          onSlash={onSlash}
          onFreeform={onFreeform}
          onUnpin={() => {
            /* pin lifecycle slice — placeholder */
          }}
        />
      </div>
    </div>
  );
}
