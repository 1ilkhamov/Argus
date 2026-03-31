import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import {
  PENDING_TTL_MS,
  type PendingNotify,
  type PendingNotifyAwaitingReplyRecord,
  type PendingNotifyMessageRecord,
  type PendingNotifyRouteRecord,
  type PendingNotifyRouteStatus,
} from './pending-notify.types';

interface PendingNotifyMessageRow {
  bot_message_id: number;
  chat_id: string;
  chat_title: string;
  question: string;
  created_at: number;
  expires_at: number;
}

interface PendingNotifyAwaitingReplyRow {
  bot_chat_id: number;
  source_bot_message_id: number | null;
  chat_id: string;
  chat_title: string;
  question: string;
  created_at: number;
  expires_at: number;
}

interface PendingNotifyRouteRow {
  id: string;
  bot_chat_id: number;
  source_bot_message_id: number | null;
  chat_id: string;
  chat_title: string;
  question: string;
  reply_text: string | null;
  route_status: string;
  correlation_id: string | null;
  created_at: number;
  completed_at: number;
}

interface PendingNotifyRow {
  chat_id: string;
  chat_title: string;
  question: string;
  created_at: number;
  expires_at: number;
  source_bot_message_id?: number | null;
}

@Injectable()
export class PendingNotifyRepository implements OnModuleInit {
  private readonly logger = new Logger(PendingNotifyRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  setPending(botMessageId: number, info: PendingNotify): void {
    this.cleanupExpired();
    const db = this.getDatabase();
    db.prepare(
      `INSERT INTO pending_notify_messages (
        bot_message_id, chat_id, chat_title, question, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_message_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        chat_title = excluded.chat_title,
        question = excluded.question,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at`,
    ).run(
      botMessageId,
      info.chatId,
      info.chatTitle,
      info.question,
      info.createdAt,
      info.createdAt + PENDING_TTL_MS,
    );
  }

  getPending(botMessageId: number): PendingNotify | undefined {
    this.cleanupExpired();
    const db = this.getDatabase();
    const row = db.prepare(
      'SELECT chat_id, chat_title, question, created_at, expires_at FROM pending_notify_messages WHERE bot_message_id = ?',
    ).get(botMessageId) as PendingNotifyRow | undefined;
    return row ? this.rowToPending(row) : undefined;
  }

  listPending(limit: number = 50): PendingNotifyMessageRecord[] {
    this.cleanupExpired();
    const db = this.getDatabase();
    const rows = db.prepare(
      'SELECT bot_message_id, chat_id, chat_title, question, created_at, expires_at FROM pending_notify_messages ORDER BY created_at DESC LIMIT ?',
    ).all(this.normalizeLimit(limit)) as unknown as PendingNotifyMessageRow[];
    return rows.map((row) => this.rowToPendingMessage(row));
  }

  deletePending(botMessageId: number): void {
    const db = this.getDatabase();
    db.prepare('DELETE FROM pending_notify_messages WHERE bot_message_id = ?').run(botMessageId);
  }

  setAwaitingReply(botChatId: number, info: PendingNotify): void {
    this.cleanupExpired();
    const db = this.getDatabase();
    db.prepare(
      `INSERT INTO pending_notify_awaiting_replies (
        bot_chat_id, source_bot_message_id, chat_id, chat_title, question, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_chat_id) DO UPDATE SET
        source_bot_message_id = excluded.source_bot_message_id,
        chat_id = excluded.chat_id,
        chat_title = excluded.chat_title,
        question = excluded.question,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at`,
    ).run(
      botChatId,
      info.sourceBotMessageId ?? null,
      info.chatId,
      info.chatTitle,
      info.question,
      info.createdAt,
      info.createdAt + PENDING_TTL_MS,
    );
  }

  getAwaitingReply(botChatId: number): PendingNotify | undefined {
    this.cleanupExpired();
    const db = this.getDatabase();
    const row = db.prepare(
      'SELECT bot_chat_id, source_bot_message_id, chat_id, chat_title, question, created_at, expires_at FROM pending_notify_awaiting_replies WHERE bot_chat_id = ?',
    ).get(botChatId) as PendingNotifyAwaitingReplyRow | undefined;
    return row ? this.rowToPending(row) : undefined;
  }

  listAwaitingReplies(limit: number = 50): PendingNotifyAwaitingReplyRecord[] {
    this.cleanupExpired();
    const db = this.getDatabase();
    const rows = db.prepare(
      'SELECT bot_chat_id, source_bot_message_id, chat_id, chat_title, question, created_at, expires_at FROM pending_notify_awaiting_replies ORDER BY created_at DESC LIMIT ?',
    ).all(this.normalizeLimit(limit)) as unknown as PendingNotifyAwaitingReplyRow[];
    return rows.map((row) => this.rowToAwaitingReply(row));
  }

  consumeAwaitingReply(botChatId: number): PendingNotify | undefined {
    this.cleanupExpired();
    const db = this.getDatabase();
    const row = db.prepare(
      'SELECT bot_chat_id, source_bot_message_id, chat_id, chat_title, question, created_at, expires_at FROM pending_notify_awaiting_replies WHERE bot_chat_id = ?',
    ).get(botChatId) as PendingNotifyAwaitingReplyRow | undefined;
    if (!row) {
      return undefined;
    }

    db.prepare('DELETE FROM pending_notify_awaiting_replies WHERE bot_chat_id = ?').run(botChatId);
    return this.rowToPending(row);
  }

  completeAwaitingReply(
    botChatId: number,
    params: { replyText: string; correlationId: string | null; routeStatus?: PendingNotifyRouteStatus },
  ): PendingNotifyRouteRecord | undefined {
    this.cleanupExpired();
    const db = this.getDatabase();
    const row = db.prepare(
      'SELECT bot_chat_id, source_bot_message_id, chat_id, chat_title, question, created_at, expires_at FROM pending_notify_awaiting_replies WHERE bot_chat_id = ?',
    ).get(botChatId) as PendingNotifyAwaitingReplyRow | undefined;
    if (!row) {
      return undefined;
    }

    const completedAt = Date.now();
    const record: PendingNotifyRouteRecord = {
      id: randomUUID(),
      botChatId: row.bot_chat_id,
      sourceBotMessageId: row.source_bot_message_id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      question: row.question,
      replyText: params.replyText,
      routeStatus: params.routeStatus ?? 'sent',
      correlationId: params.correlationId,
      createdAt: row.created_at,
      completedAt,
    };

    db.prepare(
      `INSERT INTO pending_notify_reply_routes (
        id, bot_chat_id, source_bot_message_id, chat_id, chat_title, question,
        reply_text, route_status, correlation_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.botChatId,
      record.sourceBotMessageId,
      record.chatId,
      record.chatTitle,
      record.question,
      record.replyText,
      record.routeStatus,
      record.correlationId,
      record.createdAt,
      record.completedAt,
    );

    db.prepare('DELETE FROM pending_notify_awaiting_replies WHERE bot_chat_id = ?').run(botChatId);
    if (record.sourceBotMessageId !== null) {
      this.deletePending(record.sourceBotMessageId);
    }
    return record;
  }

  listRecentRoutes(limit: number = 50): PendingNotifyRouteRecord[] {
    this.cleanupExpired();
    const db = this.getDatabase();
    const rows = db.prepare(
      'SELECT id, bot_chat_id, source_bot_message_id, chat_id, chat_title, question, reply_text, route_status, correlation_id, created_at, completed_at FROM pending_notify_reply_routes ORDER BY completed_at DESC LIMIT ?',
    ).all(this.normalizeLimit(limit)) as unknown as PendingNotifyRouteRow[];
    return rows.map((row) => this.rowToRoute(row));
  }

  private cleanupExpired(): void {
    const db = this.getDatabase();
    const now = Date.now();
    const values: SQLInputValue[] = [now];
    const expiredAwaiting = db.prepare(
      'SELECT bot_chat_id, source_bot_message_id, chat_id, chat_title, question, created_at, expires_at FROM pending_notify_awaiting_replies WHERE expires_at <= ?',
    ).all(...values) as unknown as PendingNotifyAwaitingReplyRow[];
    for (const row of expiredAwaiting) {
      db.prepare(
        `INSERT INTO pending_notify_reply_routes (
          id, bot_chat_id, source_bot_message_id, chat_id, chat_title, question,
          reply_text, route_status, correlation_id, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        row.bot_chat_id,
        row.source_bot_message_id,
        row.chat_id,
        row.chat_title,
        row.question,
        null,
        'expired',
        null,
        row.created_at,
        now,
      );
      if (row.source_bot_message_id !== null) {
        this.deletePending(row.source_bot_message_id);
      }
    }
    db.prepare('DELETE FROM pending_notify_messages WHERE expires_at <= ?').run(...values);
    db.prepare('DELETE FROM pending_notify_awaiting_replies WHERE expires_at <= ?').run(...values);
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
      CREATE TABLE IF NOT EXISTS pending_notify_messages (
        bot_message_id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        question TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS pending_notify_awaiting_replies (
        bot_chat_id INTEGER PRIMARY KEY,
        source_bot_message_id INTEGER,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        question TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    try {
      database.exec(`ALTER TABLE pending_notify_awaiting_replies ADD COLUMN source_bot_message_id INTEGER`);
      this.logger.log('Migrated pending_notify_awaiting_replies: added source_bot_message_id column');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS pending_notify_reply_routes (
        id TEXT PRIMARY KEY,
        bot_chat_id INTEGER NOT NULL,
        source_bot_message_id INTEGER,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        question TEXT NOT NULL,
        reply_text TEXT,
        route_status TEXT NOT NULL,
        correlation_id TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      )
    `);
    database.exec('CREATE INDEX IF NOT EXISTS idx_pending_notify_messages_expires_at ON pending_notify_messages (expires_at)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_pending_notify_awaiting_expires_at ON pending_notify_awaiting_replies (expires_at)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_pending_notify_reply_routes_completed_at ON pending_notify_reply_routes (completed_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_pending_notify_reply_routes_bot_chat_id ON pending_notify_reply_routes (bot_chat_id)');

    this.database = database;
    this.logger.log('SQLite pending notify tables initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private normalizeLimit(limit: number): number {
    return Math.max(1, Math.min(Math.floor(limit), 200));
  }
 
  private rowToPendingMessage(row: PendingNotifyMessageRow): PendingNotifyMessageRecord {
    return {
      botMessageId: row.bot_message_id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      question: row.question,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
 
  private rowToAwaitingReply(row: PendingNotifyAwaitingReplyRow): PendingNotifyAwaitingReplyRecord {
    return {
      botChatId: row.bot_chat_id,
      sourceBotMessageId: row.source_bot_message_id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      question: row.question,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
 
  private rowToRoute(row: PendingNotifyRouteRow): PendingNotifyRouteRecord {
    return {
      id: row.id,
      botChatId: row.bot_chat_id,
      sourceBotMessageId: row.source_bot_message_id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      question: row.question,
      replyText: row.reply_text,
      routeStatus: row.route_status as PendingNotifyRouteRecord['routeStatus'],
      correlationId: row.correlation_id,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
 
  private rowToPending(row: PendingNotifyRow): PendingNotify {
    return {
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      question: row.question,
      createdAt: row.created_at,
      sourceBotMessageId: row.source_bot_message_id ?? null,
    };
  }
}
