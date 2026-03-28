import { Injectable, Logger, Optional } from '@nestjs/common';

import { ToolRegistryService } from '../registry/tool-registry.service';
import { ToolSafetyService } from '../safety/tool-safety.service';
import { ActionLoggerService } from '../../../memory/action-log/action-logger.service';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolCall,
  type ToolResult,
  type ToolExecutionContext,
} from '../tool.types';

/**
 * Executes tool calls with timeout protection, safety enforcement,
 * and structured logging.
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly safety: ToolSafetyService,
    @Optional() private readonly actionLogger?: ActionLoggerService,
  ) {}

  /**
   * Execute a single tool call.
   * Returns a ToolResult regardless of success/failure — never throws.
   */
  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool = this.registry.get(call.name);

    if (!tool) {
      this.logger.warn(`Tool not found: ${call.name}`);
      return {
        callId: call.id,
        name: call.name,
        success: false,
        output: '',
        durationMs: Date.now() - startedAt,
        error: `Unknown tool: ${call.name}`,
      };
    }

    // ── Safety gate ───────────────────────────────────────────────────────────
    const decision = this.safety.evaluate(call.name, tool.definition.safety);
    if (!decision.allowed) {
      this.logger.warn(`Tool blocked by safety policy: ${decision.reason}`);
      return {
        callId: call.id,
        name: call.name,
        success: false,
        output: '',
        durationMs: Date.now() - startedAt,
        error: decision.reason ?? `Tool "${call.name}" is not allowed by current safety policy`,
      };
    }

    const timeoutMs = tool.definition.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

    try {
      const output = await this.executeWithTimeout(
        () => tool.execute(call.arguments, context),
        timeoutMs,
      );

      const durationMs = Date.now() - startedAt;
      this.logger.debug(
        `Tool ${call.name}(${this.summarizeArgs(call.arguments)}) → OK (${durationMs}ms)`,
      );

      const result: ToolResult = {
        callId: call.id,
        name: call.name,
        success: true,
        output,
        durationMs,
      };

      this.logAction(call, result, context);
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Tool ${call.name} failed (${durationMs}ms): ${message}`);

      const result: ToolResult = {
        callId: call.id,
        name: call.name,
        success: false,
        output: '',
        durationMs,
        error: message,
      };

      this.logAction(call, result, context);
      return result;
    }
  }

  /**
   * Execute multiple tool calls in parallel.
   */
  async executeAll(calls: ToolCall[], context?: ToolExecutionContext): Promise<ToolResult[]> {
    return Promise.all(calls.map((call) => this.execute(call, context)));
  }

  private async executeWithTimeout(
    fn: () => Promise<string>,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private logAction(call: ToolCall, result: ToolResult, context?: ToolExecutionContext): void {
    if (!this.actionLogger) return;
    this.actionLogger.logAction({
      toolName: call.name,
      args: call.arguments,
      result: result.output,
      success: result.success,
      error: result.error,
      durationMs: result.durationMs,
      conversationId: context?.conversationId,
      messageId: context?.messageId,
      scopeKey: context?.scopeKey,
    }).catch((err) => {
      this.logger.warn(`Action logging failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private summarizeArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return '';

    return entries
      .map(([key, value]) => {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        const truncated = str.length > 60 ? str.slice(0, 57) + '...' : str;
        return `${key}=${truncated}`;
      })
      .join(', ');
  }
}
