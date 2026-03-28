import { IdentityRecallService } from './identity-recall.service';
import type { MemoryEntry } from '../../../memory/core/memory-entry.types';
import type { MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';

// ─── Helpers ────────────────────────────────────────────────────────────────

let entryCounter = 0;

function makeIdentityEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  entryCounter++;
  return {
    id: `id-entry-${entryCounter}`,
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
    accessCount: 0,
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
  } as unknown as MemoryEntryRepository;
}

function createStore() {
  return {
    recordAccess: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
    update: jest.fn(),
    supersede: jest.fn(),
  };
}

function buildService(entries: MemoryEntry[] = []) {
  const repo = createRepo(entries);
  const store = createStore();
  const service = new IdentityRecallService(repo, store as any);
  return { service, repo, store };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('IdentityRecallService', () => {
  beforeEach(() => {
    entryCounter = 0;
  });

  it('returns empty traits when no identity entries exist', async () => {
    const { service } = buildService([]);
    const result = await service.recall('scope:user1');

    expect(result.traits).toEqual([]);
  });

  it('returns all identity entries for a scope', async () => {
    const entries = [
      makeIdentityEntry({ category: 'style', content: 'Be concise' }),
      makeIdentityEntry({ category: 'boundary', content: 'Never apologize' }),
    ];

    const { service, repo } = buildService(entries);
    const result = await service.recall('scope:user1');

    expect(result.traits).toHaveLength(2);
    expect((repo.query as jest.Mock)).toHaveBeenCalledWith({
      kinds: ['identity'],
      excludeSuperseded: true,
      limit: 20,
      scopeKey: 'scope:user1',
    });
  });

  it('queries without scopeKey when none provided', async () => {
    const { service, repo } = buildService([]);
    await service.recall();

    expect((repo.query as jest.Mock)).toHaveBeenCalledWith({
      kinds: ['identity'],
      excludeSuperseded: true,
      limit: 20,
    });
  });

  it('sorts by category priority (boundary before style before expertise)', async () => {
    const entries = [
      makeIdentityEntry({ category: 'expertise', content: 'Good at TypeScript', importance: 0.9 }),
      makeIdentityEntry({ category: 'boundary', content: 'Never use emoji', importance: 0.7 }),
      makeIdentityEntry({ category: 'style', content: 'Be concise', importance: 0.8 }),
    ];

    const { service } = buildService(entries);
    const result = await service.recall('scope:user1');

    expect(result.traits[0]!.category).toBe('boundary');
    expect(result.traits[1]!.category).toBe('style');
    expect(result.traits[2]!.category).toBe('expertise');
  });

  it('sorts by importance within same category', async () => {
    const entries = [
      makeIdentityEntry({ category: 'style', content: 'Low importance', importance: 0.5 }),
      makeIdentityEntry({ category: 'style', content: 'High importance', importance: 0.95 }),
    ];

    const { service } = buildService(entries);
    const result = await service.recall();

    expect(result.traits[0]!.entry.content).toBe('High importance');
    expect(result.traits[1]!.entry.content).toBe('Low importance');
  });

  it('records access for lifecycle promotion', async () => {
    const entries = [
      makeIdentityEntry({ id: 'trait-1' }),
      makeIdentityEntry({ id: 'trait-2' }),
    ];

    const { service, store } = buildService(entries);
    await service.recall('scope:user1');

    expect(store.recordAccess).toHaveBeenCalledWith(['trait-1', 'trait-2']);
  });

  it('does not record access when no entries found', async () => {
    const { service, store } = buildService([]);
    await service.recall();

    expect(store.recordAccess).not.toHaveBeenCalled();
  });

  it('handles repo failure gracefully', async () => {
    const repo = {
      query: jest.fn().mockRejectedValue(new Error('DB down')),
    } as unknown as MemoryEntryRepository;
    const store = createStore();
    const service = new IdentityRecallService(repo, store as any);

    const result = await service.recall('scope:user1');

    expect(result.traits).toEqual([]);
  });

  it('defaults category to personality when entry has no category', async () => {
    const entries = [
      makeIdentityEntry({ category: undefined }),
    ];

    const { service } = buildService(entries);
    const result = await service.recall();

    expect(result.traits[0]!.category).toBe('personality');
  });
});

// ─── buildIdentitySection integration ────────────────────────────────────────

describe('buildIdentitySection', () => {
  // Import lazily to avoid circular dependency issues
  const { buildIdentitySection } = require('../../prompt/sections');

  it('returns empty array when no traits', () => {
    expect(buildIdentitySection([])).toEqual([]);
  });

  it('renders traits grouped by category', () => {
    const traits = [
      { entry: makeIdentityEntry({ category: 'boundary', content: 'Never use emoji' }), category: 'boundary' as const },
      { entry: makeIdentityEntry({ category: 'style', content: 'Be concise' }), category: 'style' as const },
      { entry: makeIdentityEntry({ category: 'style', content: 'Use bullet points' }), category: 'style' as const },
    ];

    const section = buildIdentitySection(traits);

    expect(section).toContain('Evolved identity traits (3 learned from interaction):');
    expect(section).toContain('[boundary]: Never use emoji');
    expect(section).toContain('[style]: Be concise; Use bullet points');
    expect(section.some((line: string) => line.includes('These identity traits are learned from past interactions'))).toBe(true);
  });

  it('includes augmentation note to prevent overriding invariants', () => {
    const traits = [
      { entry: makeIdentityEntry({ category: 'personality', content: 'Be warm' }), category: 'personality' as const },
    ];

    const section = buildIdentitySection(traits);

    expect(section.some((line: string) => line.includes('augment (never override)'))).toBe(true);
  });
});
