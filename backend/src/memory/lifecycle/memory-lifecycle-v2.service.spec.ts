import type { LlmService } from '../../llm/llm.service';
import type { MemoryEntry } from '../core/memory-entry.types';
import type { MemoryEntryRepository } from '../core/memory-entry.repository';
import type { MemoryStoreService } from '../core/memory-store.service';
import type { QdrantVectorService } from '../qdrant/qdrant-vector.service';
import { MemoryLifecycleV2Service } from './memory-lifecycle-v2.service';

const makeEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `entry-${Math.random().toString(36).slice(2, 8)}`,
  scopeKey: 'local:default',
  kind: 'fact',
  content: 'test content',
  tags: [],
  source: 'llm_extraction',
  horizon: 'short_term',
  importance: 0.5,
  decayRate: 0.05,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
  ...overrides,
});

function createMocks() {
  const store = {
    create: jest.fn().mockImplementation(async (params) => makeEntry({ ...params, id: 'new-' + Date.now() })),
    update: jest.fn().mockImplementation(async (id, params) => makeEntry({ id, ...params })),
    delete: jest.fn().mockResolvedValue(true),
    query: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    getById: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MemoryStoreService>;

  const repo = {
    query: jest.fn().mockResolvedValue([]),
    deleteBatch: jest.fn().mockResolvedValue(0),
    save: jest.fn(),
    saveBatch: jest.fn(),
    findById: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue(true),
    incrementAccessCount: jest.fn(),
  } as unknown as jest.Mocked<MemoryEntryRepository>;

  const qdrant = {
    isReady: jest.fn().mockReturnValue(true),
    deletePoints: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<QdrantVectorService>;

  return { store, repo, qdrant };
}

describe('MemoryLifecycleV2Service', () => {
  describe('applyDecay', () => {
    it('decays importance of old short_term entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
      const entry = makeEntry({ id: 'e1', importance: 0.5, decayRate: 0.05, updatedAt: oldDate });
      (repo.query as jest.Mock).mockResolvedValue([entry]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyDecay();

      expect(count).toBe(1);
      expect(store.update).toHaveBeenCalledWith('e1', expect.objectContaining({
        importance: expect.any(Number),
      }));
      const updatedImportance = (store.update as jest.Mock).mock.calls[0][1].importance;
      expect(updatedImportance).toBeLessThan(0.5);
      expect(updatedImportance).toBeGreaterThan(0);
    });

    it('skips pinned entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({ pinned: true, updatedAt: oldDate });
      (repo.query as jest.Mock).mockResolvedValue([entry]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyDecay();

      expect(count).toBe(0);
      expect(store.update).not.toHaveBeenCalled();
    });

    it('skips entries with zero decay rate', async () => {
      const { store, repo, qdrant } = createMocks();
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({ decayRate: 0, updatedAt: oldDate });
      (repo.query as jest.Mock).mockResolvedValue([entry]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyDecay();

      expect(count).toBe(0);
    });

    it('skips recent entries (< 1 day)', async () => {
      const { store, repo, qdrant } = createMocks();
      const entry = makeEntry({ updatedAt: new Date().toISOString() });
      (repo.query as jest.Mock).mockResolvedValue([entry]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyDecay();

      expect(count).toBe(0);
    });

    it('applies access recency bonus', async () => {
      const { store, repo, qdrant } = createMocks();
      const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const recentAccess = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const entryWithAccess = makeEntry({
        id: 'e-access',
        importance: 0.5,
        decayRate: 0.05,
        updatedAt: oldDate,
        accessCount: 3,
        lastAccessedAt: recentAccess,
      });
      const entryWithout = makeEntry({
        id: 'e-no-access',
        importance: 0.5,
        decayRate: 0.05,
        updatedAt: oldDate,
        accessCount: 0,
      });
      (repo.query as jest.Mock).mockResolvedValue([entryWithAccess, entryWithout]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      await service.applyDecay();

      const call1 = (store.update as jest.Mock).mock.calls.find((c: unknown[]) => c[0] === 'e-access');
      const call2 = (store.update as jest.Mock).mock.calls.find((c: unknown[]) => c[0] === 'e-no-access');
      expect(call1![1].importance).toBeGreaterThan(call2![1].importance);
    });
  });

  describe('applyPromotion', () => {
    it('promotes frequently accessed important entries to long_term', async () => {
      const { store, repo, qdrant } = createMocks();
      const entry = makeEntry({
        id: 'e1',
        horizon: 'short_term',
        importance: 0.7,
        accessCount: 6,
      });
      (repo.query as jest.Mock).mockResolvedValue([entry]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyPromotion();

      expect(count).toBe(1);
      expect(store.update).toHaveBeenCalledWith('e1', { horizon: 'long_term' });
    });

    it('does not promote entries with low access count', async () => {
      const { store, repo, qdrant } = createMocks();
      const entry = makeEntry({
        importance: 0.7,
        accessCount: 2,
      });
      (repo.query as jest.Mock).mockResolvedValue([entry]);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyPromotion();

      expect(count).toBe(0);
    });
  });

  describe('applyConsolidation', () => {
    it('consolidates groups of 3+ entries heuristically', async () => {
      const { store, repo, qdrant } = createMocks();
      const entries = [
        makeEntry({ id: 'e1', kind: 'fact', category: 'tech', horizon: 'long_term', importance: 0.5, updatedAt: '2025-01-01T00:00:00Z', content: 'Uses TypeScript' }),
        makeEntry({ id: 'e2', kind: 'fact', category: 'tech', horizon: 'long_term', importance: 0.7, updatedAt: '2025-01-02T00:00:00Z', content: 'Uses NestJS' }),
        makeEntry({ id: 'e3', kind: 'fact', category: 'tech', horizon: 'long_term', importance: 0.6, updatedAt: '2025-01-03T00:00:00Z', content: 'Prefers strict mode' }),
      ];
      (repo.query as jest.Mock).mockResolvedValue(entries);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyConsolidation();

      expect(count).toBe(2); // 2 entries consolidated (oldest 2), newest kept
      expect(store.create).toHaveBeenCalledTimes(1);
      expect(store.update).toHaveBeenCalledTimes(2); // mark 2 as superseded
    });

    it('uses LLM when available', async () => {
      const { store, repo, qdrant } = createMocks();
      const llm = {
        complete: jest.fn().mockResolvedValue({ content: 'Consolidated: uses TypeScript and NestJS' }),
      } as unknown as LlmService;

      const entries = [
        makeEntry({ id: 'e1', kind: 'fact', category: 'tech', horizon: 'long_term', updatedAt: '2025-01-01T00:00:00Z' }),
        makeEntry({ id: 'e2', kind: 'fact', category: 'tech', horizon: 'long_term', updatedAt: '2025-01-02T00:00:00Z' }),
        makeEntry({ id: 'e3', kind: 'fact', category: 'tech', horizon: 'long_term', updatedAt: '2025-01-03T00:00:00Z' }),
      ];
      (repo.query as jest.Mock).mockResolvedValue(entries);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant, llm);
      const count = await service.applyConsolidation();

      expect(count).toBe(2);
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it('skips pinned entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const entries = [
        makeEntry({ id: 'e1', kind: 'fact', horizon: 'long_term', pinned: true }),
        makeEntry({ id: 'e2', kind: 'fact', horizon: 'long_term', pinned: true }),
        makeEntry({ id: 'e3', kind: 'fact', horizon: 'long_term', pinned: true }),
      ];
      (repo.query as jest.Mock).mockResolvedValue(entries);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyConsolidation();

      expect(count).toBe(0);
    });

    it('skips groups with fewer than 3 entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const entries = [
        makeEntry({ id: 'e1', kind: 'fact', horizon: 'long_term' }),
        makeEntry({ id: 'e2', kind: 'fact', horizon: 'long_term' }),
      ];
      (repo.query as jest.Mock).mockResolvedValue(entries);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyConsolidation();

      expect(count).toBe(0);
    });
  });

  describe('applyPruning', () => {
    it('removes old superseded entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
      const entries = [
        makeEntry({ id: 's1', supersededBy: 'new-1', updatedAt: oldDate }),
        makeEntry({ id: 's2', supersededBy: 'new-2', updatedAt: oldDate }),
      ];
      (repo.query as jest.Mock).mockImplementation(async (q) => {
        if (q.horizons) return []; // for low importance query
        return entries; // for superseded query
      });
      (repo.deleteBatch as jest.Mock).mockResolvedValue(2);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyPruning();

      expect(count).toBe(2);
      expect(repo.deleteBatch).toHaveBeenCalledWith(['s1', 's2']);
      expect(qdrant.deletePoints).toHaveBeenCalledWith(['s1', 's2']);
    });

    it('removes near-zero importance short_term entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const entries = [
        makeEntry({ id: 'low1', horizon: 'short_term', importance: 0.01 }),
        makeEntry({ id: 'low2', horizon: 'short_term', importance: 0.03 }),
      ];
      (repo.query as jest.Mock).mockImplementation(async (q) => {
        if (q.horizons) return entries;
        return [];
      });
      (repo.deleteBatch as jest.Mock).mockResolvedValue(2);

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyPruning();

      expect(count).toBe(2);
    });

    it('does not prune pinned entries', async () => {
      const { store, repo, qdrant } = createMocks();
      const entries = [
        makeEntry({ id: 'pinned1', horizon: 'short_term', importance: 0.01, pinned: true }),
      ];
      (repo.query as jest.Mock).mockImplementation(async (q) => {
        if (q.horizons) return entries;
        return [];
      });

      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyPruning();

      expect(count).toBe(0);
    });

    it('returns 0 when nothing to prune', async () => {
      const { store, repo, qdrant } = createMocks();
      const service = new MemoryLifecycleV2Service(store, repo, qdrant);
      const count = await service.applyPruning();
      expect(count).toBe(0);
    });
  });

  describe('runFullCycle', () => {
    it('runs all 4 phases and returns summary', async () => {
      const { store, repo, qdrant } = createMocks();
      const service = new MemoryLifecycleV2Service(store, repo, qdrant);

      const result = await service.runFullCycle();

      expect(result).toEqual({
        decayed: 0,
        promoted: 0,
        consolidated: 0,
        pruned: 0,
      });
    });
  });
});
