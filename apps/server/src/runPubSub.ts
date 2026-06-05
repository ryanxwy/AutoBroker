/**
 * runPubSub — the per-run SSE event log + subscriber fan-out (BACKEND_SERVICES
 * §4 + §5). Replaces the legacy self-built SkillRunRegistry's
 * subscribers/append_event with an in-memory replay buffer fed by the runtime
 * glue and drained by the HTTP /stream route. Pure in-memory at M1: the Mastra
 * workflow snapshot (mastra.db) is the DURABLE truth; this buffer is the live
 * fan-out only, rebuilt from scratch each boot (§5 "实时态集中到一个有重放语义的
 * 缓冲里").
 *
 * THE SSE ENVELOPE (§4.1, verbatim from legacy sse.py:91-118):
 *   every frame = { ts:<ISO-8601 UTC>, kind:<EVENT_KIND>, payload:{...} }
 *   - append() stamps `ts`, asserts `kind ∈ EVENT_KINDS` (an unknown kind THROWS
 *     — the caller cannot drift), and payload is always an object (default {}).
 *   - the HTTP route serializes each frame as `data: <compact-json>\n\n` — there
 *     is NO `event:` named line (all frames ride the default message handler so a
 *     single EventSource.onmessage consumer can switch on payload.kind).
 *
 * FIRST FRAME = init {run_id, skill, driver_kind} (§4.2/§5.3, D-B4): the
 * driver_kind is INJECTED HERE = 'deepseek_apikey' — the two-place lock-step note
 * (D-B4): this emitter and the harness evaluator's driver_kind anchor expectation
 * must change together; the value is the default api-key lane label
 * (core HARNESS_DRIVER_KINDS includes it). anthropic_apikey/openai_apikey are M4.
 *
 * SINGLE-TERMINAL-FRAME INVARIANT (§4.4, the load-bearing "wire wins" rule):
 *   - terminal kinds are EXACTLY three: done | error | aborted (§4.4; `declined`
 *     is a STATUS projection, NOT a wire kind — a decline lands as `aborted` on
 *     the wire and `declined` in the status projection, delta recorded). Decline
 *     metadata rides the aborted frame payload (reason) + the status projection.
 *   - once a terminal frame lands, every later append is DISCARDED with a
 *     console.warn (wire wins). A status-only terminal re-entry after a wire
 *     terminal is ignored too.
 *
 * REPLAY-ON-SUBSCRIBE (§4.3): a late subscriber gets the FULL ordered backlog
 * (snapshot) then live events, taken under one lock so nothing is missed or
 * doubled. Reconnect = re-subscribe to the same run (no Last-Event-ID, no id:).
 *
 * Dependency wall: app layer. Imports core (the SkillRunStatus type only,
 * indirectly via EVENT_KINDS) — NEVER @mastra, NEVER the product DB.
 */

/**
 * The closed EVENT_KINDS set (§4.2 frozenset). M1 emits a subset; the full set is
 * declared so an unknown kind throws (no drift). browser.* and the SDK-only
 * approval/permission kinds are listed for completeness but never emitted by
 * intake.
 */
export const EVENT_KINDS = [
  "init",
  "text",
  "tool_call",
  "tool_result",
  "awaiting_user",
  "awaiting_permission",
  "approval_required",
  "approval_response",
  "reasoning_full",
  "reasoning_summary",
  "refusal",
  "browser.opened",
  "browser.action",
  "browser.error",
  "browser.closed",
  "done",
  "error",
  "aborted",
  "runs.list_changed",
  "runs.run_updated",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The three terminal wire kinds (§4.4). A run's stream ends after exactly one. */
export const TERMINAL_EVENT_KINDS = ["done", "error", "aborted"] as const;
export type TerminalEventKind = (typeof TERMINAL_EVENT_KINDS)[number];

const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);
const TERMINAL_SET = new Set<string>(TERMINAL_EVENT_KINDS);

/** One SSE frame (§4.1). */
export interface SseEvent {
  ts: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

/** The driver_kind injected into the init frame (D-B4, two-place lock-step). The
 *  default api-key lane label; anthropic_apikey/openai_apikey are M4 TODOs. */
export const INIT_DRIVER_KIND = "deepseek_apikey" as const;

/** A live subscriber's queue: an async iterator the HTTP route drains. New events
 *  pushed after subscribe arrive here; the snapshot covers everything before. */
export interface SseQueue {
  /** Push a live event (no-op once the run is terminal-closed for this queue). */
  push(ev: SseEvent): void;
  /** Mark the queue closed (terminal reached); wakes a pending next() with done. */
  close(): void;
  /** Async iterator the route awaits; ends when close() is called and drained. */
  [Symbol.asyncIterator](): AsyncIterator<SseEvent>;
}

/** What subscribe() returns under one lock (§4.3): the ordered backlog, a live
 *  queue (only attached when not yet terminal), and whether already terminal. */
export interface Subscription {
  snapshot: SseEvent[];
  queue: SseQueue | null;
  isTerminal: boolean;
}

/** Per-run state: the ordered log, whether a terminal frame landed, and the live
 *  subscriber queues. */
interface RunChannel {
  log: SseEvent[];
  terminal: boolean;
  queues: Set<SseQueue>;
}

/** Build an unbounded async queue (§4.4: queue is unbounded — backpressure is
 *  memory growth, events are never dropped). */
function makeQueue(): SseQueue {
  const buffer: SseEvent[] = [];
  let closed = false;
  let resolveNext: ((r: IteratorResult<SseEvent>) => void) | null = null;

  return {
    push(ev: SseEvent): void {
      if (closed) return;
      if (resolveNext !== null) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        buffer.push(ev);
      }
    },
    close(): void {
      closed = true;
      if (resolveNext !== null) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as unknown as SseEvent, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
      return {
        next(): Promise<IteratorResult<SseEvent>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as SseEvent, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };
}

/**
 * The per-run pubsub. One instance per server process; `attachInit` opens a
 * channel, `append` adds frames (terminal-aware), `subscribe` joins a late
 * reader with replay. In-memory only (M1).
 */
export class RunPubSub {
  private readonly channels = new Map<string, RunChannel>();

  /** True once a run has a channel (init emitted). */
  has(runId: string): boolean {
    return this.channels.has(runId);
  }

  /**
   * Open the run's channel and emit the MANDATORY first frame — init
   * {run_id, skill, driver_kind} — with driver_kind injected here (D-B4). Idempotent
   * per run: a second call is a no-op (the init frame is emitted exactly once).
   */
  attachInit(runId: string, skill: string): void {
    if (this.channels.has(runId)) return;
    const channel: RunChannel = { log: [], terminal: false, queues: new Set() };
    this.channels.set(runId, channel);
    this.append(runId, {
      kind: "init",
      payload: { run_id: runId, skill, driver_kind: INIT_DRIVER_KIND },
    });
  }

  /**
   * Append an event. Stamps `ts`, validates `kind` (unknown → throw, no drift),
   * enforces the single-terminal-frame invariant (§4.4): after a terminal frame,
   * later appends are discarded with a console.warn (wire wins). Returns true when
   * the event was appended, false when discarded post-terminal.
   */
  append(runId: string, ev: { kind: EventKind; payload?: Record<string, unknown> }): boolean {
    const channel = this.channels.get(runId);
    if (channel === undefined) {
      throw new Error(`runPubSub.append: no channel for run '${runId}' (attachInit first)`);
    }
    if (!EVENT_KIND_SET.has(ev.kind)) {
      // Caller cannot drift the closed kind set (§4.1 makeEvent semantics).
      throw new Error(`runPubSub.append: unknown event kind '${ev.kind}'`);
    }
    if (channel.terminal) {
      // wire wins: a terminal frame already landed; discard + warn (§4.4).
      console.warn(
        `runPubSub: discarding '${ev.kind}' append after terminal frame for run '${runId}' (wire wins)`,
      );
      return false;
    }

    const frame: SseEvent = {
      ts: new Date().toISOString(),
      kind: ev.kind,
      payload: ev.payload ?? {},
    };
    channel.log.push(frame);

    if (TERMINAL_SET.has(ev.kind)) {
      channel.terminal = true;
    }

    // Fan out to live subscribers (the snapshot covers earlier frames).
    for (const q of channel.queues) {
      q.push(frame);
      if (channel.terminal) q.close();
    }
    return true;
  }

  /** True once a terminal frame (done/error/aborted) has landed for the run. */
  isTerminal(runId: string): boolean {
    return this.channels.get(runId)?.terminal ?? false;
  }

  /** The full ordered backlog (a copy). Empty when the run is unknown. */
  snapshot(runId: string): SseEvent[] {
    return [...(this.channels.get(runId)?.log ?? [])];
  }

  /**
   * Subscribe a late reader (§4.3). Under one synchronous critical section
   * (single-threaded JS — the map ops are atomic) it returns the ordered snapshot
   * and, only when not yet terminal, a live queue for subsequent frames. An
   * already-terminal run returns snapshot + null queue (the route replays then
   * closes). Returns null when the run is unknown (the route maps that to 404).
   */
  subscribe(runId: string): Subscription | null {
    const channel = this.channels.get(runId);
    if (channel === undefined) return null;
    const snapshot = [...channel.log];
    if (channel.terminal) {
      return { snapshot, queue: null, isTerminal: true };
    }
    const queue = makeQueue();
    channel.queues.add(queue);
    return { snapshot, queue, isTerminal: false };
  }

  /** Detach a live queue (the route's connection closed before terminal). */
  unsubscribe(runId: string, queue: SseQueue): void {
    const channel = this.channels.get(runId);
    if (channel === undefined) return;
    channel.queues.delete(queue);
    queue.close();
  }

  /** Test-only: drop all channels between isolated cases. */
  resetForTests(): void {
    this.channels.clear();
  }
}
