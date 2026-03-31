import { Injectable } from '@nestjs/common';

import {
  CRON_JOB_NOTIFICATION_POLICIES,
  CRON_SCHEDULE_TYPES,
  type CronJobNotificationPolicy,
  type CronScheduleType,
} from '../../../cron/cron-job.types';
import { CronSchedulerService } from '../../../cron/cron-scheduler.service';

@Injectable()
export class CronManagementToolService {
  constructor(private readonly scheduler: CronSchedulerService) {}

  async listJobs(): Promise<string> {
    const jobs = await this.scheduler.listJobs();
    if (jobs.length === 0) {
      return 'No scheduled jobs.';
    }

    const lines = [`${jobs.length} scheduled job(s):`, ''];
    for (const job of jobs) {
      lines.push(`- **${job.name}** (${job.enabled ? 'enabled' : 'paused'})`);
      lines.push(`  ID: ${job.id}`);
      lines.push(`  Schedule: ${job.scheduleType} — ${job.schedule}`);
      lines.push(`  Task: ${job.task}`);
      lines.push(`  Runs: ${job.runCount}${job.maxRuns > 0 ? '/' + job.maxRuns : ''}`);
      lines.push(`  Notification policy: ${job.notificationPolicy}`);
      lines.push(`  Next: ${job.nextRunAt ?? '—'}`);
      lines.push(`  Last: ${job.lastRunAt ?? 'never'}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  async createJob(args: Record<string, unknown>): Promise<string> {
    const name = this.readRequiredString(args.name, 'name');
    const task = this.readRequiredString(args.task, 'task');
    const scheduleType = this.parseScheduleType(args.schedule_type, 'cron');
    const schedule = this.readRequiredString(args.schedule, 'schedule');
    const maxRuns = this.parseNonNegativeInteger(args.max_runs, 0, 'max_runs');
    const notificationPolicy = this.parseNotificationPolicy(args.notification_policy, 'always');

    const job = await this.scheduler.createJob({
      name,
      task,
      scheduleType,
      schedule,
      maxRuns,
      notificationPolicy,
    });

    return [
      'Cron job created successfully.',
      `ID: ${job.id}`,
      `Name: ${job.name}`,
      `Schedule: ${job.scheduleType} — ${job.schedule}`,
      `Notification policy: ${job.notificationPolicy}`,
      `Next run: ${job.nextRunAt ?? 'not scheduled'}`,
      `Max runs: ${job.maxRuns === 0 ? 'unlimited' : job.maxRuns}`,
    ].join('\n');
  }

  async updateJob(args: Record<string, unknown>): Promise<string> {
    const id = this.readRequiredString(args.id, 'id');
    const updates = {
      name: this.readOptionalTrimmedString(args.name),
      task: this.readOptionalTrimmedString(args.task),
      scheduleType: this.parseOptionalScheduleType(args.schedule_type),
      schedule: this.readOptionalTrimmedString(args.schedule),
      maxRuns: this.parseOptionalNonNegativeInteger(args.max_runs, 'max_runs'),
      notificationPolicy: this.parseOptionalNotificationPolicy(args.notification_policy),
    };

    if (Object.values(updates).every((value) => value === undefined)) {
      throw new Error('At least one field must be provided for update.');
    }

    const job = await this.scheduler.updateJob(id, updates);
    if (!job) {
      return `Job ${id} not found.`;
    }

    return [
      `Job "${job.name}" updated.`,
      `ID: ${job.id}`,
      `Schedule: ${job.scheduleType} — ${job.schedule}`,
      `Notification policy: ${job.notificationPolicy}`,
      `Next run: ${job.nextRunAt ?? 'not scheduled'}`,
      `Max runs: ${job.maxRuns === 0 ? 'unlimited' : job.maxRuns}`,
    ].join('\n');
  }

  async listRuns(args: Record<string, unknown>): Promise<string> {
    const jobId = this.readOptionalTrimmedString(args.id);
    const limit = this.parseNonNegativeInteger(args.limit, 10, 'limit', 20, 1);
    const runs = await this.scheduler.listRecentRuns({ jobId, limit });

    if (runs.length === 0) {
      return jobId
        ? `No execution history found for job ${jobId}.`
        : 'No cron execution history found.';
    }

    const lines = [`Recent cron runs (${runs.length}):`, ''];
    for (const run of runs) {
      lines.push(`- **${run.jobName}** (${run.status})`);
      lines.push(`  Run ID: ${run.id}`);
      lines.push(`  Job ID: ${run.jobId}`);
      lines.push(`  Attempt: ${run.attempt}`);
      lines.push(`  Started: ${run.startedAt}`);
      lines.push(`  Finished: ${run.finishedAt ?? 'running'}`);
      lines.push(`  Scheduled for: ${run.scheduledFor ?? '—'}`);
      lines.push(`  Result: ${run.resultStatus}`);
      lines.push(`  Notification: ${run.notificationStatus}`);
      lines.push(`  Tools: ${run.toolNames.length ? `${run.toolNames.join(', ')} (${run.toolRoundsUsed} rounds)` : 'none'}`);
      if (run.outputPreview) {
        lines.push(`  Output: ${run.outputPreview}`);
      }
      if (run.errorMessage) {
        lines.push(`  Error: ${run.errorMessage}`);
      }
      if (run.notificationErrorMessage) {
        lines.push(`  Notification error: ${run.notificationErrorMessage}`);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  async deleteJob(args: Record<string, unknown>): Promise<string> {
    const id = this.readRequiredString(args.id, 'id');
    const deleted = await this.scheduler.deleteJob(id);
    return deleted ? `Job ${id} deleted.` : `Job ${id} not found.`;
  }

  async pauseJob(args: Record<string, unknown>): Promise<string> {
    const id = this.readRequiredString(args.id, 'id');
    const job = await this.scheduler.pauseJob(id);
    return job ? `Job "${job.name}" paused.` : `Job ${id} not found.`;
  }

  async resumeJob(args: Record<string, unknown>): Promise<string> {
    const id = this.readRequiredString(args.id, 'id');
    const job = await this.scheduler.resumeJob(id);
    return job ? `Job "${job.name}" resumed. Next run: ${job.nextRunAt ?? '—'}` : `Job ${id} not found.`;
  }

  private readRequiredString(value: unknown, field: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      throw new Error(`"${field}" is required.`);
    }
    return normalized;
  }

  private readOptionalTrimmedString(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      throw new Error('String update fields cannot be empty.');
    }
    return normalized;
  }

  private parseScheduleType(rawValue: unknown, fallback: CronScheduleType): CronScheduleType {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      return fallback;
    }
    const value = String(rawValue).trim() as CronScheduleType;
    if (!CRON_SCHEDULE_TYPES.includes(value)) {
      throw new Error(`invalid schedule_type "${value}". Use ${CRON_SCHEDULE_TYPES.map((item) => `"${item}"`).join(', ')}.`);
    }
    return value;
  }

  private parseOptionalScheduleType(rawValue: unknown): CronScheduleType | undefined {
    if (rawValue === undefined) {
      return undefined;
    }
    return this.parseScheduleType(rawValue, 'cron');
  }

  private parseNotificationPolicy(rawValue: unknown, fallback: CronJobNotificationPolicy): CronJobNotificationPolicy {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      return fallback;
    }
    const value = String(rawValue).trim() as CronJobNotificationPolicy;
    if (!CRON_JOB_NOTIFICATION_POLICIES.includes(value)) {
      throw new Error(`invalid notification_policy "${value}". Use ${CRON_JOB_NOTIFICATION_POLICIES.map((item) => `"${item}"`).join(', ')}.`);
    }
    return value;
  }

  private parseOptionalNotificationPolicy(rawValue: unknown): CronJobNotificationPolicy | undefined {
    if (rawValue === undefined) {
      return undefined;
    }
    return this.parseNotificationPolicy(rawValue, 'always');
  }

  private parseOptionalNonNegativeInteger(rawValue: unknown, field: string): number | undefined {
    if (rawValue === undefined) {
      return undefined;
    }
    return this.parseNonNegativeInteger(rawValue, 0, field);
  }

  private parseNonNegativeInteger(
    rawValue: unknown,
    fallback: number,
    field: string,
    maxValue?: number,
    minValue: number = 0,
  ): number {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      return fallback;
    }
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < minValue || (maxValue !== undefined && value > maxValue)) {
      const range = maxValue !== undefined ? `${minValue}-${maxValue}` : `${minValue}+`;
      throw new Error(`"${field}" must be an integer in range ${range}.`);
    }
    return value;
  }
}
