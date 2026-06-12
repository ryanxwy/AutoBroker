/**
 * App — the app shell, AND the home of the SINGLE useChat instance. App is the
 * root component: it never unmounts across route/mode changes (TopBar, the
 * GateBannerHost, the Canvas main region and the ChatRail all stay mounted
 * under it; only the main region's content switches per route), so the one
 * Chat instance it owns survives every navigation. It owns:
 *
 *   - THE chat: one `Chat` (RunChatTransport over /stream-v2) + one useChat.
 *     Each launch clears the rail and sends ONE chat message whose
 *     options.body.runId points the transport at the just-started run; the
 *     whole run (suspends included) streams into ONE assistant message whose
 *     id IS the server runId. Transient data-browser parts arrive via onData
 *     and merge into the active turn's activity line only — never history.
 *   - routing (the tiny hand-rolled router): '/' → Canvas (workbench),
 *     '/runs/:id' → Canvas bound to the run, '/profiles/:id' →
 *     ProfileWorkspace placeholder, '*' → NotFound.
 *   - the intake entries → launchIntake (fresh unpinned session): POST start →
 *     capture {run_id, session_id, scope_notice} → stream the run into the rail
 *     → navigate to /runs/:run_id. Starting a run NEVER goes through the chat
 *     transport (POST /api/skill-runs owns starts).
 *   - HITL decisions: useDecision POSTs /form-decision (decide() kept; the
 *     resumed frames flow down the already-open stream).
 *   - REFRESH RECOVERY: on mount at /runs/:id with no in-chat message for that
 *     run, resumeStream re-opens /stream-v2 (the server replays the backlog)
 *     and the form draft restores from localStorage keyed by the same runId.
 *
 * GATE SURFACES (two, structurally ordered): GateBannerHost is the system
 * layer ABOVE the workbench/rail split (banner-tracked gates precede app-main
 * and every prose zone in document order); the rail's gate zone lives inside
 * each assistant turn. Which kind renders where is the single gateTrack map.
 */

import { useEffect, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";

import { ApiClient, apiClient } from "./api/client.js";
import { useAsync } from "./api/useApi.js";
import type { IntakeScopeNotice, Mode, SkillManifest, SkillList, StartAck } from "./api/wire.js";
import { Canvas } from "./canvas/Canvas.js";
import {
  projectTurns,
  type RunUIMessage,
  type TurnView,
} from "./chat/messageModel.js";
import { RunChatTransport } from "./chat/transport.js";
import { useDecision } from "./chat/useDecision.js";
import { GateBannerHost } from "./gate/GateBannerHost.js";
import { launchIntake, launchSkill, type LaunchMode } from "./launch.js";
import { ChatRail } from "./rail/ChatRail.js";
import { NotFound } from "./routes/NotFound.js";
import { ProfileWorkspace } from "./routes/ProfileWorkspace.js";
import { navigate, useRoute } from "./router.js";
import { TopBar } from "./shell/TopBar.js";
import { useLayout } from "./store/layout.js";

// Pre-load fallback only: the live skill list comes from GET /api/skills
// (knownSkills below). This literal is used until that fetch resolves; the UI
// does not import @autobroker/skills (it would pull the manifest into the
// browser bundle for no runtime gain — the server already serves it).
const INTAKE_SKILL = "search_profile_intake";

/** A short activity line for a transient data-browser part. */
function browserActivityLabel(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const kind = (data as { kind?: unknown }).kind;
  const payload = (data as { payload?: unknown }).payload;
  const p = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  switch (kind) {
    case "browser.opened":
      return typeof p["url"] === "string" ? `Browsing ${p["url"]}` : "Browser opened";
    case "browser.action":
      return typeof p["type"] === "string" ? `Browser: ${p["type"]}` : "Browser working…";
    case "browser.error":
      return typeof p["message"] === "string" ? `Browser issue: ${p["message"]}` : "Browser issue";
    case "browser.closed":
      return null; // activity over — clear the line.
    default:
      return null;
  }
}

export function App({ client = apiClient }: { client?: ApiClient } = {}): JSX.Element {
  const route = useRoute();
  const mode = useAsync<Mode>(() => client.getMode(), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);
  const layoutMode = useLayout((s) => s.mode);

  // ---- the single chat (never recreated, never unmounted) -------------------
  // onData fires from deep inside the stream processor; route it through a ref
  // so the Chat instance (created once) always reaches the CURRENT handler.
  const onDataRef = useRef<(part: { type: string; data: unknown }) => void>(() => {});
  const [chat] = useState(
    () =>
      new Chat<RunUIMessage>({
        id: "rail",
        transport: new RunChatTransport(client),
        onData: (part) => onDataRef.current(part as { type: string; data: unknown }),
      }),
  );
  const { messages } = useChat<RunUIMessage>({ chat });

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<IntakeScopeNotice | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [railTitle, setRailTitle] = useState<string>("New search");
  // The server session (Mastra thread) the rail is currently on — intake forks
  // FROM it (the fork rule), so the last ack's session_id is remembered here.
  const sessionIdRef = useRef<string | null>(null);
  // Runs already bound to the rail (fresh launches need no refresh recovery).
  const recoveredRef = useRef<string | null>(null);
  // Transient browser activity (live-only; never persisted into the messages).
  const [browserActivity, setBrowserActivity] = useState<string | null>(null);
  onDataRef.current = (part): void => {
    if (part.type === "data-browser") setBrowserActivity(browserActivityLabel(part.data));
  };

  const knownSkills = skills.kind === "ok" ? skills.data.map((s) => s.name) : [INTAKE_SKILL];

  // ---- launch (intake entries + slash/freeform + Skills popover) ------------
  // Bind a StartAck to the rail: clear the chat (a launch starts a fresh
  // conversation), send the ONE chat message that streams the run, navigate.
  const streamRun = async (runId: string, userText?: string): Promise<void> => {
    try {
      await chat.stop(); // tear down any previous live stream first.
    } catch {
      /* no active stream */
    }
    chat.messages = [];
    setBrowserActivity(null);
    // The chat message is the stream CARRIER only: the run is already started.
    // A button launch has no prose — send a silent (part-less) user message.
    await chat.sendMessage(
      userText !== undefined ? { text: userText } : { parts: [] },
      { body: { runId } },
    );
  };

  const bindAck = (ack: StartAck, title: string, userText?: string): void => {
    setRailTitle(title);
    setScopeNotice(ack.scope_notice);
    setActiveRunId(ack.run_id);
    sessionIdRef.current = ack.session_id;
    recoveredRef.current = ack.run_id; // a fresh launch needs no recovery.
    void streamRun(ack.run_id, userText);
    navigate(`/runs/${ack.run_id}`);
  };

  const doLaunch = (mode: LaunchMode, userText?: string): void => {
    setLaunchError(null);
    // Always fork a fresh unpinned session from the current one.
    launchIntake(client, { mode, fromSessionId: sessionIdRef.current })
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
  // The Skills popover Run control — intake keeps its fork path, every other
  // (manifest-listed, implemented) skill starts generically.
  const onRunSkill = (skill: SkillManifest): void => {
    if (skill.name === INTAKE_SKILL) startIntakeFresh();
    else doLaunchSkill(skill.name);
  };

  // ---- refresh recovery: /runs/:id with no in-chat message -> re-stream -----
  useEffect(() => {
    if (route.name !== "run") return;
    const runId = route.runId;
    if (recoveredRef.current === runId) return;
    recoveredRef.current = runId;
    setActiveRunId(runId);
    const known = chat.messages.some((m) => m.id === runId);
    if (!known) {
      // Cold refresh / direct link: re-open the run's stream from scratch (the
      // server replays the full backlog into a fresh assistant message). The
      // draft restores from localStorage in the SchemaForm (keyed by runId).
      setRailTitle("Recovered search");
      void (async (): Promise<void> => {
        try {
          await chat.stop();
        } catch {
          /* no active stream */
        }
        chat.messages = [];
        setBrowserActivity(null);
        await chat.resumeStream({ body: { runId } });
      })();
    }
  }, [route, chat]);

  // ---- projections the surfaces render from ---------------------------------
  const turns: TurnView[] = projectTurns(messages);
  const activeTurn =
    activeRunId !== null
      ? turns.find((t): t is TurnView & { kind: "assistant" } => t.kind === "assistant" && t.id === activeRunId)
      : undefined;
  // Merge the transient browser activity into the ACTIVE turn's activity line
  // (tool activity wins; terminal turns show none).
  const renderedTurns: TurnView[] = turns.map((t) => {
    if (
      t.kind !== "assistant" ||
      t.id !== activeRunId ||
      browserActivity === null ||
      t.turn.currentActivity !== null ||
      t.turn.status === "done" ||
      t.turn.status === "error" ||
      t.turn.status === "declined" ||
      t.turn.status === "aborted"
    ) {
      return t;
    }
    return { ...t, turn: { ...t.turn, currentActivity: browserActivity } };
  });

  const activeAwaiting =
    activeTurn !== undefined && activeTurn.turn.status === "awaiting_approval"
      ? activeTurn.turn.awaitingUser
      : null;
  const decision = useDecision(client, activeRunId, activeAwaiting?.decisionId ?? null);

  const backendDown =
    mode.kind === "error" ? mode.message : skills.kind === "error" ? skills.message : null;

  return (
    <div className="app-shell">
      <TopBar
        client={client}
        activeRunId={activeRunId}
        mode={mode}
        onStartIntake={startIntakeFresh}
        onRunSkill={onRunSkill}
      />

      {backendDown !== null && (
        <div className="backend-banner" data-testid="backend-banner" role="alert">
          Backend unreachable: {backendDown}
        </div>
      )}

      {/* System-layer gate surface — ABOVE the workbench/rail split, so a
          banner-tracked gate precedes app-main and all prose in document order. */}
      <GateBannerHost awaiting={activeAwaiting} />

      <div className="app-body" data-layout={layoutMode}>
        <main className="app-main" data-testid="app-main">
          {launchError !== null && (
            <p className="danger-text" role="alert" data-testid="launch-error">
              {launchError}
            </p>
          )}
          {route.name === "home" && <Canvas client={client} onStartIntake={startIntakeFresh} />}
          {route.name === "run" && (
            <Canvas client={client} onStartIntake={startIntakeFresh} runId={route.runId} />
          )}
          {route.name === "profile" && <ProfileWorkspace client={client} profileId={route.profileId} />}
          {route.name === "not_found" && <NotFound path={route.path} />}
        </main>

        <ChatRail
          title={railTitle}
          turns={renderedTurns}
          activeRunId={activeRunId}
          decision={decision}
          knownSkills={knownSkills}
          scopeNotice={scopeNotice}
          pinnedProfileId={null}
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
