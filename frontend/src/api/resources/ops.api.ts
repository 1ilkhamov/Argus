import { apiFetch } from '../http/client';
import { API_ENDPOINTS } from '@/config';

export const LOG_ENTRY_LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
export type LogEntryLevel = (typeof LOG_ENTRY_LEVELS)[number];

export const LOG_FILE_KINDS = ['any', 'app', 'error'] as const;
export type LogFileKind = (typeof LOG_FILE_KINDS)[number];

export const OUTBOUND_AUDIT_ACTORS = ['human', 'agent', 'cron', 'watchdog', 'notify_reply', 'system'] as const;
export type OutboundAuditActor = (typeof OUTBOUND_AUDIT_ACTORS)[number];

export const OUTBOUND_AUDIT_ORIGINS = [
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
export type OutboundAuditOrigin = (typeof OUTBOUND_AUDIT_ORIGINS)[number];

export const OUTBOUND_AUDIT_RESULTS = ['attempted', 'sent', 'blocked', 'failed'] as const;
export type OutboundAuditResult = (typeof OUTBOUND_AUDIT_RESULTS)[number];

export const TELEGRAM_POLICY_DECISIONS = ['allow', 'deny'] as const;
export type TelegramPolicyDecision = (typeof TELEGRAM_POLICY_DECISIONS)[number];

export const TG_CHAT_MODES = ['auto', 'read_only', 'manual', 'disabled'] as const;

export type TgChatMode = 'auto' | 'read_only' | 'manual' | 'disabled';
export type TelegramWatchRuleType = 'telegram_unanswered_message_monitor';
export type TelegramWatchStateStatus = 'idle' | 'unanswered' | 'alerted' | 'paused' | 'error';
export type TelegramWatchEvaluationStatus = 'noop' | 'observed' | 'alerted' | 'deduped' | 'resolved' | 'paused' | 'error';
export type TelegramClientMonitorStatus = 'idle' | 'queued' | 'cooldown' | 'processing' | 'manual' | 'error';
export type CronScheduleType = 'cron' | 'interval' | 'once';
export type CronJobNotificationPolicy = 'always' | 'never';
export type CronJobRunStatus = 'running' | 'success' | 'noop' | 'notified' | 'failed' | 'canceled';
export type CronJobRunResultStatus = 'running' | 'success' | 'noop' | 'failed' | 'canceled';
export type CronJobRunNotificationStatus = 'pending' | 'sent' | 'skipped' | 'failed';
export type TelegramOutboundChannel = 'telegram_client' | 'telegram_bot';
export type TelegramOutboundAction = 'send_message' | 'notify';
export type TelegramOutboundOrigin =
  | 'telegram_client_tool'
  | 'telegram_client_listener'
  | 'telegram_update_handler'
  | 'notify_tool'
  | 'cron_executor'
  | 'hook_executor'
  | 'telegram_watchdog'
  | 'telegram_message_sender'
  | 'system';
export type PendingNotifyRouteStatus = 'sent' | 'expired';
export type StructuredOperationalEventKind = 'cron_run' | 'monitor_evaluation' | 'monitor_alert' | 'telegram_outbound' | 'notify_route';
export type StructuredOperationalEventSeverity = 'info' | 'warning' | 'error';

export interface ParsedLogEntry {
  file: string;
  timestamp: string;
  level: LogEntryLevel;
  context: string | null;
  message: string;
  event: string | null;
  payload: Record<string, unknown> | null;
  raw: string;
}

export interface LogSearchResult {
  filesScanned: string[];
  entries: ParsedLogEntry[];
}

export interface LogSearchParams {
  query?: string;
  level?: LogEntryLevel;
  context?: string;
  event?: string;
  fileKind?: LogFileKind;
  date?: string;
  before?: string;
  after?: string;
  correlationId?: string;
  chatId?: string;
  jobId?: string;
  ruleId?: string;
  limit?: number;
}

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

export interface CronJob {
  id: string;
  name: string;
  task: string;
  scheduleType: CronScheduleType;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  maxRuns: number;
  notificationPolicy: CronJobNotificationPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobRun {
  id: string;
  jobId: string;
  jobName: string;
  scheduleType: CronScheduleType;
  schedule: string;
  attempt: number;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: CronJobRunStatus;
  resultStatus: CronJobRunResultStatus;
  notificationStatus: CronJobRunNotificationStatus;
  outputPreview: string | null;
  errorMessage: string | null;
  notificationErrorMessage: string | null;
  toolRoundsUsed: number;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TelegramOutboundAuditEvent {
  id: string;
  channel: TelegramOutboundChannel;
  action: TelegramOutboundAction;
  actor: OutboundAuditActor;
  origin: TelegramOutboundOrigin;
  targetChatId: string | null;
  targetChatTitle: string | null;
  monitoredChatId: string | null;
  monitoredMode: TgChatMode | null;
  scopeKey: string | null;
  conversationId: string | null;
  correlationId: string | null;
  policyDecision: TelegramPolicyDecision;
  policyReasonCode: string;
  result: OutboundAuditResult;
  payloadPreview: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundAuditSearchParams {
  actor?: OutboundAuditActor;
  origin?: OutboundAuditOrigin;
  result?: OutboundAuditResult;
  policyDecision?: TelegramPolicyDecision;
  chatId?: string;
  correlationId?: string;
  before?: string;
  after?: string;
  limit?: number;
}

export interface OpsMonitoredChat {
  id: string;
  chatId: string;
  chatTitle: string;
  chatType: 'user' | 'group' | 'supergroup' | 'channel' | 'unknown';
  mode: TgChatMode;
  cooldownSeconds: number;
  systemNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobInput {
  name: string;
  task: string;
  scheduleType: CronScheduleType;
  schedule: string;
  maxRuns?: number;
  notificationPolicy?: CronJobNotificationPolicy;
}

export interface UpdateCronJobInput {
  name?: string;
  task?: string;
  scheduleType?: CronScheduleType;
  schedule?: string;
  maxRuns?: number;
  notificationPolicy?: CronJobNotificationPolicy;
  enabled?: boolean;
}

export interface CreateMonitorRuleInput {
  monitoredChatId: string;
  name?: string;
  thresholdSeconds?: number;
  enabled?: boolean;
}

export interface UpdateMonitorRuleInput {
  monitoredChatId?: string;
  name?: string;
  thresholdSeconds?: number;
  enabled?: boolean;
}

export interface UpdateMonitoredChatInput {
  chatTitle?: string;
  mode?: TgChatMode;
  cooldownSeconds?: number;
  systemNote?: string;
}

export interface PendingNotifyMessageRecord {
  botMessageId: number;
  chatId: string;
  chatTitle: string;
  question: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingNotifyAwaitingReplyRecord {
  botChatId: number;
  sourceBotMessageId: number | null;
  chatId: string;
  chatTitle: string;
  question: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingNotifyRouteRecord {
  id: string;
  botChatId: number;
  sourceBotMessageId: number | null;
  chatId: string;
  chatTitle: string;
  question: string;
  replyText: string | null;
  routeStatus: PendingNotifyRouteStatus;
  correlationId: string | null;
  createdAt: number;
  completedAt: number;
}

export interface PendingNotifySnapshot {
  pendingMessages: PendingNotifyMessageRecord[];
  awaitingReplies: PendingNotifyAwaitingReplyRecord[];
  recentRoutes: PendingNotifyRouteRecord[];
}

export interface StructuredOperationalEvent {
  id: string;
  kind: StructuredOperationalEventKind;
  timestamp: string;
  severity: StructuredOperationalEventSeverity;
  status: string;
  source: string;
  title: string;
  summary: string;
  correlationId: string | null;
  chatId: string | null;
  chatTitle: string | null;
  jobId: string | null;
  jobName: string | null;
  ruleId: string | null;
  monitoredChatId: string | null;
  payload: Record<string, unknown>;
}

export interface StructuredOperationalEventSearchParams {
  kind?: StructuredOperationalEventKind;
  correlationId?: string;
  chatId?: string;
  jobId?: string;
  ruleId?: string;
  before?: string;
  after?: string;
  limit?: number;
}

function withQuery(endpoint: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${endpoint}?${query}` : endpoint;
}

export const opsApi = {
  listLogFiles(fileKind?: LogFileKind): Promise<{ files: string[] }> {
    return apiFetch<{ files: string[] }>(withQuery(API_ENDPOINTS.ops.logs.files, { fileKind }));
  },
  searchLogs(params: LogSearchParams = {}): Promise<LogSearchResult> {
    return apiFetch<LogSearchResult>(withQuery(API_ENDPOINTS.ops.logs.search, {
      query: params.query,
      level: params.level,
      context: params.context,
      event: params.event,
      fileKind: params.fileKind,
      date: params.date,
      before: params.before,
      after: params.after,
      correlationId: params.correlationId,
      chatId: params.chatId,
      jobId: params.jobId,
      ruleId: params.ruleId,
      limit: params.limit,
    }));
  },
  listMonitorRules(): Promise<TelegramWatchRule[]> {
    return apiFetch<TelegramWatchRule[]>(API_ENDPOINTS.ops.monitors.rules);
  },
  createMonitorRule(input: CreateMonitorRuleInput): Promise<TelegramWatchRule> {
    return apiFetch<TelegramWatchRule>(API_ENDPOINTS.ops.monitors.rules, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateMonitorRule(id: string, input: UpdateMonitorRuleInput): Promise<TelegramWatchRule> {
    return apiFetch<TelegramWatchRule>(API_ENDPOINTS.ops.monitors.rule(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  deleteMonitorRule(id: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(API_ENDPOINTS.ops.monitors.rule(id), {
      method: 'DELETE',
    });
  },
  runMonitorRule(id: string): Promise<TelegramWatchEvaluationResult> {
    return apiFetch<TelegramWatchEvaluationResult>(API_ENDPOINTS.ops.monitors.run(id), {
      method: 'POST',
    });
  },
  listMonitorStates(): Promise<TelegramWatchState[]> {
    return apiFetch<TelegramWatchState[]>(API_ENDPOINTS.ops.monitors.states);
  },
  listMonitorEvaluations(ruleId?: string, limit: number = 20): Promise<TelegramWatchEvaluationResult[]> {
    return apiFetch<TelegramWatchEvaluationResult[]>(withQuery(API_ENDPOINTS.ops.monitors.evaluations, { ruleId, limit }));
  },
  listMonitorAlerts(ruleId?: string, limit: number = 20): Promise<TelegramWatchAlertRecord[]> {
    return apiFetch<TelegramWatchAlertRecord[]>(withQuery(API_ENDPOINTS.ops.monitors.alerts, { ruleId, limit }));
  },
  listTelegramClientRuntime(): Promise<TelegramClientMonitorRuntimeState[]> {
    return apiFetch<TelegramClientMonitorRuntimeState[]>(API_ENDPOINTS.ops.telegramClientRuntime);
  },
  listMonitoredChats(): Promise<OpsMonitoredChat[]> {
    return apiFetch<OpsMonitoredChat[]>(API_ENDPOINTS.telegramClient.chats);
  },
  updateMonitoredChat(id: string, input: UpdateMonitoredChatInput): Promise<OpsMonitoredChat> {
    return apiFetch<OpsMonitoredChat>(API_ENDPOINTS.telegramClient.chat(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  listCronJobs(): Promise<CronJob[]> {
    return apiFetch<CronJob[]>(API_ENDPOINTS.ops.cron.jobs);
  },
  createCronJob(input: CreateCronJobInput): Promise<CronJob> {
    return apiFetch<CronJob>(API_ENDPOINTS.ops.cron.jobs, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateCronJob(id: string, input: UpdateCronJobInput): Promise<CronJob> {
    return apiFetch<CronJob>(API_ENDPOINTS.ops.cron.job(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  deleteCronJob(id: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(API_ENDPOINTS.ops.cron.job(id), {
      method: 'DELETE',
    });
  },
  pauseCronJob(id: string): Promise<CronJob> {
    return apiFetch<CronJob>(API_ENDPOINTS.ops.cron.pause(id), {
      method: 'POST',
    });
  },
  resumeCronJob(id: string): Promise<CronJob> {
    return apiFetch<CronJob>(API_ENDPOINTS.ops.cron.resume(id), {
      method: 'POST',
    });
  },
  listCronRuns(jobId?: string, limit: number = 20): Promise<CronJobRun[]> {
    return apiFetch<CronJobRun[]>(withQuery(API_ENDPOINTS.ops.cron.runs, { jobId, limit }));
  },
  listOutboundAudit(params: OutboundAuditSearchParams = {}): Promise<TelegramOutboundAuditEvent[]> {
    return apiFetch<TelegramOutboundAuditEvent[]>(withQuery(API_ENDPOINTS.ops.outboundAudit, {
      actor: params.actor,
      origin: params.origin,
      result: params.result,
      policyDecision: params.policyDecision,
      chatId: params.chatId,
      correlationId: params.correlationId,
      before: params.before,
      after: params.after,
      limit: params.limit,
    }));
  },
  listNotifyRouting(limit: number = 20): Promise<PendingNotifySnapshot> {
    return apiFetch<PendingNotifySnapshot>(withQuery(API_ENDPOINTS.ops.notifyRouting, { limit }));
  },
  listStructuredOperationalEvents(params: StructuredOperationalEventSearchParams = {}): Promise<StructuredOperationalEvent[]> {
    return apiFetch<StructuredOperationalEvent[]>(withQuery(API_ENDPOINTS.ops.events, {
      kind: params.kind,
      correlationId: params.correlationId,
      chatId: params.chatId,
      jobId: params.jobId,
      ruleId: params.ruleId,
      before: params.before,
      after: params.after,
      limit: params.limit,
    }));
  },
};
