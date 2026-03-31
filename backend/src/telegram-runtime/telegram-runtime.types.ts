import type { TgChatMode } from '../telegram-client/telegram-client.types';

export const TELEGRAM_OUTBOUND_CHANNELS = ['telegram_client', 'telegram_bot'] as const;
export type TelegramOutboundChannel = (typeof TELEGRAM_OUTBOUND_CHANNELS)[number];

export const TELEGRAM_OUTBOUND_ACTIONS = ['send_message', 'notify'] as const;
export type TelegramOutboundAction = (typeof TELEGRAM_OUTBOUND_ACTIONS)[number];

export const TELEGRAM_OUTBOUND_ACTORS = ['human', 'agent', 'cron', 'watchdog', 'notify_reply', 'system'] as const;
export type TelegramOutboundActor = (typeof TELEGRAM_OUTBOUND_ACTORS)[number];

export const TELEGRAM_OUTBOUND_ORIGINS = [
  'telegram_client_tool',
  'telegram_client_listener',
  'telegram_update_handler',
  'notify_tool',
  'cron_executor',
  'hook_executor',
  'telegram_watchdog',
  'telegram_message_sender',
  'system',
] as const;
export type TelegramOutboundOrigin = (typeof TELEGRAM_OUTBOUND_ORIGINS)[number];

export const TELEGRAM_POLICY_DECISIONS = ['allow', 'deny'] as const;
export type TelegramPolicyDecision = (typeof TELEGRAM_POLICY_DECISIONS)[number];

export const TELEGRAM_OUTBOUND_RESULTS = ['attempted', 'sent', 'blocked', 'failed'] as const;
export type TelegramOutboundResult = (typeof TELEGRAM_OUTBOUND_RESULTS)[number];

export const TELEGRAM_POLICY_REASON_CODES = [
  'ALLOW_BOT_CHANNEL',
  'ALLOW_AUTO_MODE',
  'ALLOW_MANUAL_HUMAN_CONTROL',
  'ALLOW_UNMONITORED_HUMAN_CONTROL',
  'DENY_DISABLED_MODE',
  'DENY_READ_ONLY_MODE',
  'DENY_MANUAL_MODE_AUTOMATION',
  'DENY_UNMONITORED_AUTOMATION',
] as const;
export type TelegramPolicyReasonCode = (typeof TELEGRAM_POLICY_REASON_CODES)[number];

export interface TelegramOutboundContext {
  actor: TelegramOutboundActor;
  origin: TelegramOutboundOrigin;
  scopeKey?: string;
  conversationId?: string;
  correlationId?: string;
}

export interface TelegramPolicyEvaluationInput extends TelegramOutboundContext {
  channel: TelegramOutboundChannel;
  action: TelegramOutboundAction;
  chatId?: string | null;
  chatTitle?: string | null;
  monitoredChatId?: string | null;
  monitoredMode?: TgChatMode | null;
}

export interface TelegramPolicyEvaluation {
  decision: TelegramPolicyDecision;
  reasonCode: TelegramPolicyReasonCode;
  message: string;
}

export interface TelegramOutboundAuditEvent {
  id: string;
  channel: TelegramOutboundChannel;
  action: TelegramOutboundAction;
  actor: TelegramOutboundActor;
  origin: TelegramOutboundOrigin;
  targetChatId: string | null;
  targetChatTitle: string | null;
  monitoredChatId: string | null;
  monitoredMode: TgChatMode | null;
  scopeKey: string | null;
  conversationId: string | null;
  correlationId: string | null;
  policyDecision: TelegramPolicyDecision;
  policyReasonCode: TelegramPolicyReasonCode;
  result: TelegramOutboundResult;
  payloadPreview: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTelegramOutboundAuditEventParams {
  channel: TelegramOutboundChannel;
  action: TelegramOutboundAction;
  actor: TelegramOutboundActor;
  origin: TelegramOutboundOrigin;
  targetChatId?: string | null;
  targetChatTitle?: string | null;
  monitoredChatId?: string | null;
  monitoredMode?: TgChatMode | null;
  scopeKey?: string | null;
  conversationId?: string | null;
  correlationId?: string | null;
  policyDecision: TelegramPolicyDecision;
  policyReasonCode: TelegramPolicyReasonCode;
  result: TelegramOutboundResult;
  payloadPreview?: string | null;
  errorMessage?: string | null;
}

export interface SearchTelegramOutboundAuditEventsParams {
  channel?: TelegramOutboundChannel;
  actor?: TelegramOutboundActor;
  origin?: TelegramOutboundOrigin;
  result?: TelegramOutboundResult;
  policyDecision?: TelegramPolicyDecision;
  targetChatId?: string;
  correlationId?: string;
  before?: string;
  after?: string;
  limit?: number;
}
