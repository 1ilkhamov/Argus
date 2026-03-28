import type { MemoryEntry } from '../../core/memory-entry.types';
import type { KnowledgeGraphService } from '../knowledge-graph.service';
import { KgAutoUpdateService } from './kg-auto-update.service';

const makeEntry = (id: string, kind: MemoryEntry['kind'], content: string): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind,
  content,
  tags: [],
  source: 'llm_extraction',
  horizon: 'long_term',
  importance: 0.7,
  decayRate: 0,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
});

const createMockKgService = () => ({
  extractAndUpsert: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
}) as unknown as KnowledgeGraphService;

describe('KgAutoUpdateService', () => {
  it('processes extractable entries', async () => {
    const kgService = createMockKgService();
    const service = new KgAutoUpdateService(kgService);

    await service.processEntries([
      makeEntry('e1', 'fact', 'User works at Google as a senior engineer'),
      makeEntry('e2', 'episode', 'Decided to migrate the backend to NestJS'),
    ]);

    expect(kgService.extractAndUpsert).toHaveBeenCalledTimes(2);
  });

  it('skips non-extractable kinds', async () => {
    const kgService = createMockKgService();
    const service = new KgAutoUpdateService(kgService);

    await service.processEntries([
      makeEntry('e1', 'action', 'Ran web_search for NestJS patterns'),
      makeEntry('e2', 'preference', 'User prefers dark mode'),
    ]);

    // action is extractable, preference is not
    expect(kgService.extractAndUpsert).toHaveBeenCalledTimes(0);
  });

  it('skips entries with short content', async () => {
    const kgService = createMockKgService();
    const service = new KgAutoUpdateService(kgService);

    await service.processEntries([
      makeEntry('e1', 'fact', 'short'),
    ]);

    expect(kgService.extractAndUpsert).not.toHaveBeenCalled();
  });

  it('includes tags in extraction text', async () => {
    const kgService = createMockKgService();
    const service = new KgAutoUpdateService(kgService);

    const entry = makeEntry('e1', 'fact', 'User uses TypeScript for all projects');
    entry.tags = ['typescript', 'programming'];
    entry.category = 'technical';

    await service.processEntries([entry]);

    expect(kgService.extractAndUpsert).toHaveBeenCalledWith(
      expect.stringContaining('typescript'),
    );
    expect(kgService.extractAndUpsert).toHaveBeenCalledWith(
      expect.stringContaining('technical'),
    );
  });

  it('handles extraction errors gracefully', async () => {
    const kgService = createMockKgService();
    (kgService.extractAndUpsert as jest.Mock).mockRejectedValue(new Error('DB down'));
    const service = new KgAutoUpdateService(kgService);

    // Should not throw
    await expect(
      service.processEntries([
        makeEntry('e1', 'fact', 'User works at a large company'),
      ]),
    ).resolves.not.toThrow();
  });

  it('processes a single entry via processEntry', async () => {
    const kgService = createMockKgService();
    const service = new KgAutoUpdateService(kgService);

    await service.processEntry(
      makeEntry('e1', 'learning', 'Fire-and-forget pattern works well for non-blocking captures'),
    );

    expect(kgService.extractAndUpsert).toHaveBeenCalledTimes(1);
  });

  it('does nothing for empty entries array', async () => {
    const kgService = createMockKgService();
    const service = new KgAutoUpdateService(kgService);

    await service.processEntries([]);

    expect(kgService.extractAndUpsert).not.toHaveBeenCalled();
  });
});
