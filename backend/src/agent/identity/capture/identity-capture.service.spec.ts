import { IdentityCaptureService } from './identity-capture.service';
import { IdentityExtractorService, type IdentityExtractionResult } from './identity-extractor.service';
import type { MemoryEntry, CreateMemoryEntryParams } from '../../../memory/core/memory-entry.types';
import type { MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';

// ─── Helpers ────────────────────────────────────────────────────────────────

let entryCounter = 0;

function makeMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  entryCounter++;
  return {
    id: `entry-${entryCounter}`,
    scopeKey: 'local:default',
    kind: 'identity',
    content: 'test content',
    source: 'llm_extraction',
    category: 'style',
    tags: [],
    importance: 0.85,
    horizon: 'long_term',
    decayRate: 0,
    pinned: false,
    accessCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createExtractor(result?: IdentityExtractionResult) {
  return {
    isAvailable: jest.fn().mockReturnValue(result !== undefined),
    extractFromTurn: jest.fn().mockResolvedValue(result),
  } as unknown as IdentityExtractorService;
}

function createStore() {
  return {
    create: jest.fn().mockImplementation((params: CreateMemoryEntryParams) =>
      Promise.resolve(makeMemoryEntry({
        kind: params.kind,
        content: params.content,
        category: params.category,
        tags: params.tags,
        importance: params.importance,
        scopeKey: params.scopeKey,
      })),
    ),
    update: jest.fn().mockResolvedValue(undefined),
    supersede: jest.fn().mockImplementation((_id: string, params: CreateMemoryEntryParams) =>
      Promise.resolve(makeMemoryEntry({
        kind: params.kind,
        content: params.content,
        category: params.category,
        tags: params.tags,
        importance: params.importance,
        scopeKey: params.scopeKey,
      })),
    ),
  };
}

function createRepo(existingEntries: MemoryEntry[] = []) {
  return {
    query: jest.fn().mockResolvedValue(existingEntries),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  } as unknown as MemoryEntryRepository;
}

function createContradictionResolver(action: 'keep_new' | 'keep_old' | 'merge' | 'keep_both' | 'none' = 'none') {
  return {
    findConflicts: jest.fn().mockImplementation((existing: MemoryEntry[]) => {
      if (action === 'none' || existing.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        existingEntry: existing[0],
        resolution: action === 'merge'
          ? { action: 'merge', merged: 'merged content' }
          : { action },
      }]);
    }),
  };
}

function createEmbeddingService() {
  return {
    isAvailable: jest.fn().mockReturnValue(false),
    embedBatch: jest.fn().mockResolvedValue(null),
  };
}

function createQdrantService() {
  return {
    isReady: jest.fn().mockReturnValue(false),
    upsertPoints: jest.fn(),
  };
}

function buildService(options: {
  extractionResult?: IdentityExtractionResult;
  existingEntries?: MemoryEntry[];
  contradictionAction?: 'keep_new' | 'keep_old' | 'merge' | 'keep_both' | 'none';
} = {}) {
  const extractor = createExtractor(options.extractionResult);
  const store = createStore();
  const repo = createRepo(options.existingEntries ?? []);
  const contradictionResolver = createContradictionResolver(options.contradictionAction ?? 'none');
  const embeddingService = createEmbeddingService();
  const qdrantService = createQdrantService();

  const service = new IdentityCaptureService(
    extractor as any,
    store as any,
    contradictionResolver as any,
    embeddingService as any,
    qdrantService as any,
    repo,
  );

  return { service, extractor, store, repo, contradictionResolver };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('IdentityCaptureService', () => {
  beforeEach(() => {
    entryCounter = 0;
  });

  it('returns empty result when extractor is not available', async () => {
    const { service } = buildService();
    const result = await service.captureFromTurn('hello', 'hi', 'conv-1', 'msg-1', 'local:default');
    expect(result).toEqual({ created: [], superseded: [], skipped: 0 });
  });

  it('returns empty result when extraction yields no traits', async () => {
    const { service } = buildService({ extractionResult: { traits: [] } });
    const result = await service.captureFromTurn('hello', 'hi');
    expect(result.created).toHaveLength(0);
  });

  it('creates identity memory entries from extracted traits', async () => {
    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'style', content: 'Skip preambles and answer directly', confidence: 'high', signal: 'explicit' },
        ],
      },
    });

    const result = await service.captureFromTurn('test', 'response', 'conv-1', 'msg-1', 'scope:user1');

    expect(result.created).toHaveLength(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    const createCall = store.create.mock.calls[0]![0] as CreateMemoryEntryParams;
    expect(createCall.kind).toBe('identity');
    expect(createCall.category).toBe('style');
    expect(createCall.content).toBe('Skip preambles and answer directly');
    expect(createCall.scopeKey).toBe('scope:user1');
    expect(createCall.importance).toBe(0.9); // high confidence
    expect(createCall.tags).toContain('identity');
    expect(createCall.tags).toContain('style');
    expect(createCall.tags).toContain('explicit_signal');
  });

  it('uses lower importance for medium-confidence traits', async () => {
    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'personality', content: 'Seems to appreciate humor', confidence: 'medium', signal: 'inferred' },
        ],
      },
    });

    await service.captureFromTurn('test', 'response');

    const createCall = store.create.mock.calls[0]![0] as CreateMemoryEntryParams;
    expect(createCall.importance).toBe(0.75);
    expect(createCall.tags).not.toContain('explicit_signal');
  });

  it('skips near-duplicate traits', async () => {
    const existingEntries = [
      makeMemoryEntry({ category: 'style', content: 'Skip preambles and answer directly' }),
    ];

    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'style', content: 'Skip preambles and answer directly', confidence: 'high', signal: 'test' },
        ],
      },
      existingEntries,
    });

    const result = await service.captureFromTurn('test', 'response');

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('supersedes conflicting traits with keep_new resolution', async () => {
    const existing = makeMemoryEntry({ category: 'style', content: 'Be verbose and detailed' });

    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'style', content: 'Be concise and direct', confidence: 'high', signal: 'correction' },
        ],
      },
      existingEntries: [existing],
      contradictionAction: 'keep_new',
    });

    const result = await service.captureFromTurn('test', 'response');

    expect(result.created).toHaveLength(1);
    expect(result.superseded).toHaveLength(1);
    expect(store.supersede).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      kind: 'identity',
      content: 'Be concise and direct',
    }));
  });

  it('discards traits with keep_old resolution', async () => {
    const existing = makeMemoryEntry({ category: 'style', content: 'Be formal' });

    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'style', content: 'Be casual', confidence: 'medium', signal: 'test' },
        ],
      },
      existingEntries: [existing],
      contradictionAction: 'keep_old',
    });

    const result = await service.captureFromTurn('test', 'response');

    expect(result.created).toHaveLength(0);
    expect(store.create).not.toHaveBeenCalled();
    expect(store.supersede).not.toHaveBeenCalled();
  });

  it('merges conflicting traits with merge resolution', async () => {
    const existing = makeMemoryEntry({ category: 'value', content: 'Accuracy matters' });

    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'value', content: 'Speed matters too', confidence: 'high', signal: 'test' },
        ],
      },
      existingEntries: [existing],
      contradictionAction: 'merge',
    });

    const result = await service.captureFromTurn('test', 'response');

    expect(result.created).toHaveLength(1);
    expect(result.superseded).toHaveLength(1);
    expect(store.supersede).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      content: 'merged content',
    }));
  });

  it('keeps both with keep_both resolution', async () => {
    const existing = makeMemoryEntry({ category: 'expertise', content: 'Good at TypeScript' });

    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'expertise', content: 'Good at architecture', confidence: 'medium', signal: 'test' },
        ],
      },
      existingEntries: [existing],
      contradictionAction: 'keep_both',
    });

    const result = await service.captureFromTurn('test', 'response');

    expect(result.created).toHaveLength(1);
    expect(result.superseded).toHaveLength(0);
    expect(store.create).toHaveBeenCalledTimes(1);
  });

  it('processes multiple traits in a single turn', async () => {
    const { service } = buildService({
      extractionResult: {
        traits: [
          { category: 'style', content: 'Use bullet points for clarity', confidence: 'high', signal: 'test' },
          { category: 'boundary', content: 'Never apologize for previous answers', confidence: 'high', signal: 'test' },
          { category: 'value', content: 'Action over deliberation always', confidence: 'medium', signal: 'test' },
        ],
      },
    });

    const result = await service.captureFromTurn('test', 'response', 'conv-1', 'msg-1', 'scope:user1');

    expect(result.created).toHaveLength(3);
  });

  it('includes provenance in created entries', async () => {
    const { service, store } = buildService({
      extractionResult: {
        traits: [
          { category: 'personality', content: 'Be direct and concise', confidence: 'high', signal: 'test' },
        ],
      },
    });

    await service.captureFromTurn('test', 'response', 'conv-42', 'msg-99');

    const createCall = store.create.mock.calls[0]![0] as CreateMemoryEntryParams;
    expect(createCall.provenance).toBeDefined();
    expect(createCall.provenance!.conversationId).toBe('conv-42');
    expect(createCall.provenance!.messageId).toBe('msg-99');
    expect(createCall.provenance!.timestamp).toBeDefined();
  });
});
