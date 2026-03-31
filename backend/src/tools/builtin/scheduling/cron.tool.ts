import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { CronManagementToolService } from './cron-management-tool.service';

@Injectable()
export class CronTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(CronTool.name);

  readonly definition: ToolDefinition = {
    name: 'cron',
    description:
      'Manage scheduled tasks and reminders. ALWAYS use this when the user says "remind me", "напомни", "через X минут", "каждые X минут", or any time-based request.\n\nSchedule formats:\n- once: ISO date for a ONE-TIME reminder/task (e.g. "2026-03-26T10:00:00Z"). Use datetime tool first to compute the target time if user says "through 2 minutes".\n- cron: standard 5-field cron (e.g. "0 9 * * *" = daily 9:00, "*/30 * * * *" = every 30 min)\n- interval: milliseconds between runs (e.g. "3600000" = every hour)',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: "create", "update", "list", "list_runs", "delete", "pause", or "resume".',
          enum: ['create', 'update', 'list', 'list_runs', 'delete', 'pause', 'resume'],
        },
        name: {
          type: 'string',
          description: 'Human-readable job name (for "create" or "update"). E.g. "Morning news summary".',
        },
        task: {
          type: 'string',
          description: 'What the agent should do when the job fires (for "create" or "update"). Write it as if you are giving yourself an instruction. E.g. "Search for top tech news and send a summary notification to the user".',
        },
        schedule_type: {
          type: 'string',
          description: 'Schedule type (for "create" or "update"): "cron", "interval", or "once".',
          enum: ['cron', 'interval', 'once'],
        },
        schedule: {
          type: 'string',
          description: 'Schedule expression (for "create" or "update"). See description for format.',
        },
        max_runs: {
          type: 'number',
          description: 'Max executions (for "create" or "update"). 0 = unlimited. Default: 0.',
        },
        notification_policy: {
          type: 'string',
          description: 'Notification policy (for "create" or "update"): "always" or "never". "never" keeps successful runs silent while still recording run history.',
          enum: ['always', 'never'],
        },
        id: {
          type: 'string',
          description: 'Job ID (for "update", "delete", "pause", "resume", or filtering "list_runs").',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of recent runs to return for "list_runs". Default: 10, max: 20.',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly management: CronManagementToolService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('cron tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '');

    try {
      switch (action) {
        case 'create':
          return this.handleCreate(args);
        case 'update':
          return this.handleUpdate(args);
        case 'list':
          return this.handleList();
        case 'list_runs':
          return this.handleListRuns(args);
        case 'delete':
          return this.handleDelete(args);
        case 'pause':
          return this.handlePause(args);
        case 'resume':
          return this.handleResume(args);
        default:
          return `Unknown action: "${action}". Use "create", "update", "list", "list_runs", "delete", "pause", or "resume".`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`cron ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  private async handleCreate(args: Record<string, unknown>): Promise<string> {
    return this.management.createJob(args);
  }

  private async handleUpdate(args: Record<string, unknown>): Promise<string> {
    return this.management.updateJob(args);
  }

  private async handleList(): Promise<string> {
    return this.management.listJobs();
  }

  private async handleListRuns(args: Record<string, unknown>): Promise<string> {
    return this.management.listRuns(args);
  }

  private async handleDelete(args: Record<string, unknown>): Promise<string> {
    return this.management.deleteJob(args);
  }

  private async handlePause(args: Record<string, unknown>): Promise<string> {
    return this.management.pauseJob(args);
  }

  private async handleResume(args: Record<string, unknown>): Promise<string> {
    return this.management.resumeJob(args);
  }
}
