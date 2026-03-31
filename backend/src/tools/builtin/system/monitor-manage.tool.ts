import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { TelegramWatchdogService } from '../../../monitors/telegram-watchdog.service';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

@Injectable()
export class MonitorManageTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(MonitorManageTool.name);

  readonly definition: ToolDefinition = {
    name: 'monitor_manage',
    description:
      'Manage monitor rules and inspect monitor runtime state for stateful backend monitors. Use this for unanswered-message watchdog rules, evaluation history, dedupe state, alert history, and pause/resume flows. Do NOT use this for monitored Telegram chat configuration; use telegram_client for chat modes/cooldowns.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: ['list_rules', 'create_rule', 'update_rule', 'pause_rule', 'resume_rule', 'delete_rule', 'list_states', 'list_evaluations', 'list_alerts', 'run_rule'],
        },
        id: {
          type: 'string',
          description: 'Monitor rule ID for update/pause/resume/delete/run or filtering history.',
        },
        monitored_chat_id: {
          type: 'string',
          description: 'Monitored chat ID for create_rule or update_rule. This is the internal monitored chat record ID, not the Telegram chat ID.',
        },
        name: {
          type: 'string',
          description: 'Optional human-readable monitor rule name for create_rule or update_rule.',
        },
        threshold_seconds: {
          type: 'number',
          description: 'Threshold in seconds before an unanswered-message alert is triggered.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of evaluations or alerts to return. Default: 20, max: 100.',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
    timeoutMs: 20_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly watchdogService: TelegramWatchdogService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('monitor_manage tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();

    try {
      switch (action) {
        case 'list_rules':
          return this.handleListRules();
        case 'create_rule':
          return this.handleCreateRule(args);
        case 'update_rule':
          return this.handleUpdateRule(args);
        case 'pause_rule':
          return this.handlePauseRule(args);
        case 'resume_rule':
          return this.handleResumeRule(args);
        case 'delete_rule':
          return this.handleDeleteRule(args);
        case 'list_states':
          return this.handleListStates();
        case 'list_evaluations':
          return this.handleListEvaluations(args);
        case 'list_alerts':
          return this.handleListAlerts(args);
        case 'run_rule':
          return this.handleRunRule(args);
        default:
          return 'Unknown action. Use list_rules, create_rule, update_rule, pause_rule, resume_rule, delete_rule, list_states, list_evaluations, list_alerts, or run_rule.';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`monitor_manage ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  private async handleListRules(): Promise<string> {
    const rules = await this.watchdogService.listRules();
    if (!rules.length) {
      return 'No monitor rules configured.';
    }

    const lines = rules.map((rule) => [
      `- **${rule.name}** (${rule.enabled ? 'enabled' : 'paused'})`,
      `  ID: ${rule.id}`,
      `  Type: ${rule.ruleType}`,
      `  Monitored chat ID: ${rule.monitoredChatId}`,
      `  Threshold: ${rule.thresholdSeconds}s`,
      `  Updated: ${rule.updatedAt}`,
    ].join('\n'));

    return `Monitor rules (${rules.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleCreateRule(args: Record<string, unknown>): Promise<string> {
    const monitoredChatId = String(args.monitored_chat_id ?? '').trim();
    if (!monitoredChatId) {
      return 'Error: "monitored_chat_id" is required for create_rule.';
    }

    const rule = await this.watchdogService.createRule({
      monitoredChatId,
      name: args.name ? String(args.name).trim() : undefined,
      thresholdSeconds: args.threshold_seconds === undefined ? undefined : Number(args.threshold_seconds),
    });

    return [
      'Monitor rule created successfully.',
      `ID: ${rule.id}`,
      `Name: ${rule.name}`,
      `Type: ${rule.ruleType}`,
      `Monitored chat ID: ${rule.monitoredChatId}`,
      `Threshold: ${rule.thresholdSeconds}s`,
    ].join('\n');
  }

  private async handleUpdateRule(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for update_rule.';
    }

    const rule = await this.watchdogService.updateRule(id, {
      monitoredChatId: args.monitored_chat_id ? String(args.monitored_chat_id).trim() : undefined,
      name: args.name === undefined ? undefined : String(args.name).trim(),
      thresholdSeconds: args.threshold_seconds === undefined ? undefined : Number(args.threshold_seconds),
    });

    return `Monitor rule "${rule.name}" updated. Threshold: ${rule.thresholdSeconds}s.`;
  }

  private async handlePauseRule(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for pause_rule.';
    }

    const rule = await this.watchdogService.updateRule(id, { enabled: false });
    return `Monitor rule "${rule.name}" paused.`;
  }

  private async handleResumeRule(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for resume_rule.';
    }

    const rule = await this.watchdogService.updateRule(id, { enabled: true });
    return `Monitor rule "${rule.name}" resumed.`;
  }

  private async handleDeleteRule(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for delete_rule.';
    }

    const deleted = await this.watchdogService.deleteRule(id);
    return deleted ? `Monitor rule ${id} deleted.` : `Monitor rule ${id} not found.`;
  }

  private async handleListStates(): Promise<string> {
    const states = await this.watchdogService.listStates();
    if (!states.length) {
      return 'No monitor runtime state available.';
    }

    const lines = states.map((state) => [
      `- **Rule ${state.ruleId}** (${state.status})`,
      `  Monitored chat ID: ${state.monitoredChatId}`,
      `  Chat: ${state.chatTitle ?? 'n/a'} (${state.chatId ?? 'n/a'})`,
      `  Last inbound: ${state.lastInboundAt ?? '—'}${state.lastInboundSenderName ? ` from ${state.lastInboundSenderName}` : ''}`,
      `  Last owner reply: ${state.lastOwnerReplyAt ?? '—'}${state.lastOwnerReplyMessageId ? ` (msg ${state.lastOwnerReplyMessageId})` : ''}`,
      `  Unanswered since: ${state.unansweredSince ?? '—'}`,
      `  Last alerted: ${state.lastAlertedAt ?? '—'}`,
      `  Dedupe: ${state.dedupeKey ?? '—'}`,
      `  Evaluation: ${state.lastEvaluationStatus} — ${state.lastEvaluationMessage}`,
      `  Updated: ${state.updatedAt}`,
    ].join('\n'));

    return `Monitor states (${states.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleListEvaluations(args: Record<string, unknown>): Promise<string> {
    const evaluations = await this.watchdogService.listEvaluations(
      args.id ? String(args.id).trim() : undefined,
      this.parseLimit(args.limit),
    );

    if (!evaluations.length) {
      return 'No monitor evaluations found.';
    }

    const lines = evaluations.map((evaluation) => [
      `- **${evaluation.evaluationStatus}** for rule ${evaluation.ruleId}`,
      `  Evaluation ID: ${evaluation.id}`,
      `  Chat: ${evaluation.chatTitle ?? 'n/a'} (${evaluation.chatId ?? 'n/a'})`,
      `  State: ${evaluation.stateStatus}`,
      `  Last inbound msg: ${evaluation.lastInboundMessageId ?? '—'}`,
      `  Last owner reply msg: ${evaluation.lastOwnerReplyMessageId ?? '—'}`,
      `  Dedupe: ${evaluation.dedupeKey ?? '—'}`,
      `  Correlation: ${evaluation.correlationId ?? '—'}`,
      `  Alert triggered: ${evaluation.alertTriggered}`,
      `  Message: ${evaluation.message}`,
      `  Evaluated: ${evaluation.evaluatedAt}`,
    ].join('\n'));

    return `Monitor evaluations (${evaluations.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleListAlerts(args: Record<string, unknown>): Promise<string> {
    const alerts = await this.watchdogService.listAlertHistory(
      args.id ? String(args.id).trim() : undefined,
      this.parseLimit(args.limit),
    );

    if (!alerts.length) {
      return 'No monitor alerts found.';
    }

    const lines = alerts.map((alert) => [
      `- **Alert** for rule ${alert.ruleId}`,
      `  Evaluation ID: ${alert.evaluationId}`,
      `  Monitored chat ID: ${alert.monitoredChatId}`,
      `  Chat: ${alert.chatTitle ?? 'n/a'} (${alert.chatId ?? 'n/a'})`,
      `  Last inbound msg: ${alert.lastInboundMessageId ?? '—'}`,
      `  Dedupe: ${alert.dedupeKey ?? '—'}`,
      `  Correlation: ${alert.correlationId ?? '—'}`,
      `  Message: ${alert.message}`,
      `  Evaluated: ${alert.evaluatedAt}`,
    ].join('\n'));

    return `Monitor alerts (${alerts.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleRunRule(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for run_rule.';
    }

    const evaluation = await this.watchdogService.runRule(id);
    return [
      'Monitor rule evaluated successfully.',
      `Evaluation ID: ${evaluation.id}`,
      `Rule ID: ${evaluation.ruleId}`,
      `Status: ${evaluation.evaluationStatus}`,
      `State: ${evaluation.stateStatus}`,
      `Alert triggered: ${evaluation.alertTriggered}`,
      `Message: ${evaluation.message}`,
      `Correlation: ${evaluation.correlationId ?? '—'}`,
      `Evaluated: ${evaluation.evaluatedAt}`,
    ].join('\n');
  }

  private parseLimit(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 20;
    }
    return Math.min(Math.floor(parsed), 100);
  }
}
