import { Injectable, Logger } from '@nestjs/common';

import { LlmService } from '../../../llm/llm.service';
import type { LlmMessage } from '../../../llm/interfaces/llm.interface';
import { ToolOrchestratorService } from '../../core/tool-orchestrator.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SubAgentTask {
  /** Unique label for the task (used in results) */
  label: string;
  /** The instruction/prompt for this sub-agent */
  prompt: string;
  /** Optional context to include */
  context?: string;
}

export interface SubAgentResult {
  label: string;
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
  toolsUsed?: string[];
}

export interface SubAgentRunOptions {
  /** Whether sub-agents can use tools (default: false — LLM-only for speed) */
  useTools?: boolean;
  /** Max concurrent sub-agents (default: 5) */
  concurrency?: number;
  /** Max tokens per sub-agent response */
  maxTokens?: number;
  /** Temperature for sub-agent calls */
  temperature?: number;
}

/** Max tasks in a single run */
const MAX_TASKS = 20;
/** Default concurrency */
const DEFAULT_CONCURRENCY = 5;
/** Default max tokens per sub-agent */
const DEFAULT_MAX_TOKENS = 2048;

@Injectable()
export class SubAgentService {
  private readonly logger = new Logger(SubAgentService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly toolOrchestrator: ToolOrchestratorService,
  ) {}

  /**
   * Run multiple sub-agent tasks in parallel with concurrency control.
   */
  async runTasks(
    tasks: SubAgentTask[],
    options: SubAgentRunOptions = {},
  ): Promise<SubAgentResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    if (tasks.length > MAX_TASKS) {
      throw new Error(`Too many tasks (${tasks.length}, max ${MAX_TASKS}). Split into smaller batches.`);
    }

    const concurrency = Math.min(
      options.concurrency ?? DEFAULT_CONCURRENCY,
      DEFAULT_CONCURRENCY,
    );
    const useTools = options.useTools ?? false;

    this.logger.log(
      `Running ${tasks.length} sub-agent tasks (concurrency=${concurrency}, tools=${useTools})`,
    );

    const results: SubAgentResult[] = [];
    const queue = [...tasks];
    const running: Promise<void>[] = [];

    const processTask = async (task: SubAgentTask): Promise<void> => {
      const result = useTools
        ? await this.executeWithTools(task, options)
        : await this.executePlain(task, options);
      results.push(result);
    };

    // Process with concurrency limit
    for (const task of queue) {
      const promise = processTask(task).then(() => {
        running.splice(running.indexOf(promise), 1);
      });
      running.push(promise);

      if (running.length >= concurrency) {
        await Promise.race(running);
      }
    }

    // Wait for remaining
    await Promise.all(running);

    this.logger.log(
      `Sub-agent run complete: ${results.filter((r) => r.success).length}/${results.length} succeeded`,
    );

    return results;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Execute a task with plain LLM call (no tools).
   */
  private async executePlain(
    task: SubAgentTask,
    options: SubAgentRunOptions,
  ): Promise<SubAgentResult> {
    const startedAt = Date.now();

    try {
      const messages = this.buildMessages(task);
      const result = await this.llmService.complete(messages, {
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature ?? 0.3,
      });

      return {
        label: task.label,
        success: true,
        output: result.content,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Sub-agent "${task.label}" failed: ${message}`);

      return {
        label: task.label,
        success: false,
        output: '',
        durationMs: Date.now() - startedAt,
        error: message,
      };
    }
  }

  /**
   * Execute a task with tool access via the orchestrator.
   */
  private async executeWithTools(
    task: SubAgentTask,
    options: SubAgentRunOptions,
  ): Promise<SubAgentResult> {
    const startedAt = Date.now();

    try {
      const messages = this.buildMessages(task);
      const result = await this.toolOrchestrator.completeWithTools(messages, {
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature ?? 0.3,
      });

      return {
        label: task.label,
        success: true,
        output: result.content,
        durationMs: Date.now() - startedAt,
        toolsUsed: result.toolCallLog.map((t) => t.name),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Sub-agent "${task.label}" (with tools) failed: ${message}`);

      return {
        label: task.label,
        success: false,
        output: '',
        durationMs: Date.now() - startedAt,
        error: message,
      };
    }
  }

  private buildMessages(task: SubAgentTask): LlmMessage[] {
    const systemContent = [
      'You are a focused sub-agent executing a specific task. Be concise and direct.',
      'Return only the result — no preamble, no meta-commentary.',
      task.context ? `\nContext:\n${task.context}` : '',
    ].filter(Boolean).join('\n');

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: task.prompt },
    ];
  }
}
