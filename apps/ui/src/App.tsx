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

import { useEffect, useId, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";

import { ApiClient, apiClient } from "./api/client.js";
import { useAsync } from "./api/useApi.js";
import { invalidate, useDataRefetch, useRefocusRefetch } from "./api/useDataChanged.js";
import { ChainedRunSchema } from "./api/wire.js";
import type {
  ApprovalList,
  ChainedRun,
  EnvConfigResponse,
  IntakeScopeNotice,
  KeyPresenceResponse,
  Mode,
  PortfolioView,
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
import { NeedsYouInbox } from "./gate/NeedsYouInbox.js";
import { toSnapshot, vehicleLabel, zipOf } from "./home/profileView.js";
import { launchIntake, launchSkill, type LaunchMode } from "./launch.js";
import {
  agentPayload,
  loadAgentSelection,
  saveAgentSelection,
  uiSelectionFromWire,
  type AgentPresence,
  type AgentUiSelection,
} from "./rail/AgentBar.js";
import { ChatRail } from "./rail/ChatRail.js";
import { Digest } from "./routes/Digest.js";
import { NotFound } from "./routes/NotFound.js";
import { Portfolio } from "./routes/Portfolio.js";
import { ProfileWorkspace } from "./routes/ProfileWorkspace.js";
import { Settings } from "./routes/Settings.js";
import { SettingsBody } from "./settings/SettingsBody.js";
import { navigate, useRoute } from "./router.js";
import { Modal } from "./shell/Modal.js";
import { PortfolioStatusBar } from "./shell/PortfolioStatusBar.js";
import { RailResizer } from "./shell/RailResizer.js";
import { nextSuggestedSkills, type ServerSuggestion } from "./shell/SkillsPopover.js";
import { Toast } from "./shell/Toast.js";
import { TopBar } from "./shell/TopBar.js";
import { clampRailWidth, loadRailWidth } from "./store/layout.js";

// Pre-load fallback only: the live skill list comes from GET /api/skills
// (knownSkills below). This literal is used until that fetch resolves; the UI
// does not import @autobroker/skills (it would pull the manifest into the
// browser bundle for no runtime gain — the server already serves it).
const INTAKE_SKILL = "search_profile_intake";

// Stable bus keys (module-level so useDataRefetch's effect deps don't churn).
const PROFILE_KINDS = ["profiles"] as const;
// The portfolio header + "Needs you" widget overview EVERY pipeline, so they
// refetch on any write family (plus on window refocus). Global scope.
const PORTFOLIO_KINDS = [
  "portfolio",
  "profiles",
  "sessions",
  "dealers",
  "leads",
  "threads",
  "messages",
  "listings",
  "quotes",
  "incentives",
  "digest",
] as const;
// After a hard purge, refetch the profile LIST + sessions only. The Canvas's
// per-profile sub-resource reads (dealers/threads/quotes/…) are keyed on the
// active profile id, so the list refetch re-derives the active profile and
// cascades those automatically — invalidating them here too would race the
// list update and refetch the just-deleted id (transient 404s).
const PURGE_KINDS = ["profiles", "sessions"];

/** Read the `chained_run` metadata off a run-stream data-frame payload, or null
 *  when the frame is not a chained-run announce. It rides a `text` frame's
 *  payload (server appendChainedRunAnnounce); an ordinary text frame has none. */
function readChainedRun(payload: unknown): ChainedRun | null {
  if (payload === null || typeof payload !== "object") return null;
  const cr = (payload as { chained_run?: unknown }).chained_run;
  const parsed = ChainedRunSchema.safeParse(cr);
  return parsed.success ? parsed.data : null;
}

export function App({ client = apiClient }: { client?: ApiClient } = {}): JSX.Element {
  const route = useRoute();
  const mode = useAsync<Mode>(() => client.getMode(), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);
  // Key presence — the SINGLE source for both the Settings panel AND the
  // first-run gate. deepseekReady drives whether skills can launch; saving the
  // key in Settings calls keyPresence.refetch() → the gate clears with no reload.
  const keyPresence = useAsync<KeyPresenceResponse>(() => client.getKeyPresence(), []);
  const deepseekReady = keyPresence.kind === "ok" ? keyPresence.data.deepseek.present : true;
  // The AgentBar's credential gating reads the SAME presence (optimistic-true
  // while loading, mirroring deepseekReady — no greyed flash before the read).
  const agentPresence: AgentPresence = {
    deepseek: keyPresence.kind === "ok" ? keyPresence.data.deepseek.present : true,
    anthropic: keyPresence.kind === "ok" ? keyPresence.data.anthropic.present : true,
    claudeOauth: keyPresence.kind === "ok" ? keyPresence.data.claude_oauth.present : true,
  };
  // The curated operational env vars — owned here (like presence) so the
  // Environment panel reflects a live value after a write with no reload.
  const env = useAsync<EnvConfigResponse>(() => client.getEnvConfig(), []);
  // Active-profile presence drives the rail Skills tray readiness grouping (the
  // top bar no longer owns the only profiles read).
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  useDataRefetch(PROFILE_KINDS, profiles.refetch);
  const hasActiveProfile = profiles.kind === "ok" && profiles.data.length > 0;
  // The portfolio board projection + the global "Needs you" approval inbox —
  // owned here (App never unmounts) so the header counts strip and the floating
  // widget stay in sync across pages. Both refetch on any write pulse / refocus.
  const portfolio = useAsync<PortfolioView>(() => client.getPortfolio(), []);
  const inbox = useAsync<ApprovalList>(() => client.approvalInbox(), []);
  useDataRefetch(PORTFOLIO_KINDS, portfolio.refetch);
  useDataRefetch(PORTFOLIO_KINDS, inbox.refetch);
  const portfolioCards = portfolio.kind === "ok" ? portfolio.data.cards : [];
  const inboxItems = inbox.kind === "ok" ? inbox.data : [];

  // The Settings pop-up overlay (the top-right gear). The /settings ROUTE still
  // exists for the first-run gate + deep links; the gear opens the SAME settings
  // body in a Modal so the owner never leaves the workbench to adjust env config.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTitleId = useId();

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
  // The AgentBar selection (device-local, mirrors the mode/pin state pattern).
  // `dirty` is true once the user actively chose; only then does `agent` ride a
  // run/route payload (a fresh browser omits it → the server default wins).
  const [agent, setAgent] = useState<{ selection: AgentUiSelection; dirty: boolean }>(loadAgentSelection);
  const onAgentChange = (next: AgentUiSelection): void => {
    setAgent({ selection: next, dirty: true });
    saveAgentSelection(next);
  };
  // Reflect the server's EFFECTIVE default (AUTOBROKER_AGENT_PROVIDER) in the bar
  // DISPLAY so its boxes show what will actually run (e.g. Claude under
  // `/e2e-loop --provider claude`) — but only when the user hasn't explicitly
  // picked, and WITHOUT marking dirty, so the payload stays omitted and the env
  // default still drives. A real user pick (dirty) always wins.
  const serverAgentDefault = keyPresence.kind === "ok" ? keyPresence.data.agentDefault : null;
  useEffect(() => {
    if (serverAgentDefault === null) return;
    setAgent((prev) => (prev.dirty ? prev : { selection: uiSelectionFromWire(serverAgentDefault), dirty: false }));
  }, [serverAgentDefault]);
  // The reconciled, wire-shaped selection for the next run/route — undefined
  // until dirty (the dirty-omit contract).
  const agentRun = agentPayload(agent.selection, agent.dirty, agentPresence);
  // The current session's TRUE pin (thread metadata) + its human label —
  // hydrated from GET /api/sessions/:id together with the scope notice.
  const [pinnedProfileId, setPinnedProfileId] = useState<string | null>(null);
  const [pinLabel, setPinLabel] = useState<string | null>(null);
  // The pinned search's ZIP (postal_code, else parsed from location_query) — the
  // rail header renders it after the vehicle so the title reads as the pinned
  // search identity (year make model trim · zip) instead of the skill name.
  const [pinZip, setPinZip] = useState<string | null>(null);
  // The server session (Mastra thread) the rail is currently on — intake forks
  // FROM it (the fork rule), so the last ack's session_id is remembered here.
  const sessionIdRef = useRef<string | null>(null);
  // The session whose turns are CURRENTLY accumulated in the rail. A skill run
  // within the same session keeps the prior turns (one continuous conversation
  // across the whole journey); only a NEW session (intake forks one) clears the
  // rail — so a full multi-skill run shows its history instead of resetting each step.
  const streamedSessionRef = useRef<string | null>(null);
  // Runs already bound to the rail (fresh launches need no refresh recovery).
  const recoveredRef = useRef<string | null>(null);
  // The pending site_scan → aggregator_scan auto-chain: onData records the
  // sibling run announced on the ACTIVE parent stream; an effect streams it as
  // its OWN new turn once the parent turn is terminal (streaming it while the
  // parent stream is still open would race two streams on the one chat).
  // `startedChains` dedupes a re-delivered announce (same run_id twice).
  const pendingChainRef = useRef<{ parent: string; chain: ChainedRun } | null>(null);
  const startedChainsRef = useRef<Set<string>>(new Set());
  // A run recovered COLD (a refresh / deep link onto /runs/:id whose stream the
  // server REPLAYS from scratch) must NOT re-fire its already-finished sibling
  // chain: the replayed announce would restart the (finished) aggregator sibling
  // AND wipe the recovered parent turn. Record the cold-recovered runId so onData
  // drops a chain whose parent is it.
  const coldRecoveredRef = useRef<string | null>(null);
  // Transient browser activity view (live-only; never persisted into the
  // messages — the zone-4 trail + open count + latest screenshot).
  const [browserView, setBrowserView] = useState<BrowserView>(EMPTY_BROWSER_VIEW);
  // The Hybrid skills-popover re-rank: an LLM ordering + reasons for the
  // deterministic top-3, fetched ONCE when a run completes (cached per run id),
  // and gated to a real-key context (the server no-ops it in any harness/CI
  // lane). Empty (the default, and always in test) → the popover keeps its
  // deterministic order + curated reasons; a result only re-orders/re-words the
  // SAME visible 3.
  const [serverSuggested, setServerSuggested] = useState<ServerSuggestion[]>([]);
  const suggestFetchedRef = useRef<string | null>(null);
  // Mirrors the active run id so a late suggest fetch can drop its result if the
  // user has since launched another run (advisory — never apply a stale re-rank).
  const activeRunIdRef = useRef<string | null>(null);
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
        const payload = data.payload as { kinds?: unknown; profile_id?: unknown } | null;
        const kinds = payload?.kinds;
        if (Array.isArray(kinds)) {
          // Honor the pulse's profile_id so a write in A refreshes only A's
          // scoped views (a null profile_id is a global pulse → refetch all).
          const profileId = typeof payload?.profile_id === "string" ? payload.profile_id : null;
          invalidate(
            kinds.filter((k): k is string => typeof k === "string"),
            profileId,
          );
        }
      }
      // A chained-run announce (a completed site_scan auto-started an aggregator
      // sibling) → remember it against the ACTIVE parent run; the effect below
      // streams it as its own turn once this parent turn is terminal. Dedupe a
      // re-delivered announce.
      const chained = data !== null && typeof data === "object" ? readChainedRun(data.payload) : null;
      if (chained !== null) {
        const parent = activeRunIdRef.current;
        // Skip a cold-recovered parent: its replayed announce points at a sibling
        // that already ran (re-streaming it would wipe the recovered turn).
        if (
          parent !== null &&
          parent !== coldRecoveredRef.current &&
          !startedChainsRef.current.has(chained.run_id)
        ) {
          pendingChainRef.current = { parent, chain: chained };
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
    setPinZip(null);
    if (s.pinned_profile_id !== null) {
      const pin = s.pinned_profile_id;
      client
        .getProfile(pin)
        .then((row) => {
          const snap = toSnapshot(row);
          setPinLabel(vehicleLabel(snap) || pin);
          setPinZip(zipOf(snap));
        })
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

  // ---- portfolio drill-in: focus a profile's workbench ----------------------
  // The board card is the entry; opening it PINS that profile to the session and
  // navigates to the workbench (home), where the Canvas binds to the pin — the
  // single-profile workbench is the drill-in leaf. Heavy detail loads there.
  const onOpenPortfolioProfile = (profileId: string): void => {
    onPin(profileId);
    navigate("/");
  };

  // ---- "Needs you" routing: a parked gate surfaces in the global inbox even
  // when focused on another pipeline; reviewing it navigates to THAT run, where
  // the existing per-run GateBannerHost renders the card and the decision routes
  // to that run's (runId, decisionId). The widget never approves inline.
  const onReviewGate = (runId: string): void => {
    navigate(`/runs/${runId}`);
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
          setPinZip(null);
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
  const streamRun = async (
    runId: string,
    userText?: string,
    keepHistory = false,
  ): Promise<void> => {
    try {
      await chat.stop(); // tear down any previous live stream first.
    } catch {
      /* no active stream */
    }
    // Keep the rail's history WITHIN a session (each skill run appends its own
    // turn); clear only when the session changed — i.e. intake forked a new one,
    // or a session-less headless run. bindAck has already set sessionIdRef to
    // this run's session before calling streamRun. `keepHistory` (the auto-chain
    // sibling path) NEVER clears — the sibling is a new turn in the SAME
    // conversation, and a null session (headless / cold-recovered parent) must
    // not be read as clear-worthy and wipe the parent turn.
    const sid = sessionIdRef.current;
    if (!keepHistory && (sid === null || sid !== streamedSessionRef.current)) {
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
    setServerSuggested([]); // clear the prior run's re-rank until this one completes.
    sessionIdRef.current = ack.session_id;
    recoveredRef.current = ack.run_id; // a fresh launch needs no recovery.
    // Hydrate the linked session's pin + persisted notice (one fetch); a
    // session-less headless start keeps the rail unpinned.
    if (ack.session_id !== null) hydrateSession(ack.session_id);
    else {
      setPinnedProfileId(null);
      setPinLabel(null);
      setPinZip(null);
    }
    void streamRun(ack.run_id, userText);
    navigate(`/runs/${ack.run_id}`);
  };

  // Stream an auto-chained sibling run (already started server-side by the
  // scan-chain listener) as its OWN new assistant turn. Mirrors bindAck's tail
  // WITHOUT a re-POST and WITHOUT clearing history (keepHistory): the sibling
  // shares the parent's session, so the parent turn stays in the rail — even for
  // a headless (null-session) parent, which would otherwise read as clear-worthy.
  // Best-effort — a not-yet-live sibling channel is swallowed (the scan still ran).
  const streamChainedRun = (parentRunId: string, chainRunId: string): void => {
    setActiveRunId(chainRunId);
    setServerSuggested([]);
    recoveredRef.current = chainRunId; // live-streamed here — no cold recovery.
    void streamRun(chainRunId, undefined, true).catch(() => {});
    // Only take over the URL when the user is actually VIEWING the parent run —
    // never yank them off the portfolio board / digest / another run they opened.
    // The sibling turn streams into the always-visible rail either way.
    if (route.name === "run" && route.runId === parentRunId) {
      navigate(`/runs/${chainRunId}`);
    }
  };

  const doLaunch = (mode: LaunchMode, userText?: string): void => {
    setLaunchError(null);
    // Always fork a fresh unpinned session from the current one.
    launchIntake(client, {
      mode,
      fromSessionId: sessionIdRef.current,
      ...(agentRun !== undefined ? { agent: agentRun } : {}),
    })
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
      ...(agentRun !== undefined ? { agent: agentRun } : {}),
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
      .route({
        nl_input: text,
        session_id: sessionIdRef.current,
        from_session_id: sessionIdRef.current,
        ...(agentRun !== undefined ? { agent: agentRun } : {}),
      })
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
      // This parent was recovered COLD — if it was a completed site_scan, the
      // replayed backlog re-delivers its chain announce; mark it so onData drops
      // that announce (the sibling already ran; re-firing would wipe this turn
      // and hijack the URL).
      coldRecoveredRef.current = runId;
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

  // Auto-chain: once the parent site_scan turn is terminal, stream the announced
  // aggregator sibling as its OWN turn. Deferred to terminal so the sibling's
  // stream never races the parent's still-open one. Drop the pending chain if the
  // user navigated to another run mid-stream (chat history stays in one session).
  useEffect(() => {
    const pending = pendingChainRef.current;
    if (pending === null) return;
    if (activeRunId !== pending.parent) {
      pendingChainRef.current = null;
      return;
    }
    if (!activeTurnTerminal) return;
    pendingChainRef.current = null;
    if (startedChainsRef.current.has(pending.chain.run_id)) return;
    startedChainsRef.current.add(pending.chain.run_id);
    streamChainedRun(pending.parent, pending.chain.run_id);
    // streamChainedRun / refs are stable enough; keying off the two terminal
    // signals is sufficient (an extra render fires a cheap null-guarded no-op).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, activeTurnTerminal]);

  // A run is ACTIVE while it exists and has not reached a terminal status
  // (running OR awaiting_approval). Drives the TopBar run pill AND the composer
  // SOFT-BLOCK: a message typed mid-run must not spawn a concurrent run.
  const runActive = activeRunId !== null && !activeTurnTerminal;

  const activeAwaiting =
    activeTurn !== undefined && activeTurn.turn.status === "awaiting_approval"
      ? activeTurn.turn.awaitingUser
      : null;
  const decision = useDecision(client, activeRunId, activeAwaiting?.decisionId ?? null);

  // Hybrid skills-popover re-rank: when a run COMPLETES, fetch a conversation-
  // aware ordering + reasons for the deterministic top-3 (ONCE per run id). The
  // deterministic set still renders instantly; this only re-orders/re-words the
  // SAME visible 3 when it arrives. Gated to a configured key; the server further
  // no-ops it in any harness/CI lane and on a fail-closed model outcome, so the
  // UI lane stays deterministic and makes no provider call.
  activeRunIdRef.current = activeRunId; // latest run id for the async drop-stale guard.
  useEffect(() => {
    if (!deepseekReady) return;
    if (activeRunId === null || !activeTurnTerminal) return;
    if (suggestFetchedRef.current === activeRunId) return;
    const skillList = skills.kind === "ok" ? skills.data : [];
    if (skillList.length === 0) return; // skills not loaded yet — a later render retries.
    // Derive lastSkill the SAME way the popover does (the literal last turn if it
    // is an assistant run) so the candidate set we send the server is EXACTLY the
    // set the popover renders and re-ranks against — never a divergent window.
    const lastTurn = turns[turns.length - 1];
    const lastSkill = lastTurn?.kind === "assistant" ? lastTurn.turn.skill : null;
    const candidateIds = nextSuggestedSkills(skillList, {
      pin: pinnedProfileId,
      hasActiveProfile,
      lastSkill,
    }).map((s) => s.name);
    if (candidateIds.length === 0) return;
    // Mark fetched ONLY now — everything above is synchronous, so no interleaving
    // render can double-fire, and we never poison the one-shot when data isn't
    // ready yet (e.g. a cold reload onto a completed run while skills still load).
    suggestFetchedRef.current = activeRunId;
    const forRun = activeRunId;
    const conversation = turns
      .slice(-8)
      .map((t) =>
        t.kind === "user"
          ? `user: ${t.text}`
          : `assistant(${t.turn.skill ?? "?"}): ${t.turn.text || t.turn.status}`,
      )
      .join("\n");
    client
      .suggestNextSkills({
        session_id: sessionIdRef.current,
        candidate_ids: candidateIds,
        conversation,
      })
      .then((ack) => {
        // Drop a late result whose run is no longer active (the user launched
        // another run while this was in flight) — advisory, never apply stale.
        if (activeRunIdRef.current !== forRun) return;
        setServerSuggested(ack.suggestions.map((s) => ({ skillId: s.skill_id, reason: s.reason })));
      })
      .catch(() => {
        if (activeRunIdRef.current === forRun) setServerSuggested([]); // advisory — never surface.
      });
  }, [
    activeRunId,
    activeTurnTerminal,
    deepseekReady,
    turns,
    skills,
    pinnedProfileId,
    hasActiveProfile,
    client,
  ]);

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
        // On the /settings ROUTE the full page is already showing — don't also
        // open the pop-up (it would duplicate the same SettingsBody).
        onOpenSettings={() => {
          if (route.name !== "settings") setSettingsOpen(true);
        }}
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

      {/* Multi-profile header strip — renders only with 2+ active searches, so
          the single-active path stays byte-identical. Reports by COUNTS. */}
      <PortfolioStatusBar cards={portfolioCards} items={inboxItems} />

      <div className="app-body" data-testid="app-body" ref={appBodyRef}>
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
              profileId={pinnedProfileId}
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
              profileId={pinnedProfileId}
              deepseekReady={deepseekReady}
              onEditProfile={onViewProfile}
              onDeleteProfile={onDeleteProfile}
            />
          )}
          {route.name === "portfolio" && <Portfolio client={client} onOpen={onOpenPortfolioProfile} />}
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

        {/* The draggable seam — the single way to rebalance the workbench: drag
            the rail's left boundary to narrow/widen it (always active). */}
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
          pinZip={pinZip}
          currentSessionId={sessionIdRef.current}
          skills={skills.kind === "ok" ? skills.data : []}
          serverSuggested={serverSuggested}
          hasActiveProfile={hasActiveProfile}
          deepseekReady={deepseekReady}
          agentSelection={agent.selection}
          agentPresence={agentPresence}
          onAgentChange={onAgentChange}
          onSlash={onSlash}
          onFreeform={onFreeform}
          onUnpin={onUnpin}
          onPin={onPin}
          onViewProfile={onViewProfile}
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

      {/* Settings pop-up — the top-right gear's overlay. Renders the SAME body as
          the /settings route (one shared SettingsBody); a calm "dialog" Modal
          (Escape + backdrop both close — adjusting env config destroys nothing).
          Suppressed on the /settings route so the body never renders twice. */}
      {settingsOpen && route.name !== "settings" && (
        <Modal open onClose={() => setSettingsOpen(false)} labelId={settingsTitleId}>
          <div className="settings-overlay" data-testid="settings-overlay">
            <header className="settings-overlay-head">
              <h2 id={settingsTitleId}>Settings</h2>
              <a
                href="/settings"
                className="settings-overlay-expand"
                data-testid="settings-overlay-expand"
                title="Open the full settings page"
                onClick={(e) => {
                  e.preventDefault();
                  setSettingsOpen(false);
                  navigate("/settings");
                }}
              >
                Full page ↗
              </a>
            </header>
            <div className="settings-overlay-body">
              <SettingsBody
                client={client}
                presence={keyPresence}
                onChanged={keyPresence.refetch}
                env={env}
                onEnvChanged={env.refetch}
                mode={mode}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Global "Needs you" approval inbox — a floating widget that follows the
          user across pages, aggregating every parked gate across all pipelines
          (error-first). Reviewing routes to the parked run; it never approves
          inline. Absent when nothing is parked (read-only/idle world). */}
      <NeedsYouInbox items={inboxItems} onReview={onReviewGate} />
    </div>
  );
}
