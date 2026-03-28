import type { MemoryEntry, RecalledMemory } from '../core/memory-entry.types';
import {
  type RankedCandidate,
  mergeRecallResults,
  normalizeScores,
  assignConfidence,
  detectContradictions,
  applyDiversityFilter,
  computeCompositeScore,
  scoreToConfidence,
  _testing,
} from './recall-merger';

const makeEntry = (id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind: 'fact',
  content: `content-${id}`,
  tags: [],
  source: 'llm_extraction',
  horizon: 'long_term',
  importance: 0.5,
  decayRate: 0.01,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
  ...overrides,
});

const makeCandidate = (id: string, score: number, source: RankedCandidate['source'], overrides: Partial<MemoryEntry> = {}): RankedCandidate => ({
  entry: makeEntry(id, overrides),
  score,
  source,
});

const makeRecalled = (id: string, score: number, overrides: Partial<MemoryEntry> = {}): RecalledMemory => ({
  entry: makeEntry(id, overrides),
  score,
  matchSource: 'semantic',
  confidence: 'medium',
});

describe('recall-merger', () => {
  // ─── mergeRecallResults ────────────────────────────────────────────────

  describe('mergeRecallResults', () => {
    it('returns empty array for empty input', () => {
      expect(mergeRecallResults([])).toEqual([]);
    });

    it('merges a single ranked list preserving order', () => {
      const list: RankedCandidate[] = [
        makeCandidate('a', 0.9, 'semantic'),
        makeCandidate('b', 0.7, 'semantic'),
        makeCandidate('c', 0.5, 'semantic'),
      ];

      const result = mergeRecallResults([list]);

      expect(result).toHaveLength(3);
      expect(result[0]!.entry.id).toBe('a');
      expect(result[1]!.entry.id).toBe('b');
      expect(result[2]!.entry.id).toBe('c');
    });

    it('merges two lists and boosts entries appearing in both', () => {
      const semantic: RankedCandidate[] = [
        makeCandidate('a', 0.9, 'semantic'),
        makeCandidate('b', 0.7, 'semantic'),
      ];
      const keyword: RankedCandidate[] = [
        makeCandidate('b', 0.8, 'keyword'),
        makeCandidate('c', 0.6, 'keyword'),
      ];

      const result = mergeRecallResults([semantic, keyword]);

      const bResult = result.find((r) => r.entry.id === 'b');
      expect(bResult).toBeDefined();
      expect(bResult!.matchSource).toBe('merged');

      const aResult = result.find((r) => r.entry.id === 'a');
      expect(bResult!.score).toBeGreaterThan(aResult!.score);
    });

    it('respects the limit option', () => {
      const list: RankedCandidate[] = Array.from({ length: 10 }, (_, i) =>
        makeCandidate(`e${i}`, 1 - i * 0.1, 'semantic'),
      );

      const result = mergeRecallResults([list], { limit: 3 });

      expect(result).toHaveLength(3);
    });

    it('filters by minScore', () => {
      const list: RankedCandidate[] = [
        makeCandidate('a', 0.9, 'semantic'),
      ];

      const result = mergeRecallResults([list], { minScore: 100 });

      expect(result).toHaveLength(0);
    });

    it('populates confidence field (placeholder before normalization)', () => {
      const list: RankedCandidate[] = [makeCandidate('a', 0.9, 'semantic')];
      const result = mergeRecallResults([list]);

      expect(result[0]!.confidence).toBe('medium');
    });
  });

  // ─── computeCompositeScore ─────────────────────────────────────────────

  describe('computeCompositeScore', () => {
    const now = Date.now();
    const baseRRF = 1 / 61; // rank 0, k=60

    it('does not decay facts (infinite half-life)', () => {
      const oldFact = makeEntry('f', {
        kind: 'fact',
        createdAt: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year old
      });
      const score = computeCompositeScore(oldFact, baseRRF, now);
      // kindDecayFactor should be 1.0 for facts
      const expected = baseRRF * 1.0 * 1.0 * (1.0 + (0.5 - 0.5) * _testing.IMPORTANCE_SPREAD) * 1.0;
      expect(score).toBeCloseTo(expected, 10);
    });

    it('decays episodes with 14-day half-life', () => {
      const freshEpisode = makeEntry('e1', {
        kind: 'episode',
        createdAt: new Date(now).toISOString(),
      });
      const oldEpisode = makeEntry('e2', {
        kind: 'episode',
        createdAt: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days old
      });

      const freshScore = computeCompositeScore(freshEpisode, baseRRF, now);
      const oldScore = computeCompositeScore(oldEpisode, baseRRF, now);

      // Old episode (at half-life) should be ~half the score
      expect(oldScore).toBeCloseTo(freshScore * 0.5, 4);
    });

    it('decays actions with 7-day half-life', () => {
      const freshAction = makeEntry('a1', { kind: 'action', createdAt: new Date(now).toISOString() });
      const oldAction = makeEntry('a2', { kind: 'action', createdAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString() });

      const freshScore = computeCompositeScore(freshAction, baseRRF, now);
      const oldScore = computeCompositeScore(oldAction, baseRRF, now);

      expect(oldScore).toBeCloseTo(freshScore * 0.5, 4);
    });

    it('boosts recently accessed entries', () => {
      const recentlyAccessed = makeEntry('ra', {
        lastAccessedAt: new Date(now - 1000).toISOString(), // 1 sec ago
      });
      const neverAccessed = makeEntry('na');

      const boostedScore = computeCompositeScore(recentlyAccessed, baseRRF, now);
      const normalScore = computeCompositeScore(neverAccessed, baseRRF, now);

      expect(boostedScore).toBeGreaterThan(normalScore);
    });

    it('does not boost entries accessed more than 24h ago', () => {
      const oldAccess = makeEntry('oa', {
        lastAccessedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      });
      const neverAccessed = makeEntry('na');

      const s1 = computeCompositeScore(oldAccess, baseRRF, now);
      const s2 = computeCompositeScore(neverAccessed, baseRRF, now);

      expect(s1).toBeCloseTo(s2, 10);
    });

    it('high importance scores higher than low importance', () => {
      const high = makeEntry('hi', { importance: 1.0 });
      const low = makeEntry('lo', { importance: 0.0 });

      const highScore = computeCompositeScore(high, baseRRF, now);
      const lowScore = computeCompositeScore(low, baseRRF, now);

      expect(highScore).toBeGreaterThan(lowScore);
    });

    it('pinned entries get 1.5x boost', () => {
      const pinned = makeEntry('p', { pinned: true });
      const unpinned = makeEntry('u', { pinned: false });

      const pinnedScore = computeCompositeScore(pinned, baseRRF, now);
      const unpinnedScore = computeCompositeScore(unpinned, baseRRF, now);

      expect(pinnedScore).toBeCloseTo(unpinnedScore * _testing.PINNED_BOOST, 10);
    });
  });

  // ─── normalizeScores ───────────────────────────────────────────────────

  describe('normalizeScores', () => {
    it('returns empty for empty input', () => {
      expect(normalizeScores([])).toEqual([]);
    });

    it('normalizes so top score is 1.0', () => {
      const memories: RecalledMemory[] = [
        makeRecalled('a', 0.8),
        makeRecalled('b', 0.4),
      ];

      const result = normalizeScores(memories);

      expect(result[0]!.score).toBe(1.0);
      expect(result[1]!.score).toBe(0.5);
    });
  });

  // ─── assignConfidence ──────────────────────────────────────────────────

  describe('assignConfidence', () => {
    it('assigns high for score >= 0.6', () => {
      const result = assignConfidence([makeRecalled('a', 0.8)]);
      expect(result[0]!.confidence).toBe('high');
    });

    it('assigns medium for score >= 0.3 and < 0.6', () => {
      const result = assignConfidence([makeRecalled('a', 0.4)]);
      expect(result[0]!.confidence).toBe('medium');
    });

    it('assigns low for score < 0.3', () => {
      const result = assignConfidence([makeRecalled('a', 0.1)]);
      expect(result[0]!.confidence).toBe('low');
    });

    it('assigns boundary values correctly', () => {
      expect(scoreToConfidence(0.6)).toBe('high');
      expect(scoreToConfidence(0.3)).toBe('medium');
      expect(scoreToConfidence(0.29)).toBe('low');
    });
  });

  // ─── detectContradictions ──────────────────────────────────────────────

  describe('detectContradictions', () => {
    it('returns unchanged for single entry', () => {
      const input = [makeRecalled('a', 0.9)];
      const result = detectContradictions(input);
      expect(result).toEqual(input);
    });

    it('detects contradiction between same-kind same-category entries with different content', () => {
      const a = makeRecalled('a', 0.9, {
        kind: 'fact',
        category: 'identity',
        content: 'User works at NovaTech',
      });
      const b = makeRecalled('b', 0.8, {
        kind: 'fact',
        category: 'identity',
        content: 'User works at CloudBase',
      });

      const result = detectContradictions([a, b]);

      expect(result[0]!.contradicts).toContain('b');
      expect(result[1]!.contradicts).toContain('a');
    });

    it('does not flag contradiction for entries with very different categories', () => {
      const a = makeRecalled('a', 0.9, {
        kind: 'fact',
        category: 'identity',
        content: 'User name is Alex',
      });
      const b = makeRecalled('b', 0.8, {
        kind: 'fact',
        category: 'technical',
        content: 'Uses TypeScript and NestJS',
      });

      const result = detectContradictions([a, b]);

      expect(result[0]!.contradicts).toBeUndefined();
      expect(result[1]!.contradicts).toBeUndefined();
    });

    it('does not flag contradiction for entries with high content overlap (similar, not contradictory)', () => {
      const a = makeRecalled('a', 0.9, {
        kind: 'fact',
        category: 'identity',
        content: 'User works at CloudBase as developer',
      });
      const b = makeRecalled('b', 0.8, {
        kind: 'fact',
        category: 'identity',
        content: 'User works at CloudBase as senior developer',
      });

      const result = detectContradictions([a, b]);

      // High overlap → not contradiction (they agree)
      expect(result[0]!.contradicts).toBeUndefined();
    });

    it('skips entries without category', () => {
      const a = makeRecalled('a', 0.9, { kind: 'fact', content: 'some content' });
      const b = makeRecalled('b', 0.8, { kind: 'fact', content: 'other content' });

      const result = detectContradictions([a, b]);
      expect(result[0]!.contradicts).toBeUndefined();
    });

    it('skips entries with non-contradiction categories', () => {
      const a = makeRecalled('a', 0.9, {
        kind: 'preference',
        category: 'style',
        content: 'Prefers dark mode',
      });
      const b = makeRecalled('b', 0.8, {
        kind: 'preference',
        category: 'style',
        content: 'Prefers light mode',
      });

      const result = detectContradictions([a, b]);
      // 'style' is not in CONTRADICTION_CATEGORIES
      expect(result[0]!.contradicts).toBeUndefined();
    });
  });

  // ─── applyDiversityFilter ──────────────────────────────────────────────

  describe('applyDiversityFilter', () => {
    it('returns all entries if under budget', () => {
      const memories = [
        makeRecalled('a', 0.9),
        makeRecalled('b', 0.8),
      ];

      const result = applyDiversityFilter(memories, { totalBudget: 10 });
      expect(result).toHaveLength(2);
    });

    it('respects totalBudget', () => {
      const topics = [
        'typescript compiler internals and abstract syntax trees',
        'kubernetes deployment strategies and rolling updates',
        'postgresql query optimization and indexing techniques',
        'react server components and streaming rendering',
        'docker container networking and bridge configuration',
        'redis caching patterns and eviction policies',
        'graphql schema design and resolver patterns',
        'nginx reverse proxy and load balancing setup',
        'elasticsearch full text search and analyzers',
        'terraform infrastructure modules and state management',
        'python asyncio event loops and coroutines',
        'rust ownership model and borrow checker rules',
        'golang goroutines concurrency and channel patterns',
        'swift protocol oriented programming and generics',
        'java virtual machine garbage collection tuning',
      ];
      const memories = topics.map((topic, i) =>
        makeRecalled(`e${i}`, 1 - i * 0.05, {
          kind: 'fact',
          content: topic,
        }),
      );

      const result = applyDiversityFilter(memories, { totalBudget: 5 });
      expect(result).toHaveLength(5);
    });

    it('limits entries per kind', () => {
      const memories = [
        makeRecalled('f1', 0.9, { kind: 'fact', content: 'fact alpha about dogs' }),
        makeRecalled('f2', 0.85, { kind: 'fact', content: 'fact beta about cats' }),
        makeRecalled('f3', 0.8, { kind: 'fact', content: 'fact gamma about birds' }),
        makeRecalled('f4', 0.75, { kind: 'fact', content: 'fact delta about fish' }),
        makeRecalled('e1', 0.7, { kind: 'episode', content: 'episode about meeting' }),
      ];

      const result = applyDiversityFilter(memories, {
        totalBudget: 5,
        maxPerKind: { fact: 2, episode: 2, preference: 2, learning: 1, skill: 1, action: 1 },
      });

      const factCount = result.filter((r) => r.entry.kind === 'fact').length;
      // Pass 1: 2 facts (limited), 1 episode = 3
      // Pass 2: fills remaining with f3, f4
      expect(factCount).toBeLessThanOrEqual(4); // at most 2 from pass1 + 2 from pass2
      expect(result).toHaveLength(5);
    });

    it('deduplicates similar content within same kind slot', () => {
      const memories = [
        makeRecalled('f1', 0.9, { kind: 'fact', content: 'User works at CloudBase as developer' }),
        makeRecalled('f2', 0.85, { kind: 'fact', content: 'User works at CloudBase as engineer' }),
        makeRecalled('f3', 0.8, { kind: 'fact', content: 'User prefers TypeScript over JavaScript' }),
        makeRecalled('e1', 0.7, { kind: 'episode', content: 'Discussed migration plan yesterday' }),
      ];

      const result = applyDiversityFilter(memories, { totalBudget: 3 });

      // f1 and f2 are very similar → f2 should be deduped, f3 and e1 should be included
      const ids = result.map((r) => r.entry.id);
      expect(ids).toContain('f1');
      expect(ids).not.toContain('f2');
    });

    it('fills remaining budget in overflow pass', () => {
      const memories = [
        makeRecalled('f1', 0.95, { kind: 'fact', content: 'fact one about alpha' }),
        makeRecalled('f2', 0.9, { kind: 'fact', content: 'fact two about beta' }),
        makeRecalled('f3', 0.85, { kind: 'fact', content: 'fact three about gamma' }),
        makeRecalled('f4', 0.8, { kind: 'fact', content: 'fact four about delta' }),
        makeRecalled('f5', 0.75, { kind: 'fact', content: 'fact five about epsilon' }),
      ];

      const result = applyDiversityFilter(memories, {
        totalBudget: 4,
        maxPerKind: { fact: 2, episode: 2, preference: 2, learning: 1, skill: 1, action: 1 },
      });

      // Pass 1: 2 facts (capped). Pass 2: fills 2 more from remaining facts
      expect(result).toHaveLength(4);
    });
  });

  // ─── _testing helpers ──────────────────────────────────────────────────

  describe('internal helpers', () => {
    it('jaccardSimilarity returns 1.0 for identical texts', () => {
      expect(_testing.jaccardSimilarity('hello world', 'hello world')).toBe(1.0);
    });

    it('jaccardSimilarity returns 0 for disjoint texts', () => {
      expect(_testing.jaccardSimilarity('alpha beta', 'gamma delta')).toBe(0);
    });

    it('jaccardSimilarity returns partial for overlapping texts', () => {
      const sim = _testing.jaccardSimilarity('hello world foo', 'hello world bar');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it('normalizeForComparison lowercases and strips punctuation', () => {
      expect(_testing.normalizeForComparison('Hello, World!')).toBe('hello world');
    });
  });
});
