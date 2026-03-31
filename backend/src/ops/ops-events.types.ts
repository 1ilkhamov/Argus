export const STRUCTURED_OPERATIONAL_EVENT_KINDS = [
  'cron_run',
  'monitor_evaluation',
  'monitor_alert',
  'telegram_outbound',
  'notify_route',
] as const;
export type StructuredOperationalEventKind = (typeof STRUCTURED_OPERATIONAL_EVENT_KINDS)[number];

export const STRUCTURED_OPERATIONAL_EVENT_SEVERITIES = ['info', 'warning', 'error'] as const;
export type StructuredOperationalEventSeverity = (typeof STRUCTURED_OPERATIONAL_EVENT_SEVERITIES)[number];

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

export interface ListStructuredOperationalEventsParams {
  kind?: StructuredOperationalEventKind;
  correlationId?: string;
  chatId?: string;
  jobId?: string;
  ruleId?: string;
  before?: string;
  after?: string;
  limit?: number;
}
