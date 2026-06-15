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
 *     and fold into the active turn's zone-4 browser view (trail + open count
 *     + live screenshot) only — never history, gone after terminal.
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
import { invalidate, useRefocusRefetch } from "./api/useDataChanged.js";
import type {
  EnvConfigResponse,
  IntakeScopeNotice,
  KeyPresenceResponse,
  Mode,
  SkillManifest,
  SkillList,
  StartAck,
} from "./api/wire.js";
import { Canvas } from "./canvas/Canvas.js";
import {
  EMPTY_BROWSER_VIEW,
  reduceBrowserView,
  type BrowserView,
} from "./chat/browserView.js";
import {
  projectTurns,
  recoveredTurnMessage,
  type RunUIMessage,
  type TurnView,
} from "./chat/messageModel.js";
import { RunChatTransport } from "./chat/transport.js";
import { useDecision } from "./chat/useDecision.js";
import { GateBannerHost } from "./gate/GateBannerHost.js";
import { toSnapshot, vehicleLabel } from "./home/profileView.js";
import { launchIntake, launchSkill, type LaunchMode } from "./launch.js";
import { ChatRail } from "./rail/ChatRail.js";
import { Digest } from "./routes/Digest.js";
import { NotFound } from "./routes/NotFound.js";
import { ProfileWorkspace } from "./routes/ProfileWorkspace.js";
import { Settings } from "./routes/Settings.js";
import { navigate, useRoute } from "./router.js";
import { Toast } from "./shell/Toast.js";
import { TopBar } from "./shell/TopBar.js";
import { useLayout } from "./store/layout.js";

// Pre-load fallback only: the live skill list comes from GET /api/skills
// (knownSkills below). This literal is used until that fetch resolves; the UI
// does not import @autobroker/skills (it would pull the manifest into the
// browser bundle for no runtime gain — the server already serves it).
const INTAKE_SKILL = "search_profile_intake";

export function App({ client = apiClient }: { client?: ApiClient } = {}): JSX.Element {
  const route = useRoute();
  const mode = useAsync<Mode>(() => client.getMode(), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);
  // Key presence — the SINGLE source for both the Settings panel AND the
  // first-run gate. deepseekReady drives whether skills can launch; saving the
  // key in Settings calls keyPresence.refetch() → the gate clears with no reload.
  const keyPresence = useAsync<KeyPresenceResponse>(() => client.getKeyPresence(), []);
  const deepseekReady = keyPresence.kind === "ok" ? keyPresence.data.deepseek.present : true;
  // The cross-provider RETRY key (Anthropic) gates the Threads section's manual
  // "retry failed extractions on another provider" affordance. Default false
  // until presence resolves (the affordance is opt-in egress — never assume the
  // key is there before the read confirms it).
  const anthropicReady = keyPresence.kind === "ok" ? keyPresence.data.anthropic.present : false;
  // The curated operational env vars — owned here (like presence) so the
  // Environment panel reflects a live value after a write with no reload.
  const env = useAsync<EnvConfigResponse>(() => client.getEnvConfig(), []);
  const layoutMode = useLayout((s) => s.mode);

  // First-run gate: on a fresh install (no DeepSeek key) land the owner on
  // Settings once, framing setup. Only redirect from the home route (a direct
  // deep link or an in-progress run is left alone), and only once the presence
  // read has resolved (never on the optimistic loading default).
  const redirectedRef = useRef(false);
  useEffect(() => {
    if (keyPresence.kind !== "ok") return;
    if (keyPresence.data.deepseek.present) return;
    if (redirectedRef.current) return;
    if (route.name === "home") {
      redirectedRef.current = true;
      navigate("/settings");
    }
  }, [keyPresence, route]);

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
  // The current session's TRUE pin (thread metadata) + its human label —
  // hydrated from GET /api/sessions/:id together with the scope notice.
  const [pinnedProfileId, setPinnedProfileId] = useState<string | null>(null);
  const [pinLabel, setPinLabel] = useState<string | null>(null);
  // The server session (Mastra thread) the rail is currently on — intake forks
  // FROM it (the fork rule), so the last ack's session_id is remembered here.
  const sessionIdRef = useRef<string | null>(null);
  // Runs already bound to the rail (fresh launches need no refresh recovery).
  const recoveredRef = useRef<string | null>(null);
  // Transient browser activity view (live-only; never persisted into the
  // messages — the zone-4 trail + open count + latest screenshot).
  const [browserView, setBrowserView] = useState<BrowserView>(EMPTY_BROWSER_VIEW);
  onDataRef.current = (part): void => {
    if (part.type === "data-browser") {
      setBrowserView((v) => reduceBrowserView(v, part.data));
      return;
    }
    // A data.changed pulse (carried as a data-frame {kind, payload}) →
    // refetch the views that render the named kinds. Additive to the transient
    // browser routing above; every other data-frame is projected by
    // messageModel from message.parts (this handler never owns those).
    if (part.type === "data-frame") {
      const data = part.data as { kind?: unknown; payload?: unknown } | null;
      if (data !== null && typeof data === "object" && data.kind === "data.changed") {
        const kinds = (data.payload as { kinds?: unknown } | null)?.kinds;
        if (Array.isArray(kinds)) {
          invalidate(kinds.filter((k): k is string => typeof k === "string"));
        }
      }
    }
  };

  // Fresh-on-refocus: refetch every registered read view when the window
  // re-activates (installed once, App never unmounts).
  useRefocusRefetch();

  const knownSkills = skills.kind === "ok" ? skills.data.map((s) => s.name) : [INTAKE_SKILL];

  // ---- session hydration (pin + persisted scope notice, ONE fetch) ----------
  // Applies a fetched session to the rail state; the pin chip label resolves
  // from the pinned profile's vehicle fields (best-effort — the raw id shows
  // until/unless the profile read lands).
  const applySession = (s: {
    id: string;
    pinned_profile_id: string | null;
    scope_notice: IntakeScopeNotice | null;
    last_run_id?: string | null;
  }): void => {
    sessionIdRef.current = s.id;
    setPinnedProfileId(s.pinned_profile_id);
    setScopeNotice(s.scope_notice);
    setPinLabel(null);
    if (s.pinned_profile_id !== null) {
      const pin = s.pinned_profile_id;
      client
        .getProfile(pin)
        .then((row) => setPinLabel(vehicleLabel(toSnapshot(row)) || pin))
        .catch(() => setPinLabel(pin)); // label only — the pin itself is set.
    }
  };

  const hydrateSession = (sessionId: string): void => {
    client
      .getSession(sessionId)
      .then(applySession)
      .catch((err: unknown) => {
        // Hydration is a read-back of state the server just acked; surface a
        // failure rather than silently rendering a pin-less rail.
        setLaunchError(err instanceof Error ? err.message : "Could not load the session.");
      });
  };

  // ---- pin lifecycle (Searches popover verbs + the rail chip) ---------------
  const onPin = (profileId: string): void => {
    setLaunchError(null);
    const sessionId = sessionIdRef.current;
    const op =
      sessionId !== null
        ? client.patchSession(sessionId, { pinnedProfileId: profileId })
        : client.createSession({ title: "Pinned search", pinnedProfileId: profileId });
    op.then(applySession).catch((err: unknown) => {
      setLaunchError(err instanceof Error ? err.message : "Could not pin the search.");
    });
  };

  const onUnpin = (): void => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null) return;
    client
      .patchSession(sessionId, { pinnedProfileId: null })
      .then(applySession)
      .catch((err: unknown) => {
        setLaunchError(err instanceof Error ? err.message : "Could not unpin the search.");
      });
  };

  const onSelectSession = (sessionId: string): void => {
    setRailTitle("Session");
    // One fetch hydrates pin + notice AND re-binds the session's BOUND run:
    // navigating to /runs/:id hands the rest to the refresh-recovery effect
    // (stream replay when the channel is live; status-fallback synthesis when
    // the server restarted and only the durable terminal state remains).
    client
      .getSession(sessionId)
      .then((s) => {
        applySession(s);
        if (s.last_run_id !== null) navigate(`/runs/${s.last_run_id}`);
      })
      .catch((err: unknown) => {
        setLaunchError(err instanceof Error ? err.message : "Could not load the session.");
      });
  };

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
    setBrowserView(EMPTY_BROWSER_VIEW);
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
    // Hydrate the linked session's pin + persisted notice (one fetch); a
    // session-less headless start keeps the rail unpinned.
    if (ack.session_id !== null) hydrateSession(ack.session_id);
    else {
      setPinnedProfileId(null);
      setPinLabel(null);
    }
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
  // fresh-unpinned fork semantics). `extra` carries the slash args / the
  // STOP-picker's search_profile_id into the POST body. The server's
  // RunDescriptor registry validates the skill; an unknown skill surfaces as a
  // launch error.
  const doLaunchSkill = (skill: string, extra?: Record<string, unknown>, userText?: string): void => {
    setLaunchError(null);
    // PIN THREADING: a pinned session's launches carry the pin as
    // search_profile_id — the resolver then takes the pinned branch instead of
    // inferring newest-active. An EXPLICIT search_profile_id in the args wins
    // (slash args / STOP-picker pick); unpinned sessions send nothing and keep
    // the inferred_newest behavior. Intake never reaches here (fork path).
    const args =
      pinnedProfileId !== null && extra?.["search_profile_id"] === undefined
        ? { ...(extra ?? {}), search_profile_id: pinnedProfileId }
        : extra;
    // The run links to the rail's CURRENT session (the durable bound turn the
    // Searches popover pill reads); a session-less rail starts headless.
    launchSkill(client, {
      skill,
      ...(args !== undefined ? { args } : {}),
      sessionId: sessionIdRef.current,
    })
      .then((ack) => bindAck(ack, `/${skill}`, userText))
      .catch((err: unknown) => {
        setLaunchError(err instanceof Error ? err.message : `Could not start ${skill}.`);
      });
  };

  const startIntakeFresh = (): void => doLaunch({ kind: "slash" });
  // A ready slash for intake keeps the special launchIntake path (fresh-unpinned
  // fork); a ready slash for ANY other skill starts THAT skill generically with
  // its parsed key=value args spread into the start body. Freeform stays
  // intake-scoped (the ratified scope-notice behavior).
  const onSlash = (skill: string, args: Record<string, string>): void => {
    const argText = Object.entries(args)
      .map(([k, v]) => ` ${k}=${v}`)
      .join("");
    if (skill === INTAKE_SKILL) doLaunch({ kind: "slash" }, `/${skill}`);
    else doLaunchSkill(skill, args, `/${skill}${argText}`);
  };

  // STOP-picker re-launch: a typed 2+-profiles STOP is TERMINAL — picking a
  // vehicle starts a NEW run of the same skill pinned via search_profile_id
  // (never a resume of the stopped run).
  const onStopPick = (skill: string | null, profileId: string): void => {
    if (skill === null) {
      setLaunchError("Cannot re-launch: the stopped run carried no skill id.");
      return;
    }
    doLaunchSkill(skill, { search_profile_id: profileId });
  };
  const onFreeform = (text: string): void => doLaunch({ kind: "freeform", freeformText: text }, text);
  // The Skills popover Run control — intake keeps its fork path, every other
  // (manifest-listed, implemented) skill starts generically.
  const onRunSkill = (skill: SkillManifest): void => {
    if (skill.name === INTAKE_SKILL) startIntakeFresh();
    else doLaunchSkill(skill.name);
  };

  // MANUAL cross-provider retry of a profile's failed extractions: launch
  // dealer_reply_extract with escalate:true (the Anthropic native lane). This is
  // the ONLY caller that sets escalate — the auto-path never does. The explicit
  // profile id pins the run (the failures the user is recovering live there).
  const onRetryFailedExtractions = (profileId: string): void =>
    doLaunchSkill("dealer_reply_extract", { search_profile_id: profileId, escalate: true });

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
        setBrowserView(EMPTY_BROWSER_VIEW);
        await chat.resumeStream({ body: { runId } });
        // After a SERVER RESTART a finished run has no live channel (stream
        // 404 → resumeStream lands nothing). The terminal state is still
        // durable in Mastra storage — read it once and synthesize the
        // matching terminal message so the turn renders correctly.
        if (!chat.messages.some((m) => m.id === runId)) {
          try {
            const summary = await client.runStatus(runId);
            const recovered = recoveredTurnMessage(summary);
            if (recovered !== null) chat.messages = [recovered];
          } catch {
            // Unknown run / unreachable server: the rail stays empty and the
            // canvas still shows the route's run id — nothing to invent.
          }
        }
      })();
    }
  }, [route, chat]);

  // ---- projections the surfaces render from ---------------------------------
  const turns: TurnView[] = projectTurns(messages);
  const activeTurn =
    activeRunId !== null
      ? turns.find((t): t is TurnView & { kind: "assistant" } => t.kind === "assistant" && t.id === activeRunId)
      : undefined;
  // The transient browser view attaches to the ACTIVE turn only and is GONE
  // after terminal (trail + thumbnail never persist into message parts).
  const activeTurnTerminal =
    activeTurn !== undefined &&
    (activeTurn.turn.status === "done" ||
      activeTurn.turn.status === "error" ||
      activeTurn.turn.status === "declined" ||
      activeTurn.turn.status === "aborted");
  const activeBrowserView =
    !activeTurnTerminal && browserView.entries.length > 0 ? browserView : null;

  const activeAwaiting =
    activeTurn !== undefined && activeTurn.turn.status === "awaiting_approval"
      ? activeTurn.turn.awaitingUser
      : null;
  const decision = useDecision(client, activeRunId, activeAwaiting?.decisionId ?? null);

  const backendDown =
    mode.kind === "error" ? mode.message : skills.kind === "error" ? skills.message : null;

  return (
    <div className="app-shell">
      {/* In-app toast for a background notification delivered while the window
          is focused (Electron shell only; inert in a plain browser). */}
      <Toast />
      <TopBar
        client={client}
        activeRunId={activeRunId}
        mode={mode}
        pinnedProfileId={pinnedProfileId}
        deepseekReady={deepseekReady}
        onStartIntake={startIntakeFresh}
        onRunSkill={onRunSkill}
        onPin={onPin}
        onUnpin={onUnpin}
        onSelectSession={onSelectSession}
      />

      {backendDown !== null && (
        <div className="backend-banner" data-testid="backend-banner" role="alert">
          Backend unreachable: {backendDown}
        </div>
      )}

      {/* Demo mode — a persistent, non-dismissable strip whenever the server
          reports the isolated sample-world DB. Informational (not an alert):
          nothing here touches real data. */}
      {mode.kind === "ok" && mode.data.demo && (
        <div className="demo-banner" data-testid="demo-banner" role="status">
          <strong>DEMO DATA</strong> · You&rsquo;re viewing sample data in an isolated database.
          Nothing here is real.
        </div>
      )}

      {/* System-layer gate surface — ABOVE the workbench/rail split, so a
          banner-tracked gate precedes app-main and all prose in document order. */}
      <GateBannerHost awaiting={activeAwaiting} decision={decision} />

      <div className="app-body" data-layout={layoutMode}>
        <main className="app-main" data-testid="app-main">
          {launchError !== null && (
            <p className="danger-text" role="alert" data-testid="launch-error">
              {launchError}
            </p>
          )}
          {route.name === "home" && (
            <Canvas
              client={client}
              onStartIntake={startIntakeFresh}
              deepseekReady={deepseekReady}
              anthropicReady={anthropicReady}
              onRetryFailedExtractions={onRetryFailedExtractions}
            />
          )}
          {route.name === "run" && (
            <Canvas
              client={client}
              onStartIntake={startIntakeFresh}
              runId={route.runId}
              deepseekReady={deepseekReady}
              anthropicReady={anthropicReady}
              onRetryFailedExtractions={onRetryFailedExtractions}
            />
          )}
          {route.name === "profile" && <ProfileWorkspace client={client} profileId={route.profileId} />}
          {route.name === "digest" && <Digest client={client} profileId={route.profileId} />}
          {route.name === "settings" && (
            <Settings
              client={client}
              presence={keyPresence}
              onChanged={keyPresence.refetch}
              env={env}
              onEnvChanged={env.refetch}
            />
          )}
          {route.name === "not_found" && <NotFound path={route.path} />}
        </main>

        <ChatRail
          title={railTitle}
          turns={turns}
          activeRunId={activeRunId}
          browserView={activeBrowserView}
          decision={decision}
          knownSkills={knownSkills}
          client={client}
          scopeNotice={scopeNotice}
          pinnedProfileId={pinnedProfileId}
          pinLabel={pinLabel}
          onSlash={onSlash}
          onFreeform={onFreeform}
          onUnpin={onUnpin}
          onStartIntake={startIntakeFresh}
          onStopPick={onStopPick}
        />
      </div>
    </div>
  );
}
