/** Supported schedule types */
export type CronScheduleType = 'cron' | 'interval' | 'once';

export interface CronJob {
  id: string;
  /** Human-readable name (e.g. "Morning news summary") */
  name: string;
  /** What the agent should do when the job fires */
  task: string;
  /** Schedule type */
  scheduleType: CronScheduleType;
  /**
   * Schedule expression:
   * - cron: standard cron expression (e.g. "0 9 * * *")
   * - interval: milliseconds (e.g. "3600000" for 1 hour)
   * - once: ISO date string (e.g. "2026-03-26T10:00:00Z")
   */
  schedule: string;
  /** Whether the job is active */
  enabled: boolean;
  /** Last time this job was executed */
  lastRunAt: string | null;
  /** Next scheduled execution time */
  nextRunAt: string | null;
  /** Number of times this job has executed */
  runCount: number;
  /** Maximum number of runs (0 = unlimited) */
  maxRuns: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobParams {
  name: string;
  task: string;
  scheduleType: CronScheduleType;
  schedule: string;
  maxRuns?: number;
}
