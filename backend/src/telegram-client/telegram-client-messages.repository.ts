import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';

import type { TgStoredMessage, CreateStoredMessageParams, TgChatType, TgChatProfile } from './telegram-client.types';

interface MessageRow {
  id: string;
  chat_id: string;
  tg_message_id: number;
  sender_id: string;
  sender_name: string;
  text: string;
  is_outgoing: number;
  reply_to_id: number | null;
  timestamp: string;
}

interface ProfileRow {
  chat_id: string;
  chat_type: string;
  language: string;
  owner_style_summary: string;
  owner_style_examples: string;
  chat_topic_summary: string;
  participant_summary: string;
  last_profiled_at: string;
  total_messages: number;
}

@Injectable()
export class TelegramClientMessagesRepository implements OnModuleInit {
  private readonly logger = new Logger(TelegramClientMessagesRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.getDatabase();
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  async save(params: CreateStoredMessageParams): Promise<TgStoredMessage> {
    const db = this.getDatabase();
    const msg: TgStoredMessage = {
      id: randomUUID(),
      chatId: params.chatId,
      tgMessageId: params.tgMessageId,
      senderId: params.senderId,
      senderName: params.senderName,
      text: params.text,
      isOutgoing: params.isOutgoing,
      replyToId: params.replyToId ?? null,
      timestamp: params.timestamp,
    };

    db.prepare(
      `INSERT OR IGNORE INTO tg_chat_messages
        (id, chat_id, tg_message_id, sender_id, sender_name, text, is_outgoing, reply_to_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      msg.id, msg.chatId, msg.tgMessageId, msg.senderId, msg.senderName,
      msg.text, msg.isOutgoing ? 1 : 0, msg.replyToId, msg.timestamp,
    );

    return msg;
  }

  async saveBulk(messages: CreateStoredMessageParams[]): Promise<number> {
    if (messages.length === 0) return 0;

    const db = this.getDatabase();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO tg_chat_messages
        (id, chat_id, tg_message_id, sender_id, sender_name, text, is_outgoing, reply_to_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let inserted = 0;
    db.exec('BEGIN');
    try {
      for (const msg of messages) {
        const result = stmt.run(
          randomUUID(), msg.chatId, msg.tgMessageId, msg.senderId, msg.senderName,
          msg.text, msg.isOutgoing ? 1 : 0, msg.replyToId ?? null, msg.timestamp,
        );
        if ((result as unknown as { changes: number }).changes > 0) inserted++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    this.logger.debug(`Bulk saved ${inserted}/${messages.length} messages for chat ${messages[0]?.chatId}`);
    return inserted;
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  async getRecent(chatId: string, limit = 50): Promise<TgStoredMessage[]> {
    const db = this.getDatabase();
    const rows = db.prepare(
      `SELECT * FROM tg_chat_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
    ).all(chatId, limit) as unknown as MessageRow[];

    // Return in chronological order (oldest first)
    return rows.map((r) => this.rowToMessage(r)).reverse();
  }

  async getOwnerMessages(chatId: string, limit = 30): Promise<TgStoredMessage[]> {
    const db = this.getDatabase();
    const rows = db.prepare(
      `SELECT * FROM tg_chat_messages WHERE chat_id = ? AND is_outgoing = 1 ORDER BY timestamp DESC LIMIT ?`,
    ).all(chatId, limit) as unknown as MessageRow[];

    return rows.map((r) => this.rowToMessage(r)).reverse();
  }

  async getMessageCount(chatId: string): Promise<number> {
    const db = this.getDatabase();
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM tg_chat_messages WHERE chat_id = ?`,
    ).get(chatId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  async hasMessages(chatId: string): Promise<boolean> {
    const count = await this.getMessageCount(chatId);
    return count > 0;
  }

  async deleteForChat(chatId: string): Promise<number> {
    const db = this.getDatabase();
    const result = db.prepare('DELETE FROM tg_chat_messages WHERE chat_id = ?').run(chatId);
    return (result as unknown as { changes: number }).changes;
  }

  // ─── Chat Profiles ──────────────────────────────────────────────────────

  async getChatProfile(chatId: string): Promise<TgChatProfile | null> {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM tg_chat_profiles WHERE chat_id = ?').get(chatId) as ProfileRow | undefined;
    return row ? this.rowToProfile(row) : null;
  }

  async saveChatProfile(profile: TgChatProfile): Promise<void> {
    const db = this.getDatabase();
    db.prepare(
      `INSERT INTO tg_chat_profiles
        (chat_id, chat_type, language, owner_style_summary, owner_style_examples,
         chat_topic_summary, participant_summary, last_profiled_at, total_messages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         chat_type = excluded.chat_type,
         language = excluded.language,
         owner_style_summary = excluded.owner_style_summary,
         owner_style_examples = excluded.owner_style_examples,
         chat_topic_summary = excluded.chat_topic_summary,
         participant_summary = excluded.participant_summary,
         last_profiled_at = excluded.last_profiled_at,
         total_messages = excluded.total_messages`,
    ).run(
      profile.chatId, profile.chatType, profile.language,
      profile.ownerStyleSummary, JSON.stringify(profile.ownerStyleExamples),
      profile.chatTopicSummary, profile.participantSummary,
      profile.lastProfiledAt, profile.totalMessages,
    );
  }

  async deleteChatProfile(chatId: string): Promise<void> {
    const db = this.getDatabase();
    db.prepare('DELETE FROM tg_chat_profiles WHERE chat_id = ?').run(chatId);
  }

  private rowToProfile(row: ProfileRow): TgChatProfile {
    let examples: string[] = [];
    try {
      examples = JSON.parse(row.owner_style_examples);
    } catch {
      examples = [];
    }

    return {
      chatId: row.chat_id,
      chatType: (row.chat_type || 'unknown') as TgChatType,
      language: row.language,
      ownerStyleSummary: row.owner_style_summary,
      ownerStyleExamples: examples,
      chatTopicSummary: row.chat_topic_summary,
      participantSummary: row.participant_summary,
      lastProfiledAt: row.last_profiled_at,
      totalMessages: row.total_messages,
    };
  }

  // ─── Database ───────────────────────────────────────────────────────────

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
      CREATE TABLE IF NOT EXISTS tg_chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        tg_message_id INTEGER NOT NULL,
        sender_id TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        is_outgoing INTEGER NOT NULL DEFAULT 0,
        reply_to_id INTEGER,
        timestamp TEXT NOT NULL,
        UNIQUE(chat_id, tg_message_id)
      )
    `);

    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_chat_ts ON tg_chat_messages (chat_id, timestamp)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_chat_outgoing ON tg_chat_messages (chat_id, is_outgoing)');

    database.exec(`
      CREATE TABLE IF NOT EXISTS tg_chat_profiles (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL DEFAULT 'unknown',
        language TEXT NOT NULL DEFAULT 'auto',
        owner_style_summary TEXT NOT NULL DEFAULT '',
        owner_style_examples TEXT NOT NULL DEFAULT '[]',
        chat_topic_summary TEXT NOT NULL DEFAULT '',
        participant_summary TEXT NOT NULL DEFAULT '',
        last_profiled_at TEXT NOT NULL,
        total_messages INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.database = database;
    this.logger.log('SQLite tg_chat_messages + tg_chat_profiles tables initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private rowToMessage(row: MessageRow): TgStoredMessage {
    return {
      id: row.id,
      chatId: row.chat_id,
      tgMessageId: row.tg_message_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      text: row.text,
      isOutgoing: row.is_outgoing === 1,
      replyToId: row.reply_to_id,
      timestamp: row.timestamp,
    };
  }
}
