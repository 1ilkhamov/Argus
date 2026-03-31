import type { CronScheduleType } from './cron-job.types';

export const CRON_JOB_RUN_RESULT_STATUSES = ['running', 'success', 'noop', 'failed', 'canceled'] as const;
export type CronJobRunResultStatus = (typeof CRON_JOB_RUN_RESULT_STATUSES)[number];

export const CRON_JOB_RUN_NOTIFICATION_STATUSES = ['pending', 'sent', 'skipped', 'failed'] as const;
export type CronJobRunNotificationStatus = (typeof CRON_JOB_RUN_NOTIFICATION_STATUSES)[number];

export const CRON_JOB_RUN_STATUSES = ['running', 'success', 'noop', 'notified', 'failed', 'canceled'] as const;
export type CronJobRunStatus = (typeof CRON_JOB_RUN_STATUSES)[number];

export interface CronJobRun {
  id: string;
  jobId: string;
  jobName: string;
  scheduleType: CronScheduleType;
  schedule: string;
  attempt: number;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: CronJobRunStatus;
  resultStatus: CronJobRunResultStatus;
  notificationStatus: CronJobRunNotificationStatus;
  outputPreview: string | null;
  errorMessage: string | null;
  notificationErrorMessage: string | null;
  toolRoundsUsed: number;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobRunParams {
  jobId: string;
  jobName: string;
  scheduleType: CronScheduleType;
  schedule: string;
  attempt: number;
  scheduledFor?: string | null;
  startedAt: string;
}

export interface UpdateCronJobRunParams {
  finishedAt?: string | null;
  status?: CronJobRunStatus;
  resultStatus?: CronJobRunResultStatus;
  notificationStatus?: CronJobRunNotificationStatus;
  outputPreview?: string | null;
  errorMessage?: string | null;
  notificationErrorMessage?: string | null;
  toolRoundsUsed?: number;
  toolNames?: string[];
}

export interface ListCronJobRunsParams {
  jobId?: string;
  limit?: number;
}

export interface CronJobFireContext {
  runId: string;
  attempt: number;
  scheduledFor: string | null;
  startedAt: string;
}
