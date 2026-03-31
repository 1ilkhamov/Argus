import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, Clock3, FileText, Radio, RefreshCw, ShieldCheck } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import {
  LOG_ENTRY_LEVELS,
  LOG_FILE_KINDS,
  OUTBOUND_AUDIT_ACTORS,
  OUTBOUND_AUDIT_RESULTS,
  type LogEntryLevel,
  type LogFileKind,
  type OutboundAuditActor,
  type OutboundAuditResult,
} from '@/api/resources/ops.api';
import { PageDivider, PageEmpty, PageError, PageFooter, PageHeader, PageLoading, PageScrollArea, PageSearchBar, TabBar } from '@/components/common';
import type { TabItem } from '@/components/common';
import { useOpsStore } from '@/stores/ops/ops.store';
import { useLangStore } from '@/stores/ui/lang.store';

type OpsTab = 'logs' | 'monitors' | 'runtime' | 'cron' | 'audit';
type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function includesNeedle(needle: string, ...values: Array<string | number | null | undefined>): boolean {
  if (!needle) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(needle));
}

function toneColor(tone: BadgeTone): { background: string; color: string } {
  if (tone === 'success') return { background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e' };
  if (tone === 'warning') return { background: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b' };
  if (tone === 'danger') return { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' };
  return { background: 'var(--panel-muted)', color: 'var(--text-secondary)' };
}

function Badge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  const style = toneColor(tone);
  return <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={style}>{label}</span>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl px-3 py-2" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)' }}><div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{label}</div><div className="mt-1 text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div></div>;
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}><span>{label}</span>{children}</label>;
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section><div className="mb-2 flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{title}</h3><Badge label={String(count)} /></div><div className="space-y-2">{children}</div></section>;
}

function Card({ title, subtitle, badges, lines, body }: { title: string; subtitle?: string; badges?: ReactNode; lines?: Array<[string, string]>; body?: string | null }) {
  return <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)', border: '1px solid var(--border-secondary)' }}><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>{subtitle && <div className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{subtitle}</div>}</div>{badges && <div className="flex shrink-0 flex-wrap items-center gap-1">{badges}</div>}</div>{lines && lines.length > 0 && <div className="mt-2 grid gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{lines.map(([label, value]) => <div key={`${title}-${label}`} className="flex gap-2"><span className="min-w-[108px]" style={{ color: 'var(--text-tertiary)' }}>{label}</span><span className="min-w-0 break-words">{value}</span></div>)}</div>}{body && <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[11px]" style={{ background: 'var(--panel-muted)', color: 'var(--text-secondary)' }}>{body}</pre>}</div>;
}

export function OpsPanel() {
  const { t } = useLangStore();
  const [activeTab, setActiveTab] = useState<OpsTab>('logs');
  const [logQuery, setLogQuery] = useState('');
  const [logLevel, setLogLevel] = useState<'' | LogEntryLevel>('');
  const [logContext, setLogContext] = useState('');
  const [logEvent, setLogEvent] = useState('');
  const [logFileKind, setLogFileKind] = useState<'' | LogFileKind>('');
  const [logDate, setLogDate] = useState('');
  const [monitorQuery, setMonitorQuery] = useState('');
  const [runtimeQuery, setRuntimeQuery] = useState('');
  const [cronQuery, setCronQuery] = useState('');
  const [auditChatId, setAuditChatId] = useState('');
  const [auditActor, setAuditActor] = useState<'' | OutboundAuditActor>('');
  const [auditResult, setAuditResult] = useState<'' | OutboundAuditResult>('');
  const {
    logs, logFilesScanned, monitorRules, monitorStates, monitorEvaluations, monitorAlerts,
    runtimeStates, cronJobs, cronRuns, outboundAuditEvents, isLoading, error, lastUpdatedAt,
    loadLogs, loadMonitorSnapshot, loadRuntimeStates, loadCronSnapshot, loadOutboundAudit, clearError,
  } = useOpsStore(useShallow((s) => ({
    logs: s.logs,
    logFilesScanned: s.logFilesScanned,
    monitorRules: s.monitorRules,
    monitorStates: s.monitorStates,
    monitorEvaluations: s.monitorEvaluations,
    monitorAlerts: s.monitorAlerts,
    runtimeStates: s.runtimeStates,
    cronJobs: s.cronJobs,
    cronRuns: s.cronRuns,
    outboundAuditEvents: s.outboundAuditEvents,
    isLoading: s.isLoading,
    error: s.error,
    lastUpdatedAt: s.lastUpdatedAt,
    loadLogs: s.loadLogs,
    loadMonitorSnapshot: s.loadMonitorSnapshot,
    loadRuntimeStates: s.loadRuntimeStates,
    loadCronSnapshot: s.loadCronSnapshot,
    loadOutboundAudit: s.loadOutboundAudit,
    clearError: s.clearError,
  })));

  const refresh = useCallback(async () => {
    if (activeTab === 'logs') return loadLogs({ query: logQuery.trim() || undefined, level: logLevel || undefined, context: logContext.trim() || undefined, event: logEvent.trim() || undefined, fileKind: logFileKind || undefined, date: logDate || undefined, limit: 50 });
    if (activeTab === 'monitors') return loadMonitorSnapshot();
    if (activeTab === 'runtime') return loadRuntimeStates();
    if (activeTab === 'cron') return loadCronSnapshot();
    return loadOutboundAudit({ actor: auditActor || undefined, result: auditResult || undefined, chatId: auditChatId.trim() || undefined, limit: 50 });
  }, [activeTab, auditActor, auditChatId, auditResult, loadCronSnapshot, loadLogs, loadMonitorSnapshot, loadOutboundAudit, loadRuntimeStates, logContext, logDate, logEvent, logFileKind, logLevel, logQuery]);

  useEffect(() => { void refresh(); }, [refresh]);

  const monitorNeedle = monitorQuery.trim().toLowerCase();
  const runtimeNeedle = runtimeQuery.trim().toLowerCase();
  const cronNeedle = cronQuery.trim().toLowerCase();
  const filteredMonitorRules = useMemo(() => monitorRules.filter((rule) => includesNeedle(monitorNeedle, rule.id, rule.name, rule.monitoredChatId)), [monitorNeedle, monitorRules]);
  const filteredMonitorStates = useMemo(() => monitorStates.filter((state) => includesNeedle(monitorNeedle, state.ruleId, state.chatId, state.chatTitle, state.lastEvaluationMessage)), [monitorNeedle, monitorStates]);
  const filteredMonitorEvaluations = useMemo(() => monitorEvaluations.filter((item) => includesNeedle(monitorNeedle, item.ruleId, item.chatId, item.chatTitle, item.message)), [monitorNeedle, monitorEvaluations]);
  const filteredMonitorAlerts = useMemo(() => monitorAlerts.filter((item) => includesNeedle(monitorNeedle, item.ruleId, item.chatId, item.chatTitle, item.message)), [monitorNeedle, monitorAlerts]);
  const filteredRuntimeStates = useMemo(() => runtimeStates.filter((state) => includesNeedle(runtimeNeedle, state.chatId, state.chatTitle, state.mode, state.status, state.lastInboundSenderName, state.lastErrorMessage)), [runtimeNeedle, runtimeStates]);
  const filteredCronJobs = useMemo(() => cronJobs.filter((job) => includesNeedle(cronNeedle, job.id, job.name, job.task, job.schedule)), [cronNeedle, cronJobs]);
  const filteredCronRuns = useMemo(() => cronRuns.filter((run) => includesNeedle(cronNeedle, run.id, run.jobId, run.jobName, run.outputPreview, run.errorMessage)), [cronNeedle, cronRuns]);

  const tabs: TabItem<OpsTab>[] = [
    { key: 'logs', label: t('ops.tabLogs'), icon: FileText, count: logs.length },
    { key: 'monitors', label: t('ops.tabMonitors'), icon: BellRing, count: monitorRules.length },
    { key: 'runtime', label: t('ops.tabRuntime'), icon: Radio, count: runtimeStates.length },
    { key: 'cron', label: t('ops.tabCron'), icon: Clock3, count: cronJobs.length },
    { key: 'audit', label: t('ops.tabAudit'), icon: ShieldCheck, count: outboundAuditEvents.length },
  ];

  const renderFilters = () => {
    if (activeTab === 'logs') return <><PageSearchBar value={logQuery} onChange={setLogQuery} placeholder={t('ops.searchLogs')} /><div className="grid grid-cols-1 gap-2 px-6 pb-3 md:grid-cols-5"><FilterField label={t('ops.level')}><select value={logLevel} onChange={(e) => setLogLevel(e.target.value as '' | LogEntryLevel)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }}><option value="">{t('ops.all')}</option>{LOG_ENTRY_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></FilterField><FilterField label={t('ops.fileKind')}><select value={logFileKind} onChange={(e) => setLogFileKind(e.target.value as '' | LogFileKind)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }}><option value="">{t('ops.all')}</option>{LOG_FILE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></FilterField><FilterField label={t('ops.context')}><input value={logContext} onChange={(e) => setLogContext(e.target.value)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }} /></FilterField><FilterField label={t('ops.event')}><input value={logEvent} onChange={(e) => setLogEvent(e.target.value)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }} /></FilterField><FilterField label={t('ops.date')}><input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }} /></FilterField></div></>;
    if (activeTab === 'monitors') return <PageSearchBar value={monitorQuery} onChange={setMonitorQuery} placeholder={t('ops.monitorSearch')} />;
    if (activeTab === 'runtime') return <PageSearchBar value={runtimeQuery} onChange={setRuntimeQuery} placeholder={t('ops.runtimeSearch')} />;
    if (activeTab === 'cron') return <PageSearchBar value={cronQuery} onChange={setCronQuery} placeholder={t('ops.cronSearch')} />;
    return <><PageSearchBar value={auditChatId} onChange={setAuditChatId} placeholder={t('ops.auditSearch')} /><div className="grid grid-cols-1 gap-2 px-6 pb-3 md:grid-cols-2"><FilterField label={t('ops.actor')}><select value={auditActor} onChange={(e) => setAuditActor(e.target.value as '' | OutboundAuditActor)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }}><option value="">{t('ops.all')}</option>{OUTBOUND_AUDIT_ACTORS.map((actor) => <option key={actor} value={actor}>{actor}</option>)}</select></FilterField><FilterField label={t('ops.result')}><select value={auditResult} onChange={(e) => setAuditResult(e.target.value as '' | OutboundAuditResult)} className="rounded-xl px-3 py-2 text-[12px]" style={{ background: 'var(--panel-muted)', border: '1px solid var(--border-secondary)', color: 'var(--text-primary)' }}><option value="">{t('ops.all')}</option>{OUTBOUND_AUDIT_RESULTS.map((result) => <option key={result} value={result}>{result}</option>)}</select></FilterField></div></>;
  };

  const renderContent = () => {
    if (isLoading) return <PageLoading label={t('common.loading')} />;
    if (activeTab === 'logs') return logs.length === 0 ? <PageEmpty label={t('ops.noLogs')} /> : <div className="space-y-3"><div className="grid grid-cols-2 gap-2 md:grid-cols-3"><Metric label={t('ops.entries')} value={logs.length} /><Metric label={t('ops.filesScanned')} value={logFilesScanned.length} /><Metric label={t('ops.events')} value={logs.filter((entry) => entry.event).length} /></div>{logs.map((entry, index) => <Card key={`${entry.file}-${entry.timestamp}-${index}`} title={`${entry.file} · ${formatDate(entry.timestamp)}`} subtitle={entry.context ?? undefined} badges={<><Badge label={entry.level} tone={entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warning' : 'neutral'} />{entry.event && <Badge label={entry.event} tone="success" />}</>} body={entry.message} />)}</div>;
    if (activeTab === 'monitors') return filteredMonitorRules.length + filteredMonitorStates.length === 0 ? <PageEmpty label={t('ops.noMonitorData')} /> : <div className="space-y-4"><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label={t('ops.rules')} value={filteredMonitorRules.length} /><Metric label={t('ops.states')} value={filteredMonitorStates.length} /><Metric label={t('ops.evaluations')} value={filteredMonitorEvaluations.length} /><Metric label={t('ops.alerts')} value={filteredMonitorAlerts.length} /></div><Section title={t('ops.sectionRules')} count={filteredMonitorRules.length}>{filteredMonitorRules.map((rule) => <Card key={rule.id} title={rule.name} subtitle={rule.id} badges={<><Badge label={rule.enabled ? t('ops.active') : t('ops.paused')} tone={rule.enabled ? 'success' : 'warning'} /><Badge label={`${rule.thresholdSeconds}s`} /></>} lines={[[t('ops.chat'), rule.monitoredChatId], [t('ops.updated'), formatDate(rule.updatedAt)]]} />)}</Section><Section title={t('ops.sectionStates')} count={filteredMonitorStates.length}>{filteredMonitorStates.map((state) => <Card key={state.ruleId} title={state.chatTitle ?? state.chatId ?? state.monitoredChatId} subtitle={state.ruleId} badges={<><Badge label={state.status} tone={state.status === 'alerted' ? 'danger' : state.status === 'unanswered' ? 'warning' : 'neutral'} /><Badge label={state.lastEvaluationStatus} /></>} lines={[[t('ops.lastInbound'), formatDate(state.lastInboundAt)], [t('ops.lastReply'), formatDate(state.lastOwnerReplyAt)], [t('ops.lastEvaluation'), formatDate(state.lastEvaluatedAt)]]} body={state.lastEvaluationMessage} />)}</Section><Section title={t('ops.sectionEvaluations')} count={filteredMonitorEvaluations.length}>{filteredMonitorEvaluations.map((item) => <Card key={item.id} title={item.chatTitle ?? item.chatId ?? item.ruleId} subtitle={item.ruleId} badges={<><Badge label={item.evaluationStatus} tone={item.alertTriggered ? 'danger' : item.evaluationStatus === 'resolved' ? 'success' : 'warning'} /><Badge label={item.stateStatus} /></>} lines={[[t('ops.chat'), item.monitoredChatId], [t('ops.updated'), formatDate(item.evaluatedAt)]]} body={item.message} />)}</Section><Section title={t('ops.sectionAlerts')} count={filteredMonitorAlerts.length}>{filteredMonitorAlerts.map((item) => <Card key={`${item.evaluationId}-${item.ruleId}`} title={item.chatTitle ?? item.chatId ?? item.ruleId} subtitle={item.ruleId} badges={<Badge label={item.dedupeKey ?? 'alert'} tone="danger" />} lines={[[t('ops.chat'), item.monitoredChatId], [t('ops.updated'), formatDate(item.evaluatedAt)]]} body={item.message} />)}</Section></div>;
    if (activeTab === 'runtime') return filteredRuntimeStates.length === 0 ? <PageEmpty label={t('ops.noRuntime')} /> : <div className="space-y-3"><div className="grid grid-cols-2 gap-2 md:grid-cols-3"><Metric label={t('ops.states')} value={filteredRuntimeStates.length} /><Metric label={t('ops.queue')} value={filteredRuntimeStates.reduce((sum, state) => sum + state.queueLength, 0)} /><Metric label={t('ops.errorLabel')} value={filteredRuntimeStates.filter((state) => state.status === 'error').length} /></div>{filteredRuntimeStates.map((state) => <Card key={state.monitoredChatId} title={state.chatTitle} subtitle={state.chatId} badges={<><Badge label={state.status} tone={state.status === 'error' ? 'danger' : state.status === 'processing' || state.status === 'queued' ? 'warning' : 'neutral'} /><Badge label={state.mode} /></>} lines={[[t('ops.queue'), `${state.queueLength} · active=${state.queueActive}`], [t('ops.lastInbound'), formatDate(state.lastInboundAt)], [t('ops.lastReply'), formatDate(state.lastReplyAt)], [t('ops.cooldown'), formatDate(state.cooldownUntil)], [t('ops.updated'), formatDate(state.updatedAt)]]} body={state.lastErrorMessage} />)}</div>;
    if (activeTab === 'cron') return filteredCronJobs.length + filteredCronRuns.length === 0 ? <PageEmpty label={t('ops.noCronData')} /> : <div className="space-y-4"><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label={t('ops.jobs')} value={filteredCronJobs.length} /><Metric label={t('ops.runs')} value={filteredCronRuns.length} /><Metric label={t('ops.active')} value={filteredCronJobs.filter((job) => job.enabled).length} /><Metric label={t('ops.errorLabel')} value={filteredCronRuns.filter((run) => run.status === 'failed').length} /></div><Section title={t('ops.sectionJobs')} count={filteredCronJobs.length}>{filteredCronJobs.map((job) => <Card key={job.id} title={job.name} subtitle={job.id} badges={<><Badge label={job.enabled ? t('ops.active') : t('ops.paused')} tone={job.enabled ? 'success' : 'warning'} /><Badge label={job.scheduleType} /></>} lines={[[t('ops.schedule'), job.schedule], [t('ops.nextRun'), formatDate(job.nextRunAt)], [t('ops.lastRun'), formatDate(job.lastRunAt)]]} body={job.task} />)}</Section><Section title={t('ops.sectionRuns')} count={filteredCronRuns.length}>{filteredCronRuns.map((run) => <Card key={run.id} title={run.jobName} subtitle={run.jobId} badges={<Badge label={run.status} tone={run.status === 'failed' ? 'danger' : run.status === 'success' || run.status === 'notified' ? 'success' : 'warning'} />} lines={[[t('ops.attempt'), String(run.attempt)], [t('ops.schedule'), `${run.scheduleType} · ${run.schedule}`], [t('ops.updated'), formatDate(run.startedAt)], [t('ops.toolsUsed'), run.toolNames.length ? `${run.toolNames.join(', ')} (${run.toolRoundsUsed})` : '—']]} body={run.errorMessage ?? run.outputPreview} />)}</Section></div>;
    return outboundAuditEvents.length === 0 ? <PageEmpty label={t('ops.noAudit')} /> : <div className="space-y-3"><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label={t('ops.events')} value={outboundAuditEvents.length} /><Metric label={t('ops.result')} value={outboundAuditEvents.filter((event) => event.result === 'sent').length} /><Metric label={t('ops.actor')} value={new Set(outboundAuditEvents.map((event) => event.actor)).size} /><Metric label={t('ops.target')} value={new Set(outboundAuditEvents.map((event) => event.targetChatId ?? event.targetChatTitle ?? event.id)).size} /></div>{outboundAuditEvents.map((event) => <Card key={event.id} title={event.targetChatTitle ?? event.targetChatId ?? event.id} subtitle={formatDate(event.createdAt)} badges={<><Badge label={event.result} tone={event.result === 'failed' || event.result === 'blocked' ? 'danger' : event.result === 'sent' ? 'success' : 'warning'} /><Badge label={event.actor} /></>} lines={[[t('ops.origin'), event.origin], [t('ops.policy'), `${event.policyDecision}/${event.policyReasonCode}`], [t('ops.chat'), event.targetChatId ?? '—']]} body={event.errorMessage ?? event.payloadPreview} />)}</div>;
  };

  return <div className="flex h-full flex-col"><PageHeader icon={Activity} title={t('ops.title')} subtitle={lastUpdatedAt ? `${t('ops.updated')}: ${formatDate(lastUpdatedAt)}` : t('ops.subtitle')} actions={<button onClick={() => void refresh()} disabled={isLoading} className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium disabled:opacity-50" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{<RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />}{t('ops.refresh')}</button>} /><TabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} variant="pill" />{renderFilters()}<PageDivider />{error && <PageError message={error} onDismiss={clearError} dismissLabel={t('common.dismiss')} />}<PageScrollArea>{renderContent()}</PageScrollArea><PageFooter><p className="text-center text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('ops.subtitle')}</p></PageFooter></div>;
}
