import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

import type { CronJob, CreateCronJobParams } from './cron-job.types';
import { randomUUID } from 'crypto';

interface CronJobRow {
  id: string;
  name: string;
  task: string;
  schedule_type: string;
  schedule: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  max_runs: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CronJobRepository implements OnModuleInit {
  private readonly logger = new Logger(CronJobRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  // ─── Create ──────────────────────────────────────────────────────────────

  async create(params: CreateCronJobParams): Promise<CronJob> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const job: CronJob = {
      id: randomUUID(),
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

    db.prepare(
      `INSERT INTO cron_jobs (id, name, task, schedule_type, schedule, enabled, last_run_at, next_run_at, run_count, max_runs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id, job.name, job.task, job.scheduleType, job.schedule,
      job.enabled ? 1 : 0, job.lastRunAt, job.nextRunAt,
      job.runCount, job.maxRuns, job.createdAt, job.updatedAt,
    );

    this.logger.debug(`Created cron job: ${job.id} "${job.name}"`);
    return job;
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<CronJob | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined;
    return row ? this.rowToJob(row) : undefined;
  }

  async findAll(): Promise<CronJob[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as unknown as CronJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  async findEnabled(): Promise<CronJob[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run_at ASC').all() as unknown as CronJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  async findDue(now: string): Promise<CronJob[]> {
    const db = this.getDatabase();
    const rows = db.prepare(
      `SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    ).all(now) as unknown as CronJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  async update(id: string, updates: Partial<Pick<CronJob, 'enabled' | 'lastRunAt' | 'nextRunAt' | 'runCount' | 'name' | 'task' | 'schedule' | 'scheduleType' | 'maxRuns'>>): Promise<void> {
    const db = this.getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.enabled !== undefined) { sets.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.lastRunAt !== undefined) { sets.push('last_run_at = ?'); values.push(updates.lastRunAt); }
    if (updates.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(updates.nextRunAt); }
    if (updates.runCount !== undefined) { sets.push('run_count = ?'); values.push(updates.runCount); }
    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.task !== undefined) { sets.push('task = ?'); values.push(updates.task); }
    if (updates.schedule !== undefined) { sets.push('schedule = ?'); values.push(updates.schedule); }
    if (updates.scheduleType !== undefined) { sets.push('schedule_type = ?'); values.push(updates.scheduleType); }
    if (updates.maxRuns !== undefined) { sets.push('max_runs = ?'); values.push(updates.maxRuns); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values as [string]);
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const db = this.getDatabase();
    const result = db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
    return (result as unknown as { changes: number }).changes > 0;
  }

  // ─── Database ────────────────────────────────────────────────────────────

  private getDatabase(): DatabaseSync {
    if (this.database) return this.database;

    const dbPath = this.getDbFilePath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const database = new DatabaseSync(dbPath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');

    database.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        schedule_type TEXT NOT NULL DEFAULT 'cron',
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        max_runs INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    database.exec('CREATE INDEX IF NOT EXISTS idx_cron_enabled ON cron_jobs (enabled)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_cron_next_run ON cron_jobs (next_run_at)');

    this.database = database;
    this.logger.log('SQLite cron_jobs table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToJob(row: CronJobRow): CronJob {
    return {
      id: row.id,
      name: row.name,
      task: row.task,
      scheduleType: row.schedule_type as CronJob['scheduleType'],
      schedule: row.schedule,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      runCount: row.run_count,
      maxRuns: row.max_runs,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
