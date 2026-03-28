import { ConfigService } from '@nestjs/config';

import { CronJobRepository } from './cron-job.repository';
import { CronSchedulerService } from './cron-scheduler.service';
import type { CreateCronJobParams, CronJob } from './cron-job.types';

const createConfigService = (): ConfigService => ({
  get: jest.fn((_: string, defaultValue?: unknown) => defaultValue),
}) as unknown as ConfigService;

const buildJob = (params: CreateCronJobParams): CronJob => {
  const now = new Date().toISOString();

  return {
    id: 'job-1',
    name: params.name,
    task: params.task,
    scheduleType: params.scheduleType,
    schedule: params.schedule,
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    maxRuns: params.maxRuns ?? 0,
    createdAt: now,
    updatedAt: now,
  };
};

const createRepository = () => {
  let storedJob: CronJob | undefined;

  return {
    create: jest.fn(async (params: CreateCronJobParams) => {
      storedJob = buildJob(params);
      return storedJob;
    }),
    findAll: jest.fn(async () => (storedJob ? [storedJob] : [])),
    delete: jest.fn(async () => true),
    findById: jest.fn(async (id: string) => (storedJob?.id === id ? storedJob : undefined)),
    findDue: jest.fn(async () => []),
    findEnabled: jest.fn(async () => (storedJob?.enabled ? [storedJob] : [])),
    update: jest.fn(async (id: string, patch: Partial<CronJob>) => {
      if (storedJob?.id === id) {
        storedJob = {
          ...storedJob,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
      }
      return storedJob;
    }),
  };
};

describe('CronSchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects invalid or unschedulable schedules before persisting a job', async () => {
    const repository = createRepository();
    const service = new CronSchedulerService(
      repository as unknown as CronJobRepository,
      createConfigService(),
    );

    await expect(
      service.createJob({
        name: 'bad-once-job',
        task: 'test',
        scheduleType: 'once',
        schedule: 'not-a-date',
      }),
    ).rejects.toThrow('Invalid or unschedulable once schedule');

    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('computes future monthly cron occurrences beyond the old 48-hour horizon', async () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    const repository = createRepository();
    const service = new CronSchedulerService(
      repository as unknown as CronJobRepository,
      createConfigService(),
    );

    const job = await service.createJob({
      name: 'monthly-job',
      task: 'test',
      scheduleType: 'cron',
      schedule: '0 0 1 * *',
    });

    expect(job.nextRunAt).not.toBeNull();
    const diffMs = Date.parse(job.nextRunAt ?? '') - now.getTime();
    expect(diffMs).toBeGreaterThan(10 * 24 * 60 * 60 * 1000);
    expect(diffMs).toBeLessThan(40 * 24 * 60 * 60 * 1000);
  });

  it('uses standard cron day-of-month/day-of-week OR semantics', async () => {
    const now = new Date('2026-03-15T10:37:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    const repository = createRepository();
    const service = new CronSchedulerService(
      repository as unknown as CronJobRepository,
      createConfigService(),
    );

    const schedule = `${now.getMinutes()} ${now.getHours()} ${now.getDate()} * ${(now.getDay() + 1) % 7}`;
    const job = await service.createJob({
      name: 'dom-dow-or-job',
      task: 'test',
      scheduleType: 'cron',
      schedule,
    });

    expect(job.nextRunAt).not.toBeNull();
    const diffMs = Date.parse(job.nextRunAt ?? '') - now.getTime();
    expect(diffMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diffMs).toBeLessThan(25 * 60 * 60 * 1000);
  });
});
