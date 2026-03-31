import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  CreateTelegramWatchEvaluationParams,
  CreateTelegramWatchRuleParams,
  TelegramWatchAlertRecord,
  TelegramWatchEvaluationResult,
  TelegramWatchRule,
  TelegramWatchState,
  UpdateTelegramWatchRuleParams,
  UpsertTelegramWatchStateParams,
} from './monitor.types';

interface TelegramWatchRuleRow {
  id: string;
  rule_type: string;
  monitored_chat_id: string;
  name: string;
  threshold_seconds: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface TelegramWatchStateRow {
  rule_id: string;
  rule_type: string;
  monitored_chat_id: string;
  chat_id: string | null;
  chat_title: string | null;
  status: string;
  last_inbound_message_id: number | null;
  last_inbound_sender_name: string | null;
  last_inbound_at: string | null;
  last_owner_reply_message_id: number | null;
  last_owner_reply_at: string | null;
  unanswered_since: string | null;
  last_evaluated_at: string;
  last_alerted_at: string | null;
  dedupe_key: string | null;
  last_evaluation_status: string;
  last_evaluation_message: string;
  updated_at: string;
}

interface TelegramWatchEvaluationRow {
  id: string;
  rule_id: string;
  rule_type: string;
  monitored_chat_id: string;
  chat_id: string | null;
  chat_title: string | null;
  state_status: string;
  evaluation_status: string;
  last_inbound_message_id: number | null;
  last_owner_reply_message_id: number | null;
  dedupe_key: string | null;
  correlation_id: string | null;
  alert_triggered: number;
  message: string;
  evaluated_at: string;
}

@Injectable()
export class MonitorRepository implements OnModuleInit {
  private readonly logger = new Logger(MonitorRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  async createRule(params: CreateTelegramWatchRuleParams): Promise<TelegramWatchRule> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const rule: TelegramWatchRule = {
      id: randomUUID(),
      ruleType: 'telegram_unanswered_message_monitor',
      monitoredChatId: params.monitoredChatId,
      name: params.name?.trim() || `Unanswered messages for ${params.monitoredChatId}`,
      thresholdSeconds: Math.max(60, Math.floor(params.thresholdSeconds ?? 15 * 60)),
      enabled: params.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      `INSERT INTO tg_watch_rules (
        id, rule_type, monitored_chat_id, name, threshold_seconds, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rule.id,
      rule.ruleType,
      rule.monitoredChatId,
      rule.name,
      rule.thresholdSeconds,
      rule.enabled ? 1 : 0,
      rule.createdAt,
      rule.updatedAt,
    );

    return rule;
  }

  async findRuleById(id: string): Promise<TelegramWatchRule | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM tg_watch_rules WHERE id = ?').get(id) as TelegramWatchRuleRow | undefined;
    return row ? this.rowToRule(row) : undefined;
  }

  async findRuleByMonitoredChatId(monitoredChatId: string): Promise<TelegramWatchRule | undefined> {
    const db = this.getDatabase();
    const row = db.prepare(
      `SELECT * FROM tg_watch_rules WHERE rule_type = 'telegram_unanswered_message_monitor' AND monitored_chat_id = ?`,
    ).get(monitoredChatId) as TelegramWatchRuleRow | undefined;
    return row ? this.rowToRule(row) : undefined;
  }

  async listRules(): Promise<TelegramWatchRule[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM tg_watch_rules ORDER BY created_at DESC').all() as unknown as TelegramWatchRuleRow[];
    return rows.map((row) => this.rowToRule(row));
  }

  async listEnabledRules(): Promise<TelegramWatchRule[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM tg_watch_rules WHERE enabled = 1 ORDER BY created_at DESC').all() as unknown as TelegramWatchRuleRow[];
    return rows.map((row) => this.rowToRule(row));
  }

  async updateRule(id: string, updates: UpdateTelegramWatchRuleParams): Promise<void> {
    const db = this.getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.monitoredChatId !== undefined) {
      sets.push('monitored_chat_id = ?');
      values.push(updates.monitoredChatId);
    }
    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name.trim());
    }
    if (updates.thresholdSeconds !== undefined) {
      sets.push('threshold_seconds = ?');
      values.push(Math.max(60, Math.floor(updates.thresholdSeconds)));
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (sets.length === 0) {
      return;
    }

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE tg_watch_rules SET ${sets.join(', ')} WHERE id = ?`).run(...values as [string]);
  }

  async deleteRule(id: string): Promise<boolean> {
    const db = this.getDatabase();
    const result = db.prepare('DELETE FROM tg_watch_rules WHERE id = ?').run(id);
    return (result as unknown as { changes: number }).changes > 0;
  }

  async findStateByRuleId(ruleId: string): Promise<TelegramWatchState | undefined> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM tg_watch_state WHERE rule_id = ?').get(ruleId) as TelegramWatchStateRow | undefined;
    return row ? this.rowToState(row) : undefined;
  }

  async listStates(): Promise<TelegramWatchState[]> {
    const db = this.getDatabase();
    const rows = db.prepare('SELECT * FROM tg_watch_state ORDER BY updated_at DESC').all() as unknown as TelegramWatchStateRow[];
    return rows.map((row) => this.rowToState(row));
  }

  async upsertState(params: UpsertTelegramWatchStateParams): Promise<TelegramWatchState> {
    const current = await this.findStateByRuleId(params.ruleId);
    const next: TelegramWatchState = {
      ruleId: params.ruleId,
      ruleType: params.ruleType,
      monitoredChatId: params.monitoredChatId,
      chatId: params.chatId ?? current?.chatId ?? null,
      chatTitle: params.chatTitle ?? current?.chatTitle ?? null,
      status: params.status ?? current?.status ?? 'idle',
      lastInboundMessageId: params.lastInboundMessageId ?? current?.lastInboundMessageId ?? null,
      lastInboundSenderName: params.lastInboundSenderName ?? current?.lastInboundSenderName ?? null,
      lastInboundAt: params.lastInboundAt ?? current?.lastInboundAt ?? null,
      lastOwnerReplyMessageId: params.lastOwnerReplyMessageId ?? current?.lastOwnerReplyMessageId ?? null,
      lastOwnerReplyAt: params.lastOwnerReplyAt ?? current?.lastOwnerReplyAt ?? null,
      unansweredSince: params.unansweredSince ?? current?.unansweredSince ?? null,
      lastEvaluatedAt: params.lastEvaluatedAt ?? current?.lastEvaluatedAt ?? new Date().toISOString(),
      lastAlertedAt: params.lastAlertedAt ?? current?.lastAlertedAt ?? null,
      dedupeKey: params.dedupeKey ?? current?.dedupeKey ?? null,
      lastEvaluationStatus: params.lastEvaluationStatus ?? current?.lastEvaluationStatus ?? 'noop',
      lastEvaluationMessage: params.lastEvaluationMessage ?? current?.lastEvaluationMessage ?? '',
      updatedAt: new Date().toISOString(),
    };

    const db = this.getDatabase();
    db.prepare(
      `INSERT INTO tg_watch_state (
        rule_id, rule_type, monitored_chat_id, chat_id, chat_title, status,
        last_inbound_message_id, last_inbound_sender_name, last_inbound_at,
        last_owner_reply_message_id, last_owner_reply_at, unanswered_since,
        last_evaluated_at, last_alerted_at, dedupe_key,
        last_evaluation_status, last_evaluation_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        rule_type = excluded.rule_type,
        monitored_chat_id = excluded.monitored_chat_id,
        chat_id = excluded.chat_id,
        chat_title = excluded.chat_title,
        status = excluded.status,
        last_inbound_message_id = excluded.last_inbound_message_id,
        last_inbound_sender_name = excluded.last_inbound_sender_name,
        last_inbound_at = excluded.last_inbound_at,
        last_owner_reply_message_id = excluded.last_owner_reply_message_id,
        last_owner_reply_at = excluded.last_owner_reply_at,
        unanswered_since = excluded.unanswered_since,
        last_evaluated_at = excluded.last_evaluated_at,
        last_alerted_at = excluded.last_alerted_at,
        dedupe_key = excluded.dedupe_key,
        last_evaluation_status = excluded.last_evaluation_status,
        last_evaluation_message = excluded.last_evaluation_message,
        updated_at = excluded.updated_at`,
    ).run(
      next.ruleId,
      next.ruleType,
      next.monitoredChatId,
      next.chatId,
      next.chatTitle,
      next.status,
      next.lastInboundMessageId,
      next.lastInboundSenderName,
      next.lastInboundAt,
      next.lastOwnerReplyMessageId,
      next.lastOwnerReplyAt,
      next.unansweredSince,
      next.lastEvaluatedAt,
      next.lastAlertedAt,
      next.dedupeKey,
      next.lastEvaluationStatus,
      next.lastEvaluationMessage,
      next.updatedAt,
    );

    return next;
  }

  async createEvaluation(params: CreateTelegramWatchEvaluationParams): Promise<TelegramWatchEvaluationResult> {
    const db = this.getDatabase();
    const evaluation: TelegramWatchEvaluationResult = {
      id: randomUUID(),
      ruleId: params.ruleId,
      ruleType: params.ruleType,
      monitoredChatId: params.monitoredChatId,
      chatId: params.chatId,
      chatTitle: params.chatTitle,
      stateStatus: params.stateStatus,
      evaluationStatus: params.evaluationStatus,
      lastInboundMessageId: params.lastInboundMessageId,
      lastOwnerReplyMessageId: params.lastOwnerReplyMessageId,
      dedupeKey: params.dedupeKey,
      correlationId: params.correlationId,
      alertTriggered: params.alertTriggered,
      message: params.message,
      evaluatedAt: params.evaluatedAt ?? new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO tg_watch_evaluations (
        id, rule_id, rule_type, monitored_chat_id, chat_id, chat_title,
        state_status, evaluation_status, last_inbound_message_id, last_owner_reply_message_id,
        dedupe_key, correlation_id, alert_triggered, message, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evaluation.id,
      evaluation.ruleId,
      evaluation.ruleType,
      evaluation.monitoredChatId,
      evaluation.chatId,
      evaluation.chatTitle,
      evaluation.stateStatus,
      evaluation.evaluationStatus,
      evaluation.lastInboundMessageId,
      evaluation.lastOwnerReplyMessageId,
      evaluation.dedupeKey,
      evaluation.correlationId,
      evaluation.alertTriggered ? 1 : 0,
      evaluation.message,
      evaluation.evaluatedAt,
    );

    return evaluation;
  }

  async listEvaluations(ruleId?: string, limit = 50): Promise<TelegramWatchEvaluationResult[]> {
    const db = this.getDatabase();
    const normalizedLimit = Math.max(1, Math.min(limit, 200));

    const rows = ruleId
      ? db.prepare(
        'SELECT * FROM tg_watch_evaluations WHERE rule_id = ? ORDER BY evaluated_at DESC LIMIT ?',
      ).all(ruleId, normalizedLimit) as unknown as TelegramWatchEvaluationRow[]
      : db.prepare(
        'SELECT * FROM tg_watch_evaluations ORDER BY evaluated_at DESC LIMIT ?',
      ).all(normalizedLimit) as unknown as TelegramWatchEvaluationRow[];

    return rows.map((row) => this.rowToEvaluation(row));
  }

  async listAlertHistory(ruleId?: string, limit = 50): Promise<TelegramWatchAlertRecord[]> {
    const evaluations = await this.listEvaluations(ruleId, limit * 3);
    return evaluations
      .filter((evaluation) => evaluation.alertTriggered)
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((evaluation) => ({
        evaluationId: evaluation.id,
        ruleId: evaluation.ruleId,
        monitoredChatId: evaluation.monitoredChatId,
        chatId: evaluation.chatId,
        chatTitle: evaluation.chatTitle,
        correlationId: evaluation.correlationId,
        lastInboundMessageId: evaluation.lastInboundMessageId,
        dedupeKey: evaluation.dedupeKey,
        message: evaluation.message,
        evaluatedAt: evaluation.evaluatedAt,
      }));
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
      CREATE TABLE IF NOT EXISTS tg_watch_rules (
        id TEXT PRIMARY KEY,
        rule_type TEXT NOT NULL,
        monitored_chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        threshold_seconds INTEGER NOT NULL DEFAULT 900,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(rule_type, monitored_chat_id)
      )
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS tg_watch_state (
        rule_id TEXT PRIMARY KEY,
        rule_type TEXT NOT NULL,
        monitored_chat_id TEXT NOT NULL,
        chat_id TEXT,
        chat_title TEXT,
        status TEXT NOT NULL,
        last_inbound_message_id INTEGER,
        last_inbound_sender_name TEXT,
        last_inbound_at TEXT,
        last_owner_reply_message_id INTEGER,
        last_owner_reply_at TEXT,
        unanswered_since TEXT,
        last_evaluated_at TEXT NOT NULL,
        last_alerted_at TEXT,
        dedupe_key TEXT,
        last_evaluation_status TEXT NOT NULL,
        last_evaluation_message TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(rule_id) REFERENCES tg_watch_rules(id) ON DELETE CASCADE
      )
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS tg_watch_evaluations (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        monitored_chat_id TEXT NOT NULL,
        chat_id TEXT,
        chat_title TEXT,
        state_status TEXT NOT NULL,
        evaluation_status TEXT NOT NULL,
        last_inbound_message_id INTEGER,
        last_owner_reply_message_id INTEGER,
        dedupe_key TEXT,
        correlation_id TEXT,
        alert_triggered INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        FOREIGN KEY(rule_id) REFERENCES tg_watch_rules(id) ON DELETE CASCADE
      )
    `);

    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_rules_enabled ON tg_watch_rules (enabled)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_rules_monitored_chat_id ON tg_watch_rules (monitored_chat_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_state_updated_at ON tg_watch_state (updated_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_state_status ON tg_watch_state (status)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_evaluations_rule_id ON tg_watch_evaluations (rule_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_evaluations_evaluated_at ON tg_watch_evaluations (evaluated_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_watch_evaluations_alert_triggered ON tg_watch_evaluations (alert_triggered)');

    this.database = database;
    this.logger.log('SQLite tg_watch_rules + tg_watch_state + tg_watch_evaluations tables initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToRule(row: TelegramWatchRuleRow): TelegramWatchRule {
    return {
      id: row.id,
      ruleType: row.rule_type as TelegramWatchRule['ruleType'],
      monitoredChatId: row.monitored_chat_id,
      name: row.name,
      thresholdSeconds: row.threshold_seconds,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToState(row: TelegramWatchStateRow): TelegramWatchState {
    return {
      ruleId: row.rule_id,
      ruleType: row.rule_type as TelegramWatchState['ruleType'],
      monitoredChatId: row.monitored_chat_id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      status: row.status as TelegramWatchState['status'],
      lastInboundMessageId: row.last_inbound_message_id,
      lastInboundSenderName: row.last_inbound_sender_name,
      lastInboundAt: row.last_inbound_at,
      lastOwnerReplyMessageId: row.last_owner_reply_message_id,
      lastOwnerReplyAt: row.last_owner_reply_at,
      unansweredSince: row.unanswered_since,
      lastEvaluatedAt: row.last_evaluated_at,
      lastAlertedAt: row.last_alerted_at,
      dedupeKey: row.dedupe_key,
      lastEvaluationStatus: row.last_evaluation_status as TelegramWatchState['lastEvaluationStatus'],
      lastEvaluationMessage: row.last_evaluation_message,
      updatedAt: row.updated_at,
    };
  }

  private rowToEvaluation(row: TelegramWatchEvaluationRow): TelegramWatchEvaluationResult {
    return {
      id: row.id,
      ruleId: row.rule_id,
      ruleType: row.rule_type as TelegramWatchEvaluationResult['ruleType'],
      monitoredChatId: row.monitored_chat_id,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      stateStatus: row.state_status as TelegramWatchEvaluationResult['stateStatus'],
      evaluationStatus: row.evaluation_status as TelegramWatchEvaluationResult['evaluationStatus'],
      lastInboundMessageId: row.last_inbound_message_id,
      lastOwnerReplyMessageId: row.last_owner_reply_message_id,
      dedupeKey: row.dedupe_key,
      correlationId: row.correlation_id,
      alertTriggered: row.alert_triggered === 1,
      message: row.message,
      evaluatedAt: row.evaluated_at,
    };
  }
}
