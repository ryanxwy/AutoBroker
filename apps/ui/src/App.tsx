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
import { invalidate, useDataRefetch, useRefocusRefetch } from "./api/useDataChanged.js";
import type {
  EnvConfigResponse,
  IntakeScopeNotice,
  KeyPresenceResponse,
  Mode,
  ProfileList,
  RouteAck,
  SkillManifest,
  SkillList,
  StartAck,
} from "./api/wire.js";
import { Canvas } from "./canvas/Canvas.js";
import { HardDeleteModal, ProfileEditModal } from "./canvas/ProfileModals.js";
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
import { RailResizer } from "./shell/RailResizer.js";
import { Toast } from "./shell/Toast.js";
import { TopBar } from "./shell/TopBar.js";
import { clampRailWidth, loadRailWidth, useLayout } from "./store/layout.js";

// Pre-load fallback only: the live skill list comes from GET /api/skills
// (knownSkills below). This literal is used until that fetch resolves; the UI
// does not import @autobroker/skills (it would pull the manifest into the
// browser bundle for no runtime gain — the server already serves it).
const INTAKE_SKILL = "search_profile_intake";

// Stable bus keys (module-level so useDataRefetch's effect deps don't churn).
const PROFILE_KINDS = ["profiles"] as const;
// After a hard purge, refetch the profile LIST + sessions only. The Canvas's
// per-profile sub-resource reads (dealers/threads/quotes/…) are keyed on the
// active profile id, so the list refetch re-derives the active profile and
// cascades those automatically — invalidating them here too would race the
// list update and refetch the just-deleted id (transient 404s).
const PURGE_KINDS = ["profiles", "sessions"];

export function App({ client = apiClient }: { client?: ApiClient } = {}): JSX.Element {
  const route = useRoute();
  const mode = useAsync<Mode>(() => client.getMode(), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);
  // Key presence — the SINGLE source for both the Settings panel AND the
  // first-run gate. deepseekReady drives whether skills can launch; saving the
  // key in Settings calls keyPresence.refetch() → the gate clears with no reload.
  const keyPresence = useAsync<KeyPresenceResponse>(() => client.getKeyPresence(), []);
  const deepseekReady = keyPresence.kind === "ok" ? keyPresence.data.deepseek.present : true;
  // The curated operational env vars — owned here (like presence) so the
  // Environment panel reflects a live value after a write with no reload.
  const env = useAsync<EnvConfigResponse>(() => client.getEnvConfig(), []);
  // Active-profile presence drives the rail Skills tray readiness grouping (the
  // top bar no longer owns the only profiles read).
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  useDataRefetch(PROFILE_KINDS, profiles.refetch);
  const hasActiveProfile = profiles.kind === "ok" && profiles.data.length > 0;
  const layoutMode = useLayout((s) => s.mode);

  // ---- draggable rail width: own the --rail-width on the .app-body host ------
  // RailResizer writes the CSS var imperatively during a drag; App sets the
  // initial (persisted, re-clamped) value on mount and re-clamps on window resize
  // so a width saved on a wide window can't starve the canvas on a narrow one.
  const appBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = appBodyRef.current;
    if (el === null) return;
    const applyClamped = (): void => {
      const cw = el.clientWidth || window.innerWidth;
      el.style.setProperty("--rail-width", `${clampRailWidth(loadRailWidth(), cw)}px`);
    };
    applyClamped();
    window.addEventListener("resize", applyClamped);
    return () => window.removeEventListener("resize", applyClamped);
  }, []);

  // ---- profile modals (view/edit + hard-delete), hosted here ----------------
  const [profileModal, setProfileModal] = useState<
    { kind: "edit" | "delete"; id: string; name: string } | null
  >(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const closeProfileModal = (): void => {
    setProfileModal(null);
    setDeleteError(null);
  };
  const onViewProfile = (id: string, name: string): void => setProfileModal({ kind: "edit", id, name });
  const onDeleteProfile = (id: string, name: string): void => setProfileModal({ kind: "delete", id, name });

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
  // The session whose turns are CURRENTLY accumulated in the rail. A skill run
  // within the same session keeps the prior turns (one continuous conversation
  // across the whole journey); only a NEW session (intake forks one) clears the
  // rail — so a 17-skill run shows its full history instead of resetting each step.
  const streamedSessionRef = useRef<string | null>(null);
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

  // ---- hard delete (irreversible): purge the profile + everything scoped to it
  const doPurge = (id: string): void => {
    setDeleteBusy(true);
    setDeleteError(null);
    client
      .purgeProfile(id)
      .then(() => {
        // Refetch every family the purge touched; clear a now-dangling pin (the
        // server already unbound the session) and leave a deleted profile's route.
        invalidate(PURGE_KINDS);
        if (id === pinnedProfileId) {
          setPinnedProfileId(null);
          setPinLabel(null);
        }
        setProfileModal(null);
        if (route.name === "profile" && route.profileId === id) navigate("/");
      })
      .catch((err: unknown) => {
        setDeleteError(err instanceof Error ? err.message : "delete failed");
      })
      .finally(() => setDeleteBusy(false));
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
    // Keep the rail's history WITHIN a session (each skill run appends its own
    // turn); clear only when the session changed — i.e. intake forked a new one,
    // or a session-less headless run. bindAck has already set sessionIdRef to
    // this run's session before calling streamRun.
    const sid = sessionIdRef.current;
    if (sid === null || sid !== streamedSessionRef.current) {
      chat.messages = [];
    }
    streamedSessionRef.current = sid;
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
  // its parsed key=value args spread into the start body. (Free-form prose is NOT
  // handled here — it goes through onFreeform → the NL router, POST /api/route.)
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
    // Persist the EXPLICIT pick to the session pin (same as the Searches-popover
    // pin), so every subsequent pin_required skill in this conversation inherits
    // it instead of re-prompting for the picker each time. Honoring an explicit
    // user pick is NOT inference, so it respects the profile-ASK contract. The
    // immediate run still carries search_profile_id explicitly below, so it does
    // not depend on the (async) pin write landing first. (live-e2e 巡检 2026-06-16:
    // the inline picker was transient while the popover pin persisted — this
    // closes that inconsistency.)
    onPin(profileId);
    doLaunchSkill(skill, { search_profile_id: profileId });
  };
  // Render a LOCAL clarify turn (no run, no SSE): the user's prose as a user turn
  // + an assistant text turn carrying the router's reason, marked terminal so it
  // renders calm (not an in-progress spinner). The router started NO run.
  const renderClarifyTurn = (
    userText: string,
    reason: string,
    suggestedSkill: string | null = null,
  ): void => {
    const id = `clarify-${Date.now()}`;
    // A sensitivity-downgrade clarify carries the detected skill so the turn can
    // offer a button-only "Run it explicitly" launch (the launch still goes
    // through doLaunchSkill → every pin/approval gate downstream; nothing is
    // pre-approved). Dead-end clarifies (no suggested skill) carry no button.
    const suggestPart =
      suggestedSkill !== null
        ? [
            {
              type: "data-frame" as const,
              id: `${id}-suggest`,
              data: { kind: "clarify_suggest", payload: { skill: suggestedSkill } },
            },
          ]
        : [];
    chat.messages = [
      ...chat.messages,
      { id: `${id}-u`, role: "user", parts: [{ type: "text", text: userText }] },
      {
        id,
        role: "assistant",
        parts: [
          { type: "text", text: reason },
          ...suggestPart,
          { type: "data-frame", id: `${id}-done`, data: { kind: "done", payload: {} } },
        ],
      },
    ];
    setActiveRunId(null);
  };

  // The NL skill-router dispatch (the core product feature): the freeform text is
  // sent to POST /api/route; the LLM classifies it to a skill and either LAUNCHES
  // it through the EXACT existing start path (→ bindAck+streamRun like today, so
  // every gate stays downstream, button-only) or returns a CLARIFY (→ a local
  // assistant turn, no run). The router NEVER pre-approves anything.
  const onFreeform = (text: string): void => {
    setLaunchError(null);
    client
      .route({ nl_input: text, session_id: sessionIdRef.current, from_session_id: sessionIdRef.current })
      .then((ack: RouteAck) => {
        if (ack.routing.kind === "launch" && ack.run_id !== undefined) {
          const startAck: StartAck = {
            run_id: ack.run_id,
            session_id: ack.session_id ?? null,
            scope_notice: ack.scope_notice ?? null,
          };
          bindAck(startAck, `/${ack.routing.skill_id}`, text);
        } else if (ack.routing.kind === "clarify") {
          // A sensitivity downgrade names the detected skill in candidates[0];
          // surface it as a button-only "Run it explicitly" affordance.
          renderClarifyTurn(text, ack.routing.reason, ack.routing.candidates?.[0]?.skillId ?? null);
        }
      })
      .catch((err: unknown) => {
        setLaunchError(err instanceof Error ? err.message : "Could not route your message.");
      });
  };
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

  // A run is ACTIVE while it exists and has not reached a terminal status
  // (running OR awaiting_approval). Drives the TopBar run pill AND the composer
  // SOFT-BLOCK: a message typed mid-run must not spawn a concurrent run.
  const runActive = activeRunId !== null && !activeTurnTerminal;

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
        runActive={runActive}
        pinnedProfileId={pinnedProfileId}
        appMode={mode.kind === "ok" ? mode.data.mode : null}
        onModeSwitched={mode.refetch}
        onStartIntake={startIntakeFresh}
        onPin={onPin}
        onUnpin={onUnpin}
        onViewProfile={onViewProfile}
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

      <div className="app-body" data-layout={layoutMode} ref={appBodyRef}>
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
              onEditProfile={onViewProfile}
              onDeleteProfile={onDeleteProfile}
            />
          )}
          {route.name === "run" && (
            <Canvas
              client={client}
              onStartIntake={startIntakeFresh}
              runId={route.runId}
              deepseekReady={deepseekReady}
              onEditProfile={onViewProfile}
              onDeleteProfile={onDeleteProfile}
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
              mode={mode}
            />
          )}
          {route.name === "not_found" && <NotFound path={route.path} />}
        </main>

        {/* The draggable seam — canvas-layout affordance only (CSS hides it in
            conversation layout, where the rail is flex:1). */}
        <RailResizer containerRef={appBodyRef} />

        <ChatRail
          title={railTitle}
          turns={turns}
          activeRunId={activeRunId}
          runActive={runActive}
          browserView={activeBrowserView}
          decision={decision}
          knownSkills={knownSkills}
          client={client}
          scopeNotice={scopeNotice}
          pinnedProfileId={pinnedProfileId}
          pinLabel={pinLabel}
          currentSessionId={sessionIdRef.current}
          skills={skills.kind === "ok" ? skills.data : []}
          hasActiveProfile={hasActiveProfile}
          deepseekReady={deepseekReady}
          onSlash={onSlash}
          onFreeform={onFreeform}
          onUnpin={onUnpin}
          onStartIntake={startIntakeFresh}
          onStopPick={onStopPick}
          onSelectSession={onSelectSession}
          onRunSkill={onRunSkill}
          onRunSuggested={(skill) => doLaunchSkill(skill)}
        />
      </div>

      {/* Profile dialogs — the unified view/edit modal and the irreversible
          hard-delete confirm (App owns the state so both Canvas and the Searches
          list can open them). */}
      {profileModal?.kind === "edit" && (
        <ProfileEditModal
          client={client}
          profileId={profileModal.id}
          name={profileModal.name}
          open
          onClose={closeProfileModal}
          onDeleteRequest={() => setProfileModal({ kind: "delete", id: profileModal.id, name: profileModal.name })}
        />
      )}
      {profileModal?.kind === "delete" && (
        <HardDeleteModal
          open
          name={profileModal.name}
          busy={deleteBusy}
          error={deleteError}
          onClose={closeProfileModal}
          onConfirm={() => doPurge(profileModal.id)}
        />
      )}
    </div>
  );
}
