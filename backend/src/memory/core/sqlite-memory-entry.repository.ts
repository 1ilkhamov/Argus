import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { MemoryEntryRepository } from './memory-entry.repository';
import type {
  MemoryEntry,
  MemoryHorizon,
  MemoryKind,
  MemoryProvenance,
  MemoryQuery,
  MemorySource,
} from './memory-entry.types';

interface MemoryEntryRow {
  id: string;
  scope_key: string;
  kind: string;
  category: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  provenance_json: string | null;
  horizon: string;
  importance: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
  superseded_by: string | null;
  consolidated_from_json: string | null;
  embedding_id: string | null;
}

@Injectable()
export class SqliteMemoryEntryRepository extends MemoryEntryRepository implements OnModuleInit {
  private readonly logger = new Logger(SqliteMemoryEntryRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  onModuleInit(): void {
    const storageDriver = this.configService.get<string>('storage.driver', 'sqlite');
    if (storageDriver !== 'sqlite') {
      return;
    }

    this.getDatabase();
  }

  // ─── Save ───────────────────────────────────────────────────────────────

  async save(entry: MemoryEntry): Promise<void> {
    const db = this.getDatabase();
    db.prepare(
      `INSERT OR REPLACE INTO memory_entries (
        id, scope_key, kind, category, content, summary, tags_json,
        source, provenance_json, horizon, importance, decay_rate,
        access_count, last_accessed_at, created_at, updated_at,
        pinned, superseded_by, consolidated_from_json, embedding_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...(this.entryToParams(entry) as SQLInputValue[]));
  }

  async saveBatch(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const db = this.getDatabase();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO memory_entries (
        id, scope_key, kind, category, content, summary, tags_json,
        source, provenance_json, horizon, importance, decay_rate,
        access_count, last_accessed_at, created_at, updated_at,
        pinned, superseded_by, consolidated_from_json, embedding_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        stmt.run(...(this.entryToParams(entry) as SQLInputValue[]));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  async findById(id: string): Promise<MemoryEntry | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as MemoryEntryRow | undefined;
    return row ? this.rowToEntry(row) : undefined;
  }

  async findByIds(ids: string[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    const db = this.getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM memory_entries WHERE id IN (${placeholders})`).all(...ids) as unknown as MemoryEntryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const { sql, params } = this.buildQuerySql(query, false);
    const db = this.getDatabase();
    const rows = db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as MemoryEntryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async count(query: MemoryQuery): Promise<number> {
    const { sql, params } = this.buildQuerySql(query, true);
    const db = this.getDatabase();
    const result = db.prepare(sql).get(...(params as SQLInputValue[])) as unknown as { count: number } | undefined;
    return result?.count ?? 0;
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const db = this.getDatabase();
    const result = db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    return (result as { changes: number }).changes > 0;
  }

  async deleteBatch(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const db = this.getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM memory_entries WHERE id IN (${placeholders})`).run(...ids);
    return (result as { changes: number }).changes;
  }

  // ─── Access tracking ──────────────────────────────────────────────────

  async incrementAccessCount(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memory_entries
       SET access_count = access_count + 1,
           last_accessed_at = ?
       WHERE id IN (${placeholders})`,
    ).run(now, ...ids);
  }

  // ─── Query builder ─────────────────────────────────────────────────────

  private buildQuerySql(
    query: MemoryQuery,
    countOnly: boolean,
  ): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.scopeKey !== undefined) {
      conditions.push('scope_key = ?');
      params.push(query.scopeKey);
    }

    if (query.kinds && query.kinds.length > 0) {
      const placeholders = query.kinds.map(() => '?').join(',');
      conditions.push(`kind IN (${placeholders})`);
      params.push(...query.kinds);
    }

    if (query.horizons && query.horizons.length > 0) {
      const placeholders = query.horizons.map(() => '?').join(',');
      conditions.push(`horizon IN (${placeholders})`);
      params.push(...query.horizons);
    }

    if (query.sources && query.sources.length > 0) {
      const placeholders = query.sources.map(() => '?').join(',');
      conditions.push(`source IN (${placeholders})`);
      params.push(...query.sources);
    }

    if (query.category !== undefined) {
      conditions.push('category = ?');
      params.push(query.category);
    }

    if (query.minImportance !== undefined) {
      conditions.push('importance >= ?');
      params.push(query.minImportance);
    }

    if (query.pinned !== undefined) {
      conditions.push('pinned = ?');
      params.push(query.pinned ? 1 : 0);
    }

    if (query.excludeSuperseded) {
      conditions.push('superseded_by IS NULL');
    }

    if (query.tags && query.tags.length > 0) {
      for (const tag of query.tags) {
        conditions.push(`tags_json LIKE ?`);
        params.push(`%"${tag}"%`);
      }
    }

    if (query.tagsAny && query.tagsAny.length > 0) {
      const tagConditions = query.tagsAny.map(() => `tags_json LIKE ?`);
      conditions.push(`(${tagConditions.join(' OR ')})`);
      for (const tag of query.tagsAny) {
        params.push(`%"${tag}"%`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (countOnly) {
      return { sql: `SELECT COUNT(*) AS count FROM memory_entries ${where}`, params };
    }

    const orderCol = this.resolveOrderColumn(query.orderBy);
    const orderDir = query.orderDirection === 'asc' ? 'ASC' : 'DESC';
    const order = `ORDER BY ${orderCol} ${orderDir}`;

    const limit = query.limit ? `LIMIT ${query.limit}` : '';
    const offset = query.offset ? `OFFSET ${query.offset}` : '';

    return {
      sql: `SELECT * FROM memory_entries ${where} ${order} ${limit} ${offset}`,
      params,
    };
  }

  private resolveOrderColumn(orderBy?: MemoryQuery['orderBy']): string {
    switch (orderBy) {
      case 'importance':
        return 'importance';
      case 'createdAt':
        return 'created_at';
      case 'accessCount':
        return 'access_count';
      case 'updatedAt':
      default:
        return 'updated_at';
    }
  }

  // ─── Mapping ──────────────────────────────────────────────────────────

  private rowToEntry(row: MemoryEntryRow): MemoryEntry {
    return {
      id: row.id,
      scopeKey: row.scope_key ?? 'local:default',
      kind: row.kind as MemoryKind,
      category: row.category ?? undefined,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: this.parseJsonArray(row.tags_json),
      source: row.source as MemorySource,
      provenance: this.parseJson<MemoryProvenance>(row.provenance_json),
      horizon: row.horizon as MemoryHorizon,
      importance: Number(row.importance),
      decayRate: Number(row.decay_rate),
      accessCount: Number(row.access_count),
      lastAccessedAt: row.last_accessed_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pinned: row.pinned === 1,
      supersededBy: row.superseded_by ?? undefined,
      consolidatedFrom: this.parseJsonArray(row.consolidated_from_json) as string[] | undefined,
      embeddingId: row.embedding_id ?? undefined,
    };
  }

  private entryToParams(entry: MemoryEntry): unknown[] {
    return [
      entry.id,
      entry.scopeKey ?? 'local:default',
      entry.kind,
      entry.category ?? null,
      entry.content,
      entry.summary ?? null,
      JSON.stringify(entry.tags),
      entry.source,
      entry.provenance ? JSON.stringify(entry.provenance) : null,
      entry.horizon,
      entry.importance,
      entry.decayRate,
      entry.accessCount,
      entry.lastAccessedAt ?? null,
      entry.createdAt,
      entry.updatedAt,
      entry.pinned ? 1 : 0,
      entry.supersededBy ?? null,
      entry.consolidatedFrom ? JSON.stringify(entry.consolidatedFrom) : null,
      entry.embeddingId ?? null,
    ];
  }

  private parseJson<T>(value: string | null | undefined): T | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  private parseJsonArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ─── Database initialization ──────────────────────────────────────────

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
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'local:default',
        kind TEXT NOT NULL,
        category TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        tags_json TEXT DEFAULT '[]',
        source TEXT NOT NULL,
        provenance_json TEXT,
        horizon TEXT NOT NULL DEFAULT 'short_term',
        importance REAL NOT NULL DEFAULT 0.5,
        decay_rate REAL NOT NULL DEFAULT 0.05,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        consolidated_from_json TEXT,
        embedding_id TEXT
      )
    `);

    // Migration: add scope_key column to existing tables
    try {
      database.exec(`ALTER TABLE memory_entries ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'local:default'`);
    } catch {
      // Column already exists — expected on subsequent runs
    }

    database.exec('CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_entries (kind)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_memory_horizon ON memory_entries (horizon)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_entries (importance)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_entries (pinned)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_entries (updated_at)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_memory_scope_key ON memory_entries (scope_key)');

    this.database = database;
    this.logger.log('SQLite memory_entries table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
