import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

interface SettingsRow {
  key: string;
  value: string;
  encrypted: number;
  updated_at: string;
}

export interface SettingsEntry {
  key: string;
  value: string;
  encrypted: boolean;
  updatedAt: string;
}

@Injectable()
export class SettingsRepository implements OnModuleInit {
  private readonly logger = new Logger(SettingsRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  async get(key: string): Promise<SettingsEntry | null> {
    const db = this.getDatabase();
    const stmt = db.prepare('SELECT key, value, encrypted, updated_at FROM settings WHERE key = ?');
    const row = stmt.get(key) as SettingsRow | undefined;
    if (!row) return null;
    return this.toEntry(row);
  }

  async getAll(): Promise<SettingsEntry[]> {
    const db = this.getDatabase();
    const stmt = db.prepare('SELECT key, value, encrypted, updated_at FROM settings ORDER BY key');
    const rows = stmt.all() as unknown as SettingsRow[];
    return rows.map((r) => this.toEntry(r));
  }

  async getByPrefix(prefix: string): Promise<SettingsEntry[]> {
    const db = this.getDatabase();
    const stmt = db.prepare('SELECT key, value, encrypted, updated_at FROM settings WHERE key LIKE ? ORDER BY key');
    const rows = stmt.all(`${prefix}%`) as unknown as SettingsRow[];
    return rows.map((r) => this.toEntry(r));
  }

  async set(key: string, value: string, encrypted: boolean): Promise<void> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO settings (key, value, encrypted, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
    );
    stmt.run(key, value, encrypted ? 1 : 0, now);
  }

  async delete(key: string): Promise<boolean> {
    const db = this.getDatabase();
    const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  private toEntry(row: SettingsRow): SettingsEntry {
    return {
      key: row.key,
      value: row.value,
      encrypted: row.encrypted === 1,
      updatedAt: row.updated_at,
    };
  }

  private getDatabase(): DatabaseSync {
    if (this.database) return this.database;

    const dbPath = this.getDbFilePath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const database = new DatabaseSync(dbPath);
    database.exec('PRAGMA journal_mode = WAL');

    database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);

    this.database = database;
    this.logger.log('SQLite settings table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
