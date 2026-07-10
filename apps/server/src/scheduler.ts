/**
 * scheduler — the long-running-background MACHINERY: three anchored croner jobs
 * (a 6-hourly inbox poll, a 07:00 morning scan, and an 18:00 daily digest) plus the catch-up watermark
 * logic that survives sleep/down windows. Runs INSIDE the long-lived server
 * subprocess (this app layer), never in the Electron main process — the main
 * process owns powerMonitor and forwards resume/suspend down to here.
 *
 * WHY HERE, NOT MAIN: the server child is the durable backend that already holds
 * the product DB handle (the watermark store) and is where registered job bodies
 * drive workflows. The Electron main process is a thin launcher; it
 * has no DB and no workflow registry. So croner lives here, and the platform
 * power signal that main alone can see (Electron's powerMonitor) is relayed in
 * over the utilityProcess message channel as a {scheduler:'power', kind} message.
 *
 * JOB BODIES are registered by the app entrypoint. A missing registration stays
 * a traced no-op seam; the scheduler never fabricates a workflow run.
 *
 * CATCH-UP (the load-bearing logic): the watermark (pipeline_state, via the tools
 * accessors) records each job's last success as epoch-ms. On three triggers —
 * (a) boot, (b) a forwarded power-resume, (c) a 60s heartbeat (to catch a wall-
 * clock jump the resume event can miss, e.g. lid-sleep) — every job is checked:
 * if its most-recent scheduled fire ≤ now is later than its watermark, it runs
 * ONCE (merging N missed periods into one run) and the watermark is set to now.
 * The croner scheduled fire and a catch-up run can never double-run: the first
 * to complete writes last_success = now, so the other sees that fire as already
 * covered (catchUpDecision uses a strict >). croner's `protect` additionally
 * guards against a literal overlap.
 *
 * Dependency wall: app layer. Imports croner (a generic scheduling dep) + the
 * tools watermark accessors (the only product-DB touch, funnelled through tools).
 */

import { randomUUID } from "node:crypto";

import { Cron } from "croner";

import {
  readLastSuccess,
  releaseScheduledJobClaim,
  tryClaimScheduledJob,
  writeLastSuccess,
  type ScheduledJobClaim,
} from "@autobroker/tools";

import { catchUpDecision } from "./schedulerCatchup.js";

/** The three standing background jobs. The cron patterns are anchored (top of the
 *  hour) so the most-recent-fire math is stable. */
export interface JobSpec {
  /** Stable job name — the watermark key and the trace label. */
  name: string;
  /** Anchored 5-field cron pattern (minute hour dom month dow). */
  pattern: string;
  /** The skill targeted by the handler registered for this job. */
  skill: string;
}

export const SCHEDULED_JOBS: readonly JobSpec[] = [
  // Inbox poll — every 6 hours on the hour (00:00, 06:00, 12:00, 18:00).
  { name: "inbox_poll", pattern: "0 */6 * * *", skill: "dealer_inbox_check" },
  // Morning inventory refresh — 07:00 local, per active profile.
  { name: "morning_scan", pattern: "0 7 * * *", skill: "inventory_site_scan" },
  // Daily digest — 18:00 local.
  { name: "daily_digest", pattern: "0 18 * * *", skill: "daily_digest" },
];

/** A real job body, installed by the app entrypoint at its injection point. Receives
 *  the job spec + the trigger that fired it; resolves when the work is done. */
export type ScheduledJobHandler = (
  job: JobSpec,
  trigger: JobTrigger,
  trace: (line: SchedulerTrace) => void,
) => Promise<void>;

/** What caused a job to run — for the trace span and a handler's own logic. */
export type JobTrigger = "scheduled" | "catch_up_boot" | "catch_up_resume" | "catch_up_heartbeat";

/** A structured trace line (the voiced background-activity record). */
export interface SchedulerTrace {
  scheduler:
    | "job_run"
    | "job_noop"
    | "job_skipped_claimed"
    | "job_error"
    | "profile_run"
    | "profile_skipped"
    | "catch_up"
    | "power"
    | "lifecycle";
  job?: string;
  skill?: string;
  profileId?: string;
  trigger?: JobTrigger;
  detail?: string;
}

export interface SchedulerOptions {
  /** Power-scoped guard run AROUND a single job (acquire) and released after
   *  (release). In the desktop host this acquires/releases an Electron
   *  powerSaveBlocker for the job's duration ONLY — never held long-term. */
  powerGuard?: {
    acquire: () => void;
    release: () => void;
  };
  /** Structured trace sink (defaults to a single JSON console line). */
  trace?: (line: SchedulerTrace) => void;
  /** Heartbeat period in ms (default 60s). The heartbeat catches a wall-clock
   *  jump that a missed/late power-resume would otherwise leave uncaught. */
  heartbeatMs?: number;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
  /** Stable process owner id for the cross-process SQLite claim. */
  instanceId?: string;
  /** Stale-claim recovery window. Handlers only start child runs and return. */
  claimLeaseMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 15 * 60_000;

/**
 * The background scheduler. Owns the croner jobs, the registered job handlers,
 * and the boot/resume/heartbeat catch-up triggers. One instance per server
 * process; start() once, stop() on shutdown.
 */
export class BackgroundScheduler {
  private readonly handlers = new Map<string, ScheduledJobHandler>();
  private readonly crons: Cron[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  // Per-job in-flight guard so a catch-up trigger and the croner fire (or two
  // heartbeats) cannot run the same job concurrently (defence in depth beside
  // croner's own `protect`, and the only guard for catch-up runs).
  private readonly inflight = new Set<string>();
  private readonly trace: (line: SchedulerTrace) => void;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly powerGuard: SchedulerOptions["powerGuard"];
  private readonly instanceId: string;
  private readonly claimLeaseMs: number;

  constructor(opts: SchedulerOptions = {}) {
    this.trace = opts.trace ?? ((line) => console.info(JSON.stringify(line)));
    this.now = opts.now ?? (() => Date.now());
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.powerGuard = opts.powerGuard;
    this.instanceId = opts.instanceId ?? randomUUID();
    this.claimLeaseMs = opts.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  }

  /**
   * Register the real body for a job (the injection point later waves fill).
   * Until a handler is registered the job is a traced no-op seam.
   */
  registerHandler(jobName: string, handler: ScheduledJobHandler): void {
    this.handlers.set(jobName, handler);
  }

  /**
   * Arm the scheduler: create the anchored croner jobs (each with `protect` to
   * forbid re-entrant overlap and `catch` so a job failure logs + traces but
   * NEVER rethrows — a thrown job body must not kill the scheduler), then run
   * the boot catch-up pass and start the heartbeat.
   */
  start(): void {
    for (const job of SCHEDULED_JOBS) {
      const cron = new Cron(
        job.pattern,
        {
          protect: true, // no re-entrant overlap of the same job
          // `catch` swallows a job throw into a trace; the scheduler lives on.
          catch: (err: unknown) => {
            this.trace({
              scheduler: "job_error",
              job: job.name,
              skill: job.skill,
              trigger: "scheduled",
              detail: err instanceof Error ? err.message : String(err),
            });
          },
        },
        () => this.runJob(job, "scheduled"),
      );
      this.crons.push(cron);
    }
    this.trace({ scheduler: "lifecycle", detail: `armed ${this.crons.length} jobs` });

    // (a) Boot catch-up: a fire missed while the process was down runs now.
    void this.runCatchUp("catch_up_boot");

    // (c) Heartbeat catch-up: a >~heartbeat wall-clock jump (lid-sleep) that the
    // power-resume event can miss is caught here. setInterval is the recurring
    // probe, NOT a one-shot 6h timer — the catch-up decision, not the timer
    // firing on time, is what decides a run.
    this.heartbeat = setInterval(() => {
      void this.runCatchUp("catch_up_heartbeat");
    }, this.heartbeatMs);
    // Do not keep the event loop alive for the heartbeat alone (the server's
    // listening socket already does); a lone timer must not block a clean exit.
    this.heartbeat.unref?.();
  }

  /** (b) Power-resume trigger — forwarded from the Electron main process. A
   *  suspend is recorded for the trace only (no action; the heartbeat + the
   *  resume pass cover the asleep window). */
  onPower(kind: "resume" | "suspend"): void {
    this.trace({ scheduler: "power", detail: kind });
    if (kind === "resume") void this.runCatchUp("catch_up_resume");
  }

  /** Tear down: stop every croner job and the heartbeat. */
  stop(): void {
    for (const cron of this.crons) cron.stop();
    this.crons.length = 0;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.trace({ scheduler: "lifecycle", detail: "stopped" });
  }

  /** Run the catch-up pass over every job for a given trigger. */
  private async runCatchUp(
    trigger: Extract<JobTrigger, "catch_up_boot" | "catch_up_resume" | "catch_up_heartbeat">,
  ): Promise<void> {
    const now = this.now();
    for (const job of SCHEDULED_JOBS) {
      let lastSuccess: number;
      try {
        lastSuccess = readLastSuccess(job.name);
      } catch (err) {
        // A watermark read failure must not stop the other jobs or crash the
        // pass — trace and skip this job this round.
        this.trace({
          scheduler: "job_error",
          job: job.name,
          trigger,
          detail: `watermark read failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const decision = catchUpDecision(job.pattern, lastSuccess, now);
      if (decision.due) {
        this.trace({
          scheduler: "catch_up",
          job: job.name,
          trigger,
          detail: `missed fire at ${decision.mostRecentFireMs} > last ${lastSuccess}`,
        });
        await this.runJob(job, trigger);
      }
    }
  }

  /**
   * Run one job: the power-scoped guard wraps the run (acquired only for this
   * job's duration, released in finally), the registered handler runs if present
   * else the no-op seam is traced, and on success the watermark advances to now.
   * The per-job in-flight guard collapses a concurrent catch-up + scheduled fire
   * into one run. A handler throw is contained here (traced, not rethrown) so a
   * scheduled-fire path that bypasses croner's `catch` still cannot escape.
   */
  private async runJob(job: JobSpec, trigger: JobTrigger): Promise<void> {
    if (this.inflight.has(job.name)) {
      this.trace({ scheduler: "job_noop", job: job.name, trigger, detail: "already in flight" });
      return;
    }
    this.inflight.add(job.name);
    let claim: ScheduledJobClaim | null = null;
    let powerAcquired = false;
    try {
      claim = tryClaimScheduledJob({
        jobName: job.name,
        ownerId: this.instanceId,
        nowMs: this.now(),
        leaseMs: this.claimLeaseMs,
      });
      if (claim === null) {
        this.trace({
          scheduler: "job_skipped_claimed",
          job: job.name,
          skill: job.skill,
          trigger,
          detail: "another process owns this scheduled fire",
        });
        return;
      }

      // The pre-check in runCatchUp can go stale while another process runs.
      // Re-check only after winning the claim; if the fire is now covered, do
      // nothing. This closes the release-after-success race.
      const covered = catchUpDecision(job.pattern, readLastSuccess(job.name), this.now());
      if (!covered.due) {
        this.trace({
          scheduler: "job_noop",
          job: job.name,
          skill: job.skill,
          trigger,
          detail: "scheduled fire already covered",
        });
        return;
      }

      this.powerGuard?.acquire();
      powerAcquired = this.powerGuard !== undefined;
      const handler = this.handlers.get(job.name);
      if (handler === undefined) {
        // SEAM: the skill is not wired yet. Trace the no-op and advance the
        // watermark so the missed-fire bookkeeping stays correct — the machinery
        // is fully exercised; only the work is deferred to a later wave.
        this.trace({
          scheduler: "job_noop",
          job: job.name,
          skill: job.skill,
          trigger,
          detail: `no-op: ${job.skill} not yet wired`,
        });
      } else {
        await handler(job, trigger, (line) => this.trace(line));
        this.trace({ scheduler: "job_run", job: job.name, skill: job.skill, trigger });
      }
      writeLastSuccess(job.name, this.now());
    } catch (err) {
      // A handler failure does NOT advance the watermark (so it stays catch-up-
      // due) and is contained — never rethrown into croner's tick or a trigger.
      this.trace({
        scheduler: "job_error",
        job: job.name,
        skill: job.skill,
        trigger,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (powerAcquired) this.powerGuard?.release();
      if (claim !== null) {
        try {
          releaseScheduledJobClaim(claim);
        } catch (err) {
          this.trace({
            scheduler: "job_error",
            job: job.name,
            skill: job.skill,
            trigger,
            detail: `claim release failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      this.inflight.delete(job.name);
    }
  }
}
