import type { LlmService } from '../../../llm/llm.service';
import { MemoryExtractorV2Service } from './memory-extractor-v2.service';

const createLlmService = (response: string) =>
  ({
    complete: jest.fn().mockResolvedValue({ content: response }),
  }) as unknown as LlmService;

describe('MemoryExtractorV2Service', () => {
  describe('isAvailable', () => {
    it('returns false when no LLM service', () => {
      const service = new MemoryExtractorV2Service();
      expect(service.isAvailable()).toBe(false);
    });

    it('returns true when LLM service provided', () => {
      const service = new MemoryExtractorV2Service(createLlmService('{}'));
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('extractFromTurn', () => {
    it('returns undefined when LLM is unavailable', async () => {
      const service = new MemoryExtractorV2Service();
      const result = await service.extractFromTurn('hello', 'hi');
      expect(result).toBeUndefined();
    });

    it('returns undefined for empty user message', async () => {
      const service = new MemoryExtractorV2Service(createLlmService('{}'));
      const result = await service.extractFromTurn('', 'hi');
      expect(result).toBeUndefined();
    });

    it('extracts facts and episodes from valid JSON response', async () => {
      const llmResponse = JSON.stringify({
        items: [
          { kind: 'fact', content: 'User name is Alice', category: 'identity', tags: ['name'], importance: 0.9 },
          { kind: 'episode', content: 'Decided to use NestJS', tags: ['architecture'], importance: 0.6 },
        ],
        invalidations: [],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('My name is Alice', 'Nice to meet you!');

      expect(result).toBeDefined();
      expect(result!.items).toHaveLength(2);
      expect(result!.items[0]!.kind).toBe('fact');
      expect(result!.items[0]!.content).toBe('User name is Alice');
      expect(result!.items[0]!.category).toBe('identity');
      expect(result!.items[0]!.tags).toEqual(['name']);
      expect(result!.items[0]!.importance).toBe(0.9);
      expect(result!.items[1]!.kind).toBe('episode');
    });

    it('extracts invalidations', async () => {
      const llmResponse = JSON.stringify({
        items: [],
        invalidations: [
          { contentPattern: 'works at Company X', kind: 'fact', reason: 'user left Company X' },
        ],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('I left Company X', 'Noted.');

      expect(result).toBeDefined();
      expect(result!.invalidations).toHaveLength(1);
      expect(result!.invalidations[0]!.contentPattern).toBe('works at Company X');
      expect(result!.invalidations[0]!.kind).toBe('fact');
    });

    it('returns undefined when LLM returns empty extraction', async () => {
      const llmResponse = JSON.stringify({ items: [], invalidations: [] });
      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('hello', 'hi');
      expect(result).toBeUndefined();
    });

    it('returns undefined on LLM error', async () => {
      const llm = {
        complete: jest.fn().mockRejectedValue(new Error('LLM down')),
      } as unknown as LlmService;
      const service = new MemoryExtractorV2Service(llm);
      const result = await service.extractFromTurn('hello', 'hi');
      expect(result).toBeUndefined();
    });

    it('rejects invalid kinds', async () => {
      const llmResponse = JSON.stringify({
        items: [
          { kind: 'invalid_kind', content: 'something', importance: 0.5 },
          { kind: 'fact', content: 'valid content', importance: 0.5 },
        ],
        invalidations: [],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('test', 'test');

      expect(result).toBeDefined();
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]!.kind).toBe('fact');
    });

    it('rejects items with content shorter than 3 chars', async () => {
      const llmResponse = JSON.stringify({
        items: [
          { kind: 'fact', content: 'ab', importance: 0.5 },
        ],
        invalidations: [],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('test', 'test');
      expect(result).toBeUndefined();
    });

    it('clamps importance to 0-1 range', async () => {
      const llmResponse = JSON.stringify({
        items: [
          { kind: 'fact', content: 'valid content', importance: 5.0 },
        ],
        invalidations: [],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('test', 'test');

      expect(result).toBeDefined();
      expect(result!.items[0]!.importance).toBeUndefined(); // out of range → stripped
    });

    it('handles JSON wrapped in markdown fences', async () => {
      const llmResponse = '```json\n' + JSON.stringify({
        items: [{ kind: 'learning', content: 'Always use strict mode', importance: 0.7 }],
        invalidations: [],
      }) + '\n```';

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('test', 'test');

      expect(result).toBeDefined();
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]!.kind).toBe('learning');
    });

    it('lowercases and trims tags', async () => {
      const llmResponse = JSON.stringify({
        items: [{ kind: 'skill', content: 'Can deploy to Netlify', tags: ['  Deploy ', 'NETLIFY'] }],
        invalidations: [],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.extractFromTurn('test', 'test');

      expect(result!.items[0]!.tags).toEqual(['deploy', 'netlify']);
    });
  });

  describe('reflectOnSession', () => {
    it('returns undefined when LLM is unavailable', async () => {
      const service = new MemoryExtractorV2Service();
      const result = await service.reflectOnSession('session summary');
      expect(result).toBeUndefined();
    });

    it('extracts learnings from session summary', async () => {
      const llmResponse = JSON.stringify({
        items: [
          { kind: 'learning', content: 'User prefers concise answers in Russian', importance: 0.8 },
        ],
        invalidations: [],
      });

      const service = new MemoryExtractorV2Service(createLlmService(llmResponse));
      const result = await service.reflectOnSession('We discussed code architecture...');

      expect(result).toBeDefined();
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]!.kind).toBe('learning');
    });
  });
});
