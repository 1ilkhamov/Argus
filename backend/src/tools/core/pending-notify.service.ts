import { Injectable, Logger } from '@nestjs/common';

/**
 * Tracks pending notify requests from tg-client conversations.
 * When the agent calls `notify` from a tg-client scope, we store the source chat info.
 * The bot can then route the owner's reply back to the correct chat.
 */

export interface PendingNotify {
  /** Source tg-client chat ID (e.g. "-1002083278583") */
  chatId: string;
  /** Human-readable chat title */
  chatTitle: string;
  /** Original question/request text */
  question: string;
  /** Timestamp when the notify was created */
  createdAt: number;
}

/** TTL for pending notifies (10 minutes) */
const PENDING_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class PendingNotifyService {
  private readonly logger = new Logger(PendingNotifyService.name);

  /**
   * Bot message ID → pending notify info.
   * Keyed by the Telegram message ID of the notification sent to the owner.
   */
  private readonly pending = new Map<number, PendingNotify>();

  /**
   * Bot chat ID → target chat ID.
   * When the owner taps "Ответить", we store their bot chatId → target chatId
   * so the NEXT text message from them is routed to the target chat.
   */
  private readonly awaitingReply = new Map<number, PendingNotify>();

  /** Store a pending notify keyed by the bot message ID */
  setPending(botMessageId: number, info: PendingNotify): void {
    this.pending.set(botMessageId, info);
    this.logger.debug(`Pending notify stored: msg=${botMessageId} → chat="${info.chatTitle}" (${info.chatId})`);
    this.cleanup();
  }

  /** Get pending notify by bot message ID */
  getPending(botMessageId: number): PendingNotify | undefined {
    return this.pending.get(botMessageId);
  }

  /** Mark that the owner is about to reply — next text message should be routed */
  setAwaitingReply(botChatId: number, info: PendingNotify): void {
    this.awaitingReply.set(botChatId, info);
    this.logger.debug(`Awaiting reply from bot chat ${botChatId} → "${info.chatTitle}"`);
  }

  /** Check and consume awaiting reply for a bot chat */
  consumeAwaitingReply(botChatId: number): PendingNotify | undefined {
    const info = this.awaitingReply.get(botChatId);
    if (info) {
      this.awaitingReply.delete(botChatId);
    }
    return info;
  }

  /** Remove expired entries */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, info] of this.pending) {
      if (now - info.createdAt > PENDING_TTL_MS) {
        this.pending.delete(id);
      }
    }
  }
}
