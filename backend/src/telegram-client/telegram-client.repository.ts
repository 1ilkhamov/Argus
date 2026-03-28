import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';

import type {
  TgMonitoredChat,
  TgChatMode,
  TgChatType,
  CreateMonitoredChatParams,
  UpdateMonitoredChatParams,
} from './telegram-client.types';

interface ChatRow {
  id: string;
  chat_id: string;
  chat_title: string;
  chat_type: string;
  mode: string;
  cooldown_seconds: number;
  system_note: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TelegramClientRepository implements OnModuleInit {
  private readonly logger = new Logger(TelegramClientRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  // ─── Create ──────────────────────────────────────────────────────────────

  async create(params: CreateMonitoredChatParams): Promise<TgMonitoredChat> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const chat: TgMonitoredChat = {
      id: randomUUID(),
      chatId: params.chatId,
      chatTitle: params.chatTitle,
      chatType: params.chatType ?? 'unknown',
      mode: params.mode ?? 'auto',
      cooldownSeconds: params.cooldownSeconds ?? 30,
      systemNote: params.systemNote ?? '',
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      `INSERT INTO tg_client_chats (id, chat_id, chat_title, chat_type, mode, cooldown_seconds, system_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chat.id, chat.chatId, chat.chatTitle, chat.chatType, chat.mode,
      chat.cooldownSeconds, chat.systemNote, chat.createdAt, chat.updatedAt,
    );

    this.logger.debug(`Monitored chat added: ${chat.chatId} "${chat.chatTitle}" (${chat.mode})`);
    return chat;
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<TgMonitoredChat | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM tg_client_chats WHERE id = ?').get(id) as ChatRow | undefined;
    return row ? this.rowToChat(row) : undefined;
  }

  async findByChatId(chatId: string): Promise<TgMonitoredChat | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM tg_client_chats WHERE chat_id = ?').get(chatId) as ChatRow | undefined;
    return row ? this.rowToChat(row) : undefined;
  }

  async findAll(): Promise<TgMonitoredChat[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM tg_client_chats ORDER BY created_at DESC').all() as unknown as ChatRow[];
    return rows.map((r) => this.rowToChat(r));
  }

  async findActive(): Promise<TgMonitoredChat[]> {
    const db = this.getDatabase();
    const rows = db.prepare(
      `SELECT * FROM tg_client_chats WHERE mode != 'disabled' ORDER BY created_at DESC`,
    ).all() as unknown as ChatRow[];
    return rows.map((r) => this.rowToChat(r));
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  async update(id: string, updates: UpdateMonitoredChatParams): Promise<void> {
    const db = this.getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.chatTitle !== undefined) { sets.push('chat_title = ?'); values.push(updates.chatTitle); }
    if (updates.chatType !== undefined) { sets.push('chat_type = ?'); values.push(updates.chatType); }
    if (updates.mode !== undefined) { sets.push('mode = ?'); values.push(updates.mode); }
    if (updates.cooldownSeconds !== undefined) { sets.push('cooldown_seconds = ?'); values.push(updates.cooldownSeconds); }
    if (updates.systemNote !== undefined) { sets.push('system_note = ?'); values.push(updates.systemNote); }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE tg_client_chats SET ${sets.join(', ')} WHERE id = ?`).run(...values as [string]);
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const db = this.getDatabase();
    const result = db.prepare('DELETE FROM tg_client_chats WHERE id = ?').run(id);
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
      CREATE TABLE IF NOT EXISTS tg_client_chats (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        chat_title TEXT NOT NULL DEFAULT '',
        chat_type TEXT NOT NULL DEFAULT 'unknown',
        mode TEXT NOT NULL DEFAULT 'auto',
        cooldown_seconds INTEGER NOT NULL DEFAULT 30,
        system_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_chat_id ON tg_client_chats (chat_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_chat_mode ON tg_client_chats (mode)');

    // Migration: add chat_type column for existing databases
    try {
      database.exec(`ALTER TABLE tg_client_chats ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'unknown'`);
      this.logger.log('Migrated tg_client_chats: added chat_type column');
    } catch {
      // Column already exists — expected on fresh databases
    }

    this.database = database;
    this.logger.log('SQLite tg_client_chats table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToChat(row: ChatRow): TgMonitoredChat {
    return {
      id: row.id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      chatType: (row.chat_type || 'unknown') as TgChatType,
      mode: row.mode as TgChatMode,
      cooldownSeconds: row.cooldown_seconds,
      systemNote: row.system_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
