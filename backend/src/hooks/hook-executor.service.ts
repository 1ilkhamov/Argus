import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import type { LlmMessage } from '../llm/interfaces/llm.interface';
import { ToolOrchestratorService } from '../tools/core/tool-orchestrator.service';
import { NotifyTool } from '../tools/builtin/system/notify.tool';
import { HooksService } from './hooks.service';
import type { HookFireContext, HookFireResult } from './hook.types';

/**
 * Wires the hooks service to the LLM + notification system.
 *
 * When a webhook fires:
 * 1. Interpolates the hook's prompt template with the request payload/headers/query
 * 2. Sends the prompt to the LLM (with tools available)
 * 3. Optionally delivers the LLM response via notification (desktop + telegram)
 */
@Injectable()
export class HookExecutorService implements OnModuleInit {
  private readonly logger = new Logger(HookExecutorService.name);

  constructor(
    private readonly hooksService: HooksService,
    private readonly toolOrchestrator: ToolOrchestratorService,
    private readonly notifyTool: NotifyTool,
  ) {}

  onModuleInit(): void {
    this.hooksService.setFireHandler((ctx) => this.executeHook(ctx));
    this.logger.log('Hook executor wired to hooks service');
  }

  private async executeHook(ctx: HookFireContext): Promise<HookFireResult> {
    const startMs = Date.now();
    const { hook } = ctx;

    this.logger.log(`Executing hook: "${hook.name}" from ${ctx.sourceIp}`);

    try {
      const prompt = this.interpolateTemplate(ctx);

      const messages: LlmMessage[] = [
        {
          role: 'system',
          content: [
            'You are Argus, processing an incoming webhook event. Be concise and direct.',
            'Analyze the webhook payload and produce an actionable result.',
            'You have access to tools (web_search, web_fetch, notify, system_run, etc.) — USE them if the task requires it.',
            `Webhook name: "${hook.name}"`,
            hook.description ? `Description: ${hook.description}` : '',
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: prompt,
        },
      ];

      const toolResult = await this.toolOrchestrator.completeWithTools(messages);
      let result = toolResult.content.trim();

      if (toolResult.toolRoundsUsed > 0) {
        this.logger.debug(
          `Hook "${hook.name}" used tools: ${toolResult.toolCallLog.map((c) => c.name).join(', ')}`,
        );
      }

      if (!result) {
        result = `Webhook "${hook.name}" processed but produced no output.`;
      }

      // Send notification if configured
      if (hook.notifyOnFire) {
        try {
          await this.notifyTool.sendNotification(`🔔 ${hook.name}`, result);
        } catch (notifyErr) {
          this.logger.warn(
            `Notification failed for hook "${hook.name}": ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
          );
        }
      }

      const durationMs = Date.now() - startMs;
      this.logger.log(`Hook "${hook.name}" completed in ${durationMs}ms`);

      return {
        hookName: hook.name,
        success: true,
        content: result,
        toolRoundsUsed: toolResult.toolRoundsUsed,
        durationMs,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startMs;
      this.logger.error(`Hook "${hook.name}" failed: ${msg}`);

      // Notify about failure
      if (hook.notifyOnFire) {
        try {
          await this.notifyTool.sendNotification(
            `❌ ${hook.name}`,
            `Webhook processing failed: ${msg}`,
          );
        } catch {
          // Notification itself failed
        }
      }

      return {
        hookName: hook.name,
        success: false,
        content: '',
        toolRoundsUsed: 0,
        durationMs,
        error: msg,
      };
    }
  }

  /**
   * Interpolate the hook's prompt template with request context.
   *
   * Supported placeholders:
   * - {{payload}} — raw request body
   * - {{payload.key}} — dot-notation access into parsed JSON payload
   * - {{headers.key}} — request header value (lowercase key)
   * - {{query.key}} — query string parameter
   * - {{method}} — HTTP method
   * - {{source_ip}} — source IP address
   * - {{hook_name}} — hook name
   */
  private interpolateTemplate(ctx: HookFireContext): string {
    const { hook, payload, parsedPayload, headers, query, method, sourceIp } = ctx;

    return hook.promptTemplate.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      const trimmedKey = key.trim();

      if (trimmedKey === 'payload') {
        return payload;
      }

      if (trimmedKey === 'method') {
        return method;
      }

      if (trimmedKey === 'source_ip') {
        return sourceIp;
      }

      if (trimmedKey === 'hook_name') {
        return hook.name;
      }

      if (trimmedKey.startsWith('payload.') && parsedPayload) {
        const path = trimmedKey.slice('payload.'.length);
        return this.getNestedValue(parsedPayload, path) ?? `{{${trimmedKey}}}`;
      }

      if (trimmedKey.startsWith('headers.')) {
        const headerKey = trimmedKey.slice('headers.'.length).toLowerCase();
        return headers[headerKey] ?? `{{${trimmedKey}}}`;
      }

      if (trimmedKey.startsWith('query.')) {
        const queryKey = trimmedKey.slice('query.'.length);
        return query[queryKey] ?? `{{${trimmedKey}}}`;
      }

      // Unknown placeholder — return as-is
      return `{{${trimmedKey}}}`;
    });
  }

  /**
   * Get a nested value from an object using dot notation.
   * E.g. getNestedValue({a: {b: 1}}, 'a.b') => '1'
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    if (current === null || current === undefined) {
      return undefined;
    }

    return typeof current === 'object' ? JSON.stringify(current) : String(current);
  }
}
