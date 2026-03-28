import type { LlmService } from '../../llm/llm.service';
import type { MemoryEntry } from '../core/memory-entry.types';
import { MemoryStoreService } from '../core/memory-store.service';
import { SessionReflectionService } from './session-reflection.service';

const makeEntry = (id: string, kind: MemoryEntry['kind'] = 'episode'): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind,
  content: 'test',
  tags: [],
  source: 'agent_reflection',
  horizon: 'long_term',
  importance: 0.7,
  decayRate: 0,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
});

let idCounter = 0;
const createMockStore = () => {
  const store = {
    create: jest.fn().mockImplementation(async () => {
      idCounter++;
      return makeEntry(`entry-${idCounter}`);
    }),
    update: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    clearWorkingMemory: jest.fn().mockResolvedValue(0),
    deleteByQuery: jest.fn().mockResolvedValue(0),
  };
  return store as unknown as MemoryStoreService;
};

const createMockLlm = (response: string) => ({
  complete: jest.fn().mockResolvedValue({ content: response }),
}) as unknown as LlmService;

describe('SessionReflectionService', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it('returns false for isAvailable when no LLM', () => {
    const service = new SessionReflectionService(createMockStore());
    expect(service.isAvailable()).toBe(false);
  });

  it('returns true for isAvailable when LLM provided', () => {
    const service = new SessionReflectionService(createMockStore(), createMockLlm('{}'));
    expect(service.isAvailable()).toBe(true);
  });

  it('returns undefined for empty session context', async () => {
    const service = new SessionReflectionService(createMockStore(), createMockLlm('{}'));
    const result = await service.reflect('');
    expect(result).toBeUndefined();
  });

  it('returns undefined for short session context', async () => {
    const service = new SessionReflectionService(createMockStore(), createMockLlm('{}'));
    const result = await service.reflect('short');
    expect(result).toBeUndefined();
  });

  it('creates memory entries from a full reflection', async () => {
    const store = createMockStore();
    const llmResponse = JSON.stringify({
      summary: 'Discussed NestJS architecture and memory system design.',
      keyDecisions: ['Use Qdrant for vector storage', 'Adopt RRF for search merging'],
      openQuestions: ['How to handle KG scaling?'],
      learnings: ['Fire-and-forget is good for non-blocking capture'],
    });
    const service = new SessionReflectionService(store, createMockLlm(llmResponse));

    const result = await service.reflect(
      'We discussed building a memory system for the AI agent with hybrid search capabilities...',
      'conv-123',
    );

    expect(result).toBeDefined();
    expect(result!.summary).toBe('Discussed NestJS architecture and memory system design.');
    expect(result!.keyDecisions).toHaveLength(2);
    expect(result!.openQuestions).toHaveLength(1);
    expect(result!.learnings).toHaveLength(1);
    // 1 summary + 2 decisions + 1 question + 1 learning = 5 entries
    expect(result!.createdEntryIds).toHaveLength(5);
    expect(store.create).toHaveBeenCalledTimes(5);
  });

  it('creates only summary entry when no decisions/questions/learnings', async () => {
    const store = createMockStore();
    const llmResponse = JSON.stringify({
      summary: 'Quick chat about configuration.',
      keyDecisions: [],
      openQuestions: [],
      learnings: [],
    });
    const service = new SessionReflectionService(store, createMockLlm(llmResponse));

    const result = await service.reflect(
      'The user asked about env configuration and I provided the answer.',
    );

    expect(result).toBeDefined();
    expect(result!.createdEntryIds).toHaveLength(1);
  });

  it('promotes important working memories and clears working memory', async () => {
    const store = createMockStore();
    (store.query as jest.Mock)
      .mockResolvedValueOnce([]) // recent memories for context
      .mockResolvedValueOnce([ // working memories to promote
        makeEntry('work-1'),
        { ...makeEntry('work-2'), importance: 0.3 }, // too low, won't promote
      ]);

    const llmResponse = JSON.stringify({
      summary: 'Session about deployment.',
      keyDecisions: [],
      openQuestions: [],
      learnings: [],
    });
    const service = new SessionReflectionService(store, createMockLlm(llmResponse));

    await service.reflect('We discussed deployment strategies and CI/CD pipelines.');

    expect(store.clearWorkingMemory).toHaveBeenCalled();
  });

  it('handles LLM failure gracefully', async () => {
    const store = createMockStore();
    const llm = { complete: jest.fn().mockRejectedValue(new Error('LLM down')) } as unknown as LlmService;
    const service = new SessionReflectionService(store, llm);

    const result = await service.reflect('Long session about architecture decisions and patterns.');

    expect(result).toBeUndefined();
  });

  it('handles malformed LLM JSON gracefully', async () => {
    const store = createMockStore();
    const service = new SessionReflectionService(store, createMockLlm('not json'));

    const result = await service.reflect('Long session about architecture decisions and patterns.');

    expect(result).toBeUndefined();
  });

  it('handles markdown-fenced JSON', async () => {
    const store = createMockStore();
    const fenced = '```json\n' + JSON.stringify({
      summary: 'Fenced response.',
      keyDecisions: ['One decision'],
      openQuestions: [],
      learnings: [],
    }) + '\n```';
    const service = new SessionReflectionService(store, createMockLlm(fenced));

    const result = await service.reflect('We had a productive session about fencing in JSON.');

    expect(result).toBeDefined();
    expect(result!.summary).toBe('Fenced response.');
    expect(result!.keyDecisions).toHaveLength(1);
  });
});
