import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  CreateTelegramOutboundAuditEventParams,
  SearchTelegramOutboundAuditEventsParams,
  TelegramOutboundAuditEvent,
} from './telegram-runtime.types';
import type { TgChatMode } from '../telegram-client/telegram-client.types';

interface TelegramOutboundAuditRow {
  id: string;
  channel: string;
  action: string;
  actor: string;
  origin: string;
  target_chat_id: string | null;
  target_chat_title: string | null;
  monitored_chat_id: string | null;
  monitored_mode: string | null;
  scope_key: string | null;
  conversation_id: string | null;
  correlation_id: string | null;
  policy_decision: string;
  policy_reason_code: string;
  result: string;
  payload_preview: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TelegramOutboundAuditRepository implements OnModuleInit {
  private readonly logger = new Logger(TelegramOutboundAuditRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  async create(params: CreateTelegramOutboundAuditEventParams): Promise<TelegramOutboundAuditEvent> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const event: TelegramOutboundAuditEvent = {
      id: randomUUID(),
      channel: params.channel,
      action: params.action,
      actor: params.actor,
      origin: params.origin,
      targetChatId: params.targetChatId ?? null,
      targetChatTitle: params.targetChatTitle ?? null,
      monitoredChatId: params.monitoredChatId ?? null,
      monitoredMode: params.monitoredMode ?? null,
      scopeKey: params.scopeKey ?? null,
      conversationId: params.conversationId ?? null,
      correlationId: params.correlationId ?? null,
      policyDecision: params.policyDecision,
      policyReasonCode: params.policyReasonCode,
      result: params.result,
      payloadPreview: params.payloadPreview ?? null,
      errorMessage: params.errorMessage ?? null,
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      `INSERT INTO tg_outbound_events (
        id, channel, action, actor, origin,
        target_chat_id, target_chat_title,
        monitored_chat_id, monitored_mode,
        scope_key, conversation_id, correlation_id,
        policy_decision, policy_reason_code, result,
        payload_preview, error_message,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.channel,
      event.action,
      event.actor,
      event.origin,
      event.targetChatId,
      event.targetChatTitle,
      event.monitoredChatId,
      event.monitoredMode,
      event.scopeKey,
      event.conversationId,
      event.correlationId,
      event.policyDecision,
      event.policyReasonCode,
      event.result,
      event.payloadPreview,
      event.errorMessage,
      event.createdAt,
      event.updatedAt,
    );

    return event;
  }

  async updateResult(id: string, result: TelegramOutboundAuditEvent['result'], errorMessage?: string | null): Promise<void> {
    const db = this.getDatabase();
    db.prepare(
      `UPDATE tg_outbound_events
       SET result = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(result, errorMessage ?? null, new Date().toISOString(), id);
  }

  async search(params: SearchTelegramOutboundAuditEventsParams = {}): Promise<TelegramOutboundAuditEvent[]> {
    const db = this.getDatabase();
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];

    if (params.channel) {
      clauses.push('channel = ?');
      values.push(params.channel);
    }
    if (params.actor) {
      clauses.push('actor = ?');
      values.push(params.actor);
    }
    if (params.origin) {
      clauses.push('origin = ?');
      values.push(params.origin);
    }
    if (params.result) {
      clauses.push('result = ?');
      values.push(params.result);
    }
    if (params.policyDecision) {
      clauses.push('policy_decision = ?');
      values.push(params.policyDecision);
    }
    if (params.targetChatId) {
      clauses.push('target_chat_id = ?');
      values.push(params.targetChatId);
    }
    if (params.correlationId) {
      clauses.push('correlation_id = ?');
      values.push(params.correlationId);
    }
    if (params.before) {
      clauses.push('created_at < ?');
      values.push(params.before);
    }
    if (params.after) {
      clauses.push('created_at > ?');
      values.push(params.after);
    }

    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    values.push(limit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM tg_outbound_events ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...values) as unknown as TelegramOutboundAuditRow[];

    return rows.map((row) => this.rowToEvent(row));
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
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`
      CREATE TABLE IF NOT EXISTS tg_outbound_events (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        origin TEXT NOT NULL,
        target_chat_id TEXT,
        target_chat_title TEXT,
        monitored_chat_id TEXT,
        monitored_mode TEXT,
        scope_key TEXT,
        conversation_id TEXT,
        correlation_id TEXT,
        policy_decision TEXT NOT NULL,
        policy_reason_code TEXT NOT NULL,
        result TEXT NOT NULL,
        payload_preview TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbound_events_created_at ON tg_outbound_events (created_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbound_events_target_chat_id ON tg_outbound_events (target_chat_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbound_events_origin ON tg_outbound_events (origin)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbound_events_correlation_id ON tg_outbound_events (correlation_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbound_events_result ON tg_outbound_events (result)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbound_events_policy_decision ON tg_outbound_events (policy_decision)');

    this.database = database;
    this.logger.log('SQLite tg_outbound_events table initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToEvent(row: TelegramOutboundAuditRow): TelegramOutboundAuditEvent {
    return {
      id: row.id,
      channel: row.channel as TelegramOutboundAuditEvent['channel'],
      action: row.action as TelegramOutboundAuditEvent['action'],
      actor: row.actor as TelegramOutboundAuditEvent['actor'],
      origin: row.origin as TelegramOutboundAuditEvent['origin'],
      targetChatId: row.target_chat_id,
      targetChatTitle: row.target_chat_title,
      monitoredChatId: row.monitored_chat_id,
      monitoredMode: row.monitored_mode as TgChatMode | null,
      scopeKey: row.scope_key,
      conversationId: row.conversation_id,
      correlationId: row.correlation_id,
      policyDecision: row.policy_decision as TelegramOutboundAuditEvent['policyDecision'],
      policyReasonCode: row.policy_reason_code as TelegramOutboundAuditEvent['policyReasonCode'],
      result: row.result as TelegramOutboundAuditEvent['result'],
      payloadPreview: row.payload_preview,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
