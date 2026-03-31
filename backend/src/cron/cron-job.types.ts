/** Supported schedule types */
export const CRON_SCHEDULE_TYPES = ['cron', 'interval', 'once'] as const;
export type CronScheduleType = (typeof CRON_SCHEDULE_TYPES)[number];

export const CRON_JOB_NOTIFICATION_POLICIES = ['always', 'never'] as const;
export type CronJobNotificationPolicy = (typeof CRON_JOB_NOTIFICATION_POLICIES)[number];

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
  notificationPolicy: CronJobNotificationPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobParams {
  name: string;
  task: string;
  scheduleType: CronScheduleType;
  schedule: string;
  maxRuns?: number;
  notificationPolicy?: CronJobNotificationPolicy;
}

export interface UpdateCronJobParams {
  name?: string;
  task?: string;
  scheduleType?: CronScheduleType;
  schedule?: string;
  maxRuns?: number;
  notificationPolicy?: CronJobNotificationPolicy;
  enabled?: boolean;
}
