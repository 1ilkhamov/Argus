import { Injectable } from '@nestjs/common';

import { CronJobRunRepository } from '../cron/cron-run.repository';
import type { CronJobRun } from '../cron/cron-run.types';
import { MonitorRepository } from '../monitors/monitor.repository';
import type { TelegramWatchAlertRecord, TelegramWatchEvaluationResult } from '../monitors/monitor.types';
import { TelegramOutboundAuditRepository } from '../telegram-runtime/telegram-outbound-audit.repository';
import type { TelegramOutboundAuditEvent } from '../telegram-runtime/telegram-runtime.types';
import { PendingNotifyService } from '../tools/core/pending-notify.service';
import type { PendingNotifyRouteRecord } from '../tools/core/pending-notify.types';
import type { ListStructuredOperationalEventsParams, StructuredOperationalEvent, StructuredOperationalEventKind, StructuredOperationalEventSeverity } from './ops-events.types';

@Injectable()
export class OpsEventsService {
  constructor(
    private readonly cronRunRepository: CronJobRunRepository,
    private readonly monitorRepository: MonitorRepository,
    private readonly outboundAuditRepository: TelegramOutboundAuditRepository,
    private readonly pendingNotifyService: PendingNotifyService,
  ) {}

  async listEvents(params: ListStructuredOperationalEventsParams = {}): Promise<StructuredOperationalEvent[]> {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const sourceLimit = Math.min(Math.max(limit * 4, 50), 200);
    const kinds = params.kind ? [params.kind] : undefined;

    const [cronRuns, evaluations, alerts, outboundEvents, notifyRoutes] = await Promise.all([
      this.shouldLoad(kinds, 'cron_run')
        ? this.cronRunRepository.findRecent({ jobId: params.jobId, limit: sourceLimit })
        : Promise.resolve([] as CronJobRun[]),
      this.shouldLoad(kinds, 'monitor_evaluation')
        ? this.monitorRepository.listEvaluations(params.ruleId, sourceLimit)
        : Promise.resolve([] as TelegramWatchEvaluationResult[]),
      this.shouldLoad(kinds, 'monitor_alert')
        ? this.monitorRepository.listAlertHistory(params.ruleId, sourceLimit)
        : Promise.resolve([] as TelegramWatchAlertRecord[]),
      this.shouldLoad(kinds, 'telegram_outbound')
        ? this.outboundAuditRepository.search({ targetChatId: params.chatId, limit: sourceLimit })
        : Promise.resolve([] as TelegramOutboundAuditEvent[]),
      this.shouldLoad(kinds, 'notify_route')
        ? Promise.resolve(this.pendingNotifyService.getSnapshot(sourceLimit).recentRoutes)
        : Promise.resolve([] as PendingNotifyRouteRecord[]),
    ]);

    const events = [
      ...cronRuns.map((run) => this.mapCronRun(run)),
      ...evaluations.map((evaluation) => this.mapMonitorEvaluation(evaluation)),
      ...alerts.map((alert) => this.mapMonitorAlert(alert)),
      ...outboundEvents.map((event) => this.mapOutboundAudit(event)),
      ...notifyRoutes.map((route) => this.mapNotifyRoute(route)),
    ];

    return events
      .filter((event) => this.matchesFilters(event, params))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, limit);
  }

  private shouldLoad(kinds: StructuredOperationalEventKind[] | undefined, kind: StructuredOperationalEventKind): boolean {
    return !kinds || kinds.includes(kind);
  }

  private matchesFilters(event: StructuredOperationalEvent, params: ListStructuredOperationalEventsParams): boolean {
    if (params.kind && event.kind !== params.kind) {
      return false;
    }
    if (params.correlationId && event.correlationId !== params.correlationId) {
      return false;
    }
    if (params.chatId && event.chatId !== params.chatId) {
      return false;
    }
    if (params.jobId && event.jobId !== params.jobId) {
      return false;
    }
    if (params.ruleId && event.ruleId !== params.ruleId) {
      return false;
    }
    if (params.before && event.timestamp >= params.before) {
      return false;
    }
    if (params.after && event.timestamp <= params.after) {
      return false;
    }
    return true;
  }

  private mapCronRun(run: CronJobRun): StructuredOperationalEvent {
    return {
      id: `cron_run:${run.id}`,
      kind: 'cron_run',
      timestamp: run.finishedAt ?? run.startedAt,
      severity: this.mapCronSeverity(run),
      status: run.status,
      source: 'cron',
      title: `Cron job ${run.jobName}`,
      summary: run.errorMessage ?? run.outputPreview ?? `Result ${run.resultStatus}, notification ${run.notificationStatus}`,
      correlationId: null,
      chatId: null,
      chatTitle: null,
      jobId: run.jobId,
      jobName: run.jobName,
      ruleId: null,
      monitoredChatId: null,
      payload: {
        rawId: run.id,
        attempt: run.attempt,
        scheduleType: run.scheduleType,
        schedule: run.schedule,
        scheduledFor: run.scheduledFor,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        resultStatus: run.resultStatus,
        notificationStatus: run.notificationStatus,
        outputPreview: run.outputPreview,
        errorMessage: run.errorMessage,
        notificationErrorMessage: run.notificationErrorMessage,
        toolRoundsUsed: run.toolRoundsUsed,
        toolNames: run.toolNames,
      },
    };
  }

  private mapMonitorEvaluation(evaluation: TelegramWatchEvaluationResult): StructuredOperationalEvent {
    return {
      id: `monitor_evaluation:${evaluation.id}`,
      kind: 'monitor_evaluation',
      timestamp: evaluation.evaluatedAt,
      severity: this.mapMonitorEvaluationSeverity(evaluation.evaluationStatus),
      status: evaluation.evaluationStatus,
      source: 'monitor_watchdog',
      title: `Monitor evaluation ${evaluation.ruleId}`,
      summary: evaluation.message,
      correlationId: evaluation.correlationId,
      chatId: evaluation.chatId,
      chatTitle: evaluation.chatTitle,
      jobId: null,
      jobName: null,
      ruleId: evaluation.ruleId,
      monitoredChatId: evaluation.monitoredChatId,
      payload: {
        rawId: evaluation.id,
        ruleType: evaluation.ruleType,
        stateStatus: evaluation.stateStatus,
        lastInboundMessageId: evaluation.lastInboundMessageId,
        lastOwnerReplyMessageId: evaluation.lastOwnerReplyMessageId,
        dedupeKey: evaluation.dedupeKey,
        alertTriggered: evaluation.alertTriggered,
      },
    };
  }

  private mapMonitorAlert(alert: TelegramWatchAlertRecord): StructuredOperationalEvent {
    return {
      id: `monitor_alert:${alert.evaluationId}`,
      kind: 'monitor_alert',
      timestamp: alert.evaluatedAt,
      severity: 'warning',
      status: 'alerted',
      source: 'monitor_watchdog',
      title: `Monitor alert ${alert.ruleId}`,
      summary: alert.message,
      correlationId: alert.correlationId,
      chatId: alert.chatId,
      chatTitle: alert.chatTitle,
      jobId: null,
      jobName: null,
      ruleId: alert.ruleId,
      monitoredChatId: alert.monitoredChatId,
      payload: {
        evaluationId: alert.evaluationId,
        lastInboundMessageId: alert.lastInboundMessageId,
        dedupeKey: alert.dedupeKey,
      },
    };
  }

  private mapOutboundAudit(event: TelegramOutboundAuditEvent): StructuredOperationalEvent {
    return {
      id: `telegram_outbound:${event.id}`,
      kind: 'telegram_outbound',
      timestamp: event.createdAt,
      severity: this.mapOutboundSeverity(event),
      status: event.result,
      source: 'telegram_outbound',
      title: `Telegram ${event.action} via ${event.channel}`,
      summary: event.payloadPreview ?? event.errorMessage ?? `${event.actor} ${event.result}`,
      correlationId: event.correlationId,
      chatId: event.targetChatId,
      chatTitle: event.targetChatTitle,
      jobId: null,
      jobName: null,
      ruleId: null,
      monitoredChatId: event.monitoredChatId,
      payload: {
        rawId: event.id,
        channel: event.channel,
        action: event.action,
        actor: event.actor,
        origin: event.origin,
        policyDecision: event.policyDecision,
        policyReasonCode: event.policyReasonCode,
        result: event.result,
        monitoredMode: event.monitoredMode,
        scopeKey: event.scopeKey,
        conversationId: event.conversationId,
        errorMessage: event.errorMessage,
      },
    };
  }

  private mapNotifyRoute(route: PendingNotifyRouteRecord): StructuredOperationalEvent {
    return {
      id: `notify_route:${route.id}`,
      kind: 'notify_route',
      timestamp: new Date(route.completedAt).toISOString(),
      severity: route.routeStatus === 'expired' ? 'warning' : 'info',
      status: route.routeStatus,
      source: 'notify_routing',
      title: `Notify reply route ${route.chatTitle}`,
      summary: route.replyText ?? `Reply routing ${route.routeStatus}`,
      correlationId: route.correlationId,
      chatId: route.chatId,
      chatTitle: route.chatTitle,
      jobId: null,
      jobName: null,
      ruleId: null,
      monitoredChatId: null,
      payload: {
        rawId: route.id,
        botChatId: route.botChatId,
        sourceBotMessageId: route.sourceBotMessageId,
        question: route.question,
        replyText: route.replyText,
        createdAt: new Date(route.createdAt).toISOString(),
        completedAt: new Date(route.completedAt).toISOString(),
      },
    };
  }

  private mapCronSeverity(run: CronJobRun): StructuredOperationalEventSeverity {
    if (run.status === 'failed') {
      return 'error';
    }
    if (run.status === 'canceled') {
      return 'warning';
    }
    return 'info';
  }

  private mapMonitorEvaluationSeverity(status: TelegramWatchEvaluationResult['evaluationStatus']): StructuredOperationalEventSeverity {
    if (status === 'error') {
      return 'error';
    }
    if (status === 'alerted' || status === 'deduped') {
      return 'warning';
    }
    return 'info';
  }

  private mapOutboundSeverity(event: TelegramOutboundAuditEvent): StructuredOperationalEventSeverity {
    if (event.result === 'failed') {
      return 'error';
    }
    if (event.result === 'blocked') {
      return 'warning';
    }
    return 'info';
  }
}
