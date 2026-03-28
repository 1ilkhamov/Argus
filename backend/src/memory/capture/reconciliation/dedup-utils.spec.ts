import {
  normalizeForDedup,
  jaccardSimilarity,
  extractSignificantTokens,
  significantTokenOverlap,
} from './dedup-utils';

describe('dedup-utils', () => {
  describe('normalizeForDedup', () => {
    it('lowercases and strips punctuation', () => {
      expect(normalizeForDedup('Hello, World!')).toBe('hello world');
    });

    it('collapses whitespace', () => {
      expect(normalizeForDedup('  foo   bar  ')).toBe('foo bar');
    });

    it('preserves unicode letters and numbers', () => {
      expect(normalizeForDedup('Артём — разработчик')).toBe('артём разработчик');
    });
  });

  describe('jaccardSimilarity', () => {
    it('returns 1 for identical strings', () => {
      expect(jaccardSimilarity('foo bar', 'foo bar')).toBe(1);
    });

    it('returns 0 for completely different strings', () => {
      expect(jaccardSimilarity('foo bar', 'baz qux')).toBe(0);
    });

    it('returns partial overlap correctly', () => {
      // "foo bar baz" vs "bar baz qux" → intersection=2, union=4
      expect(jaccardSimilarity('foo bar baz', 'bar baz qux')).toBe(0.5);
    });
  });

  describe('extractSignificantTokens', () => {
    it('extracts capitalized tech terms', () => {
      const tokens = extractSignificantTokens('Main stack: TypeScript, NestJS, React, PostgreSQL');
      expect(tokens.has('typescript')).toBe(true);
      expect(tokens.has('nestjs')).toBe(true);
      expect(tokens.has('react')).toBe(true);
      expect(tokens.has('postgresql')).toBe(true);
      // 'Main' is a stopword and should NOT be extracted
      expect(tokens.has('main')).toBe(false);
    });

    it('extracts proper nouns from Russian text', () => {
      const tokens = extractSignificantTokens('Основной стек — TypeScript и NestJS');
      expect(tokens.has('typescript')).toBe(true);
      expect(tokens.has('nestjs')).toBe(true);
    });

    it('extracts names', () => {
      const tokens = extractSignificantTokens("User's name is Артём.");
      expect(tokens.has('артём')).toBe(true);
    });

    it('filters out stopwords', () => {
      const tokens = extractSignificantTokens('The main stack is TypeScript');
      expect(tokens.has('the')).toBe(false);
      expect(tokens.has('main')).toBe(false);
      expect(tokens.has('is')).toBe(false);
      expect(tokens.has('typescript')).toBe(true);
    });

    it('returns empty set for all-lowercase stopword text', () => {
      const tokens = extractSignificantTokens('это просто тест без значимых слов');
      expect(tokens.size).toBe(0);
    });
  });

  describe('significantTokenOverlap', () => {
    it('returns 1 for identical token sets', () => {
      const a = new Set(['typescript', 'nestjs']);
      expect(significantTokenOverlap(a, a)).toBe(1);
    });

    it('returns 0 for disjoint token sets', () => {
      const a = new Set(['typescript', 'nestjs']);
      const b = new Set(['python', 'django']);
      expect(significantTokenOverlap(a, b)).toBe(0);
    });

    it('detects cross-language duplicates for tech stacks', () => {
      const en = extractSignificantTokens('Main stack: TypeScript, NestJS, React, PostgreSQL.');
      const ru = extractSignificantTokens('Основной стек — TypeScript и NestJS.');
      // en: {typescript, nestjs, react, postgresql}, ru: {typescript, nestjs}
      // overlap = 2/min(4,2) = 1.0
      expect(significantTokenOverlap(en, ru)).toBeGreaterThanOrEqual(0.7);
    });

    it('detects cross-language duplicates with multiple shared terms', () => {
      const en = extractSignificantTokens('Stack: TypeScript, NestJS for Argus project.');
      const ru = extractSignificantTokens('Argus использует TypeScript и NestJS.');
      // en: {typescript, nestjs, argus}, ru: {argus, typescript, nestjs}
      expect(significantTokenOverlap(en, ru)).toBeGreaterThanOrEqual(0.7);
    });

    it('does not false-positive on unrelated texts', () => {
      const a = extractSignificantTokens('Stack: TypeScript and NestJS');
      const b = extractSignificantTokens('Argus использует React и PostgreSQL.');
      // a: {typescript, nestjs}, b: {argus, react, postgresql}
      expect(significantTokenOverlap(a, b)).toBeLessThan(0.7);
    });
  });
});
