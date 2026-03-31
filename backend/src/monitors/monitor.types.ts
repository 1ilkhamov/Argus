export const TELEGRAM_WATCH_RULE_TYPES = ['telegram_unanswered_message_monitor'] as const;
export type TelegramWatchRuleType = (typeof TELEGRAM_WATCH_RULE_TYPES)[number];

export const TELEGRAM_WATCH_STATE_STATUSES = ['idle', 'unanswered', 'alerted', 'paused', 'error'] as const;
export type TelegramWatchStateStatus = (typeof TELEGRAM_WATCH_STATE_STATUSES)[number];

export const TELEGRAM_WATCH_EVALUATION_STATUSES = ['noop', 'observed', 'alerted', 'deduped', 'resolved', 'paused', 'error'] as const;
export type TelegramWatchEvaluationStatus = (typeof TELEGRAM_WATCH_EVALUATION_STATUSES)[number];

export interface TelegramWatchRule {
  id: string;
  ruleType: TelegramWatchRuleType;
  monitoredChatId: string;
  name: string;
  thresholdSeconds: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTelegramWatchRuleParams {
  monitoredChatId: string;
  name?: string;
  thresholdSeconds?: number;
  enabled?: boolean;
}

export interface UpdateTelegramWatchRuleParams {
  monitoredChatId?: string;
  name?: string;
  thresholdSeconds?: number;
  enabled?: boolean;
}

export interface TelegramWatchState {
  ruleId: string;
  ruleType: TelegramWatchRuleType;
  monitoredChatId: string;
  chatId: string | null;
  chatTitle: string | null;
  status: TelegramWatchStateStatus;
  lastInboundMessageId: number | null;
  lastInboundSenderName: string | null;
  lastInboundAt: string | null;
  lastOwnerReplyMessageId: number | null;
  lastOwnerReplyAt: string | null;
  unansweredSince: string | null;
  lastEvaluatedAt: string;
  lastAlertedAt: string | null;
  dedupeKey: string | null;
  lastEvaluationStatus: TelegramWatchEvaluationStatus;
  lastEvaluationMessage: string;
  updatedAt: string;
}

export interface UpsertTelegramWatchStateParams {
  ruleId: string;
  ruleType: TelegramWatchRuleType;
  monitoredChatId: string;
  chatId?: string | null;
  chatTitle?: string | null;
  status?: TelegramWatchStateStatus;
  lastInboundMessageId?: number | null;
  lastInboundSenderName?: string | null;
  lastInboundAt?: string | null;
  lastOwnerReplyMessageId?: number | null;
  lastOwnerReplyAt?: string | null;
  unansweredSince?: string | null;
  lastEvaluatedAt?: string;
  lastAlertedAt?: string | null;
  dedupeKey?: string | null;
  lastEvaluationStatus?: TelegramWatchEvaluationStatus;
  lastEvaluationMessage?: string;
  updatedAt?: string;
}

export interface CreateTelegramWatchEvaluationParams {
  ruleId: string;
  ruleType: TelegramWatchRuleType;
  monitoredChatId: string;
  chatId: string | null;
  chatTitle: string | null;
  stateStatus: TelegramWatchStateStatus;
  evaluationStatus: TelegramWatchEvaluationStatus;
  lastInboundMessageId: number | null;
  lastOwnerReplyMessageId: number | null;
  dedupeKey: string | null;
  correlationId: string | null;
  alertTriggered: boolean;
  message: string;
  evaluatedAt?: string;
}

export interface TelegramWatchEvaluationResult {
  id: string;
  ruleId: string;
  ruleType: TelegramWatchRuleType;
  monitoredChatId: string;
  chatId: string | null;
  chatTitle: string | null;
  stateStatus: TelegramWatchStateStatus;
  evaluationStatus: TelegramWatchEvaluationStatus;
  lastInboundMessageId: number | null;
  lastOwnerReplyMessageId: number | null;
  dedupeKey: string | null;
  correlationId: string | null;
  alertTriggered: boolean;
  message: string;
  evaluatedAt: string;
}

export interface TelegramWatchAlertRecord {
  evaluationId: string;
  ruleId: string;
  monitoredChatId: string;
  chatId: string | null;
  chatTitle: string | null;
  correlationId: string | null;
  lastInboundMessageId: number | null;
  dedupeKey: string | null;
  message: string;
  evaluatedAt: string;
}
