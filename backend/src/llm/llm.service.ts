import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  SupportedLlmProvider,
  getDefaultLlmApiBase,
  getDefaultLlmModel,
} from '../config/defaults';
import { LlmException } from '../common/exceptions/llm.exception';
import {
  getTextContent,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
  LlmToolCall,
} from './interfaces/llm.interface';

type HealthResult = {
  status: 'up' | 'down';
  model: string;
  responseTimeMs: number;
  error?: string;
};

type OpenAiCompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAiCompatibleStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

type AnthropicResponse = {
  content?: Array<{ text?: string }>;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  stop_reason?: string | null;
};

type AnthropicStreamChunk = {
  type?: string;
  delta?: { type?: string; text?: string };
};

type GoogleCandidate = {
  content?: {
    parts?: Array<{ text?: string }>;
  };
  finishReason?: string;
};

type GoogleResponse = {
  candidates?: GoogleCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

type ErrorResponse = {
  error?: { message?: string } | string;
  message?: string;
};

type ClassifiedLlmError = {
  code: 'auth' | 'empty_stream' | 'malformed_stream' | 'rate_limited' | 'timeout' | 'upstream' | 'unknown';
  message: string;
  retryable: boolean;
};

const COMPLETION_TIMEOUT_MS = parseInt(process.env.LLM_COMPLETION_TIMEOUT_MS ?? '45000', 10);
const STREAM_TIMEOUT_MS = parseInt(process.env.LLM_STREAM_TIMEOUT_MS ?? '90000', 10);
const EARLY_STREAM_RETRY_ATTEMPTS = 1;

@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private readonly provider: SupportedLlmProvider;
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;

  constructor(private readonly configService: ConfigService) {
    const configuredProvider = this.configService.get<SupportedLlmProvider>(
      'llm.provider',
      DEFAULT_LLM_PROVIDER,
    );
    this.provider = configuredProvider;
    this.apiBase = this.configService.get<string>('llm.apiBase', getDefaultLlmApiBase(configuredProvider));
    this.apiKey = this.configService.get<string>('llm.apiKey', '');
    this.defaultModel = this.configService.get<string>('llm.model', getDefaultLlmModel(configuredProvider));
    this.defaultMaxTokens = this.configService.get<number>('llm.maxTokens', DEFAULT_LLM_MAX_TOKENS);
    this.defaultTemperature = this.configService.get<number>('llm.temperature', DEFAULT_LLM_TEMPERATURE);
  }

  onModuleInit(): void {
    this.logger.log(
      `LLM configured: provider=${this.provider}, model=${this.defaultModel}, maxTokens=${this.defaultMaxTokens}`,
    );
  }

  async complete(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const model = options?.model ?? this.defaultModel;
    const startedAt = Date.now();

    try {
      if (this.provider === 'anthropic') {
        return await this.completeAnthropic(messages, options);
      }

      if (this.provider === 'google') {
        return await this.completeGoogle(messages, options);
      }

      return await this.completeOpenAiCompatible(messages, options);
    } catch (error) {
      if (error instanceof LlmException) {
        throw error;
      }

      const classified = this.classifyLlmError(error);
      this.logFailure('completion', model, startedAt, classified);
      throw new LlmException(`LLM completion failed: ${classified.message}`, error instanceof Error ? error : undefined);
    }
  }

  async *stream(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? this.defaultModel;

    try {
      if (this.provider === 'anthropic') {
        yield* this.streamWithRecovery(messages, options, () => this.streamAnthropic(messages, options));
        return;
      }

      if (this.provider === 'google') {
        yield* this.streamWithRecovery(messages, options, () => this.streamGoogle(messages, options));
        return;
      }

      yield* this.streamWithRecovery(messages, options, () => this.streamOpenAiCompatible(messages, options));
    } catch (error) {
      if (error instanceof LlmException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown LLM error';
      this.logFailure('stream', model, Date.now(), {
        code: 'unknown',
        message,
        retryable: false,
      });
      throw new LlmException(`LLM stream failed: ${message}`, error instanceof Error ? error : undefined);
    }
  }

  async checkHealth(): Promise<HealthResult> {
    const startedAt = Date.now();

    try {
      if (this.provider === 'anthropic') {
        await this.checkAnthropicHealth();
      } else if (this.provider === 'google') {
        await this.checkGoogleHealth();
      } else {
        await this.checkOpenAiCompatibleHealth();
      }

      return {
        status: 'up',
        model: this.defaultModel,
        responseTimeMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown LLM health check error';
      return {
        status: 'down',
        model: this.defaultModel,
        responseTimeMs: Date.now() - startedAt,
        error: message,
      };
    }
  }

  private async completeOpenAiCompatible(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const payload: Record<string, unknown> = {
      model: options?.model ?? this.defaultModel,
      messages: this.toOpenAiMessages(messages),
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
    };

    if (options?.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      if (options.toolChoice) {
        payload.tool_choice = options.toolChoice;
      }
    }

    const response = await this.fetchWithTimeout(this.buildApiUrl('/chat/completions'), {
      method: 'POST',
      headers: this.buildOpenAiCompatibleHeaders(),
      body: JSON.stringify(payload),
    }, COMPLETION_TIMEOUT_MS, options?.signal);

    const body = await this.parseJsonResponse<OpenAiCompatibleResponse>(response);
    const choice = body.choices?.[0];
    if (!choice) {
      throw new Error('LLM returned empty response');
    }

    const toolCalls = this.extractOpenAiToolCalls(choice.message?.tool_calls);

    return {
      content: this.readOpenAiContent(choice.message?.content),
      model: body.model ?? (options?.model ?? this.defaultModel),
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason ?? 'stop',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private async *streamOpenAiCompatible(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): AsyncGenerator<LlmStreamChunk> {
    const payload: Record<string, unknown> = {
      model: options?.model ?? this.defaultModel,
      messages: this.toOpenAiMessages(messages),
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
      stream: true,
    };

    if (options?.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      if (options.toolChoice) {
        payload.tool_choice = options.toolChoice;
      }
    }

    const response = await this.fetchWithTimeout(this.buildApiUrl('/chat/completions'), {
      method: 'POST',
      headers: this.buildOpenAiCompatibleHeaders(),
      body: JSON.stringify(payload),
    }, STREAM_TIMEOUT_MS, options?.signal);

    if (!response.ok || !response.body) {
      throw new Error(await this.readErrorResponse(response));
    }

    let done = false;
    // Accumulate tool calls from streamed deltas
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

    for await (const data of this.iterateSseData(response.body)) {
      if (data === '[DONE]') {
        if (!done) {
          done = true;
          const toolCalls = this.finalizeStreamedToolCalls(toolCallAccumulator);
          yield { content: '', done: true, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
        }
        continue;
      }

      const chunk = JSON.parse(data) as OpenAiCompatibleStreamChunk;
      const choice = chunk.choices?.[0];
      const content = this.readOpenAiContent(choice?.delta?.content);

      // Accumulate tool call deltas
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallAccumulator.get(idx);
          if (!existing) {
            toolCallAccumulator.set(idx, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          }
        }
      }

      if (content) {
        yield { content, done: false };
      }

      if (choice?.finish_reason && !done) {
        done = true;
        const toolCalls = this.finalizeStreamedToolCalls(toolCallAccumulator);
        yield { content: '', done: true, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
      }
    }

    if (!done) {
      const toolCalls = this.finalizeStreamedToolCalls(toolCallAccumulator);
      yield { content: '', done: true, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
    }
  }

  private async completeAnthropic(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    this.ensureApiKey('anthropic');

    const payload = this.buildAnthropicPayload(messages, options, false);
    const response = await this.fetchWithTimeout(this.buildApiUrl('/messages'), {
      method: 'POST',
      headers: this.buildAnthropicHeaders(),
      body: JSON.stringify(payload),
    }, COMPLETION_TIMEOUT_MS, options?.signal);

    const body = await this.parseJsonResponse<AnthropicResponse>(response);
    return {
      content: this.readAnthropicContent(body.content),
      model: body.model ?? (options?.model ?? this.defaultModel),
      usage: {
        promptTokens: body.usage?.input_tokens ?? 0,
        completionTokens: body.usage?.output_tokens ?? 0,
        totalTokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      },
      finishReason: body.stop_reason ?? 'stop',
    };
  }

  private async *streamAnthropic(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): AsyncGenerator<LlmStreamChunk> {
    this.ensureApiKey('anthropic');

    const payload = this.buildAnthropicPayload(messages, options, true);
    const response = await this.fetchWithTimeout(this.buildApiUrl('/messages'), {
      method: 'POST',
      headers: this.buildAnthropicHeaders(),
      body: JSON.stringify(payload),
    }, STREAM_TIMEOUT_MS, options?.signal);

    if (!response.ok || !response.body) {
      throw new Error(await this.readErrorResponse(response));
    }

    let done = false;

    for await (const data of this.iterateSseData(response.body)) {
      const chunk = JSON.parse(data) as AnthropicStreamChunk;

      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && chunk.delta.text) {
        yield { content: chunk.delta.text, done: false };
      }

      if (chunk.type === 'message_stop' && !done) {
        done = true;
        yield { content: '', done: true };
      }
    }

    if (!done) {
      yield { content: '', done: true };
    }
  }

  private async completeGoogle(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    this.ensureApiKey('google');

    const model = options?.model ?? this.defaultModel;
    const payload = this.buildGooglePayload(messages, options);
    const response = await this.fetchWithTimeout(this.buildGoogleApiUrl(`${model}:generateContent`), {
      method: 'POST',
      headers: this.buildGoogleHeaders(),
      body: JSON.stringify(payload),
    }, COMPLETION_TIMEOUT_MS, options?.signal);

    const body = await this.parseJsonResponse<GoogleResponse>(response);
    return {
      content: this.readGoogleContent(body),
      model,
      usage: {
        promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: body.usageMetadata?.totalTokenCount ?? 0,
      },
      finishReason: body.candidates?.[0]?.finishReason ?? 'stop',
    };
  }

  private async *streamGoogle(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): AsyncGenerator<LlmStreamChunk> {
    this.ensureApiKey('google');

    const model = options?.model ?? this.defaultModel;
    const payload = this.buildGooglePayload(messages, options);
    const response = await this.fetchWithTimeout(this.buildGoogleApiUrl(`${model}:streamGenerateContent`, { alt: 'sse' }), {
      method: 'POST',
      headers: this.buildGoogleHeaders(),
      body: JSON.stringify(payload),
    }, STREAM_TIMEOUT_MS, options?.signal);

    if (!response.ok || !response.body) {
      throw new Error(await this.readErrorResponse(response));
    }

    let done = false;

    for await (const data of this.iterateSseData(response.body)) {
      const parsed = JSON.parse(data) as GoogleResponse | GoogleResponse[];
      const chunks = Array.isArray(parsed) ? parsed : [parsed];

      for (const chunk of chunks) {
        const content = this.readGoogleContent(chunk);
        if (content) {
          yield { content, done: false };
        }

        const finishReason = chunk.candidates?.[0]?.finishReason;
        if (finishReason && !done) {
          done = true;
          yield { content: '', done: true };
        }
      }
    }

    if (!done) {
      yield { content: '', done: true };
    }
  }

  private async checkOpenAiCompatibleHealth(): Promise<void> {
    const response = await fetch(this.buildApiUrl('/models'), {
      headers: this.buildOptionalBearerHeaders(),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`LLM health check failed with status ${response.status}`);
    }
  }

  private async checkAnthropicHealth(): Promise<void> {
    this.ensureApiKey('anthropic');

    const response = await fetch(this.buildApiUrl('/models'), {
      headers: this.buildAnthropicHeaders(),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`LLM health check failed with status ${response.status}`);
    }
  }

  private async checkGoogleHealth(): Promise<void> {
    this.ensureApiKey('google');

    const response = await fetch(this.buildGoogleApiUrl(this.defaultModel), {
      headers: this.buildGoogleHeaders(),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`LLM health check failed with status ${response.status}`);
    }
  }

  private buildAnthropicPayload(messages: LlmMessage[], options: LlmCompletionOptions | undefined, stream: boolean) {
    const { system, conversation } = this.splitSystemMessages(messages);

    return {
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
      stream,
      system: system || undefined,
      messages: conversation.map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: getTextContent(message.content) }],
      })),
    };
  }

  private buildGooglePayload(messages: LlmMessage[], options?: LlmCompletionOptions) {
    const { system, conversation } = this.splitSystemMessages(messages);
    const contents = conversation.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: getTextContent(message.content) }],
    }));

    if (contents.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: '' }],
      });
    }

    return {
      contents,
      systemInstruction: system
        ? {
            parts: [{ text: system }],
          }
        : undefined,
      generationConfig: {
        temperature: options?.temperature ?? this.defaultTemperature,
        maxOutputTokens: options?.maxTokens ?? this.defaultMaxTokens,
      },
    };
  }

  private splitSystemMessages(messages: LlmMessage[]): {
    system: string;
    conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    const systemParts: string[] = [];
    const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const message of messages) {
      if (message.role === 'system') {
        systemParts.push(getTextContent(message.content));
        continue;
      }

      // Tool messages are converted to user messages for providers that
      // don't support the 'tool' role natively (Anthropic/Google).
      const role: 'user' | 'assistant' = message.role === 'tool' ? 'user' : message.role;

      const textContent = getTextContent(message.content);
      conversation.push({
        role,
        content: message.role === 'tool'
          ? `[Tool result for ${message.name ?? 'unknown'}]: ${textContent}`
          : textContent,
      });
    }

    return {
      system: systemParts.join('\n\n').trim(),
      conversation,
    };
  }

  private async *streamWithRecovery(
    messages: LlmMessage[],
    options: LlmCompletionOptions | undefined,
    createAttempt: () => AsyncGenerator<LlmStreamChunk>,
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? this.defaultModel;

    for (let attempt = 0; attempt <= EARLY_STREAM_RETRY_ATTEMPTS; attempt += 1) {
      const attemptStartedAt = Date.now();
      let receivedFirstPayload = false;

      try {
        for await (const chunk of createAttempt()) {
          // Skip empty done markers, but NOT done chunks that carry tool calls
          if (chunk.done && !receivedFirstPayload && !(chunk.toolCalls && chunk.toolCalls.length > 0)) {
            continue;
          }

          if (chunk.content || (chunk.toolCalls && chunk.toolCalls.length > 0)) {
            receivedFirstPayload = true;
          }

          yield chunk;
        }

        if (!receivedFirstPayload) {
          throw new Error('empty_stream: upstream stream closed before first payload');
        }

        return;
      } catch (error) {
        const classified = this.classifyLlmError(error);
        this.logFailure('stream', model, attemptStartedAt, classified, attempt + 1);

        if (receivedFirstPayload) {
          throw new LlmException(`LLM stream failed: ${classified.message}`, error instanceof Error ? error : undefined);
        }

        if (attempt < EARLY_STREAM_RETRY_ATTEMPTS && this.shouldRetryEarlyStreamFailure(classified)) {
          continue;
        }

        if (this.shouldFallbackToCompletion(classified)) {
          this.logger.warn(
            `LLM stream fallback to completion: provider=${this.provider}, model=${model}, code=${classified.code}, attempts=${attempt + 1}`,
          );
          const result = await this.complete(messages, options);
          if (result.content) {
            yield { content: result.content, done: false };
          }
          yield { content: '', done: true };
          return;
        }

        throw new LlmException(`LLM stream failed: ${classified.message}`, error instanceof Error ? error : undefined);
      }
    }
  }

  private buildApiUrl(pathname: string): string {
    return `${this.apiBase.replace(/\/$/, '')}${pathname}`;
  }

  private buildGoogleApiUrl(resource: string, extraParams?: Record<string, string>): string {
    const url = new URL(`${this.apiBase.replace(/\/$/, '')}/models/${resource}`);
    url.searchParams.set('key', this.apiKey);

    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  private buildOptionalBearerHeaders(): HeadersInit {
    if (!this.apiKey) {
      return {};
    }

    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildOpenAiCompatibleHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...this.buildOptionalBearerHeaders(),
    };
  }

  private buildAnthropicHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.apiKey,
    };
  }

  private buildGoogleHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    return fetch(url, { ...init, signal });
  }

  private ensureApiKey(provider: 'anthropic' | 'google'): void {
    if (!this.apiKey) {
      throw new Error(`${provider} requires LLM_API_KEY`);
    }
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(await this.readErrorResponse(response));
    }

    return (await response.json()) as T;
  }

  private async readErrorResponse(response: Response): Promise<string> {
    const fallback = `LLM request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as ErrorResponse;
      if (typeof body.error === 'string' && body.error) {
        return body.error;
      }

      if (body.error && typeof body.error === 'object' && body.error.message) {
        return body.error.message;
      }

      if (body.message) {
        return body.message;
      }
    } catch {
      try {
        const text = await response.text();
        if (text) {
          return text;
        }
      } catch {
        return fallback;
      }
    }

    return fallback;
  }

  private classifyLlmError(error: unknown): ClassifiedLlmError {
    const message = error instanceof Error ? error.message : 'Unknown LLM error';
    const normalized = message.toLocaleLowerCase();

    if (normalized.includes('empty_stream') || normalized.includes('stream closed before first payload')) {
      return { code: 'empty_stream', message, retryable: true };
    }

    if (
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('aborted') ||
      normalized.includes('aborterror')
    ) {
      return { code: 'timeout', message, retryable: true };
    }

    if (
      normalized.includes('missing api key') ||
      normalized.includes('requires llm_api_key') ||
      normalized.includes('unauthorized') ||
      normalized.includes('forbidden') ||
      normalized.includes('status 401') ||
      normalized.includes('status 403')
    ) {
      return { code: 'auth', message, retryable: false };
    }

    if (normalized.includes('status 429') || normalized.includes('rate limit')) {
      return { code: 'rate_limited', message, retryable: false };
    }

    if (
      normalized.includes('unexpected token') ||
      normalized.includes('invalid json') ||
      normalized.includes('malformed') ||
      normalized.includes('sse')
    ) {
      return { code: 'malformed_stream', message, retryable: true };
    }

    if (
      normalized.includes('status 5') ||
      normalized.includes('bad gateway') ||
      normalized.includes('upstream') ||
      normalized.includes('econnreset') ||
      normalized.includes('socket hang up')
    ) {
      return { code: 'upstream', message, retryable: true };
    }

    return { code: 'unknown', message, retryable: false };
  }

  private shouldRetryEarlyStreamFailure(classified: ClassifiedLlmError): boolean {
    return classified.code === 'empty_stream' || classified.code === 'timeout' || classified.code === 'upstream';
  }

  private shouldFallbackToCompletion(classified: ClassifiedLlmError): boolean {
    return classified.code === 'empty_stream' || classified.code === 'timeout' || classified.code === 'upstream';
  }

  private logFailure(
    operation: 'completion' | 'stream',
    model: string,
    startedAt: number,
    classified: ClassifiedLlmError,
    attempt?: number,
  ): void {
    const parts = [
      `provider=${this.provider}`,
      `model=${model}`,
      `operation=${operation}`,
      `code=${classified.code}`,
      `durationMs=${Date.now() - startedAt}`,
    ];

    if (attempt) {
      parts.push(`attempt=${attempt}`);
    }

    parts.push(`message=${classified.message}`);
    this.logger.error(`LLM ${operation} failed: ${parts.join(', ')}`);
  }

  private toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId ?? '',
        };
      }

      // Assistant messages that triggered tool calls must include tool_calls
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role,
        content: msg.content,
      };
    });
  }

  private extractOpenAiToolCalls(
    raw?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>,
  ): LlmToolCall[] {
    if (!raw || raw.length === 0) return [];

    return raw
      .filter((tc) => tc.function?.name)
      .map((tc) => ({
        id: tc.id ?? `call_${Date.now()}`,
        function: {
          name: tc.function!.name!,
          arguments: tc.function!.arguments ?? '{}',
        },
      }));
  }

  private finalizeStreamedToolCalls(
    accumulator: Map<number, { id: string; name: string; args: string }>,
  ): LlmToolCall[] {
    if (accumulator.size === 0) return [];

    const calls: LlmToolCall[] = [];
    const sorted = [...accumulator.entries()].sort(([a], [b]) => a - b);

    for (const [, { id, name, args }] of sorted) {
      if (name) {
        calls.push({
          id: id || `call_${Date.now()}`,
          function: { name, arguments: args || '{}' },
        });
      }
    }

    return calls;
  }

  private readOpenAiContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }

          if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
            return item.text;
          }

          return '';
        })
        .join('');
    }

    return '';
  }

  private readAnthropicContent(content: unknown): string {
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('');
  }

  private readGoogleContent(body: unknown): string {
    const candidates =
      body && typeof body === 'object' && 'candidates' in body && Array.isArray(body.candidates) ? body.candidates : [];
    const firstCandidate = candidates[0];
    const parts =
      firstCandidate &&
      typeof firstCandidate === 'object' &&
      'content' in firstCandidate &&
      firstCandidate.content &&
      typeof firstCandidate.content === 'object' &&
      'parts' in firstCandidate.content &&
      Array.isArray(firstCandidate.content.parts)
        ? firstCandidate.content.parts
        : [];

    return parts
      .map((part: unknown) => {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }

        return '';
      })
      .join('');
  }

  private async *iterateSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundaryMatch = buffer.match(/\r?\n\r?\n/);
        const boundaryIndex = boundaryMatch?.index ?? -1;
        if (boundaryIndex === -1 || !boundaryMatch) {
          break;
        }

        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + boundaryMatch[0].length);

        const data = rawEvent
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');

        if (data) {
          yield data;
        }
      }
    }

    const tail = buffer
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (tail) {
      yield tail;
    }
  }
}
