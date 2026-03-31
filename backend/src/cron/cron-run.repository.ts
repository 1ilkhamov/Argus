import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { CreateCronJobRunParams, CronJobRun, ListCronJobRunsParams, UpdateCronJobRunParams } from './cron-run.types';

interface CronJobRunRow {
  id: string;
  job_id: string;
  job_name: string;
  schedule_type: string;
  schedule: string;
  attempt: number;
  scheduled_for: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  result_status: string;
  notification_status: string;
  output_preview: string | null;
  error_message: string | null;
  notification_error_message: string | null;
  tool_rounds_used: number;
  tool_names_json: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CronJobRunRepository implements OnModuleInit {
  private readonly logger = new Logger(CronJobRunRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  async create(params: CreateCronJobRunParams): Promise<CronJobRun> {
    const db = this.getDatabase();
    const now = params.startedAt;
    const run: CronJobRun = {
      id: randomUUID(),
      jobId: params.jobId,
      jobName: params.jobName,
      scheduleType: params.scheduleType,
      schedule: params.schedule,
      attempt: params.attempt,
      scheduledFor: params.scheduledFor ?? null,
      startedAt: params.startedAt,
      finishedAt: null,
      status: 'running',
      resultStatus: 'running',
      notificationStatus: 'pending',
      outputPreview: null,
      errorMessage: null,
      notificationErrorMessage: null,
      toolRoundsUsed: 0,
      toolNames: [],
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      `INSERT INTO cron_job_runs (
        id, job_id, job_name, schedule_type, schedule, attempt, scheduled_for,
        started_at, finished_at, status, result_status, notification_status,
        output_preview, error_message, notification_error_message,
        tool_rounds_used, tool_names_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.jobId,
      run.jobName,
      run.scheduleType,
      run.schedule,
      run.attempt,
      run.scheduledFor,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.resultStatus,
      run.notificationStatus,
      run.outputPreview,
      run.errorMessage,
      run.notificationErrorMessage,
      run.toolRoundsUsed,
      JSON.stringify(run.toolNames),
      run.createdAt,
      run.updatedAt,
    );

    return run;
  }

  async update(id: string, updates: UpdateCronJobRunParams): Promise<void> {
    const db = this.getDatabase();
    const sets: string[] = [];
    const values: SQLInputValue[] = [];

    if (updates.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      values.push(updates.finishedAt);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.resultStatus !== undefined) {
      sets.push('result_status = ?');
      values.push(updates.resultStatus);
    }
    if (updates.notificationStatus !== undefined) {
      sets.push('notification_status = ?');
      values.push(updates.notificationStatus);
    }
    if (updates.outputPreview !== undefined) {
      sets.push('output_preview = ?');
      values.push(updates.outputPreview);
    }
    if (updates.errorMessage !== undefined) {
      sets.push('error_message = ?');
      values.push(updates.errorMessage);
    }
    if (updates.notificationErrorMessage !== undefined) {
      sets.push('notification_error_message = ?');
      values.push(updates.notificationErrorMessage);
    }
    if (updates.toolRoundsUsed !== undefined) {
      sets.push('tool_rounds_used = ?');
      values.push(updates.toolRoundsUsed);
    }
    if (updates.toolNames !== undefined) {
      sets.push('tool_names_json = ?');
      values.push(JSON.stringify(updates.toolNames));
    }

    if (!sets.length) {
      return;
    }

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE cron_job_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  async findRecent(params: ListCronJobRunsParams = {}): Promise<CronJobRun[]> {
    const db = this.getDatabase();
    const limit = Math.max(1, Math.min(params.limit ?? 20, 50));
    const values: SQLInputValue[] = [];
    const where: string[] = [];

    if (params.jobId) {
      where.push('job_id = ?');
      values.push(params.jobId);
    }

    values.push(limit);
    const query = [
      'SELECT * FROM cron_job_runs',
      where.length ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY started_at DESC',
      'LIMIT ?',
    ].filter(Boolean).join(' ');

    const rows = db.prepare(query).all(...values) as unknown as CronJobRunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  private getDatabase(): DatabaseSync {
    if (this.database) {
      return this.database;
    }

    const dbPath = this.getDbFilePath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const database = new DatabaseSync(dbPath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`
      CREATE TABLE IF NOT EXISTS cron_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        job_name TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        scheduled_for TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        result_status TEXT NOT NULL DEFAULT 'running',
        notification_status TEXT NOT NULL DEFAULT 'pending',
        output_preview TEXT,
        error_message TEXT,
        notification_error_message TEXT,
        tool_rounds_used INTEGER NOT NULL DEFAULT 0,
        tool_names_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    try {
      database.exec(`ALTER TABLE cron_job_runs ADD COLUMN result_status TEXT NOT NULL DEFAULT 'running'`);
      this.logger.log('Migrated cron_job_runs: added result_status column');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
    try {
      database.exec(`ALTER TABLE cron_job_runs ADD COLUMN notification_status TEXT NOT NULL DEFAULT 'pending'`);
      this.logger.log('Migrated cron_job_runs: added notification_status column');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
    try {
      database.exec(`ALTER TABLE cron_job_runs ADD COLUMN notification_error_message TEXT`);
      this.logger.log('Migrated cron_job_runs: added notification_error_message column');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
    database.exec(`UPDATE cron_job_runs SET status = 'notified', result_status = 'success', notification_status = 'sent' WHERE status = 'succeeded'`);
    database.exec(`UPDATE cron_job_runs SET status = 'canceled', result_status = 'canceled', notification_status = 'skipped' WHERE status = 'dropped'`);
    database.exec(`UPDATE cron_job_runs SET result_status = 'running', notification_status = 'pending' WHERE status = 'running'`);
    database.exec(`UPDATE cron_job_runs SET result_status = 'noop', notification_status = 'skipped' WHERE status = 'noop' AND notification_status = 'pending'`);
    database.exec(`UPDATE cron_job_runs SET result_status = 'success', notification_status = 'skipped' WHERE status = 'success' AND notification_status = 'pending'`);
    database.exec(`UPDATE cron_job_runs SET result_status = 'success', notification_status = 'sent' WHERE status = 'notified' AND notification_status = 'pending'`);
    database.exec(`UPDATE cron_job_runs SET result_status = 'failed', notification_status = 'failed' WHERE status = 'failed' AND notification_status = 'pending'`);
    database.exec(`UPDATE cron_job_runs SET result_status = 'canceled', notification_status = 'skipped' WHERE status = 'canceled' AND notification_status = 'pending'`);
    database.exec('CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job_id ON cron_job_runs (job_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_cron_job_runs_started_at ON cron_job_runs (started_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_cron_job_runs_status ON cron_job_runs (status)');

    this.database = database;
    this.logger.log('SQLite cron_job_runs table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToRun(row: CronJobRunRow): CronJobRun {
    let toolNames: string[] = [];
    try {
      const parsed = JSON.parse(row.tool_names_json) as unknown;
      if (Array.isArray(parsed)) {
        toolNames = parsed.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      toolNames = [];
    }

    return {
      id: row.id,
      jobId: row.job_id,
      jobName: row.job_name,
      scheduleType: row.schedule_type as CronJobRun['scheduleType'],
      schedule: row.schedule,
      attempt: row.attempt,
      scheduledFor: row.scheduled_for,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status as CronJobRun['status'],
      resultStatus: row.result_status as CronJobRun['resultStatus'],
      notificationStatus: row.notification_status as CronJobRun['notificationStatus'],
      outputPreview: row.output_preview,
      errorMessage: row.error_message,
      notificationErrorMessage: row.notification_error_message,
      toolRoundsUsed: row.tool_rounds_used,
      toolNames,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
