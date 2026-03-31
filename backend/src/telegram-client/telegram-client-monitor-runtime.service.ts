import { Injectable } from '@nestjs/common';

import { TelegramClientMonitorRuntimeRepository } from './telegram-client-monitor-runtime.repository';
import type {
  TelegramClientMonitorRuntimeContext,
  TelegramClientMonitorRuntimeState,
} from './telegram-client-monitor-runtime.types';

@Injectable()
export class TelegramClientMonitorRuntimeService {
  constructor(
    private readonly repository: TelegramClientMonitorRuntimeRepository,
  ) {}

  async listStates(): Promise<TelegramClientMonitorRuntimeState[]> {
    return this.repository.findAll();
  }

  observeInbound(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      lastInboundMessageId: context.messageId ?? null,
      lastInboundSenderName: context.senderName ?? null,
      lastInboundAt: context.observedAt ?? new Date().toISOString(),
    });
  }

  recordQueued(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: 'queued',
      queueLength: context.queueLength ?? 0,
      queueActive: context.queueActive ?? false,
      lastInboundMessageId: context.messageId ?? null,
      lastInboundSenderName: context.senderName ?? null,
      lastInboundAt: context.observedAt ?? new Date().toISOString(),
      cooldownUntil: null,
      lastErrorMessage: null,
    });
  }

  recordCooldown(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: 'cooldown',
      queueLength: context.queueLength ?? 0,
      queueActive: true,
      cooldownUntil: context.cooldownUntil ?? null,
      lastErrorMessage: null,
    });
  }

  recordProcessing(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: 'processing',
      queueLength: context.queueLength ?? 0,
      queueActive: true,
      cooldownUntil: null,
      lastProcessedAt: context.observedAt ?? new Date().toISOString(),
      lastErrorMessage: null,
    });
  }

  recordReplySent(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    const queueLength = context.queueLength ?? 0;
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: queueLength > 0 ? 'queued' : 'idle',
      queueLength,
      queueActive: queueLength > 0,
      lastReplyMessageId: context.replyMessageId ?? null,
      lastReplyAt: context.observedAt ?? new Date().toISOString(),
      lastConversationId: context.conversationId ?? null,
      cooldownUntil: null,
      lastProcessedAt: context.observedAt ?? new Date().toISOString(),
      lastErrorMessage: null,
    });
  }

  recordManual(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: 'manual',
      queueLength: context.queueLength ?? 0,
      queueActive: context.queueActive ?? false,
      lastConversationId: context.conversationId ?? null,
      cooldownUntil: null,
      lastProcessedAt: context.observedAt ?? new Date().toISOString(),
      lastErrorMessage: null,
    });
  }

  recordError(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: 'error',
      queueLength: context.queueLength ?? 0,
      queueActive: context.queueActive ?? false,
      cooldownUntil: null,
      lastProcessedAt: context.observedAt ?? new Date().toISOString(),
      lastErrorMessage: context.errorMessage ?? 'Unknown error',
    });
  }

  recordIdle(context: TelegramClientMonitorRuntimeContext): Promise<TelegramClientMonitorRuntimeState> {
    const queueLength = context.queueLength ?? 0;
    return this.repository.upsert({
      chatId: context.monitoredChat.chatId,
      monitoredChatId: context.monitoredChat.id,
      chatTitle: context.monitoredChat.chatTitle,
      mode: context.monitoredChat.mode,
      status: queueLength > 0 ? 'queued' : 'idle',
      queueLength,
      queueActive: queueLength > 0,
      lastConversationId: context.conversationId ?? null,
      cooldownUntil: null,
      lastProcessedAt: context.observedAt ?? new Date().toISOString(),
      lastErrorMessage: null,
    });
  }
}
