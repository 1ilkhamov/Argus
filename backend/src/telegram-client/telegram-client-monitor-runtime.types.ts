import type { TgChatMode, TgMonitoredChat } from './telegram-client.types';

export const TELEGRAM_CLIENT_MONITOR_STATUSES = ['idle', 'queued', 'cooldown', 'processing', 'manual', 'error'] as const;
export type TelegramClientMonitorStatus = (typeof TELEGRAM_CLIENT_MONITOR_STATUSES)[number];

export interface TelegramClientMonitorRuntimeState {
  chatId: string;
  monitoredChatId: string;
  chatTitle: string;
  mode: TgChatMode;
  status: TelegramClientMonitorStatus;
  queueLength: number;
  queueActive: boolean;
  lastInboundMessageId: number | null;
  lastInboundSenderName: string | null;
  lastInboundAt: string | null;
  lastReplyMessageId: number | null;
  lastReplyAt: string | null;
  lastConversationId: string | null;
  cooldownUntil: string | null;
  lastProcessedAt: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
}

export interface UpsertTelegramClientMonitorRuntimeStateParams {
  chatId: string;
  monitoredChatId: string;
  chatTitle: string;
  mode: TgChatMode;
  status?: TelegramClientMonitorStatus;
  queueLength?: number;
  queueActive?: boolean;
  lastInboundMessageId?: number | null;
  lastInboundSenderName?: string | null;
  lastInboundAt?: string | null;
  lastReplyMessageId?: number | null;
  lastReplyAt?: string | null;
  lastConversationId?: string | null;
  cooldownUntil?: string | null;
  lastProcessedAt?: string | null;
  lastErrorMessage?: string | null;
}

export interface TelegramClientMonitorRuntimeContext {
  monitoredChat: TgMonitoredChat;
  queueLength?: number;
  queueActive?: boolean;
  messageId?: number;
  senderName?: string;
  conversationId?: string;
  replyMessageId?: number;
  cooldownUntil?: string | null;
  errorMessage?: string | null;
  observedAt?: string;
}
