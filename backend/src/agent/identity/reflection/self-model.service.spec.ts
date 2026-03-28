import { SelfModelService } from './self-model.service';
import type { MemoryEntry } from '../../../memory/core/memory-entry.types';
import type { MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';

// ─── Helpers ────────────────────────────────────────────────────────────────

let entryCounter = 0;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  entryCounter++;
  return {
    id: `sm-entry-${entryCounter}`,
    scopeKey: 'local:default',
    kind: 'identity',
    content: `content ${entryCounter}`,
    source: 'llm_extraction',
    category: 'style',
    tags: [],
    importance: 0.8,
    horizon: 'long_term',
    decayRate: 0,
    pinned: false,
    accessCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createRepo(responses: { identity?: MemoryEntry[]; learning?: MemoryEntry[]; skill?: MemoryEntry[] } = {}) {
  const identity = responses.identity ?? [];
  const learning = responses.learning ?? [];
  const skill = responses.skill ?? [];

  return {
    query: jest.fn().mockImplementation((opts: { kinds?: string[] }) => {
      const kind = opts.kinds?.[0];
      if (kind === 'identity') return Promise.resolve(identity);
      if (kind === 'learning') return Promise.resolve(learning);
      if (kind === 'skill') return Promise.resolve(skill);
      return Promise.resolve([]);
    }),
  } as unknown as MemoryEntryRepository;
}

function buildService(responses: { identity?: MemoryEntry[]; learning?: MemoryEntry[]; skill?: MemoryEntry[] } = {}) {
  const repo = createRepo(responses);
  const service = new SelfModelService(repo);
  return { service, repo };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SelfModelService', () => {
  beforeEach(() => {
    entryCounter = 0;
  });

  it('returns empty summary when no entries exist', async () => {
    const { service } = buildService();
    const result = await service.buildSelfModelSummary('scope:user1');

    expect(result.strengths).toEqual([]);
    expect(result.improving).toEqual([]);
    expect(result.boundaries).toEqual([]);
    expect(result.style).toEqual([]);
    expect(result.values).toEqual([]);
    expect(result.raw).toBe('');
  });

  it('queries repo with correct kinds and scopeKey', async () => {
    const { service, repo } = buildService();
    await service.buildSelfModelSummary('scope:user1');

    expect((repo.query as jest.Mock)).toHaveBeenCalledTimes(3);
    expect((repo.query as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({
      kinds: ['identity'],
      scopeKey: 'scope:user1',
    }));
    expect((repo.query as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({
      kinds: ['learning'],
      scopeKey: 'scope:user1',
    }));
    expect((repo.query as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({
      kinds: ['skill'],
      scopeKey: 'scope:user1',
    }));
  });

  it('extracts strengths from expertise identity entries', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'expertise', content: 'Strong at TypeScript', importance: 0.9 }),
        makeEntry({ category: 'expertise', content: 'Good at system architecture', importance: 0.85 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.strengths).toContain('Strong at TypeScript');
    expect(result.strengths).toContain('Good at system architecture');
    expect(result.raw).toContain('Strong in:');
  });

  it('extracts strengths from skill entries', async () => {
    const { service } = buildService({
      skill: [
        makeEntry({ kind: 'skill', content: 'Can write NestJS services', importance: 0.9 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.strengths).toContain('Can write NestJS services');
  });

  it('extracts improving from weakness identity entries', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'weakness', content: 'Over-explains implementation details', importance: 0.7 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.improving).toContain('Over-explains implementation details');
    expect(result.raw).toContain('Improving:');
  });

  it('extracts improving from learning entries mentioning failures', async () => {
    const { service } = buildService({
      learning: [
        makeEntry({ kind: 'learning', content: 'The approach failed because of missing validation', importance: 0.8 }),
        makeEntry({ kind: 'learning', content: 'User prefers dark mode', importance: 0.6 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.improving).toContain('The approach failed because of missing validation');
    // "User prefers dark mode" should NOT be included (no failure keywords)
    expect(result.improving).not.toContain('User prefers dark mode');
  });

  it('extracts boundaries from boundary identity entries', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'boundary', content: 'Never use emoji', importance: 0.9 }),
        makeEntry({ category: 'boundary', content: 'Never start with apology', importance: 0.85 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.boundaries).toHaveLength(2);
    expect(result.raw).toContain('Watch out:');
  });

  it('extracts style from style and personality entries', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'style', content: 'Be concise', importance: 0.9 }),
        makeEntry({ category: 'personality', content: 'Direct and honest', importance: 0.85 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.style).toContain('Be concise');
    expect(result.style).toContain('Direct and honest');
    expect(result.raw).toContain('Communication style:');
  });

  it('extracts values from value identity entries', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'value', content: 'Accuracy over speed', importance: 0.9 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.values).toContain('Accuracy over speed');
    expect(result.raw).toContain('Priorities:');
  });

  it('renders a complete raw summary with all facets', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'expertise', content: 'TypeScript expert', importance: 0.9 }),
        makeEntry({ category: 'weakness', content: 'Tends to over-explain', importance: 0.8 }),
        makeEntry({ category: 'boundary', content: 'Never use filler words', importance: 0.85 }),
        makeEntry({ category: 'style', content: 'Be concise and direct', importance: 0.9 }),
        makeEntry({ category: 'value', content: 'Action over theory', importance: 0.85 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.raw).toContain('Strong in: TypeScript expert');
    expect(result.raw).toContain('Improving: Tends to over-explain');
    expect(result.raw).toContain('Watch out: Never use filler words');
    expect(result.raw).toContain('Communication style: Be concise and direct');
    expect(result.raw).toContain('Priorities: Action over theory');
  });

  it('deduplicates entries with same content', async () => {
    const { service } = buildService({
      identity: [
        makeEntry({ category: 'expertise', content: 'Good at TypeScript', importance: 0.9 }),
      ],
      skill: [
        makeEntry({ kind: 'skill', content: 'Good at TypeScript', importance: 0.85 }),
      ],
    });

    const result = await service.buildSelfModelSummary();

    expect(result.strengths).toHaveLength(1);
  });

  it('truncates raw summary to max length', async () => {
    const longEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ category: 'expertise', content: `Expert in domain area number ${i + 1} with extensive knowledge and detailed understanding`, importance: 0.9 - i * 0.01 }),
    );

    const { service } = buildService({ identity: longEntries });
    const result = await service.buildSelfModelSummary();

    expect(result.raw.length).toBeLessThanOrEqual(801); // 800 + ellipsis
  });

  it('handles repo failure gracefully', async () => {
    const repo = {
      query: jest.fn().mockRejectedValue(new Error('DB down')),
    } as unknown as MemoryEntryRepository;
    const service = new SelfModelService(repo);

    const result = await service.buildSelfModelSummary();

    expect(result.raw).toBe('');
    expect(result.strengths).toEqual([]);
  });
});

// ─── buildSelfModelSection integration ───────────────────────────────────────

describe('buildSelfModelSection', () => {
  const { buildSelfModelSection } = require('../../prompt/sections');

  it('returns empty array for empty raw string', () => {
    expect(buildSelfModelSection('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(buildSelfModelSection('   ')).toEqual([]);
  });

  it('renders self-model section with header', () => {
    const raw = 'Strong in: TypeScript\nImproving: conciseness';
    const section = buildSelfModelSection(raw);

    expect(section).toHaveLength(2);
    expect(section[0]).toContain('Self-awareness');
    expect(section[1]).toBe(raw);
  });
});
