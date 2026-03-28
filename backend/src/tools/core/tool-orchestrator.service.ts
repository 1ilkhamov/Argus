import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LlmService } from '../../llm/llm.service';
import type {
  LlmMessage,
  LlmCompletionOptions,
  LlmStreamChunk,
  LlmToolCall,
} from '../../llm/interfaces/llm.interface';
import { getTextContent } from '../../llm/interfaces/llm.interface';
import { ToolRegistryService } from './registry/tool-registry.service';
import { ToolExecutorService } from './execution/tool-executor.service';
import { toOpenAiToolsParam, buildToolPromptSection } from './prompt/tool-prompt.builder';
import { parseTextToolCalls, stripToolCallBlocks } from './parsing/tool-call.parser';
import { parseNativeToolCalls, type RawToolCall } from './parsing/tool-call.parser';
import { MAX_TOOL_ROUNDS, type ToolExecutionContext } from './tool.types';

export interface ToolOrchestrationResult {
  /** Final assistant content */
  content: string;
  /** All messages including tool interactions (for context) */
  messages: LlmMessage[];
  /** Number of tool rounds executed */
  toolRoundsUsed: number;
  /** Tool calls that were made */
  toolCallLog: Array<{ name: string; success: boolean; durationMs: number }>;
}

/**
 * Orchestrates the LLM ↔ Tool execution loop.
 *
 * For providers with native function calling (OpenAI, Anthropic),
 * tools are passed via the API `tools` parameter.
 *
 * For local/text-based models, tool descriptions are injected into
 * the system prompt and tool calls are parsed from text output.
 *
 * The orchestrator runs up to MAX_TOOL_ROUNDS iterations:
 *   LLM response → detect tool calls → execute → inject results → repeat
 */
@Injectable()
export class ToolOrchestratorService {
  private readonly logger = new Logger(ToolOrchestratorService.name);
  private readonly toolsEnabled: boolean;
  private readonly useNativeFunctionCalling: boolean;

  /** Tool names invoked during the most recent streamWithTools call. */
  private _lastUsedToolNames: Set<string> = new Set();

  /** Returns tool names used in the last streamWithTools call (read-once: clears after read). */
  get lastUsedToolNames(): ReadonlySet<string> {
    const names = this._lastUsedToolNames;
    this._lastUsedToolNames = new Set();
    return names;
  }

  constructor(
    private readonly llmService: LlmService,
    private readonly registry: ToolRegistryService,
    private readonly executor: ToolExecutorService,
    private readonly configService: ConfigService,
  ) {
    this.toolsEnabled = this.configService.get<boolean>('tools.enabled', true);

    // Native function calling: most OpenAI-compatible APIs (including local
    // providers like Ollama, vLLM, LM Studio) support the `tools` parameter.
    // Text-based fallback is only needed for legacy APIs without tool support.
    const provider = this.configService.get<string>('llm.provider', 'local');
    const nativeFcOverride = this.configService.get<boolean | undefined>('tools.nativeFunctionCalling', undefined);
    if (nativeFcOverride !== undefined) {
      this.useNativeFunctionCalling = nativeFcOverride;
    } else {
      // Default: native for all known providers (local uses OpenAI-compatible API)
      this.useNativeFunctionCalling = ['openai', 'local', 'anthropic', 'google'].includes(provider);
    }
  }

  /** Whether tools are available and enabled. */
  get isEnabled(): boolean {
    return this.toolsEnabled && this.registry.size > 0;
  }

  /**
   * Run a non-streaming completion with tool loop.
   * Returns the final content after all tool rounds are resolved.
   */
  async completeWithTools(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
    context?: ToolExecutionContext,
  ): Promise<ToolOrchestrationResult> {
    this._lastUsedToolNames = new Set();

    if (!this.isEnabled) {
      const result = await this.llmService.complete(messages, options);
      return {
        content: result.content,
        messages,
        toolRoundsUsed: 0,
        toolCallLog: [],
      };
    }

    const workingMessages = [...messages];
    const toolCallLog: ToolOrchestrationResult['toolCallLog'] = [];
    const completionOptions = this.buildOptions(options, context?.excludeTools);

    // Inject tool descriptions into system prompt for text-based models
    if (!this.useNativeFunctionCalling) {
      this.injectToolPrompt(workingMessages, context?.excludeTools);
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await this.llmService.complete(workingMessages, completionOptions);

      // Check for tool calls — native or text-based
      const toolCalls = this.extractToolCalls(result.toolCalls, result.content);

      if (toolCalls.length === 0) {
        // No tool calls — strip any residual tool blocks and return
        const cleanContent = this.useNativeFunctionCalling
          ? result.content
          : stripToolCallBlocks(result.content);

        return {
          content: cleanContent,
          messages: workingMessages,
          toolRoundsUsed: round,
          toolCallLog,
        };
      }

      this.logger.debug(
        `Tool round ${round + 1}: ${toolCalls.map((c) => c.name).join(', ')}`,
      );

      // Add assistant message with tool calls to history
      // OpenAI API requires tool_calls on the assistant message that triggered them
      workingMessages.push({
        role: 'assistant',
        content: result.content || '',
        toolCalls: this.toLlmToolCalls(toolCalls),
      });

      // Execute all tool calls in parallel
      const results = await this.executor.executeAll(toolCalls, context);
      for (const toolCall of toolCalls) {
        this._lastUsedToolNames.add(toolCall.name);
      }

      // Add tool results to history
      for (const toolResult of results) {
        toolCallLog.push({
          name: toolResult.name,
          success: toolResult.success,
          durationMs: toolResult.durationMs,
        });

        workingMessages.push({
          role: 'tool',
          content: toolResult.success ? toolResult.output : `Error: ${toolResult.error}`,
          toolCallId: toolResult.callId,
          name: toolResult.name,
        });
      }
    }

    // Max rounds exceeded — do one final completion without tools
    this.logger.warn(`Tool loop reached max rounds (${MAX_TOOL_ROUNDS}), completing without tools`);
    const finalOptions = { ...completionOptions };
    delete finalOptions.tools;

    const finalResult = await this.llmService.complete(workingMessages, finalOptions);

    return {
      content: finalResult.content,
      messages: workingMessages,
      toolRoundsUsed: MAX_TOOL_ROUNDS,
      toolCallLog,
    };
  }

  /**
   * Run a streaming completion with tool loop.
   *
   * Tool rounds are buffered internally. Only the final round
   * (with no tool calls) is streamed to the caller.
   * Yields special status chunks during tool execution.
   */
  async *streamWithTools(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
    context?: ToolExecutionContext,
  ): AsyncGenerator<LlmStreamChunk> {
    if (!this.isEnabled) {
      yield* this.llmService.stream(messages, options);
      return;
    }

    this._lastUsedToolNames = new Set();
    const workingMessages = [...messages];
    const completionOptions = this.buildOptions(options, context?.excludeTools);

    // Inject tool descriptions into system prompt for text-based models
    if (!this.useNativeFunctionCalling) {
      this.injectToolPrompt(workingMessages, context?.excludeTools);
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Buffer this round to check for tool calls
      const { content, toolCalls } = await this.bufferStream(workingMessages, completionOptions);

      if (toolCalls.length === 0) {
        // No tool calls — check if the LLM should have used a tool but didn't.
        // Some models "forget" to call tools with long system prompts.
        if (round === 0 && content.trim() && this.shouldRetryWithToolForce(content, workingMessages)) {
          this.logger.warn('LLM responded with text but should have used a tool — retrying with tool_choice=required (non-streaming)');
          try {
            const forceOptions = { ...completionOptions, toolChoice: 'required' as const };
            // Use non-streaming complete() — more reliable for tool_calls parsing
            const retryResult = await this.llmService.complete(workingMessages, forceOptions);
            const retryToolCalls = this.extractToolCalls(retryResult.toolCalls, retryResult.content);

            if (retryToolCalls.length > 0) {
              this.logger.log(`Forced retry got tools: ${retryToolCalls.map((c) => c.name).join(', ')}`);
              workingMessages.push({
                role: 'assistant',
                content: retryResult.content || '',
                toolCalls: this.toLlmToolCalls(retryToolCalls),
              });
              // Emit tool_start events
              for (const tc of retryToolCalls) {
                yield { content: '', done: false, toolEvent: { type: 'tool_start' as const, name: tc.name } };
              }
              const results = await this.executor.executeAll(retryToolCalls, context);
              for (const tc of retryToolCalls) this._lastUsedToolNames.add(tc.name);
              for (const toolResult of results) {
                // Emit tool_end events
                yield { content: '', done: false, toolEvent: { type: 'tool_end' as const, name: toolResult.name, durationMs: toolResult.durationMs, success: toolResult.success } };
                workingMessages.push({
                  role: 'tool',
                  content: toolResult.success ? toolResult.output : `Error: ${toolResult.error}`,
                  toolCallId: toolResult.callId,
                  name: toolResult.name,
                });
              }
              // Stream final response after tool execution
              const finalOpts = { ...completionOptions };
              delete finalOpts.tools;
              yield* this.llmService.stream(workingMessages, finalOpts);
              return;
            }
          } catch (retryError) {
            this.logger.warn(`Tool force retry failed: ${retryError instanceof Error ? retryError.message : retryError}`);
          }
          // Retry also failed — fall through to normal streaming
        }

        if (round === 0 && content.trim()) {
          // First round, no tools used, has content — stream directly from LLM
          yield* this.llmService.stream(workingMessages, completionOptions);
        } else if (round === 0 && !content.trim()) {
          // First round, no tools, EMPTY content — retry without tools
          this.logger.warn('Empty content on round 0, retrying without tools');
          const retryOptions = { ...completionOptions };
          delete retryOptions.tools;
          yield* this.llmService.stream(workingMessages, retryOptions);
        } else {
          // After tool rounds — emit the buffered content as stream
          const cleanContent = this.useNativeFunctionCalling
            ? content
            : stripToolCallBlocks(content);

          if (cleanContent) {
            yield { content: cleanContent, done: false };
            yield { content: '', done: true };
          } else {
            // Empty content after tool rounds — LLM returned nothing
            // (may happen when context is too large). Do a final call without tools.
            this.logger.warn(
              `Empty content after ${round} tool round(s), retrying without tools`,
            );
            const retryOptions = { ...completionOptions };
            delete retryOptions.tools;
            yield* this.llmService.stream(workingMessages, retryOptions);
          }
        }
        return;
      }

      this.logger.debug(
        `Tool stream round ${round + 1}: ${toolCalls.map((c) => c.name).join(', ')}`,
      );

      // Add assistant message to history
      // OpenAI API requires tool_calls on the assistant message that triggered them
      workingMessages.push({
        role: 'assistant',
        content: content || '',
        toolCalls: this.toLlmToolCalls(toolCalls),
      });

      // Emit tool_start events
      for (const tc of toolCalls) {
        yield { content: '', done: false, toolEvent: { type: 'tool_start' as const, name: tc.name } };
      }

      // Execute tools
      const results = await this.executor.executeAll(toolCalls, context);
      for (const tc of toolCalls) this._lastUsedToolNames.add(tc.name);

      for (const toolResult of results) {
        // Emit tool_end events
        yield { content: '', done: false, toolEvent: { type: 'tool_end' as const, name: toolResult.name, durationMs: toolResult.durationMs, success: toolResult.success } };
        workingMessages.push({
          role: 'tool',
          content: toolResult.success ? toolResult.output : `Error: ${toolResult.error}`,
          toolCallId: toolResult.callId,
          name: toolResult.name,
        });
      }
    }

    // Max rounds — stream final without tools
    this.logger.warn(`Tool stream loop reached max rounds (${MAX_TOOL_ROUNDS})`);
    const finalOptions = { ...completionOptions };
    delete finalOptions.tools;

    yield* this.llmService.stream(workingMessages, finalOptions);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private getFilteredDefinitions(excludeTools?: string[]) {
    const defs = this.registry.getDefinitions();
    if (!excludeTools || excludeTools.length === 0) return defs;
    const excluded = new Set(excludeTools);
    return defs.filter((d) => !excluded.has(d.name));
  }

  private buildOptions(options?: LlmCompletionOptions, excludeTools?: string[]): LlmCompletionOptions {
    const base = { ...options };

    if (this.useNativeFunctionCalling && this.registry.size > 0) {
      base.tools = toOpenAiToolsParam(this.getFilteredDefinitions(excludeTools));
      base.toolChoice = 'auto';
    }

    return base;
  }

  /**
   * Inject tool descriptions into the first system message for text-based models.
   */
  private injectToolPrompt(messages: LlmMessage[], excludeTools?: string[]): void {
    const toolSection = buildToolPromptSection(this.getFilteredDefinitions(excludeTools));
    if (!toolSection) return;

    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      messages[systemIdx] = {
        ...messages[systemIdx]!,
        content: `${getTextContent(messages[systemIdx]!.content)}\n\n${toolSection}`,
      };
    } else {
      messages.unshift({ role: 'system', content: toolSection });
    }
  }

  /**
   * Extract tool calls from either native API response or text content.
   */
  private extractToolCalls(
    nativeToolCalls: LlmToolCall[] | undefined,
    textContent: string,
  ): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
    // Try native tool calls first
    if (nativeToolCalls && nativeToolCalls.length > 0) {
      return parseNativeToolCalls(
        nativeToolCalls.map((tc) => ({
          id: tc.id,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }) as RawToolCall),
      );
    }

    // Fallback to text-based parsing (for local models)
    if (!this.useNativeFunctionCalling && textContent) {
      return parseTextToolCalls(textContent);
    }

    return [];
  }

  /**
   * Convert parsed tool calls to LlmToolCall format for assistant message metadata.
   */
  private toLlmToolCalls(
    calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  ): LlmToolCall[] {
    return calls.map((c) => ({
      id: c.id,
      function: {
        name: c.name,
        arguments: JSON.stringify(c.arguments),
      },
    }));
  }

  /**
   * If the user's message clearly requires a specific tool, and the LLM
   * responded with text instead of calling that tool, return true so the
   * orchestrator can retry with tool_choice = "required".
   */
  private shouldRetryWithToolForce(
    _assistantContent: string,
    messages: LlmMessage[],
  ): boolean {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return false;

    const userText = getTextContent(lastUser.content).toLowerCase();

    // User intent patterns that MUST result in a tool call
    const mustUseToolPatterns = [
      // Reminders / scheduling → cron
      /напомни|remind|через.*минут|через.*час|каждые.*минут|каждые.*час|every\s+\d+\s+min|every\s+\d+\s+hour|расписани|schedule|будильник|alarm|повтор|таймер|timer/,
      // Notifications → notify
      /отправь.*уведомлен|пришли.*уведомлен|send.*notif|push.*notif/,
      // Code execution → code_exec (when user wants code RUN, not just shown)
      /(?:запусти|выполни|посчитай|вычисли|run|execute|calculate).*(?:код|code|python|js|javascript|typescript|скрипт|script)/,
      /(?:на\s+(?:python|js|javascript|typescript)).*(?:выведи|посчитай|напиши.*выведи|вычисли)/,
      /(?:посчитай|вычисли|calculate|compute).*(?:сумм[уа]|средн|factorial|fibonacci|фибоначчи|факториал)/,
    ];

    for (const pattern of mustUseToolPatterns) {
      if (pattern.test(userText)) {
        this.logger.warn(`User intent requires tool but LLM responded with text. Pattern: ${pattern.source}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Buffer a stream to collect full content and tool calls.
   */
  private async bufferStream(
    messages: LlmMessage[],
    options: LlmCompletionOptions,
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> {
    let content = '';
    let streamToolCalls: LlmToolCall[] | undefined;

    for await (const chunk of this.llmService.stream(messages, options)) {
      content += chunk.content;
      if (chunk.toolCalls) {
        streamToolCalls = chunk.toolCalls;
      }
    }

    const toolCalls = this.extractToolCalls(streamToolCalls, content);

    return { content, toolCalls };
  }
}
