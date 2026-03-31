import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { CronManagementToolService } from './cron-management-tool.service';

@Injectable()
export class JobManageTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(JobManageTool.name);

  readonly definition: ToolDefinition = {
    name: 'job_manage',
    description:
      'Manage scheduled backend jobs and inspect durable run history. This is a compatible alias over the cron job domain. Use it for create/edit/pause/resume/delete flows, run history, and explicit result semantics like noop, success, failed, and notified.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: ['list_jobs', 'create_job', 'update_job', 'list_runs', 'delete_job', 'pause_job', 'resume_job'],
        },
        id: {
          type: 'string',
          description: 'Job ID for update/delete/pause/resume or filtering run history.',
        },
        name: {
          type: 'string',
          description: 'Human-readable job name for create_job or update_job.',
        },
        task: {
          type: 'string',
          description: 'Job task instruction for create_job or update_job.',
        },
        schedule_type: {
          type: 'string',
          description: 'Schedule type for create_job or update_job.',
          enum: ['cron', 'interval', 'once'],
        },
        schedule: {
          type: 'string',
          description: 'Schedule expression for create_job or update_job.',
        },
        max_runs: {
          type: 'number',
          description: 'Max executions for create_job or update_job. 0 = unlimited.',
        },
        notification_policy: {
          type: 'string',
          description: 'Notification policy for create_job or update_job: always or never.',
          enum: ['always', 'never'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of recent runs to return. Default: 10, max: 20.',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
    timeoutMs: 20_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly management: CronManagementToolService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('job_manage tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();

    try {
      switch (action) {
        case 'list_jobs':
          return this.management.listJobs();
        case 'create_job':
          return this.management.createJob(args);
        case 'update_job':
          return this.management.updateJob(args);
        case 'list_runs':
          return this.management.listRuns(args);
        case 'delete_job':
          return this.management.deleteJob(args);
        case 'pause_job':
          return this.management.pauseJob(args);
        case 'resume_job':
          return this.management.resumeJob(args);
        default:
          return 'Unknown action. Use list_jobs, create_job, update_job, list_runs, delete_job, pause_job, or resume_job.';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`job_manage ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }
}
