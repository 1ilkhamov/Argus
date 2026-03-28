import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CronJobRepository } from './cron-job.repository';
import type { CronJob, CreateCronJobParams } from './cron-job.types';

/** How often the scheduler checks for due jobs (ms) */
const TICK_INTERVAL_MS = 15_000;
/** Maximum lookahead when searching the next cron occurrence (1 year) */
const MAX_CRON_LOOKAHEAD_MINUTES = 366 * 24 * 60;

/**
 * Cron scheduler service.
 *
 * Runs a periodic timer that checks for due jobs and fires them.
 * Job results are delivered via a callback (set by the module that wires
 * the scheduler to the agent / notification system).
 */
@Injectable()
export class CronSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronSchedulerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  /** Callback invoked when a job fires. Set externally by the wiring module. */
  private onJobFired?: (job: CronJob) => Promise<void>;

  constructor(
    private readonly repo: CronJobRepository,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Register a handler for when jobs fire */
  setJobHandler(handler: (job: CronJob) => Promise<void>): void {
    this.onJobFired = handler;
  }

  // ─── Public API (used by cron tool) ──────────────────────────────────────

  async createJob(params: CreateCronJobParams): Promise<CronJob> {
    const nextRun = this.computeNextRunForSchedule(params.scheduleType, params.schedule);
    if (!nextRun) {
      throw new Error(`Invalid or unschedulable ${params.scheduleType} schedule: ${params.schedule}`);
    }

    const job = await this.repo.create(params);
    await this.repo.update(job.id, { nextRunAt: nextRun });
    job.nextRunAt = nextRun;
    return job;
  }

  async listJobs(): Promise<CronJob[]> {
    return this.repo.findAll();
  }

  async deleteJob(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }

  async pauseJob(id: string): Promise<CronJob | undefined> {
    const job = await this.repo.findById(id);
    if (!job) return undefined;
    await this.repo.update(id, { enabled: false });
    return { ...job, enabled: false };
  }

  async resumeJob(id: string): Promise<CronJob | undefined> {
    const job = await this.repo.findById(id);
    if (!job) return undefined;
    const nextRun = this.computeNextRun(job);
    if (!nextRun) {
      throw new Error(`Cannot resume job ${id}: schedule is invalid or has no future occurrence.`);
    }
    await this.repo.update(id, { enabled: true, nextRunAt: nextRun });
    return { ...job, enabled: true, nextRunAt: nextRun };
  }

  // ─── Scheduler loop ──────────────────────────────────────────────────────

  private start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error(`Scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, TICK_INTERVAL_MS);
    // Don't block process shutdown
    this.timer.unref();

    this.logger.log(`Cron scheduler started (tick every ${TICK_INTERVAL_MS / 1000}s)`);

    // Recompute nextRunAt for all enabled jobs on startup
    this.recomputeAll().catch((err) => {
      this.logger.warn(`Failed to recompute job schedules: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.logger.log('Cron scheduler stopped');
  }

  private async tick(): Promise<void> {
    if (this.running) return; // Prevent overlapping ticks
    this.running = true;

    try {
      const now = new Date().toISOString();
      const dueJobs = await this.repo.findDue(now);

      for (const job of dueJobs) {
        await this.fireJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async fireJob(job: CronJob): Promise<void> {
    this.logger.log(`Firing cron job: "${job.name}" (${job.id})`);

    const now = new Date().toISOString();
    const newRunCount = job.runCount + 1;

    // Check if max runs reached
    if (job.maxRuns > 0 && newRunCount >= job.maxRuns) {
      await this.repo.update(job.id, {
        lastRunAt: now,
        runCount: newRunCount,
        enabled: false,
        nextRunAt: null,
      });
      this.logger.log(`Job "${job.name}" reached max runs (${job.maxRuns}), disabled`);
    } else {
      const nextRun = this.computeNextRun(job, new Date());
      await this.repo.update(job.id, {
        lastRunAt: now,
        runCount: newRunCount,
        nextRunAt: nextRun,
      });
    }

    // Fire the handler
    if (this.onJobFired) {
      try {
        await this.onJobFired(job);
      } catch (err) {
        this.logger.error(`Job handler failed for "${job.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      this.logger.warn(`No job handler registered — job "${job.name}" result dropped`);
    }
  }

  private async recomputeAll(): Promise<void> {
    const jobs = await this.repo.findEnabled();
    let updated = 0;

    for (const job of jobs) {
      const nextRun = this.computeNextRun(job);
      if (!nextRun) {
        await this.repo.update(job.id, { enabled: false, nextRunAt: null });
        updated++;
        continue;
      }

      if (nextRun !== job.nextRunAt) {
        await this.repo.update(job.id, { nextRunAt: nextRun, enabled: true });
        updated++;
      }
    }

    if (updated > 0) {
      this.logger.log(`Recomputed next run for ${updated} jobs`);
    }
  }

  // ─── Schedule computation ────────────────────────────────────────────────

  private computeNextRun(job: CronJob, after?: Date): string | null {
    return this.computeNextRunForSchedule(job.scheduleType, job.schedule, after);
  }

  private computeNextRunForSchedule(
    scheduleType: CronJob['scheduleType'],
    schedule: string,
    after?: Date,
  ): string | null {
    const now = after ?? new Date();

    switch (scheduleType) {
      case 'once': {
        const target = new Date(schedule);
        if (Number.isNaN(target.getTime())) return null;
        return target > now ? target.toISOString() : null;
      }

      case 'interval': {
        const intervalMs = Number(schedule);
        if (!Number.isInteger(intervalMs) || intervalMs < 10_000) return null;
        return new Date(now.getTime() + intervalMs).toISOString();
      }

      case 'cron': {
        return this.nextCronOccurrence(schedule, now);
      }

      default:
        return null;
    }
  }

  /**
   * Simple cron expression parser.
   * Supports: minute hour day-of-month month day-of-week
   * Supports: wildcard, numbers, ranges (1-5), steps (star/5), lists (1,3,5)
   */
  private nextCronOccurrence(expression: string, after: Date): string | null {
    try {
      const parts = expression.trim().split(/\s+/);
      if (parts.length !== 5) return null;

      const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts as [string, string, string, string, string];
      const domWildcard = domExpr === '*';
      const dowWildcard = dowExpr === '*';

      // Try each minute for up to a year so monthly/rare schedules still resolve.
      const candidate = new Date(after);
      candidate.setSeconds(0, 0);
      candidate.setMinutes(candidate.getMinutes() + 1);

      for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i++) {
        const minute = candidate.getMinutes();
        const hour = candidate.getHours();
        const dom = candidate.getDate();
        const month = candidate.getMonth() + 1;
        const dow = candidate.getDay();

        const domMatches = this.matchesCronField(domExpr, dom, 1, 31);
        const dowMatches = this.matchesCronField(dowExpr, dow, 0, 7, true);
        const dayMatches = domWildcard && dowWildcard
          ? true
          : domWildcard
            ? dowMatches
            : dowWildcard
              ? domMatches
              : domMatches || dowMatches;

        if (
          this.matchesCronField(minuteExpr, minute, 0, 59) &&
          this.matchesCronField(hourExpr, hour, 0, 23) &&
          this.matchesCronField(monthExpr, month, 1, 12) &&
          dayMatches
        ) {
          return candidate.toISOString();
        }

        candidate.setMinutes(candidate.getMinutes() + 1);
      }

      return null;
    } catch {
      this.logger.warn(`Invalid cron expression: ${expression}`);
      return null;
    }
  }

  private matchesCronField(
    expr: string,
    value: number,
    min: number,
    max: number,
    allowSundaySeven = false,
  ): boolean {
    if (expr === '*') return true;

    for (const rawPart of expr.split(',')) {
      const part = rawPart.trim();
      if (!part) {
        return false;
      }

      const matched = this.matchesCronPart(part, value, min, max, allowSundaySeven);
      if (matched === null) {
        return false;
      }
      if (matched) {
        return true;
      }
    }

    return false;
  }

  private matchesCronPart(
    part: string,
    value: number,
    min: number,
    max: number,
    allowSundaySeven: boolean,
  ): boolean | null {
    if (part.includes('/')) {
      const splitParts = part.split('/');
      if (splitParts.length !== 2) return null;

      const rangeStr = splitParts[0] ?? '*';
      const step = Number(splitParts[1]);
      if (!Number.isInteger(step) || step <= 0) return null;

      let start = min;
      let end = max;
      if (rangeStr !== '*') {
        if (rangeStr.includes('-')) {
          const range = this.parseCronRange(rangeStr, min, max, allowSundaySeven);
          if (!range) return null;
          [start, end] = range;
        } else {
          const parsedStart = this.parseCronNumber(rangeStr, min, max, allowSundaySeven);
          if (parsedStart === null) return null;
          start = parsedStart;
        }
      }

      return value >= start && value <= end && (value - start) % step === 0;
    }

    if (part.includes('-')) {
      const range = this.parseCronRange(part, min, max, allowSundaySeven);
      if (!range) return null;
      const [start, end] = range;
      return value >= start && value <= end;
    }

    const exact = this.parseCronNumber(part, min, max, allowSundaySeven);
    if (exact === null) return null;
    return exact === value;
  }

  private parseCronRange(
    expr: string,
    min: number,
    max: number,
    allowSundaySeven: boolean,
  ): [number, number] | null {
    const [startRaw, endRaw, ...rest] = expr.split('-');
    if (!startRaw || !endRaw || rest.length > 0) {
      return null;
    }

    const start = this.parseCronNumber(startRaw, min, max, allowSundaySeven);
    const end = this.parseCronNumber(endRaw, min, max, allowSundaySeven);
    if (start === null || end === null || start > end) {
      return null;
    }

    return [start, end];
  }

  private parseCronNumber(
    rawValue: string,
    min: number,
    max: number,
    allowSundaySeven: boolean,
  ): number | null {
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed)) {
      return null;
    }

    if (allowSundaySeven && parsed === 7) {
      return 0;
    }

    if (parsed < min || parsed > max) {
      return null;
    }

    return parsed;
  }
}
