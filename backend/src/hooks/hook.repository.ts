import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';

import type {
  WebhookHook,
  CreateHookParams,
  UpdateHookParams,
  HookMethod,
  HookStatus,
} from './hook.types';

interface HookRow {
  id: string;
  name: string;
  description: string;
  prompt_template: string;
  secret: string;
  methods: string;
  status: string;
  notify_on_fire: number;
  max_payload_bytes: number;
  fire_count: number;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 102_400; // 100KB

@Injectable()
export class HookRepository implements OnModuleInit {
  private readonly logger = new Logger(HookRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  // ─── Create ──────────────────────────────────────────────────────────────

  async create(params: CreateHookParams): Promise<WebhookHook> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const hook: WebhookHook = {
      id: randomUUID(),
      name: params.name,
      description: params.description ?? '',
      promptTemplate: params.promptTemplate,
      secret: params.secret,
      methods: params.methods ?? ['POST'],
      status: 'active',
      notifyOnFire: params.notifyOnFire ?? true,
      maxPayloadBytes: params.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      fireCount: 0,
      lastFiredAt: null,
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      `INSERT INTO hooks (id, name, description, prompt_template, secret, methods, status, notify_on_fire, max_payload_bytes, fire_count, last_fired_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hook.id, hook.name, hook.description, hook.promptTemplate,
      hook.secret, JSON.stringify(hook.methods), hook.status,
      hook.notifyOnFire ? 1 : 0, hook.maxPayloadBytes,
      hook.fireCount, hook.lastFiredAt, hook.createdAt, hook.updatedAt,
    );

    this.logger.debug(`Created hook: ${hook.id} "${hook.name}"`);
    return hook;
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<WebhookHook | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM hooks WHERE id = ?').get(id) as HookRow | undefined;
    return row ? this.rowToHook(row) : undefined;
  }

  async findByName(name: string): Promise<WebhookHook | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM hooks WHERE name = ?').get(name) as HookRow | undefined;
    return row ? this.rowToHook(row) : undefined;
  }

  async findAll(): Promise<WebhookHook[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM hooks ORDER BY created_at DESC').all() as unknown as HookRow[];
    return rows.map((r) => this.rowToHook(r));
  }

  async findActive(): Promise<WebhookHook[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM hooks WHERE status = ? ORDER BY name ASC').all('active') as unknown as HookRow[];
    return rows.map((r) => this.rowToHook(r));
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  async update(id: string, updates: UpdateHookParams): Promise<void> {
    const db = this.getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
    if (updates.promptTemplate !== undefined) { sets.push('prompt_template = ?'); values.push(updates.promptTemplate); }
    if (updates.secret !== undefined) { sets.push('secret = ?'); values.push(updates.secret); }
    if (updates.methods !== undefined) { sets.push('methods = ?'); values.push(JSON.stringify(updates.methods)); }
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.notifyOnFire !== undefined) { sets.push('notify_on_fire = ?'); values.push(updates.notifyOnFire ? 1 : 0); }
    if (updates.maxPayloadBytes !== undefined) { sets.push('max_payload_bytes = ?'); values.push(updates.maxPayloadBytes); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE hooks SET ${sets.join(', ')} WHERE id = ?`).run(...values as [string]);
  }

  async recordFire(id: string): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE hooks SET fire_count = fire_count + 1, last_fired_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, id);
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const db = this.getDatabase();
    const result = db.prepare('DELETE FROM hooks WHERE id = ?').run(id);
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
      CREATE TABLE IF NOT EXISTS hooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        prompt_template TEXT NOT NULL,
        secret TEXT NOT NULL,
        methods TEXT NOT NULL DEFAULT '["POST"]',
        status TEXT NOT NULL DEFAULT 'active',
        notify_on_fire INTEGER NOT NULL DEFAULT 1,
        max_payload_bytes INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_PAYLOAD_BYTES},
        fire_count INTEGER NOT NULL DEFAULT 0,
        last_fired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_hooks_name ON hooks (name)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_hooks_status ON hooks (status)');

    this.database = database;
    this.logger.log('SQLite hooks table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToHook(row: HookRow): WebhookHook {
    let methods: HookMethod[];
    try {
      methods = JSON.parse(row.methods) as HookMethod[];
    } catch {
      methods = ['POST'];
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      promptTemplate: row.prompt_template,
      secret: row.secret,
      methods,
      status: row.status as HookStatus,
      notifyOnFire: row.notify_on_fire === 1,
      maxPayloadBytes: row.max_payload_bytes,
      fireCount: row.fire_count,
      lastFiredAt: row.last_fired_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
