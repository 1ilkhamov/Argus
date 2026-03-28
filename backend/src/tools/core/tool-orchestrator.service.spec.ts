import { ConfigService } from '@nestjs/config';

import type { LlmMessage, LlmStreamChunk } from '../../llm/interfaces/llm.interface';
import { LlmService } from '../../llm/llm.service';
import { ToolExecutorService } from './execution/tool-executor.service';
import { ToolOrchestratorService } from './tool-orchestrator.service';
import { ToolRegistryService } from './registry/tool-registry.service';
import type { ToolDefinition } from './tool.types';

const createConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'tools.enabled': true,
    'llm.provider': 'openai',
    ...overrides,
  };

  return {
    get: jest.fn((key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue)),
  } as unknown as ConfigService;
};

const createToolDefinition = (name: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  parameters: {
    type: 'object',
    properties: {},
  },
  safety: 'safe',
});

const collectStream = async (stream: AsyncGenerator<LlmStreamChunk>): Promise<LlmStreamChunk[]> => {
  const chunks: LlmStreamChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
};

describe('ToolOrchestratorService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tracks last used tool names for non-streaming tool turns', async () => {
    const llmService = {
      complete: jest
        .fn()
        .mockResolvedValueOnce({
          content: '',
          model: 'gpt-4.1',
          usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call-1',
              function: {
                name: 'memory_manage',
                arguments: '{"action":"store","kind":"fact"}',
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Stored successfully.',
          model: 'gpt-4.1',
          usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
          finishReason: 'stop',
        }),
      stream: jest.fn(),
    };
    const registry = {
      size: 1,
      getDefinitions: jest.fn().mockReturnValue([createToolDefinition('memory_manage')]),
    };
    const executor = {
      executeAll: jest.fn().mockResolvedValue([
        {
          callId: 'call-1',
          name: 'memory_manage',
          success: true,
          output: 'stored',
          durationMs: 4,
        },
      ]),
    };

    const service = new ToolOrchestratorService(
      llmService as unknown as LlmService,
      registry as unknown as ToolRegistryService,
      executor as unknown as ToolExecutorService,
      createConfigService(),
    );

    const result = await service.completeWithTools([{ role: 'user', content: 'Remember this fact.' }]);

    expect(result.content).toBe('Stored successfully.');
    expect(result.toolCallLog).toEqual([
      { name: 'memory_manage', success: true, durationMs: 4 },
    ]);
    expect(executor.executeAll).toHaveBeenCalledWith([
      {
        id: 'call-1',
        name: 'memory_manage',
        arguments: { action: 'store', kind: 'fact' },
      },
    ], undefined);
    expect(Array.from(service.lastUsedToolNames)).toEqual(['memory_manage']);
    expect(Array.from(service.lastUsedToolNames)).toEqual([]);
  });

  it('forces a tool retry for multimodal scheduling requests during streaming', async () => {
    const llmService = {
      complete: jest.fn().mockResolvedValue({
        content: '',
        model: 'gpt-4.1',
        usage: { promptTokens: 18, completionTokens: 4, totalTokens: 22 },
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            function: {
              name: 'cron',
              arguments: '{"action":"create","schedule_type":"once"}',
            },
          },
        ],
      }),
      stream: jest
        .fn()
        .mockImplementationOnce(async function* (_messages: LlmMessage[], _options?: unknown) {
          yield { content: 'I will handle that for you.', done: false };
          yield { content: '', done: true };
        })
        .mockImplementationOnce(async function* (_messages: LlmMessage[], _options?: unknown) {
          yield { content: 'Reminder scheduled.', done: false };
          yield { content: '', done: true };
        }),
    };
    const registry = {
      size: 1,
      getDefinitions: jest.fn().mockReturnValue([createToolDefinition('cron')]),
    };
    const executor = {
      executeAll: jest.fn().mockResolvedValue([
        {
          callId: 'call-1',
          name: 'cron',
          success: true,
          output: 'created',
          durationMs: 7,
        },
      ]),
    };

    const service = new ToolOrchestratorService(
      llmService as unknown as LlmService,
      registry as unknown as ToolRegistryService,
      executor as unknown as ToolExecutorService,
      createConfigService(),
    );

    const chunks = await collectStream(service.streamWithTools([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Remind me tomorrow at 9.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ]));

    expect(llmService.complete).toHaveBeenCalledTimes(1);
    expect(llmService.complete).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ toolChoice: 'required' }),
    );
    expect(executor.executeAll).toHaveBeenCalledWith([
      {
        id: 'call-1',
        name: 'cron',
        arguments: { action: 'create', schedule_type: 'once' },
      },
    ], undefined);
    expect(chunks).toEqual([
      { content: '', done: false, toolEvent: { type: 'tool_start', name: 'cron' } },
      { content: '', done: false, toolEvent: { type: 'tool_end', name: 'cron', durationMs: 7, success: true } },
      { content: 'Reminder scheduled.', done: false },
      { content: '', done: true },
    ]);
    expect(Array.from(service.lastUsedToolNames)).toEqual(['cron']);
  });
});
