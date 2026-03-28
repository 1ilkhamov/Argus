import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { CronSchedulerService } from '../../../cron/cron-scheduler.service';
import type { CronScheduleType } from '../../../cron/cron-job.types';

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
          description: 'Action: "create", "list", "delete", "pause", or "resume".',
          enum: ['create', 'list', 'delete', 'pause', 'resume'],
        },
        name: {
          type: 'string',
          description: 'Human-readable job name (for "create"). E.g. "Morning news summary".',
        },
        task: {
          type: 'string',
          description: 'What the agent should do when the job fires (for "create"). Write it as if you are giving yourself an instruction. E.g. "Search for top tech news and send a summary notification to the user".',
        },
        schedule_type: {
          type: 'string',
          description: 'Schedule type (for "create"): "cron", "interval", or "once".',
          enum: ['cron', 'interval', 'once'],
        },
        schedule: {
          type: 'string',
          description: 'Schedule expression (for "create"). See description for format.',
        },
        max_runs: {
          type: 'number',
          description: 'Max executions (for "create"). 0 = unlimited. Default: 0.',
        },
        id: {
          type: 'string',
          description: 'Job ID (for "delete", "pause", "resume").',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly scheduler: CronSchedulerService,
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
        case 'list':
          return this.handleList();
        case 'delete':
          return this.handleDelete(args);
        case 'pause':
          return this.handlePause(args);
        case 'resume':
          return this.handleResume(args);
        default:
          return `Unknown action: "${action}". Use "create", "list", "delete", "pause", or "resume".`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`cron ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  private async handleCreate(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '').trim();
    const task = String(args.task ?? '').trim();
    const scheduleType = String(args.schedule_type ?? 'cron').trim() as CronScheduleType;
    const schedule = String(args.schedule ?? '').trim();
    const maxRuns = Number(args.max_runs) || 0;

    if (!name) return 'Error: "name" is required for create.';
    if (!task) return 'Error: "task" is required for create.';
    if (!schedule) return 'Error: "schedule" is required for create.';
    if (!['cron', 'interval', 'once'].includes(scheduleType)) {
      return `Error: invalid schedule_type "${scheduleType}". Use "cron", "interval", or "once".`;
    }

    const job = await this.scheduler.createJob({ name, task, scheduleType, schedule, maxRuns });

    const lines = [
      'Cron job created successfully.',
      `ID: ${job.id}`,
      `Name: ${job.name}`,
      `Schedule: ${job.scheduleType} — ${job.schedule}`,
      `Next run: ${job.nextRunAt ?? 'not scheduled'}`,
      `Max runs: ${job.maxRuns === 0 ? 'unlimited' : job.maxRuns}`,
    ];
    return lines.join('\n');
  }

  private async handleList(): Promise<string> {
    const jobs = await this.scheduler.listJobs();

    if (jobs.length === 0) return 'No scheduled jobs.';

    const lines = [`${jobs.length} scheduled job(s):\n`];

    for (const job of jobs) {
      const status = job.enabled ? '✅ active' : '⏸ paused';
      lines.push(`- **${job.name}** (${status})`);
      lines.push(`  ID: ${job.id}`);
      lines.push(`  Schedule: ${job.scheduleType} — ${job.schedule}`);
      lines.push(`  Task: ${job.task}`);
      lines.push(`  Runs: ${job.runCount}${job.maxRuns > 0 ? '/' + job.maxRuns : ''}`);
      lines.push(`  Next: ${job.nextRunAt ?? '—'}`);
      lines.push(`  Last: ${job.lastRunAt ?? 'never'}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  private async handleDelete(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for delete. Use "list" to see job IDs.';

    const deleted = await this.scheduler.deleteJob(id);
    return deleted ? `Job ${id} deleted.` : `Job ${id} not found.`;
  }

  private async handlePause(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for pause.';

    const job = await this.scheduler.pauseJob(id);
    return job ? `Job "${job.name}" paused.` : `Job ${id} not found.`;
  }

  private async handleResume(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for resume.';

    const job = await this.scheduler.resumeJob(id);
    return job ? `Job "${job.name}" resumed. Next run: ${job.nextRunAt ?? '—'}` : `Job ${id} not found.`;
  }
}
