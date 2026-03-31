import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { CronJobRunRepository } from '../../../cron/cron-run.repository';
import type { CronJobFireContext, CronJobRunNotificationStatus, CronJobRunResultStatus, CronJobRunStatus } from '../../../cron/cron-run.types';
import type { LlmMessage } from '../../../llm/interfaces/llm.interface';
import { CronSchedulerService } from '../../../cron/cron-scheduler.service';
import type { CronJob } from '../../../cron/cron-job.types';
import { ToolOrchestratorService } from '../../core/tool-orchestrator.service';
import { NotifyTool } from '../system/notify.tool';

/**
 * Wires the cron scheduler to the LLM + notification system.
 *
 * When a cron job fires:
 * 1. Sends the job's task as a prompt to the LLM (with tools available)
 * 2. Delivers the LLM response via notification (desktop + telegram if configured)
 */
@Injectable()
export class CronExecutorService implements OnModuleInit {
  private readonly logger = new Logger(CronExecutorService.name);

  constructor(
    private readonly scheduler: CronSchedulerService,
    private readonly runRepository: CronJobRunRepository,
    private readonly toolOrchestrator: ToolOrchestratorService,
    private readonly notifyTool: NotifyTool,
  ) {}

  onModuleInit(): void {
    this.scheduler.setJobHandler((job, context) => this.executeJob(job, context));
    this.logger.log('Cron executor wired to scheduler');
  }

  private async executeJob(job: CronJob, context: CronJobFireContext): Promise<void> {
    this.logger.log(`Executing cron job: "${job.name}" — task: "${job.task}"`);

    let outputPreview: string | null = null;
    let toolRoundsUsed = 0;
    let toolNames: string[] = [];

    try {
      const messages: LlmMessage[] = [
        {
          role: 'system',
          content: [
            'You are Argus, executing a scheduled task. Be concise and direct.',
            'Produce a short result suitable for a notification (1-3 sentences max).',
            'You have access to tools (web_search, web_fetch, calculator, etc.) — USE them if the task requires it.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Scheduled task "${job.name}": ${job.task}`,
        },
      ];

      // Use tool orchestrator so cron jobs can leverage web_search, web_fetch, etc.
      const toolResult = await this.toolOrchestrator.completeWithTools(messages);
      toolRoundsUsed = toolResult.toolRoundsUsed;
      toolNames = toolResult.toolCallLog.map((call) => call.name);
      const result = toolResult.content.trim();

      if (toolResult.toolRoundsUsed > 0) {
        this.logger.debug(`Cron job "${job.name}" used tools: ${toolResult.toolCallLog.map((c) => c.name).join(', ')}`);
      }

      const execution = this.resolveExecutionPayload(job.name, result, toolNames);
      if (execution.resultStatus === 'noop') {
        await this.runRepository.update(context.runId, {
          finishedAt: new Date().toISOString(),
          status: 'noop',
          resultStatus: 'noop',
          notificationStatus: 'skipped',
          toolRoundsUsed,
          toolNames,
        });
        this.logger.log(`Cron job "${job.name}" completed with noop result`);
        return;
      }

      outputPreview = this.normalizePreview(execution.message);
      let notificationStatus: CronJobRunNotificationStatus = 'skipped';
      let notificationErrorMessage: string | null = null;

      if (job.notificationPolicy === 'always') {
        try {
          await this.notifyTool.sendNotification(`🕐 ${job.name}`, execution.message, {
            actor: 'cron',
            origin: 'cron_executor',
            correlationId: context.runId,
          });
          notificationStatus = 'sent';
        } catch (notifyError) {
          notificationStatus = 'failed';
          notificationErrorMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
          this.logger.warn(`Cron job "${job.name}" completed but notification failed: ${notificationErrorMessage}`);
        }
      }

      const status: CronJobRunStatus = notificationStatus === 'sent' ? 'notified' : 'success';
      await this.runRepository.update(context.runId, {
        finishedAt: new Date().toISOString(),
        status,
        resultStatus: 'success',
        notificationStatus,
        outputPreview,
        notificationErrorMessage,
        toolRoundsUsed,
        toolNames,
      });

      this.logger.log(`Cron job "${job.name}" completed with status ${status}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Cron job "${job.name}" failed: ${msg}`);

      let notificationStatus: CronJobRunNotificationStatus = 'skipped';
      let notificationErrorMessage: string | null = null;

      if (job.notificationPolicy === 'always') {
        try {
          await this.notifyTool.sendNotification(
            `❌ ${job.name}`,
            `Scheduled task failed: ${msg}`,
            {
              actor: 'cron',
              origin: 'cron_executor',
              correlationId: context.runId,
            },
          );
          notificationStatus = 'sent';
        } catch (notifyError) {
          notificationStatus = 'failed';
          notificationErrorMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
        }
      }

      await this.runRepository.update(context.runId, {
        finishedAt: new Date().toISOString(),
        status: 'failed',
        resultStatus: 'failed',
        notificationStatus,
        outputPreview,
        errorMessage: msg,
        notificationErrorMessage,
        toolRoundsUsed,
        toolNames,
      });
    }
  }

  private resolveExecutionPayload(jobName: string, result: string, toolNames: string[]): { resultStatus: CronJobRunResultStatus; message: string } | { resultStatus: 'noop'; message: null } {
    if (result) {
      return { resultStatus: 'success', message: result };
    }
    if (toolNames.length > 0) {
      return {
        resultStatus: 'success',
        message: `Cron job "${jobName}" completed using ${toolNames.join(', ')} without a textual summary.`,
      };
    }
    return { resultStatus: 'noop', message: null };
  }

  private normalizePreview(value: string): string {
    const text = value.trim();
    return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
  }
 }
