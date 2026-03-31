import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

import type {
  TelegramClientMonitorRuntimeState,
  UpsertTelegramClientMonitorRuntimeStateParams,
} from './telegram-client-monitor-runtime.types';

interface TelegramClientMonitorRuntimeRow {
  chat_id: string;
  monitored_chat_id: string;
  chat_title: string;
  mode: string;
  status: string;
  queue_length: number;
  queue_active: number;
  last_inbound_message_id: number | null;
  last_inbound_sender_name: string | null;
  last_inbound_at: string | null;
  last_reply_message_id: number | null;
  last_reply_at: string | null;
  last_conversation_id: string | null;
  cooldown_until: string | null;
  last_processed_at: string | null;
  last_error_message: string | null;
  updated_at: string;
}

@Injectable()
export class TelegramClientMonitorRuntimeRepository implements OnModuleInit {
  private readonly logger = new Logger(TelegramClientMonitorRuntimeRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  async findByChatId(chatId: string): Promise<TelegramClientMonitorRuntimeState | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM tg_client_monitor_runtime WHERE chat_id = ?').get(chatId) as TelegramClientMonitorRuntimeRow | undefined;
    return row ? this.rowToState(row) : undefined;
  }

  async findAll(): Promise<TelegramClientMonitorRuntimeState[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM tg_client_monitor_runtime ORDER BY updated_at DESC').all() as unknown as TelegramClientMonitorRuntimeRow[];
    return rows.map((row) => this.rowToState(row));
  }

  async upsert(params: UpsertTelegramClientMonitorRuntimeStateParams): Promise<TelegramClientMonitorRuntimeState> {
    const current = await this.findByChatId(params.chatId);
    const next: TelegramClientMonitorRuntimeState = {
      chatId: params.chatId,
      monitoredChatId: params.monitoredChatId,
      chatTitle: params.chatTitle,
      mode: params.mode,
      status: params.status ?? current?.status ?? 'idle',
      queueLength: params.queueLength ?? current?.queueLength ?? 0,
      queueActive: params.queueActive ?? current?.queueActive ?? false,
      lastInboundMessageId: params.lastInboundMessageId ?? current?.lastInboundMessageId ?? null,
      lastInboundSenderName: params.lastInboundSenderName ?? current?.lastInboundSenderName ?? null,
      lastInboundAt: params.lastInboundAt ?? current?.lastInboundAt ?? null,
      lastReplyMessageId: params.lastReplyMessageId ?? current?.lastReplyMessageId ?? null,
      lastReplyAt: params.lastReplyAt ?? current?.lastReplyAt ?? null,
      lastConversationId: params.lastConversationId ?? current?.lastConversationId ?? null,
      cooldownUntil: params.cooldownUntil ?? current?.cooldownUntil ?? null,
      lastProcessedAt: params.lastProcessedAt ?? current?.lastProcessedAt ?? null,
      lastErrorMessage: params.lastErrorMessage ?? current?.lastErrorMessage ?? null,
      updatedAt: new Date().toISOString(),
    };

    const db = this.getDatabase();
    db.prepare(
      `INSERT INTO tg_client_monitor_runtime (
        chat_id, monitored_chat_id, chat_title, mode, status, queue_length, queue_active,
        last_inbound_message_id, last_inbound_sender_name, last_inbound_at,
        last_reply_message_id, last_reply_at, last_conversation_id,
        cooldown_until, last_processed_at, last_error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        monitored_chat_id = excluded.monitored_chat_id,
        chat_title = excluded.chat_title,
        mode = excluded.mode,
        status = excluded.status,
        queue_length = excluded.queue_length,
        queue_active = excluded.queue_active,
        last_inbound_message_id = excluded.last_inbound_message_id,
        last_inbound_sender_name = excluded.last_inbound_sender_name,
        last_inbound_at = excluded.last_inbound_at,
        last_reply_message_id = excluded.last_reply_message_id,
        last_reply_at = excluded.last_reply_at,
        last_conversation_id = excluded.last_conversation_id,
        cooldown_until = excluded.cooldown_until,
        last_processed_at = excluded.last_processed_at,
        last_error_message = excluded.last_error_message,
        updated_at = excluded.updated_at`,
    ).run(
      next.chatId,
      next.monitoredChatId,
      next.chatTitle,
      next.mode,
      next.status,
      next.queueLength,
      next.queueActive ? 1 : 0,
      next.lastInboundMessageId,
      next.lastInboundSenderName,
      next.lastInboundAt,
      next.lastReplyMessageId,
      next.lastReplyAt,
      next.lastConversationId,
      next.cooldownUntil,
      next.lastProcessedAt,
      next.lastErrorMessage,
      next.updatedAt,
    );

    return next;
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
      CREATE TABLE IF NOT EXISTS tg_client_monitor_runtime (
        chat_id TEXT PRIMARY KEY,
        monitored_chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_length INTEGER NOT NULL DEFAULT 0,
        queue_active INTEGER NOT NULL DEFAULT 0,
        last_inbound_message_id INTEGER,
        last_inbound_sender_name TEXT,
        last_inbound_at TEXT,
        last_reply_message_id INTEGER,
        last_reply_at TEXT,
        last_conversation_id TEXT,
        cooldown_until TEXT,
        last_processed_at TEXT,
        last_error_message TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_client_monitor_runtime_updated_at ON tg_client_monitor_runtime (updated_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_client_monitor_runtime_status ON tg_client_monitor_runtime (status)');

    this.database = database;
    this.logger.log('SQLite tg_client_monitor_runtime table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToState(row: TelegramClientMonitorRuntimeRow): TelegramClientMonitorRuntimeState {
    return {
      chatId: row.chat_id,
      monitoredChatId: row.monitored_chat_id,
      chatTitle: row.chat_title,
      mode: row.mode as TelegramClientMonitorRuntimeState['mode'],
      status: row.status as TelegramClientMonitorRuntimeState['status'],
      queueLength: row.queue_length,
      queueActive: row.queue_active === 1,
      lastInboundMessageId: row.last_inbound_message_id,
      lastInboundSenderName: row.last_inbound_sender_name,
      lastInboundAt: row.last_inbound_at,
      lastReplyMessageId: row.last_reply_message_id,
      lastReplyAt: row.last_reply_at,
      lastConversationId: row.last_conversation_id,
      cooldownUntil: row.cooldown_until,
      lastProcessedAt: row.last_processed_at,
      lastErrorMessage: row.last_error_message,
      updatedAt: row.updated_at,
    };
  }
}
