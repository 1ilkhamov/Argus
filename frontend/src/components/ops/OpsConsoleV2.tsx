import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, Clock3, FileText, Radio, RefreshCw, ShieldCheck } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import {
  LOG_ENTRY_LEVELS,
  LOG_FILE_KINDS,
  OUTBOUND_AUDIT_ACTORS,
  OUTBOUND_AUDIT_ORIGINS,
  OUTBOUND_AUDIT_RESULTS,
  TELEGRAM_POLICY_DECISIONS,
  TG_CHAT_MODES,
  type CronJob,
  type CronJobNotificationPolicy,
  type LogEntryLevel,
  type LogFileKind,
  type OutboundAuditActor,
  type OutboundAuditOrigin,
  type OutboundAuditResult,
  type StructuredOperationalEventKind,
  type TelegramPolicyDecision,
  type TgChatMode,
  type TelegramWatchRule,
  type TelegramWatchState,
} from '@/api/resources/ops.api';
import { PageDivider, PageEmpty, PageError, PageFooter, PageHeader, PageLoading, PageScrollArea, PageSearchBar, TabBar } from '@/components/common';
import type { TabItem } from '@/components/common';
import { useOpsStore } from '@/stores/ops/ops.store';
import { useLangStore } from '@/stores/ui/lang.store';

type OpsTab = 'logs' | 'monitors' | 'runtime' | 'cron' | 'notify' | 'events' | 'audit';
type CronForm = { name: string; task: string; scheduleType: 'cron' | 'interval' | 'once'; schedule: string; maxRuns: string; notificationPolicy: CronJobNotificationPolicy };
type MonitorForm = { monitoredChatId: string; name: string; thresholdSeconds: string };
type ChatForm = { chatTitle: string; mode: TgChatMode; cooldownSeconds: string; systemNote: string };
type Row = [string, string];

const inputStyle = { background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' } as const;
const chipStyle = { background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)' } as const;
const cronTypes: CronForm['scheduleType'][] = ['cron', 'interval', 'once'];
const cronPolicies: CronJobNotificationPolicy[] = ['always', 'never'];
const eventKinds: StructuredOperationalEventKind[] = ['cron_run', 'monitor_evaluation', 'monitor_alert', 'telegram_outbound', 'notify_route'];
const windows = [25, 50, 100, 200] as const;

const fmt = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '—' : (Number.isNaN(new Date(value).getTime()) ? String(value) : new Date(value).toLocaleString());
const toIso = (value: string) => !value.trim() || Number.isNaN(new Date(value).getTime()) ? undefined : new Date(value).toISOString();
const hit = (q: string, ...values: Array<string | number | null | undefined>) => !q || values.some((value) => String(value ?? '').toLowerCase().includes(q));
const text = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const json = (value: Record<string, unknown> | null | undefined) => value ? JSON.stringify(value, null, 2) : null;
const mergeBody = (a?: string | null, b?: string | null) => [a?.trim(), b?.trim()].filter((value): value is string => Boolean(value)).join('\n\n') || undefined;
const latest = (state?: { lastInboundAt: string | null; lastReplyAt: string | null; lastProcessedAt: string | null }) => state ? [state.lastInboundAt, state.lastReplyAt, state.lastProcessedAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null : null;
const cronForm = (job?: CronJob): CronForm => ({ name: job?.name ?? '', task: job?.task ?? '', scheduleType: job?.scheduleType ?? 'cron', schedule: job?.schedule ?? '', maxRuns: String(job?.maxRuns ?? 0), notificationPolicy: job?.notificationPolicy ?? 'always' });
const monitorForm = (rule?: TelegramWatchRule): MonitorForm => ({ monitoredChatId: rule?.monitoredChatId ?? '', name: rule?.name ?? '', thresholdSeconds: String(rule?.thresholdSeconds ?? 900) });
const chatForm = (chat?: { chatTitle: string; mode: TgChatMode; cooldownSeconds: number; systemNote: string }): ChatForm => ({ chatTitle: chat?.chatTitle ?? '', mode: chat?.mode ?? 'auto', cooldownSeconds: String(chat?.cooldownSeconds ?? 30), systemNote: chat?.systemNote ?? '' });
function parseNonNegativeInteger(raw: string, label: string): number | undefined { if (!raw.trim()) return undefined; const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`); return value; }
function findValue(payload: Record<string, unknown> | null | undefined, ...keys: string[]): string | null { if (!payload) return null; for (const key of keys) { const value = payload[key]; if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value); } return null; }
function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) { return <section className="space-y-2"><div className="flex items-center justify-between gap-3"><h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{title}</h3><span className="rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase" style={chipStyle}>{count}</span></div>{children}</section>; }
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-xl px-3 py-2" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)' }}><div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{label}</div><div className="mt-1 text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="flex min-w-0 flex-col gap-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}><span>{label}</span>{children}</label>; }
function Card({ title, subtitle, rows, body, actions, selected = false }: { title: string; subtitle?: string; rows?: Row[]; body?: string | null; actions?: ReactNode; selected?: boolean }) { return <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)', border: selected ? '1px solid var(--accent)' : '1px solid var(--border-secondary)' }}><div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>{subtitle ? <div className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{subtitle}</div> : null}{rows?.length ? <div className="mt-2 grid gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{rows.map(([label, value]) => <div key={`${title}-${label}`} className="flex gap-2"><span className="min-w-[142px]" style={{ color: 'var(--text-tertiary)' }}>{label}</span><span className="break-words">{value}</span></div>)}</div> : null}{body ? <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[11px]" style={{ background: 'var(--panel-muted)', color: 'var(--text-secondary)' }}>{body}</pre> : null}{actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}</div>; }
function Button({ label, onClick, type = 'button', variant = 'primary' }: { label: string; onClick?: () => void; type?: 'button' | 'submit'; variant?: 'primary' | 'secondary' | 'danger' }) { const style = variant === 'danger' ? { background: 'var(--status-danger-soft)', color: 'var(--status-danger)' } : variant === 'secondary' ? { background: 'var(--panel-muted)', color: 'var(--text-primary)' } : { background: 'var(--accent-soft)', color: 'var(--accent)' }; return <button type={type} onClick={onClick} className="rounded-xl px-3 py-2 text-[12px] font-medium" style={style}>{label}</button>; }

export function OpsConsole() {
  const { t } = useLangStore();
  const [tab, setTab] = useState<OpsTab>('logs');
  const [log, setLog] = useState({ query: '', level: '' as '' | LogEntryLevel, context: '', event: '', fileKind: '' as '' | LogFileKind, date: '', correlationId: '', chatId: '', jobId: '', ruleId: '', after: '', before: '', limit: 50 });
  const [events, setEvents] = useState({ query: '', kind: '' as '' | StructuredOperationalEventKind, chatId: '', correlationId: '', jobId: '', ruleId: '', after: '', before: '', limit: 50 });
  const [audit, setAudit] = useState({ chatId: '', actor: '' as '' | OutboundAuditActor, origin: '' as '' | OutboundAuditOrigin, result: '' as '' | OutboundAuditResult, policyDecision: '' as '' | TelegramPolicyDecision, correlationId: '', after: '', before: '', limit: 50 });
  const [monitorQuery, setMonitorQuery] = useState('');
  const [runtimeQuery, setRuntimeQuery] = useState('');
  const [cronQuery, setCronQuery] = useState('');
  const [notifyQuery, setNotifyQuery] = useState('');
  const [cronDraft, setCronDraft] = useState<CronForm>(() => cronForm());
  const [monitorDraft, setMonitorDraft] = useState<MonitorForm>(() => monitorForm());
  const [chatDraft, setChatDraft] = useState<ChatForm>(() => chatForm());
  const [editingCronId, setEditingCronId] = useState<string | null>(null);
  const [editingMonitorId, setEditingMonitorId] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const store = useOpsStore(useShallow((state) => ({
    logs: state.logs,
    logFilesScanned: state.logFilesScanned,
    monitoredChats: state.monitoredChats,
    monitorRules: state.monitorRules,
    monitorStates: state.monitorStates,
    monitorEvaluations: state.monitorEvaluations,
    monitorAlerts: state.monitorAlerts,
    runtimeStates: state.runtimeStates,
    cronJobs: state.cronJobs,
    cronRuns: state.cronRuns,
    outboundAuditEvents: state.outboundAuditEvents,
    notifyRouting: state.notifyRouting,
    operationalEvents: state.operationalEvents,
    isLoading: state.isLoading,
    error: state.error,
    lastUpdatedAt: state.lastUpdatedAt,
  })));

  const {
    loadLogs,
    loadMonitorSnapshot,
    loadRuntimeStates,
    loadCronSnapshot,
    loadOutboundAudit,
    loadNotifyRouting,
    loadOperationalEvents,
    updateMonitoredChat,
    createCronJob,
    updateCronJob,
    deleteCronJob,
    pauseCronJob,
    resumeCronJob,
    createMonitorRule,
    updateMonitorRule,
    deleteMonitorRule,
    runMonitorRule,
    clearError,
  } = useOpsStore(useShallow((state) => ({
    loadLogs: state.loadLogs,
    loadMonitorSnapshot: state.loadMonitorSnapshot,
    loadRuntimeStates: state.loadRuntimeStates,
    loadCronSnapshot: state.loadCronSnapshot,
    loadOutboundAudit: state.loadOutboundAudit,
    loadNotifyRouting: state.loadNotifyRouting,
    loadOperationalEvents: state.loadOperationalEvents,
    updateMonitoredChat: state.updateMonitoredChat,
    createCronJob: state.createCronJob,
    updateCronJob: state.updateCronJob,
    deleteCronJob: state.deleteCronJob,
    pauseCronJob: state.pauseCronJob,
    resumeCronJob: state.resumeCronJob,
    createMonitorRule: state.createMonitorRule,
    updateMonitorRule: state.updateMonitorRule,
    deleteMonitorRule: state.deleteMonitorRule,
    runMonitorRule: state.runMonitorRule,
    clearError: state.clearError,
  })));

  const clearErrors = useCallback(() => {
    clearError();
    setLocalError(null);
  }, [clearError]);

  const refresh = useCallback(async () => {
    clearErrors();

    if (tab === 'logs') {
      return loadLogs({
        query: log.query.trim() || undefined,
        level: log.level || undefined,
        context: log.context.trim() || undefined,
        event: log.event.trim() || undefined,
        fileKind: log.fileKind || undefined,
        date: log.date || undefined,
        correlationId: log.correlationId.trim() || undefined,
        chatId: log.chatId.trim() || undefined,
        jobId: log.jobId.trim() || undefined,
        ruleId: log.ruleId.trim() || undefined,
        after: toIso(log.after),
        before: toIso(log.before),
        limit: log.limit,
      });
    }

    if (tab === 'monitors') {
      return loadMonitorSnapshot();
    }

    if (tab === 'runtime') {
      return loadRuntimeStates();
    }

    if (tab === 'cron') {
      return loadCronSnapshot();
    }

    if (tab === 'notify') {
      return loadNotifyRouting(50);
    }

    if (tab === 'events') {
      return loadOperationalEvents({
        kind: events.kind || undefined,
        correlationId: events.correlationId.trim() || undefined,
        chatId: events.chatId.trim() || undefined,
        jobId: events.jobId.trim() || undefined,
        ruleId: events.ruleId.trim() || undefined,
        after: toIso(events.after),
        before: toIso(events.before),
        limit: events.limit,
      });
    }

    return loadOutboundAudit({
      actor: audit.actor || undefined,
      origin: audit.origin || undefined,
      result: audit.result || undefined,
      policyDecision: audit.policyDecision || undefined,
      chatId: audit.chatId.trim() || undefined,
      correlationId: audit.correlationId.trim() || undefined,
      after: toIso(audit.after),
      before: toIso(audit.before),
      limit: audit.limit,
    });
  }, [audit, clearErrors, events, loadCronSnapshot, loadLogs, loadMonitorSnapshot, loadNotifyRouting, loadOperationalEvents, loadOutboundAudit, loadRuntimeStates, log, tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab !== 'audit') {
      return;
    }

    if (store.outboundAuditEvents.length === 0) {
      setSelectedAuditId(null);
      return;
    }

    const firstEvent = store.outboundAuditEvents[0];
    if (!firstEvent) {
      setSelectedAuditId(null);
      return;
    }

    if (!selectedAuditId || !store.outboundAuditEvents.some((item) => item.id === selectedAuditId)) {
      setSelectedAuditId(firstEvent.id);
    }
  }, [selectedAuditId, store.outboundAuditEvents, tab]);

  const mq = monitorQuery.trim().toLowerCase();
  const rq = runtimeQuery.trim().toLowerCase();
  const cq = cronQuery.trim().toLowerCase();
  const nq = notifyQuery.trim().toLowerCase();
  const eq = events.query.trim().toLowerCase();

  const filteredMonitorRules = useMemo(() => store.monitorRules.filter((item) => hit(mq, item.id, item.name, item.monitoredChatId)), [mq, store.monitorRules]);
  const filteredMonitorStates = useMemo(() => store.monitorStates.filter((item) => hit(mq, item.ruleId, item.chatId, item.chatTitle, item.status, item.lastEvaluationMessage)), [mq, store.monitorStates]);
  const filteredMonitorEvaluations = useMemo(() => store.monitorEvaluations.filter((item) => hit(mq, item.id, item.ruleId, item.chatId, item.chatTitle, item.message, item.correlationId)), [mq, store.monitorEvaluations]);
  const filteredMonitorAlerts = useMemo(() => store.monitorAlerts.filter((item) => hit(mq, item.ruleId, item.chatId, item.chatTitle, item.message, item.correlationId)), [mq, store.monitorAlerts]);
  const filteredMonitoredChats = useMemo(() => store.monitoredChats.filter((item) => hit(rq, item.id, item.chatId, item.chatTitle, item.mode, item.chatType, item.systemNote)), [rq, store.monitoredChats]);
  const filteredRuntimeStates = useMemo(() => store.runtimeStates.filter((item) => hit(rq, item.chatId, item.chatTitle, item.mode, item.status, item.lastErrorMessage)), [rq, store.runtimeStates]);
  const filteredCronJobs = useMemo(() => store.cronJobs.filter((item) => hit(cq, item.id, item.name, item.task, item.schedule, item.notificationPolicy)), [cq, store.cronJobs]);
  const filteredCronRuns = useMemo(() => store.cronRuns.filter((item) => hit(cq, item.id, item.jobId, item.jobName, item.status, item.resultStatus, item.notificationStatus, item.errorMessage, item.notificationErrorMessage)), [cq, store.cronRuns]);
  const filteredPendingMessages = useMemo(() => store.notifyRouting.pendingMessages.filter((item) => hit(nq, item.botMessageId, item.chatId, item.chatTitle, item.question)), [nq, store.notifyRouting.pendingMessages]);
  const filteredAwaitingReplies = useMemo(() => store.notifyRouting.awaitingReplies.filter((item) => hit(nq, item.botChatId, item.sourceBotMessageId, item.chatId, item.chatTitle, item.question)), [nq, store.notifyRouting.awaitingReplies]);
  const filteredNotifyRoutes = useMemo(() => store.notifyRouting.recentRoutes.filter((item) => hit(nq, item.id, item.chatId, item.chatTitle, item.replyText, item.routeStatus, item.correlationId)), [nq, store.notifyRouting.recentRoutes]);
  const filteredOperationalEvents = useMemo(() => store.operationalEvents.filter((item) => hit(eq, item.id, item.kind, item.status, item.source, item.title, item.summary, item.correlationId, item.chatId, item.chatTitle, item.jobId, item.jobName, item.ruleId)), [eq, store.operationalEvents]);
  const runtimeByChat = useMemo(() => new Map(store.runtimeStates.map((item) => [item.monitoredChatId, item])), [store.runtimeStates]);
  const watchStateByChat = useMemo(() => new Map<string, TelegramWatchState>(store.monitorStates.map((item) => [item.monitoredChatId, item])), [store.monitorStates]);
  const rulesByChat = useMemo(() => store.monitorRules.reduce((map, rule) => map.set(rule.monitoredChatId, [...(map.get(rule.monitoredChatId) ?? []), rule]), new Map<string, TelegramWatchRule[]>()), [store.monitorRules]);
  const selectedAuditEvent = useMemo(() => store.outboundAuditEvents.find((item) => item.id === selectedAuditId) ?? null, [selectedAuditId, store.outboundAuditEvents]);

  const tabs: TabItem<OpsTab>[] = [
    { key: 'logs', label: t('ops.tabLogs'), icon: FileText, count: store.logs.length },
    { key: 'monitors', label: t('ops.tabMonitors'), icon: BellRing, count: store.monitorRules.length },
    { key: 'runtime', label: t('ops.tabRuntime'), icon: Radio, count: store.runtimeStates.length },
    { key: 'cron', label: t('ops.tabCron'), icon: Clock3, count: store.cronJobs.length },
    { key: 'notify', label: t('ops.tabNotify'), icon: BellRing, count: store.notifyRouting.pendingMessages.length + store.notifyRouting.awaitingReplies.length + store.notifyRouting.recentRoutes.length },
    { key: 'events', label: t('ops.tabEvents'), icon: Activity, count: store.operationalEvents.length },
    { key: 'audit', label: t('ops.tabAudit'), icon: ShieldCheck, count: store.outboundAuditEvents.length },
  ];

  const hasTabData =
    tab === 'logs'
      ? store.logs.length > 0
      : tab === 'monitors'
        ? store.monitorRules.length + store.monitorStates.length + store.monitorEvaluations.length + store.monitorAlerts.length > 0
        : tab === 'runtime'
          ? store.monitoredChats.length + store.runtimeStates.length > 0
          : tab === 'cron'
            ? store.cronJobs.length + store.cronRuns.length > 0
            : tab === 'notify'
              ? store.notifyRouting.pendingMessages.length + store.notifyRouting.awaitingReplies.length + store.notifyRouting.recentRoutes.length > 0
              : tab === 'events'
                ? store.operationalEvents.length > 0
                : store.outboundAuditEvents.length > 0;

  const policyLabel = (mode: TgChatMode) => mode === 'read_only' ? t('ops.policyModeReadOnly') : mode === 'manual' ? t('ops.policyModeManual') : mode === 'disabled' ? t('ops.policyModeDisabled') : t('ops.policyModeAuto');

  const startCronEdit = (job: CronJob) => {
    setEditingCronId(job.id);
    setCronDraft(cronForm(job));
    setLocalError(null);
  };

  const startMonitorEdit = (rule: TelegramWatchRule) => {
    setEditingMonitorId(rule.id);
    setMonitorDraft(monitorForm(rule));
    setLocalError(null);
  };

  const startChatEdit = (chat: { id: string; chatTitle: string; mode: TgChatMode; cooldownSeconds: number; systemNote: string }) => {
    setEditingChatId(chat.id);
    setChatDraft(chatForm(chat));
    setLocalError(null);
  };

  const cancelCronEdit = () => {
    setEditingCronId(null);
    setCronDraft(cronForm());
  };

  const cancelMonitorEdit = () => {
    setEditingMonitorId(null);
    setMonitorDraft(monitorForm());
  };

  const cancelChatEdit = () => {
    setEditingChatId(null);
    setChatDraft(chatForm());
  };

  const submitCron = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearErrors();

    try {
      const payload = {
        name: cronDraft.name.trim(),
        task: cronDraft.task.trim(),
        scheduleType: cronDraft.scheduleType,
        schedule: cronDraft.schedule.trim(),
        maxRuns: parseNonNegativeInteger(cronDraft.maxRuns, t('ops.maxRuns')) ?? 0,
        notificationPolicy: cronDraft.notificationPolicy,
      };

      if (!payload.name || !payload.task || !payload.schedule) {
        throw new Error(t('ops.validationRequired'));
      }

      if (editingCronId) {
        await updateCronJob(editingCronId, payload);
      } else {
        await createCronJob(payload);
      }

      cancelCronEdit();
    } catch (error) {
      setLocalError(text(error, t('common.error')));
    }
  };

  const submitMonitor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearErrors();

    try {
      const payload = {
        monitoredChatId: monitorDraft.monitoredChatId.trim(),
        name: monitorDraft.name.trim() || undefined,
        thresholdSeconds: parseNonNegativeInteger(monitorDraft.thresholdSeconds, t('ops.thresholdSeconds')),
      };

      if (!payload.monitoredChatId) {
        throw new Error(t('ops.validationRequired'));
      }

      if (editingMonitorId) {
        await updateMonitorRule(editingMonitorId, payload);
      } else {
        await createMonitorRule(payload);
      }

      cancelMonitorEdit();
    } catch (error) {
      setLocalError(text(error, t('common.error')));
    }
  };

  const submitChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearErrors();

    try {
      if (!editingChatId) {
        throw new Error(t('ops.validationRequired'));
      }

      const chatTitle = chatDraft.chatTitle.trim();
      const cooldownSeconds = parseNonNegativeInteger(chatDraft.cooldownSeconds, t('ops.cooldown'));
      if (!chatTitle || cooldownSeconds === undefined) {
        throw new Error(t('ops.validationRequired'));
      }

      await updateMonitoredChat(editingChatId, {
        chatTitle,
        mode: chatDraft.mode,
        cooldownSeconds,
        systemNote: chatDraft.systemNote.trim(),
      });

      cancelChatEdit();
    } catch (error) {
      setLocalError(text(error, t('common.error')));
    }
  };

  const renderFilters = () => {
    if (tab === 'logs') {
      return (
        <div className="space-y-3">
          <PageSearchBar value={log.query} onChange={(query) => setLog((current) => ({ ...current, query }))} placeholder={t('ops.searchLogs')} />
          <div className="grid grid-cols-1 gap-2 px-6 pb-1 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
            <Field label={t('ops.level')}>
              <select value={log.level} onChange={(event) => setLog((current) => ({ ...current, level: event.target.value as '' | LogEntryLevel }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                <option value="">{t('ops.all')}</option>
                {LOG_ENTRY_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </Field>
            <Field label={t('ops.fileKind')}>
              <select value={log.fileKind} onChange={(event) => setLog((current) => ({ ...current, fileKind: event.target.value as '' | LogFileKind }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                <option value="">{t('ops.all')}</option>
                {LOG_FILE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </Field>
            <Field label={t('ops.context')}>
              <input value={log.context} onChange={(event) => setLog((current) => ({ ...current, context: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.event')}>
              <input value={log.event} onChange={(event) => setLog((current) => ({ ...current, event: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.date')}>
              <input type="date" value={log.date} onChange={(event) => setLog((current) => ({ ...current, date: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.windowSize')}>
              <select value={String(log.limit)} onChange={(event) => setLog((current) => ({ ...current, limit: Number(event.target.value) }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                {windows.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
              </select>
            </Field>
            <Field label={t('ops.correlationId')}>
              <input value={log.correlationId} onChange={(event) => setLog((current) => ({ ...current, correlationId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.chat')}>
              <input value={log.chatId} onChange={(event) => setLog((current) => ({ ...current, chatId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.jobId')}>
              <input value={log.jobId} onChange={(event) => setLog((current) => ({ ...current, jobId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.ruleId')}>
              <input value={log.ruleId} onChange={(event) => setLog((current) => ({ ...current, ruleId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.after')}>
              <input type="datetime-local" value={log.after} onChange={(event) => setLog((current) => ({ ...current, after: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.before')}>
              <input type="datetime-local" value={log.before} onChange={(event) => setLog((current) => ({ ...current, before: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
          </div>
        </div>
      );
    }

    if (tab === 'monitors') {
      return <PageSearchBar value={monitorQuery} onChange={setMonitorQuery} placeholder={t('ops.monitorSearch')} />;
    }

    if (tab === 'runtime') {
      return <PageSearchBar value={runtimeQuery} onChange={setRuntimeQuery} placeholder={t('ops.runtimeSearch')} />;
    }

    if (tab === 'cron') {
      return <PageSearchBar value={cronQuery} onChange={setCronQuery} placeholder={t('ops.cronSearch')} />;
    }

    if (tab === 'notify') {
      return <PageSearchBar value={notifyQuery} onChange={setNotifyQuery} placeholder={t('ops.notifySearch')} />;
    }

    if (tab === 'events') {
      return (
        <div className="space-y-3">
          <PageSearchBar value={events.query} onChange={(query) => setEvents((current) => ({ ...current, query }))} placeholder={t('ops.eventsSearch')} />
          <div className="grid grid-cols-1 gap-2 px-6 pb-1 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
            <Field label={t('ops.kind')}>
              <select value={events.kind} onChange={(event) => setEvents((current) => ({ ...current, kind: event.target.value as '' | StructuredOperationalEventKind }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                <option value="">{t('ops.all')}</option>
                {eventKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </Field>
            <Field label={t('ops.chat')}>
              <input value={events.chatId} onChange={(event) => setEvents((current) => ({ ...current, chatId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.correlationId')}>
              <input value={events.correlationId} onChange={(event) => setEvents((current) => ({ ...current, correlationId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.jobId')}>
              <input value={events.jobId} onChange={(event) => setEvents((current) => ({ ...current, jobId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.ruleId')}>
              <input value={events.ruleId} onChange={(event) => setEvents((current) => ({ ...current, ruleId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.windowSize')}>
              <select value={String(events.limit)} onChange={(event) => setEvents((current) => ({ ...current, limit: Number(event.target.value) }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                {windows.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
              </select>
            </Field>
            <Field label={t('ops.after')}>
              <input type="datetime-local" value={events.after} onChange={(event) => setEvents((current) => ({ ...current, after: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
            <Field label={t('ops.before')}>
              <input type="datetime-local" value={events.before} onChange={(event) => setEvents((current) => ({ ...current, before: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </Field>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <PageSearchBar value={audit.chatId} onChange={(chatId) => setAudit((current) => ({ ...current, chatId }))} placeholder={t('ops.auditSearch')} />
        <div className="grid grid-cols-1 gap-2 px-6 pb-1 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
          <Field label={t('ops.actor')}>
            <select value={audit.actor} onChange={(event) => setAudit((current) => ({ ...current, actor: event.target.value as '' | OutboundAuditActor }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
              <option value="">{t('ops.all')}</option>
              {OUTBOUND_AUDIT_ACTORS.map((actor) => <option key={actor} value={actor}>{actor}</option>)}
            </select>
          </Field>
          <Field label={t('ops.origin')}>
            <select value={audit.origin} onChange={(event) => setAudit((current) => ({ ...current, origin: event.target.value as '' | OutboundAuditOrigin }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
              <option value="">{t('ops.all')}</option>
              {OUTBOUND_AUDIT_ORIGINS.map((origin) => <option key={origin} value={origin}>{origin}</option>)}
            </select>
          </Field>
          <Field label={t('ops.result')}>
            <select value={audit.result} onChange={(event) => setAudit((current) => ({ ...current, result: event.target.value as '' | OutboundAuditResult }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
              <option value="">{t('ops.all')}</option>
              {OUTBOUND_AUDIT_RESULTS.map((result) => <option key={result} value={result}>{result}</option>)}
            </select>
          </Field>
          <Field label={t('ops.policy')}>
            <select value={audit.policyDecision} onChange={(event) => setAudit((current) => ({ ...current, policyDecision: event.target.value as '' | TelegramPolicyDecision }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
              <option value="">{t('ops.all')}</option>
              {TELEGRAM_POLICY_DECISIONS.map((decision) => <option key={decision} value={decision}>{decision}</option>)}
            </select>
          </Field>
          <Field label={t('ops.correlationId')}>
            <input value={audit.correlationId} onChange={(event) => setAudit((current) => ({ ...current, correlationId: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
          </Field>
          <Field label={t('ops.windowSize')}>
            <select value={String(audit.limit)} onChange={(event) => setAudit((current) => ({ ...current, limit: Number(event.target.value) }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
              {windows.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
            </select>
          </Field>
          <Field label={t('ops.after')}>
            <input type="datetime-local" value={audit.after} onChange={(event) => setAudit((current) => ({ ...current, after: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
          </Field>
          <Field label={t('ops.before')}>
            <input type="datetime-local" value={audit.before} onChange={(event) => setAudit((current) => ({ ...current, before: event.target.value }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
          </Field>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (tab === 'logs') {
      return store.logs.length === 0 ? (
        <PageEmpty label={t('ops.noLogs')} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label={t('ops.entries')} value={store.logs.length} />
            <Metric label={t('ops.filesScanned')} value={store.logFilesScanned.length} />
            <Metric label={t('ops.events')} value={store.logs.filter((item) => item.event).length} />
            <Metric label={t('ops.errorLabel')} value={store.logs.filter((item) => item.level === 'error').length} />
          </div>
          {store.logs.map((entry, index) => (
            <Card
              key={`${entry.file}-${entry.timestamp}-${index}`}
              title={`${entry.file} · ${fmt(entry.timestamp)}`}
              subtitle={entry.context ?? undefined}
              rows={[
                [t('ops.level'), entry.level],
                [t('ops.event'), entry.event ?? '—'],
                [t('ops.correlationId'), findValue(entry.payload, 'correlationId', 'correlation_id') ?? '—'],
                [t('ops.chat'), findValue(entry.payload, 'chatId', 'chat_id', 'targetChatId', 'sourceChatId') ?? '—'],
              ]}
              body={mergeBody(entry.message, json(entry.payload))}
            />
          ))}
        </div>
      );
    }

    if (tab === 'monitors') {
      return (
        <div className="space-y-4">
          <form onSubmit={(event) => void submitMonitor(event)} className="grid gap-3 rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--border-secondary)', background: 'var(--panel-surface)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {editingMonitorId ? t('ops.updateMonitorRule') : t('ops.createMonitorRule')}
              </div>
              {editingMonitorId ? <Button label={t('ops.cancelEdit')} onClick={cancelMonitorEdit} variant="secondary" /> : null}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <input value={monitorDraft.monitoredChatId} onChange={(event) => setMonitorDraft((current) => ({ ...current, monitoredChatId: event.target.value }))} placeholder={t('ops.monitoredChatId')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              <input value={monitorDraft.name} onChange={(event) => setMonitorDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t('ops.name')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              <input value={monitorDraft.thresholdSeconds} onChange={(event) => setMonitorDraft((current) => ({ ...current, thresholdSeconds: event.target.value }))} placeholder={t('ops.thresholdSeconds')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" label={editingMonitorId ? t('ops.updateMonitorRule') : t('ops.createMonitorRule')} />
            </div>
          </form>

          <Section title={t('ops.sectionRules')} count={filteredMonitorRules.length}>
            {filteredMonitorRules.length === 0 ? (
              <PageEmpty label={t('ops.noMonitorData')} />
            ) : (
              filteredMonitorRules.map((rule) => (
                <Card
                  key={rule.id}
                  title={rule.name}
                  subtitle={rule.id}
                  rows={[
                    [t('ops.monitoredChatId'), rule.monitoredChatId],
                    [t('ops.thresholdSeconds'), String(rule.thresholdSeconds)],
                    [t('ops.status'), rule.enabled ? t('ops.active') : t('ops.paused')],
                    [t('ops.updated'), fmt(rule.updatedAt)],
                  ]}
                  actions={<><Button label={t('ops.editAction')} onClick={() => startMonitorEdit(rule)} variant="secondary" /><Button label={rule.enabled ? t('ops.pauseAction') : t('ops.resumeAction')} onClick={() => void updateMonitorRule(rule.id, { enabled: !rule.enabled })} variant="secondary" /><Button label={t('ops.runAction')} onClick={() => void runMonitorRule(rule.id)} /><Button label={t('ops.deleteAction')} onClick={() => { if (window.confirm(`${t('ops.deleteConfirm')} ${rule.name}?`)) void deleteMonitorRule(rule.id); }} variant="danger" /></>}
                />
              ))
            )}
          </Section>

          <Section title={t('ops.sectionStates')} count={filteredMonitorStates.length}>
            {filteredMonitorStates.length === 0 ? (
              <PageEmpty label={t('ops.noMonitorData')} />
            ) : (
              filteredMonitorStates.map((item) => (
                <Card
                  key={item.ruleId}
                  title={item.chatTitle ?? item.chatId ?? item.monitoredChatId}
                  subtitle={item.ruleId}
                  rows={[
                    [t('ops.status'), item.status],
                    [t('ops.lastInbound'), fmt(item.lastInboundAt)],
                    [t('ops.lastReply'), fmt(item.lastOwnerReplyAt)],
                    [t('ops.lastEvaluation'), fmt(item.lastEvaluatedAt)],
                    [t('ops.updated'), fmt(item.updatedAt)],
                  ]}
                  body={item.lastEvaluationMessage}
                />
              ))
            )}
          </Section>

          <Section title={t('ops.sectionEvaluations')} count={filteredMonitorEvaluations.length}>
            {filteredMonitorEvaluations.length === 0 ? (
              <PageEmpty label={t('ops.noMonitorData')} />
            ) : (
              filteredMonitorEvaluations.map((item) => (
                <Card
                  key={item.id}
                  title={item.chatTitle ?? item.chatId ?? item.ruleId}
                  subtitle={item.ruleId}
                  rows={[
                    [t('ops.status'), item.evaluationStatus],
                    [t('ops.correlationId'), item.correlationId ?? '—'],
                    [t('ops.chat'), item.chatId ?? '—'],
                    [t('ops.updated'), fmt(item.evaluatedAt)],
                  ]}
                  body={item.message}
                />
              ))
            )}
          </Section>

          <Section title={t('ops.sectionAlerts')} count={filteredMonitorAlerts.length}>
            {filteredMonitorAlerts.length === 0 ? (
              <PageEmpty label={t('ops.noMonitorData')} />
            ) : (
              filteredMonitorAlerts.map((item) => (
                <Card
                  key={`${item.evaluationId}-${item.ruleId}`}
                  title={item.chatTitle ?? item.chatId ?? item.ruleId}
                  subtitle={item.ruleId}
                  rows={[
                    [t('ops.correlationId'), item.correlationId ?? '—'],
                    [t('ops.chat'), item.chatId ?? '—'],
                    [t('ops.updated'), fmt(item.evaluatedAt)],
                  ]}
                  body={item.message}
                />
              ))
            )}
          </Section>
        </div>
      );
    }

    if (tab === 'runtime') {
      return (
        <div className="space-y-4">
          {editingChatId ? (
            <form onSubmit={(event) => void submitChat(event)} className="grid gap-3 rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--border-secondary)', background: 'var(--panel-surface)' }}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {t('ops.updateMonitoredChat')}
                </div>
                <Button label={t('ops.cancelEdit')} onClick={cancelChatEdit} variant="secondary" />
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <input value={chatDraft.chatTitle} onChange={(event) => setChatDraft((current) => ({ ...current, chatTitle: event.target.value }))} placeholder={t('ops.chatTitle')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
                <select value={chatDraft.mode} onChange={(event) => setChatDraft((current) => ({ ...current, mode: event.target.value as TgChatMode }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                  {TG_CHAT_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
                <input value={chatDraft.cooldownSeconds} onChange={(event) => setChatDraft((current) => ({ ...current, cooldownSeconds: event.target.value }))} placeholder={t('ops.cooldown')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              </div>
              <textarea value={chatDraft.systemNote} onChange={(event) => setChatDraft((current) => ({ ...current, systemNote: event.target.value }))} rows={4} placeholder={t('ops.systemNote')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              <div className="flex justify-end">
                <Button type="submit" label={t('ops.updateMonitoredChat')} />
              </div>
            </form>
          ) : null}

          <Section title={t('ops.sectionMonitoredChats')} count={filteredMonitoredChats.length}>
            {filteredMonitoredChats.length === 0 ? (
              <PageEmpty label={t('ops.noRuntime')} />
            ) : (
              filteredMonitoredChats.map((item) => {
                const runtimeState = runtimeByChat.get(item.id);
                const watchState = watchStateByChat.get(item.id);
                const rules = rulesByChat.get(item.id) ?? [];

                return (
                  <Card
                    key={item.id}
                    title={item.chatTitle}
                    subtitle={item.chatId}
                    rows={[
                      [t('ops.chatType'), item.chatType],
                      [t('ops.mode'), item.mode],
                      [t('ops.cooldown'), `${item.cooldownSeconds}s`],
                      [t('ops.policyRestriction'), policyLabel(item.mode)],
                      [t('ops.lastActivity'), fmt(latest(runtimeState))],
                      [t('ops.unansweredState'), watchState?.status ?? '—'],
                      [t('ops.monitorLinkage'), rules.length > 0 ? rules.map((rule) => rule.name).join(', ') : '—'],
                      [t('ops.updated'), fmt(item.updatedAt)],
                    ]}
                    body={item.systemNote}
                    actions={<Button label={t('ops.editAction')} onClick={() => startChatEdit(item)} variant="secondary" />}
                  />
                );
              })
            )}
          </Section>

          <Section title={t('ops.sectionRuntimeStates')} count={filteredRuntimeStates.length}>
            {filteredRuntimeStates.length === 0 ? (
              <PageEmpty label={t('ops.noRuntime')} />
            ) : (
              filteredRuntimeStates.map((item) => (
                <Card
                  key={item.monitoredChatId}
                  title={item.chatTitle}
                  subtitle={item.chatId}
                  rows={[
                    [t('ops.status'), item.status],
                    [t('ops.queue'), `${item.queueLength}/${item.queueActive ? 'active' : 'idle'}`],
                    [t('ops.lastInbound'), fmt(item.lastInboundAt)],
                    [t('ops.lastReply'), fmt(item.lastReplyAt)],
                    [t('ops.lastProcessed'), fmt(item.lastProcessedAt)],
                    [t('ops.cooldown'), fmt(item.cooldownUntil)],
                    [t('ops.conversationId'), item.lastConversationId ?? '—'],
                  ]}
                  body={item.lastErrorMessage}
                />
              ))
            )}
          </Section>
        </div>
      );
    }

    if (tab === 'cron') {
      return (
        <div className="space-y-4">
          <form onSubmit={(event) => void submitCron(event)} className="grid gap-3 rounded-2xl border px-4 py-4" style={{ borderColor: 'var(--border-secondary)', background: 'var(--panel-surface)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {editingCronId ? t('ops.updateCronJob') : t('ops.createCronJob')}
              </div>
              {editingCronId ? <Button label={t('ops.cancelEdit')} onClick={cancelCronEdit} variant="secondary" /> : null}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <input value={cronDraft.name} onChange={(event) => setCronDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t('ops.name')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              <select value={cronDraft.scheduleType} onChange={(event) => setCronDraft((current) => ({ ...current, scheduleType: event.target.value as CronForm['scheduleType'] }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                {cronTypes.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <input value={cronDraft.schedule} onChange={(event) => setCronDraft((current) => ({ ...current, schedule: event.target.value }))} placeholder={t('ops.schedule')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              <input value={cronDraft.maxRuns} onChange={(event) => setCronDraft((current) => ({ ...current, maxRuns: event.target.value }))} placeholder={t('ops.maxRuns')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
              <select value={cronDraft.notificationPolicy} onChange={(event) => setCronDraft((current) => ({ ...current, notificationPolicy: event.target.value as CronJobNotificationPolicy }))} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle}>
                {cronPolicies.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <textarea value={cronDraft.task} onChange={(event) => setCronDraft((current) => ({ ...current, task: event.target.value }))} rows={4} placeholder={t('ops.task')} className="rounded-xl px-3 py-2 text-[12px]" style={inputStyle} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" label={editingCronId ? t('ops.updateCronJob') : t('ops.createCronJob')} />
            </div>
          </form>

          <Section title={t('ops.sectionJobs')} count={filteredCronJobs.length}>
            {filteredCronJobs.length === 0 ? (
              <PageEmpty label={t('ops.noCronData')} />
            ) : (
              filteredCronJobs.map((job) => (
                <Card
                  key={job.id}
                  title={job.name}
                  subtitle={job.id}
                  rows={[
                    [t('ops.schedule'), `${job.scheduleType} · ${job.schedule}`],
                    [t('ops.status'), job.enabled ? t('ops.active') : t('ops.paused')],
                    [t('ops.notificationPolicy'), job.notificationPolicy],
                    [t('ops.nextRun'), fmt(job.nextRunAt)],
                    [t('ops.lastRun'), fmt(job.lastRunAt)],
                  ]}
                  body={job.task}
                  actions={<><Button label={t('ops.editAction')} onClick={() => startCronEdit(job)} variant="secondary" /><Button label={job.enabled ? t('ops.pauseAction') : t('ops.resumeAction')} onClick={() => void (job.enabled ? pauseCronJob(job.id) : resumeCronJob(job.id))} variant="secondary" /><Button label={t('ops.deleteAction')} onClick={() => { if (window.confirm(`${t('ops.deleteConfirm')} ${job.name}?`)) void deleteCronJob(job.id); }} variant="danger" /></>}
                />
              ))
            )}
          </Section>

          <Section title={t('ops.sectionRuns')} count={filteredCronRuns.length}>
            {filteredCronRuns.length === 0 ? (
              <PageEmpty label={t('ops.noCronData')} />
            ) : (
              filteredCronRuns.map((run) => (
                <Card
                  key={run.id}
                  title={run.jobName}
                  subtitle={run.id}
                  rows={[
                    [t('ops.status'), run.status],
                    [t('ops.result'), run.resultStatus],
                    [t('ops.notificationStatus'), run.notificationStatus],
                    [t('ops.attempt'), String(run.attempt)],
                    [t('ops.lastRun'), fmt(run.startedAt)],
                    [t('ops.toolsUsed'), run.toolNames.join(', ') || '—'],
                  ]}
                  body={run.errorMessage ?? run.notificationErrorMessage ?? run.outputPreview}
                />
              ))
            )}
          </Section>
        </div>
      );
    }

    if (tab === 'notify') {
      return (
        <div className="space-y-4">
          <Section title={t('ops.sectionPendingMessages')} count={filteredPendingMessages.length}>
            {filteredPendingMessages.length === 0 ? (
              <PageEmpty label={t('ops.noNotifyRouting')} />
            ) : (
              filteredPendingMessages.map((item) => (
                <Card key={`${item.chatId}-${item.botMessageId}`} title={item.chatTitle} subtitle={item.chatId} rows={[[t('ops.botMessageId'), String(item.botMessageId)], [t('ops.createdAt'), fmt(item.createdAt)], [t('ops.expiresAt'), fmt(item.expiresAt)]]} body={item.question} />
              ))
            )}
          </Section>

          <Section title={t('ops.sectionAwaitingReplies')} count={filteredAwaitingReplies.length}>
            {filteredAwaitingReplies.length === 0 ? (
              <PageEmpty label={t('ops.noNotifyRouting')} />
            ) : (
              filteredAwaitingReplies.map((item) => (
                <Card key={`${item.botChatId}-${item.chatId}`} title={item.chatTitle} subtitle={item.chatId} rows={[[t('ops.botChatId'), String(item.botChatId)], [t('ops.sourceBotMessageId'), String(item.sourceBotMessageId ?? '—')], [t('ops.expiresAt'), fmt(item.expiresAt)]]} body={item.question} />
              ))
            )}
          </Section>

          <Section title={t('ops.sectionNotifyRoutes')} count={filteredNotifyRoutes.length}>
            {filteredNotifyRoutes.length === 0 ? (
              <PageEmpty label={t('ops.noNotifyRouting')} />
            ) : (
              filteredNotifyRoutes.map((item) => (
                <Card key={item.id} title={item.chatTitle} subtitle={item.id} rows={[[t('ops.status'), item.routeStatus], [t('ops.correlationId'), item.correlationId ?? '—'], [t('ops.createdAt'), fmt(item.createdAt)], [t('ops.completedAt'), fmt(item.completedAt)]]} body={`${item.question}${item.replyText ? `\n\n${item.replyText}` : ''}`} />
              ))
            )}
          </Section>
        </div>
      );
    }

    if (tab === 'events') {
      return filteredOperationalEvents.length === 0 ? (
        <PageEmpty label={t('ops.noEvents')} />
      ) : (
        <div className="space-y-3">
          {filteredOperationalEvents.map((item) => (
            <Card
              key={item.id}
              title={item.title}
              subtitle={`${item.kind} · ${fmt(item.timestamp)}`}
              rows={[
                [t('ops.status'), item.status],
                [t('ops.source'), item.source],
                [t('ops.chat'), item.chatTitle ?? item.chatId ?? '—'],
                [t('ops.jobId'), item.jobName ?? item.jobId ?? '—'],
                [t('ops.ruleId'), item.ruleId ?? '—'],
                [t('ops.correlationId'), item.correlationId ?? '—'],
              ]}
              body={mergeBody(item.summary, json(item.payload))}
            />
          ))}
        </div>
      );
    }

    return store.outboundAuditEvents.length === 0 ? (
      <PageEmpty label={t('ops.noAudit')} />
    ) : (
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-3">
          {store.outboundAuditEvents.map((item) => (
            <button key={item.id} type="button" onClick={() => setSelectedAuditId(item.id)} className="w-full text-left">
              <Card
                selected={item.id === selectedAuditId}
                title={item.targetChatTitle ?? item.targetChatId ?? item.id}
                subtitle={`${item.channel} · ${fmt(item.createdAt)}`}
                rows={[
                  [t('ops.actor'), item.actor],
                  [t('ops.origin'), item.origin],
                  [t('ops.policy'), item.policyDecision],
                  [t('ops.decisionReason'), item.policyReasonCode],
                  [t('ops.result'), item.result],
                  [t('ops.correlationId'), item.correlationId ?? '—'],
                ]}
                body={item.errorMessage ?? item.payloadPreview}
              />
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {selectedAuditEvent ? (
            <Card
              title={t('ops.auditDetails')}
              subtitle={selectedAuditEvent.id}
              rows={[
                [t('ops.target'), selectedAuditEvent.targetChatTitle ?? selectedAuditEvent.targetChatId ?? '—'],
                [t('ops.chat'), selectedAuditEvent.targetChatId ?? '—'],
                [t('ops.actor'), selectedAuditEvent.actor],
                [t('ops.origin'), selectedAuditEvent.origin],
                [t('ops.policy'), selectedAuditEvent.policyDecision],
                [t('ops.decisionReason'), selectedAuditEvent.policyReasonCode],
                [t('ops.mode'), selectedAuditEvent.monitoredMode ?? '—'],
                [t('ops.monitoredChatId'), selectedAuditEvent.monitoredChatId ?? '—'],
                [t('ops.conversationId'), selectedAuditEvent.conversationId ?? '—'],
                [t('ops.result'), selectedAuditEvent.result],
                [t('ops.createdAt'), fmt(selectedAuditEvent.createdAt)],
                [t('ops.updated'), fmt(selectedAuditEvent.updatedAt)],
              ]}
              body={mergeBody(selectedAuditEvent.errorMessage, selectedAuditEvent.payloadPreview)}
            />
          ) : (
            <PageEmpty label={t('ops.noAudit')} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Activity}
        title={t('ops.title')}
        subtitle={store.lastUpdatedAt ? `${t('ops.updated')}: ${fmt(store.lastUpdatedAt)}` : t('ops.subtitle')}
        actions={<button type="button" onClick={() => void refresh()} disabled={store.isLoading} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-60" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><RefreshCw className={store.isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{t('ops.refresh')}</button>}
      />
      <TabBar tabs={tabs} activeTab={tab} onChange={setTab} variant="pill" />
      {renderFilters()}
      <PageDivider />
      {(store.error || localError) ? <PageError message={localError ?? store.error ?? ''} onDismiss={clearErrors} dismissLabel={t('common.dismiss')} /> : null}
      <PageScrollArea>
        <div className="space-y-4">
          {store.isLoading && !hasTabData ? <PageLoading label={t('common.loading')} /> : renderContent()}
        </div>
      </PageScrollArea>
      <PageFooter>
        <p className="text-center text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {t('ops.subtitle')}
        </p>
      </PageFooter>
    </div>
  );
}
