import { ConfigService } from '@nestjs/config';

import { LlmService } from './llm.service';
import type { LlmMessage, LlmStreamChunk } from './interfaces/llm.interface';

const createConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'llm.provider': 'local',
    'llm.apiBase': 'http://localhost:8317/v1',
    'llm.apiKey': 'proxypal-local',
    'llm.model': 'gpt-5.4',
    'llm.maxTokens': 4096,
    'llm.temperature': 0.7,
    ...overrides,
  };

  return {
    get: jest.fn((key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue)),
  } as unknown as ConfigService;
};

const createJsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

const createSseResponse = (events: string[], status = 200): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event));
        }
        controller.close();
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  );

const collectStream = async (service: LlmService, messages: LlmMessage[]): Promise<LlmStreamChunk[]> => {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of service.stream(messages)) {
    chunks.push(chunk);
  }
  return chunks;
};

describe('LlmService', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: 'Reply with exactly OK' }];
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries an early empty stream failure and falls back to completion before failing the chat stream', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({ error: { message: 'empty_stream: upstream stream closed before first payload' } }, 502),
      )
      .mockResolvedValueOnce(
        createJsonResponse({ error: { message: 'empty_stream: upstream stream closed before first payload' } }, 502),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          model: 'gpt-5.4',
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );
    global.fetch = fetchMock as typeof global.fetch;

    const service = new LlmService(createConfigService());
    const chunks = await collectStream(service, messages);

    expect(chunks).toEqual([
      { content: 'OK', done: false },
      { content: '', done: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).stream).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).stream).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).stream ?? 'false').not.toBe(true);
  });

  it('streams token payloads normally when the upstream stream sends content before done', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createSseResponse([
        'data: {"choices":[{"delta":{"content":"O"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"K"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    global.fetch = fetchMock as typeof global.fetch;

    const service = new LlmService(createConfigService());
    const chunks = await collectStream(service, messages);

    expect(chunks).toEqual([
      { content: 'O', done: false },
      { content: 'K', done: false },
      { content: '', done: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('extracts text parts from multimodal messages for anthropic payloads', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createJsonResponse({
        content: [{ text: 'OK' }],
        model: 'claude-3-7-sonnet',
        usage: { input_tokens: 12, output_tokens: 1 },
        stop_reason: 'end_turn',
      }),
    );
    global.fetch = fetchMock as typeof global.fetch;

    const service = new LlmService(createConfigService({
      'llm.provider': 'anthropic',
      'llm.apiBase': 'https://anthropic.example/v1',
      'llm.apiKey': 'anthropic-test-key',
      'llm.model': 'claude-3-7-sonnet',
    }));

    const result = await service.complete([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'System instruction' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
        ],
      },
    ]);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(result.content).toBe('OK');
    expect(request.system).toBe('System instruction');
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Please describe this image' }],
      },
    ]);
  });

  it('extracts text parts from multimodal system, user, and tool messages for google payloads', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      createJsonResponse({
        candidates: [{
          content: {
            parts: [{ text: 'OK' }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 1,
          totalTokenCount: 10,
        },
      }),
    );
    global.fetch = fetchMock as typeof global.fetch;

    const service = new LlmService(createConfigService({
      'llm.provider': 'google',
      'llm.apiBase': 'https://generativelanguage.googleapis.com/v1beta',
      'llm.apiKey': 'google-test-key',
      'llm.model': 'gemini-2.5-flash',
    }));

    const result = await service.complete([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Follow the user request carefully.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,SYSTEM' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is happening here?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,USER' } },
        ],
      },
      {
        role: 'tool',
        name: 'vision',
        toolCallId: 'call-1',
        content: [
          { type: 'text', text: 'Detected a login form.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,TOOL' } },
        ],
      },
    ]);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(result.content).toBe('OK');
    expect(request.systemInstruction).toEqual({
      parts: [{ text: 'Follow the user request carefully.' }],
    });
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'What is happening here?' }],
      },
      {
        role: 'user',
        parts: [{ text: '[Tool result for vision]: Detected a login form.' }],
      },
    ]);
  });
});
