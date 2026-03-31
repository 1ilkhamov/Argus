import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SettingsService } from '../settings/settings.service';
import { TelegramClientMessagesRepository } from '../telegram-client/telegram-client-messages.repository';
import { TelegramClientRepository } from '../telegram-client/telegram-client.repository';
import type { TgMonitoredChat, TgStoredMessage } from '../telegram-client/telegram-client.types';
import { TelegramOutboundService } from '../telegram-runtime/telegram-outbound.service';
import { PendingNotifyService } from '../tools/core/pending-notify.service';
import { MonitorRepository } from './monitor.repository';
import type {
  CreateTelegramWatchRuleParams,
  TelegramWatchAlertRecord,
  TelegramWatchEvaluationResult,
  TelegramWatchRule,
  TelegramWatchState,
  UpdateTelegramWatchRuleParams,
} from './monitor.types';

@Injectable()
export class TelegramWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramWatchdogService.name);
  private readonly envTelegramBotToken: string;
  private readonly envTelegramChatId: string;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly monitorRepository: MonitorRepository,
    private readonly monitoredChatRepository: TelegramClientRepository,
    private readonly messagesRepository: TelegramClientMessagesRepository,
    private readonly pendingNotify: PendingNotifyService,
    private readonly outboundService: TelegramOutboundService,
  ) {
    this.envTelegramBotToken = this.configService.get<string>('tools.notify.telegramBotToken', '');
    this.envTelegramChatId = this.configService.get<string>('tools.notify.telegramChatId', '');
    const intervalSeconds = Number(this.configService.get<number>('monitors.telegramWatchdog.intervalSeconds', 30)) || 30;
    this.intervalMs = Math.max(10, Math.floor(intervalSeconds)) * 1000;
  }

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async listRules(): Promise<TelegramWatchRule[]> {
    return this.monitorRepository.listRules();
  }

  async listStates(): Promise<TelegramWatchState[]> {
    return this.monitorRepository.listStates();
  }

  async listEvaluations(ruleId?: string, limit = 50): Promise<TelegramWatchEvaluationResult[]> {
    return this.monitorRepository.listEvaluations(ruleId, limit);
  }

  async listAlertHistory(ruleId?: string, limit = 50): Promise<TelegramWatchAlertRecord[]> {
    return this.monitorRepository.listAlertHistory(ruleId, limit);
  }

  async createRule(params: CreateTelegramWatchRuleParams): Promise<TelegramWatchRule> {
    const monitoredChat = await this.requireMonitoredChat(params.monitoredChatId);
    const existing = await this.monitorRepository.findRuleByMonitoredChatId(params.monitoredChatId);
    if (existing) {
      throw new Error(`A monitor rule already exists for chat "${monitoredChat.chatTitle}".`);
    }

    return this.monitorRepository.createRule({
      ...params,
      name: params.name?.trim() || `Unanswered messages in ${monitoredChat.chatTitle}`,
    });
  }

  async updateRule(id: string, updates: UpdateTelegramWatchRuleParams): Promise<TelegramWatchRule> {
    const rule = await this.requireRule(id);

    if (updates.monitoredChatId && updates.monitoredChatId !== rule.monitoredChatId) {
      const monitoredChat = await this.requireMonitoredChat(updates.monitoredChatId);
      const conflicting = await this.monitorRepository.findRuleByMonitoredChatId(updates.monitoredChatId);
      if (conflicting && conflicting.id !== id) {
        throw new Error(`A monitor rule already exists for chat "${monitoredChat.chatTitle}".`);
      }
    }

    await this.monitorRepository.updateRule(id, updates);
    return this.requireRule(id);
  }

  async deleteRule(id: string): Promise<boolean> {
    return this.monitorRepository.deleteRule(id);
  }

  async runRule(id: string): Promise<TelegramWatchEvaluationResult> {
    const rule = await this.requireRule(id);
    return this.evaluateRule(rule);
  }

  async evaluateAllRules(): Promise<TelegramWatchEvaluationResult[]> {
    if (this.running) {
      return [];
    }

    this.running = true;
    try {
      const rules = await this.monitorRepository.listEnabledRules();
      const results: TelegramWatchEvaluationResult[] = [];
      for (const rule of rules) {
        results.push(await this.evaluateRule(rule));
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  private start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.evaluateAllRules().catch((err) => {
        this.logger.error(`Telegram watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.intervalMs);

    void this.evaluateAllRules().catch((err) => {
      this.logger.error(`Initial Telegram watchdog evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async evaluateRule(rule: TelegramWatchRule): Promise<TelegramWatchEvaluationResult> {
    const evaluatedAt = new Date().toISOString();
    const currentState = await this.monitorRepository.findStateByRuleId(rule.id);

    if (!rule.enabled) {
      return this.persistOutcome(rule, {
        chatId: currentState?.chatId ?? null,
        chatTitle: currentState?.chatTitle ?? null,
        stateStatus: 'paused',
        evaluationStatus: 'paused',
        lastInboundMessageId: currentState?.lastInboundMessageId ?? null,
        lastInboundSenderName: currentState?.lastInboundSenderName ?? null,
        lastInboundAt: currentState?.lastInboundAt ?? null,
        lastOwnerReplyMessageId: currentState?.lastOwnerReplyMessageId ?? null,
        lastOwnerReplyAt: currentState?.lastOwnerReplyAt ?? null,
        unansweredSince: currentState?.unansweredSince ?? null,
        lastAlertedAt: currentState?.lastAlertedAt ?? null,
        dedupeKey: currentState?.dedupeKey ?? null,
        correlationId: null,
        alertTriggered: false,
        message: 'Monitor rule is disabled.',
        evaluatedAt,
      });
    }

    const monitoredChat = await this.monitoredChatRepository.findById(rule.monitoredChatId);
    if (!monitoredChat) {
      return this.persistOutcome(rule, {
        chatId: currentState?.chatId ?? null,
        chatTitle: currentState?.chatTitle ?? null,
        stateStatus: 'error',
        evaluationStatus: 'error',
        lastInboundMessageId: currentState?.lastInboundMessageId ?? null,
        lastInboundSenderName: currentState?.lastInboundSenderName ?? null,
        lastInboundAt: currentState?.lastInboundAt ?? null,
        lastOwnerReplyMessageId: currentState?.lastOwnerReplyMessageId ?? null,
        lastOwnerReplyAt: currentState?.lastOwnerReplyAt ?? null,
        unansweredSince: currentState?.unansweredSince ?? null,
        lastAlertedAt: currentState?.lastAlertedAt ?? null,
        dedupeKey: currentState?.dedupeKey ?? null,
        correlationId: null,
        alertTriggered: false,
        message: `Monitored chat ${rule.monitoredChatId} no longer exists.`,
        evaluatedAt,
      });
    }

    const latestInbound = await this.messagesRepository.getLatestIncoming(monitoredChat.chatId);
    const latestOutgoing = await this.messagesRepository.getLatestOutgoing(monitoredChat.chatId);

    if (!latestInbound) {
      return this.persistOutcome(rule, {
        chatId: monitoredChat.chatId,
        chatTitle: monitoredChat.chatTitle,
        stateStatus: 'idle',
        evaluationStatus: 'noop',
        lastInboundMessageId: null,
        lastInboundSenderName: null,
        lastInboundAt: null,
        lastOwnerReplyMessageId: latestOutgoing?.tgMessageId ?? null,
        lastOwnerReplyAt: latestOutgoing?.timestamp ?? null,
        unansweredSince: null,
        lastAlertedAt: currentState?.lastAlertedAt ?? null,
        dedupeKey: null,
        correlationId: null,
        alertTriggered: false,
        message: 'No inbound Telegram messages observed for this chat yet.',
        evaluatedAt,
      });
    }

    const dedupeKey = this.buildDedupeKey(rule, latestInbound);
    const ownerRepliedAfterInbound = Boolean(latestOutgoing && latestOutgoing.timestamp >= latestInbound.timestamp);

    if (ownerRepliedAfterInbound) {
      const evaluationStatus = currentState?.dedupeKey === dedupeKey && currentState.lastAlertedAt ? 'resolved' : 'noop';
      return this.persistOutcome(rule, {
        chatId: monitoredChat.chatId,
        chatTitle: monitoredChat.chatTitle,
        stateStatus: 'idle',
        evaluationStatus,
        lastInboundMessageId: latestInbound.tgMessageId,
        lastInboundSenderName: latestInbound.senderName,
        lastInboundAt: latestInbound.timestamp,
        lastOwnerReplyMessageId: latestOutgoing?.tgMessageId ?? null,
        lastOwnerReplyAt: latestOutgoing?.timestamp ?? null,
        unansweredSince: null,
        lastAlertedAt: currentState?.lastAlertedAt ?? null,
        dedupeKey,
        correlationId: currentState?.dedupeKey === dedupeKey && currentState.lastAlertedAt
          ? this.buildCorrelationId(rule, latestInbound)
          : null,
        alertTriggered: false,
        message: currentState?.dedupeKey === dedupeKey && currentState.lastAlertedAt
          ? 'Owner replied after the unanswered message alert.'
          : 'Latest inbound message already has an owner reply.',
        evaluatedAt,
      });
    }

    const ageMs = Math.max(0, Date.now() - new Date(latestInbound.timestamp).getTime());
    if (ageMs < rule.thresholdSeconds * 1000) {
      return this.persistOutcome(rule, {
        chatId: monitoredChat.chatId,
        chatTitle: monitoredChat.chatTitle,
        stateStatus: 'unanswered',
        evaluationStatus: 'observed',
        lastInboundMessageId: latestInbound.tgMessageId,
        lastInboundSenderName: latestInbound.senderName,
        lastInboundAt: latestInbound.timestamp,
        lastOwnerReplyMessageId: latestOutgoing?.tgMessageId ?? null,
        lastOwnerReplyAt: latestOutgoing?.timestamp ?? null,
        unansweredSince: latestInbound.timestamp,
        lastAlertedAt: currentState?.lastAlertedAt ?? null,
        dedupeKey,
        correlationId: null,
        alertTriggered: false,
        message: `Inbound message is waiting for owner reply (${this.formatDuration(ageMs)} elapsed, threshold ${this.formatDuration(rule.thresholdSeconds * 1000)}).`,
        evaluatedAt,
      });
    }

    const correlationId = this.buildCorrelationId(rule, latestInbound);
    if (currentState?.dedupeKey === dedupeKey && currentState.lastAlertedAt) {
      return this.persistOutcome(rule, {
        chatId: monitoredChat.chatId,
        chatTitle: monitoredChat.chatTitle,
        stateStatus: 'alerted',
        evaluationStatus: 'deduped',
        lastInboundMessageId: latestInbound.tgMessageId,
        lastInboundSenderName: latestInbound.senderName,
        lastInboundAt: latestInbound.timestamp,
        lastOwnerReplyMessageId: latestOutgoing?.tgMessageId ?? null,
        lastOwnerReplyAt: latestOutgoing?.timestamp ?? null,
        unansweredSince: latestInbound.timestamp,
        lastAlertedAt: currentState.lastAlertedAt,
        dedupeKey,
        correlationId,
        alertTriggered: false,
        message: 'Alert already exists for this unanswered message; skipping duplicate notify.',
        evaluatedAt,
      });
    }

    try {
      await this.sendAlert(rule, monitoredChat, latestInbound, ageMs, correlationId);
      return this.persistOutcome(rule, {
        chatId: monitoredChat.chatId,
        chatTitle: monitoredChat.chatTitle,
        stateStatus: 'alerted',
        evaluationStatus: 'alerted',
        lastInboundMessageId: latestInbound.tgMessageId,
        lastInboundSenderName: latestInbound.senderName,
        lastInboundAt: latestInbound.timestamp,
        lastOwnerReplyMessageId: latestOutgoing?.tgMessageId ?? null,
        lastOwnerReplyAt: latestOutgoing?.timestamp ?? null,
        unansweredSince: latestInbound.timestamp,
        lastAlertedAt: evaluatedAt,
        dedupeKey,
        correlationId,
        alertTriggered: true,
        message: `Alert sent for unanswered Telegram message after ${this.formatDuration(ageMs)}.`,
        evaluatedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.persistOutcome(rule, {
        chatId: monitoredChat.chatId,
        chatTitle: monitoredChat.chatTitle,
        stateStatus: 'error',
        evaluationStatus: 'error',
        lastInboundMessageId: latestInbound.tgMessageId,
        lastInboundSenderName: latestInbound.senderName,
        lastInboundAt: latestInbound.timestamp,
        lastOwnerReplyMessageId: latestOutgoing?.tgMessageId ?? null,
        lastOwnerReplyAt: latestOutgoing?.timestamp ?? null,
        unansweredSince: latestInbound.timestamp,
        lastAlertedAt: currentState?.lastAlertedAt ?? null,
        dedupeKey,
        correlationId,
        alertTriggered: false,
        message: `Failed to send unanswered-message alert: ${message}`,
        evaluatedAt,
      });
    }
  }

  private async persistOutcome(
    rule: TelegramWatchRule,
    params: {
      chatId: string | null;
      chatTitle: string | null;
      stateStatus: TelegramWatchState['status'];
      evaluationStatus: TelegramWatchEvaluationResult['evaluationStatus'];
      lastInboundMessageId: number | null;
      lastInboundSenderName: string | null;
      lastInboundAt: string | null;
      lastOwnerReplyMessageId: number | null;
      lastOwnerReplyAt: string | null;
      unansweredSince: string | null;
      lastAlertedAt: string | null;
      dedupeKey: string | null;
      correlationId: string | null;
      alertTriggered: boolean;
      message: string;
      evaluatedAt: string;
    },
  ): Promise<TelegramWatchEvaluationResult> {
    await this.monitorRepository.upsertState({
      ruleId: rule.id,
      ruleType: rule.ruleType,
      monitoredChatId: rule.monitoredChatId,
      chatId: params.chatId,
      chatTitle: params.chatTitle,
      status: params.stateStatus,
      lastInboundMessageId: params.lastInboundMessageId,
      lastInboundSenderName: params.lastInboundSenderName,
      lastInboundAt: params.lastInboundAt,
      lastOwnerReplyMessageId: params.lastOwnerReplyMessageId,
      lastOwnerReplyAt: params.lastOwnerReplyAt,
      unansweredSince: params.unansweredSince,
      lastEvaluatedAt: params.evaluatedAt,
      lastAlertedAt: params.lastAlertedAt,
      dedupeKey: params.dedupeKey,
      lastEvaluationStatus: params.evaluationStatus,
      lastEvaluationMessage: params.message,
    });

    return this.monitorRepository.createEvaluation({
      ruleId: rule.id,
      ruleType: rule.ruleType,
      monitoredChatId: rule.monitoredChatId,
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
      evaluatedAt: params.evaluatedAt,
    });
  }

  private async sendAlert(
    rule: TelegramWatchRule,
    monitoredChat: TgMonitoredChat,
    latestInbound: TgStoredMessage,
    ageMs: number,
    correlationId: string,
  ): Promise<void> {
    const { botToken, chatId } = await this.resolveTelegramCredentials();
    if (!botToken || !chatId) {
      throw new Error('Telegram watchdog notifications are not configured. Set telegram.bot_token and tools.notify.telegram_chat_id.');
    }

    const text = this.buildAlertMessage(rule, monitoredChat, latestInbound, ageMs);
    await this.outboundService.executeSend(
      {
        channel: 'telegram_bot',
        action: 'notify',
        actor: 'watchdog',
        origin: 'telegram_watchdog',
        chatId,
        chatTitle: 'owner-monitor-alerts',
        monitoredChatId: monitoredChat.id,
        monitoredMode: monitoredChat.mode,
        scopeKey: `monitor:${rule.id}`,
        correlationId,
        payloadPreview: text,
      },
      async () => {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            reply_markup: {
              inline_keyboard: [
                [{ text: `📩 Ответить в "${monitoredChat.chatTitle}"`, callback_data: `notify_reply:${monitoredChat.chatId}` }],
              ],
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });

        const json = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };
        if (!response.ok || !json.ok) {
          throw new Error(`Telegram send failed (${response.status})${json.description ? `: ${json.description}` : ''}`);
        }

        if (json.result?.message_id) {
          this.pendingNotify.setPending(json.result.message_id, {
            chatId: monitoredChat.chatId,
            chatTitle: monitoredChat.chatTitle,
            question: latestInbound.text,
            createdAt: Date.now(),
          });
        }
      },
    );
  }

  private async resolveTelegramCredentials(): Promise<{ botToken: string; chatId: string }> {
    const botToken =
      (await this.settingsService.getValue('telegram.bot_token')) || this.envTelegramBotToken;
    let chatId =
      (await this.settingsService.getValue('tools.notify.telegram_chat_id')) || this.envTelegramChatId;

    if (!chatId) {
      const allowedUsersRaw =
        (await this.settingsService.getValue('telegram.allowed_users')) ||
        this.configService.get<string>('telegram.allowedUsers', '');
      const allowedUsers = Array.isArray(allowedUsersRaw)
        ? allowedUsersRaw
        : String(allowedUsersRaw).split(',').map((value) => value.trim()).filter(Boolean);
      if (allowedUsers.length > 0) {
        chatId = String(allowedUsers[0]);
      }
    }

    return { botToken: String(botToken || ''), chatId: String(chatId || '') };
  }

  private async requireRule(id: string): Promise<TelegramWatchRule> {
    const rule = await this.monitorRepository.findRuleById(id);
    if (!rule) {
      throw new Error(`Monitor rule ${id} not found.`);
    }
    return rule;
  }

  private async requireMonitoredChat(id: string): Promise<TgMonitoredChat> {
    const monitoredChat = await this.monitoredChatRepository.findById(id);
    if (!monitoredChat) {
      throw new Error(`Monitored chat ${id} not found.`);
    }
    return monitoredChat;
  }

  private buildDedupeKey(rule: TelegramWatchRule, latestInbound: TgStoredMessage): string {
    return `${rule.ruleType}:${rule.id}:${latestInbound.tgMessageId}`;
  }

  private buildCorrelationId(rule: TelegramWatchRule, latestInbound: TgStoredMessage): string {
    return `watchdog:${rule.id}:${latestInbound.tgMessageId}`;
  }

  private buildAlertMessage(
    rule: TelegramWatchRule,
    monitoredChat: TgMonitoredChat,
    latestInbound: TgStoredMessage,
    ageMs: number,
  ): string {
    const snippet = this.truncate(latestInbound.text.replace(/\s+/g, ' ').trim(), 500);
    return [
      '⚠️ Неотвеченное сообщение в Telegram',
      `Чат: ${monitoredChat.chatTitle}`,
      `От: ${latestInbound.senderName || 'Unknown'}`,
      `Ждёт ответа: ${this.formatDuration(ageMs)}`,
      `Порог monitor: ${this.formatDuration(rule.thresholdSeconds * 1000)}`,
      '',
      snippet || '(пустое сообщение)',
    ].join('\n');
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
  }
}
