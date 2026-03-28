import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

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
    private readonly toolOrchestrator: ToolOrchestratorService,
    private readonly notifyTool: NotifyTool,
  ) {}

  onModuleInit(): void {
    this.scheduler.setJobHandler((job) => this.executeJob(job));
    this.logger.log('Cron executor wired to scheduler');
  }

  private async executeJob(job: CronJob): Promise<void> {
    this.logger.log(`Executing cron job: "${job.name}" — task: "${job.task}"`);

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
      let result = toolResult.content.trim();

      if (toolResult.toolRoundsUsed > 0) {
        this.logger.debug(`Cron job "${job.name}" used tools: ${toolResult.toolCallLog.map((c) => c.name).join(', ')}`);
      }

      if (!result) {
        result = `Cron job "${job.name}" executed but produced no output.`;
      }

      // Send notification
      await this.notifyTool.sendNotification(`🕐 ${job.name}`, result);

      this.logger.log(`Cron job "${job.name}" completed, notification sent`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Cron job "${job.name}" failed: ${msg}`);

      // Still try to notify about the failure
      try {
        await this.notifyTool.sendNotification(
          `❌ ${job.name}`,
          `Scheduled task failed: ${msg}`,
        );
      } catch {
        // Notification itself failed — nothing more we can do
      }
    }
  }
}
