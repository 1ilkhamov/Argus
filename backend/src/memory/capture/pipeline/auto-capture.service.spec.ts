import type { EmbeddingService } from '../../../embedding/embedding.service';
import type { MemoryEntry, CreateMemoryEntryParams } from '../../core/memory-entry.types';
import type { MemoryEntryRepository } from '../../core/memory-entry.repository';
import { MemoryStoreService } from '../../core/memory-store.service';
import type { QdrantVectorService } from '../../qdrant/qdrant-vector.service';
import { AutoCaptureService } from './auto-capture.service';
import { ContradictionResolverService } from '../reconciliation/contradiction-resolver.service';
import { MemoryExtractorV2Service, type MemoryExtractionResult } from './memory-extractor-v2.service';

const makeEntry = (id: string, kind: MemoryEntry['kind'] = 'fact', content = 'test'): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind,
  content,
  tags: [],
  source: 'llm_extraction',
  horizon: 'long_term',
  importance: 0.5,
  decayRate: 0.01,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
});

const createMockRepo = () => ({
  save: jest.fn(),
  saveBatch: jest.fn(),
  findById: jest.fn(),
  query: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  update: jest.fn(),
  incrementAccessCount: jest.fn(),
  delete: jest.fn(),
  deleteBatch: jest.fn(),
  deleteByQuery: jest.fn().mockResolvedValue(0),
});

const createMockStore = (repo: ReturnType<typeof createMockRepo>) => {
  let idCounter = 0;
  const store = new MemoryStoreService(repo as unknown as MemoryEntryRepository);
  // Override create to return predictable entries
  jest.spyOn(store, 'create').mockImplementation(async (params: CreateMemoryEntryParams) => {
    idCounter++;
    return makeEntry(`new-${idCounter}`, params.kind, params.content);
  });
  jest.spyOn(store, 'update').mockResolvedValue(undefined);
  jest.spyOn(store, 'supersede').mockImplementation(async (_oldId, params) => {
    idCounter++;
    return makeEntry(`superseded-${idCounter}`, params.kind, params.content);
  });
  return store;
};

const createMockExtractor = (result: MemoryExtractionResult | undefined) => ({
  isAvailable: jest.fn().mockReturnValue(true),
  extractFromTurn: jest.fn().mockResolvedValue(result),
  reflectOnSession: jest.fn().mockResolvedValue(result),
});

const createMockContradictionResolver = () => ({
  isAvailable: jest.fn().mockReturnValue(true),
  checkAndResolve: jest.fn().mockResolvedValue({ isContradiction: false }),
  findConflicts: jest.fn().mockResolvedValue([]),
});

const createMockEmbeddingService = () => ({
  isAvailable: jest.fn().mockReturnValue(false),
  embed: jest.fn(),
  embedBatch: jest.fn(),
});

const createMockQdrant = () => ({
  isReady: jest.fn().mockReturnValue(false),
  upsertPoints: jest.fn(),
  search: jest.fn(),
  deletePoints: jest.fn(),
  ensureCollection: jest.fn(),
});

describe('AutoCaptureService', () => {
  it('returns empty result when extractor yields nothing', async () => {
    const repo = createMockRepo();
    const service = new AutoCaptureService(
      createMockExtractor(undefined) as unknown as MemoryExtractorV2Service,
      createMockStore(repo),
      createMockContradictionResolver() as unknown as ContradictionResolverService,
      createMockEmbeddingService() as unknown as EmbeddingService,
      createMockQdrant() as unknown as QdrantVectorService,
      repo as unknown as MemoryEntryRepository,
    );

    const result = await service.captureFromTurn('hello', 'hi');

    expect(result.created).toHaveLength(0);
    expect(result.superseded).toHaveLength(0);
    expect(result.invalidated).toHaveLength(0);
  });

  it('creates new entries when no conflicts exist', async () => {
    const repo = createMockRepo();
    const extraction: MemoryExtractionResult = {
      items: [
        { kind: 'fact', content: 'User name is Alice', importance: 0.9 },
        { kind: 'episode', content: 'Discussed NestJS architecture' },
      ],
      invalidations: [],
    };

    const service = new AutoCaptureService(
      createMockExtractor(extraction) as unknown as MemoryExtractorV2Service,
      createMockStore(repo),
      createMockContradictionResolver() as unknown as ContradictionResolverService,
      createMockEmbeddingService() as unknown as EmbeddingService,
      createMockQdrant() as unknown as QdrantVectorService,
      repo as unknown as MemoryEntryRepository,
    );

    const result = await service.captureFromTurn('My name is Alice', 'Nice to meet you!', 'conv-1', 'msg-1');

    expect(result.created).toHaveLength(2);
    expect(result.superseded).toHaveLength(0);
  });

  it('processes invalidations by marking matching entries as superseded', async () => {
    const existingEntry = makeEntry('existing-1', 'fact', 'works at Company X');
    const repo = createMockRepo();
    repo.query.mockResolvedValue([existingEntry]);

    const extraction: MemoryExtractionResult = {
      items: [],
      invalidations: [
        { contentPattern: 'works at Company X', kind: 'fact', reason: 'user left' },
      ],
    };

    const store = createMockStore(repo);

    const service = new AutoCaptureService(
      createMockExtractor(extraction) as unknown as MemoryExtractorV2Service,
      store,
      createMockContradictionResolver() as unknown as ContradictionResolverService,
      createMockEmbeddingService() as unknown as EmbeddingService,
      createMockQdrant() as unknown as QdrantVectorService,
      repo as unknown as MemoryEntryRepository,
    );

    const result = await service.captureFromTurn('I left Company X', 'Noted.');

    expect(result.invalidated).toContain('existing-1');
    expect(store.update).toHaveBeenCalledWith('existing-1', { supersededBy: 'invalidated' });
  });

  it('supersedes old entry when contradiction resolver says keep_new', async () => {
    const existingEntry = makeEntry('old-1', 'fact', 'User name is Bob');
    const repo = createMockRepo();
    // First call for invalidations (returns empty), second for conflict check
    repo.query
      .mockResolvedValueOnce([]) // invalidations query
      .mockResolvedValueOnce([existingEntry]); // conflict check query

    const extraction: MemoryExtractionResult = {
      items: [{ kind: 'fact', content: 'User name is Alice', importance: 0.9 }],
      invalidations: [],
    };

    const contradictionResolver = createMockContradictionResolver();
    contradictionResolver.findConflicts.mockResolvedValue([
      {
        existingEntry,
        newContent: 'User name is Alice',
        isContradiction: true,
        resolution: { action: 'keep_new', reason: 'Name changed' },
      },
    ]);

    const store = createMockStore(repo);

    const service = new AutoCaptureService(
      createMockExtractor(extraction) as unknown as MemoryExtractorV2Service,
      store,
      contradictionResolver as unknown as ContradictionResolverService,
      createMockEmbeddingService() as unknown as EmbeddingService,
      createMockQdrant() as unknown as QdrantVectorService,
      repo as unknown as MemoryEntryRepository,
    );

    const result = await service.captureFromTurn('My name is Alice', 'Noted.', 'conv-1');

    expect(result.created).toHaveLength(1);
    expect(result.superseded).toContain('old-1');
    expect(store.supersede).toHaveBeenCalled();
  });

  it('discards new item when contradiction resolver says keep_old', async () => {
    const existingEntry = makeEntry('old-1', 'fact', 'User name is Bob');
    const repo = createMockRepo();
    repo.query.mockResolvedValue([existingEntry]);

    const extraction: MemoryExtractionResult = {
      items: [{ kind: 'fact', content: 'User name is Alice', importance: 0.9 }],
      invalidations: [],
    };

    const contradictionResolver = createMockContradictionResolver();
    contradictionResolver.findConflicts.mockResolvedValue([
      {
        existingEntry,
        newContent: 'User name is Alice',
        isContradiction: true,
        resolution: { action: 'keep_old', reason: 'Noise' },
      },
    ]);

    const service = new AutoCaptureService(
      createMockExtractor(extraction) as unknown as MemoryExtractorV2Service,
      createMockStore(repo),
      contradictionResolver as unknown as ContradictionResolverService,
      createMockEmbeddingService() as unknown as EmbeddingService,
      createMockQdrant() as unknown as QdrantVectorService,
      repo as unknown as MemoryEntryRepository,
    );

    const result = await service.captureFromTurn('My name is Alice', 'Noted.');

    expect(result.created).toHaveLength(0);
    expect(result.superseded).toHaveLength(0);
  });
});
