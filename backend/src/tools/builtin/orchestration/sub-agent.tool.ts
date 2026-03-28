import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { SubAgentService, type SubAgentTask, type SubAgentResult } from './sub-agent.service';

@Injectable()
export class SubAgentTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(SubAgentTool.name);
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'sub_agent',
    description:
      'Spawn parallel sub-agents to handle multiple independent tasks simultaneously. ' +
      'Each sub-agent gets its own LLM call and returns a result. Use this when:\n' +
      '- You need to research/analyze multiple items in parallel\n' +
      '- You need to translate/transform content into multiple variants\n' +
      '- You need to compare multiple options independently\n' +
      '- Any task that can be decomposed into independent subtasks\n\n' +
      'Actions:\n' +
      '- run: Execute a list of tasks in parallel and return all results.\n\n' +
      'Each task needs a "label" (identifier) and "prompt" (instruction). Optionally add "context" for shared data.\n' +
      'Set use_tools=true if sub-agents need to call tools (web_search, calculator, etc.) — slower but more capable.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run'],
          description: 'Action to perform.',
        },
        tasks: {
          type: 'array',
          description: 'List of tasks. Each: {label: string, prompt: string, context?: string}',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short identifier for this task' },
              prompt: { type: 'string', description: 'Instruction for the sub-agent' },
              context: { type: 'string', description: 'Optional shared context/data' },
            },
            required: ['label', 'prompt'],
          },
        },
        use_tools: {
          type: 'boolean',
          description: 'Allow sub-agents to use tools (default: false). Slower but more capable.',
        },
        max_tokens: {
          type: 'number',
          description: 'Max tokens per sub-agent response (default: 2048).',
        },
        temperature: {
          type: 'number',
          description: 'Temperature for sub-agent calls (default: 0.3).',
        },
      },
      required: ['action', 'tasks'],
    },
    safety: 'moderate',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
    private readonly subAgentService: SubAgentService,
  ) {
    this.enabled = this.configService.get<boolean>('tools.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('sub_agent tool is disabled');
      return;
    }
    this.registry.register(this);
    this.logger.log('sub_agent tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();

    try {
      switch (action) {
        case 'run':
          return await this.handleRun(args);
        default:
          return `Error: Unknown action "${action}". Use: run.`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private async handleRun(args: Record<string, unknown>): Promise<string> {
    const rawTasks = args.tasks;
    if (!rawTasks || !Array.isArray(rawTasks) || rawTasks.length === 0) {
      return 'Error: "tasks" must be a non-empty array of {label, prompt, context?}.';
    }

    // Validate and parse tasks
    const tasks: SubAgentTask[] = [];
    for (let i = 0; i < rawTasks.length; i++) {
      const raw = rawTasks[i] as Record<string, unknown>;
      const label = String(raw?.label ?? '').trim();
      const prompt = String(raw?.prompt ?? '').trim();

      if (!label) {
        return `Error: Task ${i} is missing "label".`;
      }
      if (!prompt) {
        return `Error: Task ${i} ("${label}") is missing "prompt".`;
      }

      tasks.push({
        label,
        prompt,
        context: raw?.context ? String(raw.context) : undefined,
      });
    }

    const useTools = Boolean(args.use_tools);
    const maxTokens = args.max_tokens ? Number(args.max_tokens) : undefined;
    const temperature = args.temperature ? Number(args.temperature) : undefined;

    const results = await this.subAgentService.runTasks(tasks, {
      useTools,
      maxTokens,
      temperature,
    });

    return this.formatResults(results);
  }

  private formatResults(results: SubAgentResult[]): string {
    const succeeded = results.filter((r) => r.success).length;
    const lines: string[] = [
      `Sub-agent run: ${succeeded}/${results.length} tasks succeeded.\n`,
    ];

    for (const r of results) {
      lines.push(`═══ [${r.label}] ${r.success ? '✅' : '❌'} (${r.durationMs}ms) ═══`);

      if (r.success) {
        lines.push(r.output);
      } else {
        lines.push(`Error: ${r.error}`);
      }

      if (r.toolsUsed && r.toolsUsed.length > 0) {
        lines.push(`Tools used: ${r.toolsUsed.join(', ')}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}
