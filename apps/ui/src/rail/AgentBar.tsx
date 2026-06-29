/**
 * AgentBar — the four-box agent selector that rides above the chat composer
 * (Provider · Method · Model · Effort). Provider/Method/Model are Popover chips
 * showing the collapsed value; clicking opens the option list. The bar is the
 * four boxes only — no header, lane badge, resolved line, or caption (kept
 * deliberately minimal). The two supported lanes are DeepSeek·API-key and
 * Claude·OAuth-subscription; every other cell is greyed.
 *
 * CROSS-DISABLE (pure, unit-tested below):
 *   - DeepSeek runs on API key only (no subscription OAuth lane).
 *   - Claude runs on the OAuth subscription lane only (its per-token API-key lane
 *     is NOT offered here, even when an anthropic key is present).
 *   - Models are per provider; EFFORT is inert in v1 so its box is disabled.
 *   - A Provider/Method cell is enabled only when its credential is present
 *     (DeepSeek·apikey→deepseek key, Claude·oauth→claude_oauth token). Greyed
 *     cells carry the reason + a "connect it" hint.
 *
 * DIRTY-OMIT: the bar persists the selection to localStorage and the App sends
 * the `agent` field on a run ONLY when the user actively chose (dirty). A fresh
 * browser (no localStorage) is NOT dirty → the field is omitted → the server's
 * env-default / policy default wins. The pure helpers (reconcile / toAgentSelection
 * / agentPayload) own that contract; this component is a thin renderer.
 *
 * EFFORT is functional-but-inert in v1: it persists + rides the payload but is
 * consumed by NO model/workflow/server call yet. Its box is therefore rendered
 * DISABLED (present for shape, never selectable) with a title that says so.
 *
 * Dependency wall: app/ui layer. Reuses the Popover primitive + the wire types;
 * no UI framework, no new server endpoint.
 */

import type { AgentSelection } from "../api/wire.js";
import { Popover } from "../shell/Popover.js";

/** UI-facing provider id (the "claude" alias maps to wire "anthropic" on emit). */
export type AgentProvider = "deepseek" | "claude";
export type AgentMethod = "apikey" | "oauth";
export type AgentEffort = "off" | "low" | "medium" | "high" | "max";
type AgentBox = "provider" | "method" | "model" | "effort";

/** The bar's selection state (App owns it; mirrors the mode/pin state pattern). */
export interface AgentUiSelection {
  provider: AgentProvider;
  method: AgentMethod;
  model: string;
  effort: AgentEffort;
}

/** The credential bits the bar gates on (a subset of the keys-presence read). */
export interface AgentPresence {
  deepseek: boolean;
  anthropic: boolean;
  claudeOauth: boolean;
}

/** One option's availability verdict (ok + a reason when greyed). */
export interface Avail {
  ok: boolean;
  why?: string;
}

interface Opt {
  id: string;
  label: string;
  sub: string;
}

export const AGENT_PROVIDERS: readonly { id: AgentProvider; label: string }[] = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "claude", label: "Claude" },
];

export const AGENT_METHODS: readonly Opt[] = [
  { id: "apikey", label: "API key", sub: "x-api-key · per-token" },
  { id: "oauth", label: "OAuth (subscription)", sub: "Agent SDK · subscription" },
];

// Model labels carry NO provider prefix — the Provider box already names it, so
// the Model box shows just the model (e.g. "v4-flash", "Sonnet 4.6").
export const AGENT_MODELS: Readonly<Record<AgentProvider, readonly Opt[]>> = {
  deepseek: [
    { id: "deepseek-v4-flash", label: "v4-flash", sub: "fast · default" },
    { id: "deepseek-v4-pro", label: "v4-pro", sub: "strong" },
  ],
  claude: [
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "chat tier" },
    { id: "claude-opus-4-8", label: "Opus 4.8", sub: "strong tier" },
  ],
};

export const AGENT_EFFORTS: Readonly<Record<AgentProvider, readonly Opt[]>> = {
  deepseek: [
    { id: "off", label: "Off", sub: "thinking disabled" },
    { id: "high", label: "High", sub: "reasoningEffort" },
    { id: "max", label: "Max", sub: "reasoningEffort" },
  ],
  claude: [
    { id: "off", label: "Off", sub: "no thinking" },
    { id: "low", label: "Low", sub: "effort" },
    { id: "medium", label: "Medium", sub: "effort" },
    { id: "high", label: "High", sub: "effort" },
  ],
};

/** The resting default — DeepSeek · API key · v4-flash · effort off. Shown when
 *  nothing is persisted; NOT sent on a run (the bar is not dirty until a pick). */
export const DEFAULT_AGENT_SELECTION: AgentUiSelection = {
  provider: "deepseek",
  method: "apikey",
  model: "deepseek-v4-flash",
  effort: "off",
};

const LS_KEY = "autobroker:agent-selection";
const VALID_EFFORTS: readonly AgentEffort[] = ["off", "low", "medium", "high", "max"];

// ---- pure availability + reconcile rules (unit-tested) ---------------------

/** Whether a (provider, method) pair is usable given the credential presence. */
export function methodAvail(provider: AgentProvider, method: AgentMethod, p: AgentPresence): Avail {
  if (provider === "deepseek") {
    return method === "apikey"
      ? p.deepseek
        ? { ok: true }
        : { ok: false, why: "no DeepSeek API key" }
      : { ok: false, why: "DeepSeek has no subscription OAuth" };
  }
  // Claude is offered on the OAuth-subscription lane ONLY (the two supported lanes
  // are DeepSeek·API-key + Claude·OAuth). The per-token API-key lane is not exposed
  // here even when an anthropic key is present.
  if (method === "apikey") return { ok: false, why: "Claude uses the OAuth subscription lane" };
  return p.claudeOauth ? { ok: true } : { ok: false, why: "connect a subscription token" };
}

/** Whether a provider has ANY usable credential. */
export function providerAvail(provider: AgentProvider, p: AgentPresence): Avail {
  return provider === "deepseek"
    ? p.deepseek
      ? { ok: true }
      : { ok: false, why: "no DeepSeek API key" }
    : p.claudeOauth
      ? { ok: true }
      : { ok: false, why: "connect a Claude subscription token" };
}

/** Which execution lane a selection resolves to (Claude·OAuth = B, else A). */
export function laneOf(sel: AgentUiSelection): "A" | "B" {
  return sel.provider === "claude" && sel.method === "oauth" ? "B" : "A";
}

/** First available method for a provider, falling back to apikey. */
function firstMethod(provider: AgentProvider, p: AgentPresence): AgentMethod {
  for (const m of AGENT_METHODS) {
    if (methodAvail(provider, m.id as AgentMethod, p).ok) return m.id as AgentMethod;
  }
  return "apikey";
}

/** Coerce a selection back into a self-consistent state for the provider +
 *  presence: method valid+available, model belongs to provider, effort in the
 *  provider's scale. Idempotent. */
export function reconcile(sel: AgentUiSelection, p: AgentPresence): AgentUiSelection {
  let method = sel.method;
  let model = sel.model;
  let effort = sel.effort;
  const { provider } = sel;
  if (!methodAvail(provider, method, p).ok) method = firstMethod(provider, p);
  if (!AGENT_MODELS[provider].some((m) => m.id === model)) model = AGENT_MODELS[provider][0]!.id;
  if (!AGENT_EFFORTS[provider].some((e) => e.id === effort)) {
    const list = AGENT_EFFORTS[provider];
    effort = (list[1]?.id ?? list[0]!.id) as AgentEffort;
  }
  return { provider, method, model, effort };
}

/** Map the UI selection to the wire AgentSelection: claude→anthropic, and force
 *  apikey for deepseek (it has no OAuth lane). */
export function toAgentSelection(sel: AgentUiSelection): AgentSelection {
  const provider = sel.provider === "claude" ? "anthropic" : "deepseek";
  const method = provider === "deepseek" ? "apikey" : sel.method;
  return { provider, method, model: sel.model, effort: sel.effort };
}

/** Map the server's effective-default wire AgentSelection back to a UI selection
 *  (anthropic→claude; fill a valid model/effort — reconcile finalizes). Lets the
 *  bar DISPLAY what the server will actually run (e.g. `/e2e-loop --provider
 *  claude` → the bar shows Claude) without marking the bar dirty, so the payload
 *  stays omitted and the env default still drives. */
export function uiSelectionFromWire(sel: AgentSelection): AgentUiSelection {
  const provider: AgentProvider = sel.provider === "anthropic" ? "claude" : "deepseek";
  const method: AgentMethod = sel.method === "oauth" ? "oauth" : "apikey";
  const model = typeof sel.model === "string" && sel.model.length > 0 ? sel.model : AGENT_MODELS[provider][0]!.id;
  const effort = VALID_EFFORTS.includes(sel.effort as AgentEffort) ? (sel.effort as AgentEffort) : "off";
  return { provider, method, model, effort };
}

/** The dirty-omit contract: the `agent` payload is the reconciled selection ONLY
 *  when the user has made an explicit choice (dirty); undefined otherwise so the
 *  server default wins. */
export function agentPayload(
  sel: AgentUiSelection,
  dirty: boolean,
  p: AgentPresence,
): AgentSelection | undefined {
  return dirty ? toAgentSelection(reconcile(sel, p)) : undefined;
}

// ---- localStorage (best-effort; mirrors store/layout.ts) -------------------

/** Load the persisted selection. `dirty` is true ⇔ a saved selection exists (a
 *  fresh browser is not dirty → the run omits `agent`). */
export function loadAgentSelection(): { selection: AgentUiSelection; dirty: boolean } {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw === null) return { selection: DEFAULT_AGENT_SELECTION, dirty: false };
    const parsed = JSON.parse(raw) as Partial<AgentUiSelection>;
    const selection: AgentUiSelection = {
      provider: parsed.provider === "claude" ? "claude" : "deepseek",
      method: parsed.method === "oauth" ? "oauth" : "apikey",
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_AGENT_SELECTION.model,
      effort: VALID_EFFORTS.includes(parsed.effort as AgentEffort)
        ? (parsed.effort as AgentEffort)
        : DEFAULT_AGENT_SELECTION.effort,
    };
    return { selection, dirty: true };
  } catch {
    return { selection: DEFAULT_AGENT_SELECTION, dirty: false };
  }
}

/** Persist the committed selection (best-effort — view state). */
export function saveAgentSelection(sel: AgentUiSelection): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(sel));
  } catch {
    /* view state only — persistence is best-effort */
  }
}

// ---- render helpers --------------------------------------------------------

const BOXES: readonly { box: AgentBox; label: string }[] = [
  { box: "provider", label: "Provider" },
  { box: "method", label: "Method" },
  { box: "model", label: "Model" },
  { box: "effort", label: "Effort" },
];

function currentId(box: AgentBox, sel: AgentUiSelection): string {
  return box === "provider"
    ? sel.provider
    : box === "method"
      ? sel.method
      : box === "model"
        ? sel.model
        : sel.effort;
}

function currentLabel(box: AgentBox, sel: AgentUiSelection): string {
  if (box === "provider") return AGENT_PROVIDERS.find((p) => p.id === sel.provider)!.label;
  if (box === "method") return AGENT_METHODS.find((m) => m.id === sel.method)!.label;
  if (box === "model") return AGENT_MODELS[sel.provider].find((m) => m.id === sel.model)!.label;
  return AGENT_EFFORTS[sel.provider].find((e) => e.id === sel.effort)!.label;
}

function optionsFor(
  box: AgentBox,
  sel: AgentUiSelection,
  p: AgentPresence,
): { id: string; label: string; sub: string; avail: Avail }[] {
  if (box === "provider") {
    return AGENT_PROVIDERS.map((pp) => ({
      id: pp.id,
      label: pp.label,
      sub: pp.id,
      avail: providerAvail(pp.id, p),
    }));
  }
  if (box === "method") {
    return AGENT_METHODS.map((m) => ({
      id: m.id,
      label: m.label,
      sub: m.sub,
      avail: methodAvail(sel.provider, m.id as AgentMethod, p),
    }));
  }
  const list = box === "model" ? AGENT_MODELS[sel.provider] : AGENT_EFFORTS[sel.provider];
  return list.map((o) => ({ id: o.id, label: o.label, sub: o.sub, avail: { ok: true } }));
}

export interface AgentBarProps {
  selection: AgentUiSelection;
  presence: AgentPresence;
  /** Fired on an explicit user pick with the reconciled selection (App marks
   *  dirty + persists). */
  onChange: (next: AgentUiSelection) => void;
}

export function AgentBar({ selection, presence, onChange }: AgentBarProps): JSX.Element {
  // Reconcile for DISPLAY so a persisted/stale selection renders consistently;
  // the App reconciles again for the payload (the single source of the wire shape).
  const sel = reconcile(selection, presence);
  const providerClass = sel.provider === "claude" ? "agent--claude" : "agent--deepseek";

  const pick = (box: AgentBox, id: string): void => {
    onChange(reconcile({ ...sel, [box]: id }, presence));
  };

  const chipFace = (box: AgentBox, label: string): JSX.Element => (
    <span className="agent-chip__face">
      <span className="agent-chip__k">{label}</span>
      <span className="agent-chip__v">{currentLabel(box, sel)}</span>
    </span>
  );

  return (
    <div className={`agent-bar ${providerClass}`} data-testid="agent-bar">
      <div className="agent-bar__chips">
        {BOXES.map(({ box, label }) => {
          // EFFORT is functional-but-inert in v1 (no model call consumes it), so
          // its box is a disabled, non-interactive chip — present for shape only.
          if (box === "effort") {
            return (
              <div className="agent-bar__chip agent-bar__chip--effort" key={box}>
                <button
                  type="button"
                  className="agent-chip agent-chip--disabled"
                  data-testid={`agent-box-${box}`}
                  disabled
                  aria-disabled="true"
                  title="Effort tuning isn't wired into model calls yet."
                >
                  {chipFace(box, label)}
                </button>
              </div>
            );
          }
          return (
            <div className={`agent-bar__chip agent-bar__chip--${box}`} key={box}>
              <Popover
                label={chipFace(box, label)}
                triggerClassName="agent-chip"
                triggerTestId={`agent-box-${box}`}
                panelTestId={`agent-box-${box}-popover`}
              >
                {(close) => (
                  <div className="agent-opts" role="listbox" aria-label={label}>
                    <div className="agent-opts__ph">{label}</div>
                    {optionsFor(box, sel, presence).map((o) => {
                      const selected = currentId(box, sel) === o.id;
                      const disabled = !o.avail.ok;
                      return (
                        <button
                          type="button"
                          key={o.id}
                          className={`agent-opt${selected ? " is-selected" : ""}`}
                          data-testid={`agent-opt-${o.id}`}
                          role="option"
                          aria-selected={selected}
                          disabled={disabled}
                          onClick={() => {
                            if (disabled) return;
                            pick(box, o.id);
                            close();
                          }}
                        >
                          <span className="agent-opt__rad" aria-hidden="true" />
                          <span className="agent-opt__text">
                            <span className="agent-opt__label">{o.label}</span>
                            <small className="agent-opt__sub">
                              {disabled ? `✕ ${o.avail.why ?? "unavailable"}` : o.sub}
                            </small>
                            {disabled &&
                              (box === "provider" || box === "method") &&
                              /key|token/i.test(o.avail.why ?? "") && (
                                // Only a MISSING-CREDENTIAL disable is fixable by connecting a
                                // key/token; a deliberately-unavailable lane (Claude·apikey,
                                // DeepSeek·oauth) shows just its ✕ reason, no "connect it" hint.
                                <small className="agent-opt__hint">Connect it in Settings → API keys</small>
                              )}
                          </span>
                          {disabled && (
                            <span className="agent-opt__lock" aria-hidden="true">
                              🔒
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Popover>
            </div>
          );
        })}
      </div>
    </div>
  );
}
