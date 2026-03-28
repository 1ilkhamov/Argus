import { IdentityExtractorService, type IdentityExtractionResult } from './identity-extractor.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createLlmService(response: string) {
  return {
    complete: jest.fn().mockResolvedValue({ content: response }),
  } as unknown as import('../../../llm/llm.service').LlmService;
}

function createService(response?: string): IdentityExtractorService {
  if (response === undefined) {
    return new IdentityExtractorService();
  }
  return new IdentityExtractorService(createLlmService(response));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('IdentityExtractorService', () => {
  describe('isAvailable', () => {
    it('returns false when no LLM service is injected', () => {
      const service = createService();
      expect(service.isAvailable()).toBe(false);
    });

    it('returns true when LLM service is present', () => {
      const service = createService('{}');
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('extractFromTurn', () => {
    it('returns undefined when LLM is not available', async () => {
      const service = createService();
      const result = await service.extractFromTurn('hello', 'hi there');
      expect(result).toBeUndefined();
    });

    it('returns empty traits for very short routine messages', async () => {
      const service = createService('should not be called');
      const result = await service.extractFromTurn('ok', 'Got it.');
      expect(result).toEqual({ traits: [] });
    });

    it('returns empty traits for empty user message', async () => {
      const service = createService('{"traits": []}');
      const result = await service.extractFromTurn('', 'response');
      expect(result).toBeUndefined();
    });

    it('extracts identity traits from a valid LLM response', async () => {
      const llmResponse = JSON.stringify({
        traits: [
          {
            category: 'style',
            content: 'Skip preambles and lead with the answer',
            confidence: 'high',
            signal: 'user said "не разжёвывай"',
          },
          {
            category: 'boundary',
            content: 'Never start with filler affirmations',
            confidence: 'high',
            signal: 'explicit correction',
          },
        ],
      });

      const service = createService(llmResponse);
      const result = await service.extractFromTurn(
        'не разжёвывай, просто отвечай',
        'Хорошо, буду кратким.',
      );

      expect(result).toBeDefined();
      expect(result!.traits).toHaveLength(2);
      expect(result!.traits[0]!.category).toBe('style');
      expect(result!.traits[0]!.confidence).toBe('high');
      expect(result!.traits[1]!.category).toBe('boundary');
    });

    it('handles LLM response with no traits (routine turn)', async () => {
      const service = createService('{"traits": []}');
      const result = await service.extractFromTurn(
        'What is the weather today?',
        'I cannot check the weather.',
      );

      expect(result).toBeDefined();
      expect(result!.traits).toEqual([]);
    });

    it('validates category values and filters invalid ones', async () => {
      const llmResponse = JSON.stringify({
        traits: [
          { category: 'style', content: 'Be concise', confidence: 'high', signal: 'test' },
          { category: 'invalid_category', content: 'Should be filtered', confidence: 'high', signal: 'test' },
          { category: 'personality', content: 'Be direct', confidence: 'medium', signal: 'test' },
        ],
      });

      const service = createService(llmResponse);
      const result = await service.extractFromTurn('test message with content', 'response');

      expect(result!.traits).toHaveLength(2);
      expect(result!.traits[0]!.category).toBe('style');
      expect(result!.traits[1]!.category).toBe('personality');
    });

    it('caps traits at 5 per turn', async () => {
      const traits = Array.from({ length: 10 }, (_, i) => ({
        category: 'personality',
        content: `Trait number ${i + 1} for testing`,
        confidence: 'medium',
        signal: `signal ${i}`,
      }));

      const service = createService(JSON.stringify({ traits }));
      const result = await service.extractFromTurn('long message with many signals', 'response');

      expect(result!.traits).toHaveLength(5);
    });

    it('filters traits with content shorter than 5 chars', async () => {
      const llmResponse = JSON.stringify({
        traits: [
          { category: 'style', content: 'ok', confidence: 'high', signal: 'test' },
          { category: 'style', content: 'Use bullet points for clarity', confidence: 'high', signal: 'test' },
        ],
      });

      const service = createService(llmResponse);
      const result = await service.extractFromTurn('tell me something useful', 'sure thing');

      expect(result!.traits).toHaveLength(1);
      expect(result!.traits[0]!.content).toBe('Use bullet points for clarity');
    });

    it('defaults to medium confidence for unknown confidence values', async () => {
      const llmResponse = JSON.stringify({
        traits: [
          { category: 'style', content: 'Be very concise always', confidence: 'super_high', signal: 'test' },
        ],
      });

      const service = createService(llmResponse);
      const result = await service.extractFromTurn('make it shorter please', 'response');

      expect(result!.traits[0]!.confidence).toBe('medium');
    });

    it('handles markdown-wrapped JSON response', async () => {
      const llmResponse = '```json\n{"traits": [{"category": "value", "content": "Accuracy over speed", "confidence": "high", "signal": "user emphasized correctness"}]}\n```';

      const service = createService(llmResponse);
      const result = await service.extractFromTurn('accuracy matters more than speed', 'response');

      expect(result!.traits).toHaveLength(1);
      expect(result!.traits[0]!.category).toBe('value');
    });

    it('returns undefined for completely invalid JSON', async () => {
      const service = createService('not json at all');
      const result = await service.extractFromTurn('some message here', 'response');
      expect(result).toBeUndefined();
    });

    it('handles LLM failure gracefully', async () => {
      const llm = {
        complete: jest.fn().mockRejectedValue(new Error('LLM timeout')),
      };
      const service = new IdentityExtractorService(llm as any);
      const result = await service.extractFromTurn('test message content', 'response');
      expect(result).toBeUndefined();
    });

    it('skips code-heavy messages as routine', async () => {
      const codeMessage = '```typescript\nconst x = 1;\nconst y = 2;\nconst z = 3;\nconsole.log(x + y + z);\n```';
      const service = createService('should not be called');
      const result = await service.extractFromTurn(codeMessage, 'response');
      expect(result).toEqual({ traits: [] });
    });

    it('truncates content and signal to max length', async () => {
      const longContent = 'A'.repeat(500);
      const longSignal = 'B'.repeat(400);
      const llmResponse = JSON.stringify({
        traits: [
          { category: 'personality', content: longContent, confidence: 'high', signal: longSignal },
        ],
      });

      const service = createService(llmResponse);
      const result = await service.extractFromTurn('some meaningful user input', 'response');

      expect(result!.traits[0]!.content.length).toBeLessThanOrEqual(300);
      expect(result!.traits[0]!.signal.length).toBeLessThanOrEqual(200);
    });
  });
});
