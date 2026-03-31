import { Injectable, Logger } from '@nestjs/common';

import { PendingNotifyRepository } from './pending-notify.repository';
import { PENDING_TTL_MS, type PendingNotify, type PendingNotifySnapshot } from './pending-notify.types';

export type { PendingNotify, PendingNotifySnapshot } from './pending-notify.types';

/**
 * Tracks pending notify requests from tg-client conversations.
 * When the agent calls `notify` from a tg-client scope, we store the source chat info.
 * The bot can then route the owner's reply back to the correct chat.
 */

@Injectable()
export class PendingNotifyService {
  private readonly logger = new Logger(PendingNotifyService.name);

  constructor(
    private readonly repository: PendingNotifyRepository,
  ) {}

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
    this.repository.setPending(botMessageId, info);
    this.logger.debug(`Pending notify stored: msg=${botMessageId} → chat="${info.chatTitle}" (${info.chatId})`);
    this.cleanup();
  }

  /** Get pending notify by bot message ID */
  getPending(botMessageId: number): PendingNotify | undefined {
    this.cleanup();
    const cached = this.pending.get(botMessageId);
    if (cached) {
      return cached;
    }

    const stored = this.repository.getPending(botMessageId);
    if (stored) {
      this.pending.set(botMessageId, stored);
    }
    return stored;
  }

  /** Mark that the owner is about to reply — next text message should be routed */
  setAwaitingReply(botChatId: number, info: PendingNotify): void {
    this.awaitingReply.set(botChatId, info);
    this.repository.setAwaitingReply(botChatId, info);
    this.logger.debug(`Awaiting reply from bot chat ${botChatId} → "${info.chatTitle}"`);
    this.cleanup();
  }

  getAwaitingReply(botChatId: number): PendingNotify | undefined {
    this.cleanup();
    const cached = this.awaitingReply.get(botChatId);
    if (cached) {
      return cached;
    }

    const stored = this.repository.getAwaitingReply(botChatId);
    if (stored) {
      this.awaitingReply.set(botChatId, stored);
    }
    return stored;
  }

  /** Check and consume awaiting reply for a bot chat */
  consumeAwaitingReply(botChatId: number): PendingNotify | undefined {
    this.cleanup();
    this.awaitingReply.delete(botChatId);
    return this.repository.consumeAwaitingReply(botChatId);
  }

  completeAwaitingReply(botChatId: number, replyText: string, correlationId: string | null): void {
    this.cleanup();
    this.awaitingReply.delete(botChatId);
    this.repository.completeAwaitingReply(botChatId, { replyText, correlationId });
  }

  getSnapshot(limit: number = 50): PendingNotifySnapshot {
    this.cleanup();
    return {
      pendingMessages: this.repository.listPending(limit),
      awaitingReplies: this.repository.listAwaitingReplies(limit),
      recentRoutes: this.repository.listRecentRoutes(limit),
    };
  }

  /** Remove expired entries */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, info] of this.pending) {
      if (now - info.createdAt > PENDING_TTL_MS) {
        this.pending.delete(id);
      }
    }

    for (const [id, info] of this.awaitingReply) {
      if (now - info.createdAt > PENDING_TTL_MS) {
        this.awaitingReply.delete(id);
      }
    }
  }
}
