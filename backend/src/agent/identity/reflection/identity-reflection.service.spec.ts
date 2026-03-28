import { IdentityReflectionService } from './identity-reflection.service';
import type { MemoryEntry } from '../../../memory/core/memory-entry.types';
import type { MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';

// ─── Helpers ────────────────────────────────────────────────────────────────

let entryCounter = 0;

function makeIdentityEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  entryCounter++;
  return {
    id: `id-refl-${entryCounter}`,
    scopeKey: 'local:default',
    kind: 'identity',
    content: `identity content ${entryCounter}`,
    source: 'llm_extraction',
    category: 'style',
    tags: ['identity', 'style'],
    importance: 0.85,
    horizon: 'long_term',
    decayRate: 0,
    pinned: false,
    accessCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createRepo(entries: MemoryEntry[] = []) {
  return {
    query: jest.fn().mockResolvedValue(entries),
    findByIds: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteBatch: jest.fn(),
  } as unknown as MemoryEntryRepository;
}

function createStore() {
  return {
    create: jest.fn().mockImplementation((params: any) =>
      Promise.resolve(makeIdentityEntry({
        kind: params.kind,
        content: params.content,
        category: params.category,
      })),
    ),
    update: jest.fn().mockResolvedValue(undefined),
    supersede: jest.fn(),
    recordAccess: jest.fn().mockResolvedValue(undefined),
  };
}

function createLlmService(response: string) {
  return {
    complete: jest.fn().mockResolvedValue({ content: response }),
  };
}

function buildService(options: {
  entries?: MemoryEntry[];
  llmResponse?: string;
  llmAvailable?: boolean;
} = {}) {
  const entries = options.entries ?? [];
  const repo = createRepo(entries);
  const store = createStore();
  const llm = options.llmAvailable !== false && options.llmResponse
    ? createLlmService(options.llmResponse)
    : undefined;

  const service = new IdentityReflectionService(repo, store as any, llm as any);
  return { service, repo, store, llm };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('IdentityReflectionService', () => {
  beforeEach(() => {
    entryCounter = 0;
  });

  it('returns zero counts when no identity entries exist', async () => {
    const { service } = buildService({ entries: [] });
    const result = await service.reflect('scope:user1');

    expect(result).toEqual({
      contradictionsResolved: 0,
      consolidated: 0,
      promoted: 0,
      pruned: 0,
    });
  });

  it('queries repo with identity kind and scopeKey', async () => {
    const { service, repo } = buildService({ entries: [] });
    await service.reflect('scope:user1');

    expect((repo.query as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({
      kinds: ['identity'],
      excludeSuperseded: true,
      scopeKey: 'scope:user1',
    }));
  });

  it('queries without scopeKey when none provided', async () => {
    const { service, repo } = buildService({ entries: [] });
    await service.reflect();

    const call = (repo.query as jest.Mock).mock.calls[0]![0];
    expect(call.scopeKey).toBeUndefined();
  });

  describe('contradiction resolution', () => {
    it('resolves contradictions via LLM', async () => {
      const entries = [
        makeIdentityEntry({ id: 'trait-1', category: 'style', content: 'Be verbose and detailed' }),
        makeIdentityEntry({ id: 'trait-2', category: 'style', content: 'Be concise and brief' }),
      ];

      const { service, store } = buildService({
        entries,
        llmResponse: '{"remove_ids": ["trait-1"]}',
      });

      const result = await service.reflect();

      expect(result.contradictionsResolved).toBe(1);
      expect(store.update).toHaveBeenCalledWith('trait-1', { supersededBy: 'contradiction_resolved' });
    });

    it('skips contradiction resolution when LLM is unavailable', async () => {
      const entries = [
        makeIdentityEntry({ category: 'style', content: 'Be verbose' }),
        makeIdentityEntry({ category: 'style', content: 'Be concise' }),
      ];

      const { service } = buildService({ entries, llmAvailable: false });
      const result = await service.reflect();

      expect(result.contradictionsResolved).toBe(0);
    });

    it('ignores invalid IDs in contradiction result', async () => {
      const entries = [
        makeIdentityEntry({ id: 'trait-1', category: 'style', content: 'A' }),
        makeIdentityEntry({ id: 'trait-2', category: 'style', content: 'B' }),
      ];

      const { service, store } = buildService({
        entries,
        llmResponse: '{"remove_ids": ["fake-id", "trait-1"]}',
      });

      const result = await service.reflect();

      expect(result.contradictionsResolved).toBe(1);
      expect(store.update).toHaveBeenCalledWith('trait-1', { supersededBy: 'contradiction_resolved' });
    });

    it('handles LLM returning no contradictions', async () => {
      const entries = [
        makeIdentityEntry({ category: 'style', content: 'Be clear' }),
        makeIdentityEntry({ category: 'style', content: 'Use examples' }),
      ];

      const { service } = buildService({
        entries,
        llmResponse: '{"remove_ids": []}',
      });

      const result = await service.reflect();
      expect(result.contradictionsResolved).toBe(0);
    });
  });

  describe('consolidation', () => {
    it('consolidates categories with 3+ entries', async () => {
      const entries = [
        makeIdentityEntry({ category: 'style', content: 'Trait A', importance: 0.5 }),
        makeIdentityEntry({ category: 'style', content: 'Trait B', importance: 0.6 }),
        makeIdentityEntry({ category: 'style', content: 'Trait C', importance: 0.9 }),
      ];

      const { service, store } = buildService({
        entries,
        llmResponse: 'Merged trait combining A and B',
      });

      const result = await service.reflect();

      // 2 entries consolidated (the 2 weakest), strongest kept
      expect(result.consolidated).toBe(2);
      expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'identity',
        content: 'Merged trait combining A and B',
        source: 'consolidation',
      }));
    });

    it('skips consolidation when fewer than 3 entries in a category', async () => {
      const entries = [
        makeIdentityEntry({ category: 'boundary', content: 'Never apologize' }),
        makeIdentityEntry({ category: 'boundary', content: 'Never use emoji' }),
      ];

      const { service } = buildService({ entries });
      const result = await service.reflect();

      expect(result.consolidated).toBe(0);
    });

    it('uses heuristic fallback when LLM is unavailable', async () => {
      const entries = [
        makeIdentityEntry({ category: 'value', content: 'Low importance', importance: 0.3 }),
        makeIdentityEntry({ category: 'value', content: 'Medium importance', importance: 0.6 }),
        makeIdentityEntry({ category: 'value', content: 'High importance', importance: 0.9 }),
      ];

      const { service, store } = buildService({ entries, llmAvailable: false });
      const result = await service.reflect();

      expect(result.consolidated).toBe(2);
      // Heuristic picks most important content
      expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Medium importance', // most important of the 2 consolidated
      }));
    });
  });

  describe('promotion', () => {
    it('promotes identity traits with high access count', async () => {
      const entries = [
        makeIdentityEntry({ accessCount: 5, horizon: 'short_term', importance: 0.8 }),
      ];

      const { service, store } = buildService({ entries });
      const result = await service.reflect();

      expect(result.promoted).toBe(1);
      expect(store.update).toHaveBeenCalledWith(entries[0]!.id, expect.objectContaining({
        horizon: 'long_term',
      }));
    });

    it('does not promote pinned entries', async () => {
      const entries = [
        makeIdentityEntry({ accessCount: 10, horizon: 'short_term', pinned: true }),
      ];

      const { service } = buildService({ entries });
      const result = await service.reflect();

      expect(result.promoted).toBe(0);
    });

    it('does not promote entries with low access count', async () => {
      const entries = [
        makeIdentityEntry({ accessCount: 1, horizon: 'short_term' }),
      ];

      const { service } = buildService({ entries });
      const result = await service.reflect();

      expect(result.promoted).toBe(0);
    });
  });

  describe('pruning', () => {
    it('prunes low-importance traits with zero access', async () => {
      const entries = [
        makeIdentityEntry({ importance: 0.2, accessCount: 0 }),
      ];

      const { service, store } = buildService({ entries });
      const result = await service.reflect();

      expect(result.pruned).toBe(1);
      expect(store.update).toHaveBeenCalledWith(entries[0]!.id, { supersededBy: 'pruned_weak' });
    });

    it('does not prune pinned entries', async () => {
      const entries = [
        makeIdentityEntry({ importance: 0.1, accessCount: 0, pinned: true }),
      ];

      const { service } = buildService({ entries });
      const result = await service.reflect();

      expect(result.pruned).toBe(0);
    });

    it('does not prune entries with access', async () => {
      const entries = [
        makeIdentityEntry({ importance: 0.2, accessCount: 2 }),
      ];

      const { service } = buildService({ entries });
      const result = await service.reflect();

      expect(result.pruned).toBe(0);
    });
  });

  describe('error handling', () => {
    it('handles repo failure gracefully', async () => {
      const repo = {
        query: jest.fn().mockRejectedValue(new Error('DB down')),
      } as unknown as MemoryEntryRepository;
      const store = createStore();
      const service = new IdentityReflectionService(repo, store as any);

      const result = await service.reflect();

      expect(result).toEqual({
        contradictionsResolved: 0,
        consolidated: 0,
        promoted: 0,
        pruned: 0,
      });
    });
  });
});
