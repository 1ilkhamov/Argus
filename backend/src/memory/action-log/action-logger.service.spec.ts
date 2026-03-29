import type { LlmService } from '../../llm/llm.service';
import type { MemoryEntry } from '../core/memory-entry.types';
import { MemoryStoreService } from '../core/memory-store.service';
import { ActionLoggerService } from './action-logger.service';
import type { ActionLogEntry } from './action-log.types';

const makeEntry = (id: string, kind: MemoryEntry['kind'] = 'action'): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind,
  content: 'test',
  tags: [],
  source: 'tool_result',
  horizon: 'short_term',
  importance: 0.3,
  decayRate: 0.05,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
});

let idCounter = 0;
const createMockStore = () => {
  const store = {
    create: jest.fn().mockImplementation(async (params: { kind: string }) => {
      idCounter++;
      return makeEntry(`entry-${idCounter}`, params.kind as MemoryEntry['kind']);
    }),
    update: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  };
  return store as unknown as MemoryStoreService;
};

const createMockLlm = (response: string) => ({
  complete: jest.fn().mockResolvedValue({ content: response }),
}) as unknown as LlmService;

const baseAction: ActionLogEntry = {
  toolName: 'web_search',
  args: { query: 'NestJS best practices' },
  result: 'Found 10 results about NestJS patterns and practices.',
  success: true,
  durationMs: 250,
  conversationId: 'conv-1',
  messageId: 'msg-1',
};

describe('ActionLoggerService', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it('logs a successful action as a memory entry', async () => {
    const store = createMockStore();
    const service = new ActionLoggerService(store);

    const result = await service.logAction(baseAction);

    expect(result.actionEntryId).toBe('entry-1');
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'action',
        source: 'tool_result',
        category: 'web_search',
        tags: expect.arrayContaining(['web_search', 'success']),
      }),
    );
  });

  it('logs a failed action with higher importance', async () => {
    const store = createMockStore();
    const service = new ActionLoggerService(store);

    const failedAction: ActionLogEntry = {
      ...baseAction,
      success: false,
      error: 'Timeout after 30s',
    };

    await service.logAction(failedAction);

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        importance: 0.5,
        tags: expect.arrayContaining(['web_search', 'error']),
      }),
    );
  });

  it('truncates long results', async () => {
    const store = createMockStore();
    const service = new ActionLoggerService(store);

    const longAction: ActionLogEntry = {
      ...baseAction,
      result: 'x'.repeat(1000),
    };

    await service.logAction(longAction);

    const createCall = (store.create as jest.Mock).mock.calls[0]?.[0];
    expect(createCall.content).toContain('…');
    expect(createCall.content.length).toBeLessThan(1200);
  });

  it('reflects on failed actions and creates learning entry', async () => {
    const store = createMockStore();
    const llm = createMockLlm(JSON.stringify({
      outcome: 'Search timed out',
      issues: 'API rate limit exceeded',
      learning: 'Add retry logic for external API calls',
    }));
    const service = new ActionLoggerService(store, llm);

    const failedAction: ActionLogEntry = {
      ...baseAction,
      success: false,
      error: 'Timeout',
    };

    const result = await service.logAction(failedAction);

    expect(result.actionEntryId).toBe('entry-1');
    expect(result.learningEntryId).toBe('entry-2');
    expect(store.create).toHaveBeenCalledTimes(2);
    // Second call should be learning entry
    expect((store.create as jest.Mock).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        kind: 'learning',
        source: 'agent_reflection',
        content: 'Add retry logic for external API calls',
      }),
    );
  });

  it('skips reflection when no LLM service', async () => {
    const store = createMockStore();
    const service = new ActionLoggerService(store);

    const failedAction: ActionLogEntry = { ...baseAction, success: false, error: 'err' };
    const result = await service.logAction(failedAction);

    expect(result.learningEntryId).toBeUndefined();
    expect(store.create).toHaveBeenCalledTimes(1);
  });

  it('handles LLM reflection failure gracefully', async () => {
    const store = createMockStore();
    const llm = { complete: jest.fn().mockRejectedValue(new Error('LLM down')) } as unknown as LlmService;
    const service = new ActionLoggerService(store, llm);

    const failedAction: ActionLogEntry = { ...baseAction, success: false, error: 'err' };
    const result = await service.logAction(failedAction);

    expect(result.actionEntryId).toBe('entry-1');
    expect(result.learningEntryId).toBeUndefined();
  });

  it('does not reflect on trivial successful actions', async () => {
    const store = createMockStore();
    const llm = createMockLlm('{}');
    const service = new ActionLoggerService(store, llm);

    // Short result + success = trivial → no reflection
    const trivialAction: ActionLogEntry = {
      ...baseAction,
      result: 'OK',
      success: true,
    };

    await service.logAction(trivialAction);

    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('includes provenance with conversationId and messageId', async () => {
    const store = createMockStore();
    const service = new ActionLoggerService(store);

    await service.logAction(baseAction);

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({
          conversationId: 'conv-1',
          messageId: 'msg-1',
        }),
      }),
    );
  });
});
