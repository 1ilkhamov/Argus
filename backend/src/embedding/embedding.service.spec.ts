import { ConfigService } from '@nestjs/config';

import { EmbeddingService } from './embedding.service';

const createConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'embedding.enabled': false,
    'embedding.model': '',
    'embedding.apiBase': 'http://localhost:8317/v1',
    'embedding.apiKey': 'test-key',
    'embedding.dimensions': 0,
    'llm.apiBase': 'http://localhost:8317/v1',
    'llm.apiKey': 'fallback-key',
    ...overrides,
  };

  return {
    get: jest.fn((key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue)),
  } as unknown as ConfigService;
};

describe('EmbeddingService', () => {
  describe('disabled mode', () => {
    it('reports unavailable when disabled', async () => {
      const service = new EmbeddingService(createConfigService());
      await service.onModuleInit();
      expect(service.isAvailable()).toBe(false);
    });

    it('embed returns undefined when disabled', async () => {
      const service = new EmbeddingService(createConfigService());
      await service.onModuleInit();
      expect(await service.embed('test')).toBeUndefined();
    });

    it('embedBatch returns undefined when disabled', async () => {
      const service = new EmbeddingService(createConfigService());
      await service.onModuleInit();
      expect(await service.embedBatch(['test'])).toBeUndefined();
    });
  });

  describe('enabled without model', () => {
    it('disables itself when model is not set', async () => {
      const service = new EmbeddingService(
        createConfigService({ 'embedding.enabled': true, 'embedding.model': '' }),
      );
      await service.onModuleInit();
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('enabled with model but no server', () => {
    it('marks unavailable when probe fails', async () => {
      const service = new EmbeddingService(
        createConfigService({
          'embedding.enabled': true,
          'embedding.model': 'test-model',
          'embedding.apiBase': 'http://localhost:1/v1',
        }),
      );
      await service.onModuleInit();
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('embed graceful degradation', () => {
    it('returns undefined when not available', async () => {
      const service = new EmbeddingService(createConfigService());
      await service.onModuleInit();
      const result = await service.embed('hello');
      expect(result).toBeUndefined();
    });
  });

  describe('embedBatch graceful degradation', () => {
    it('returns undefined for empty array when not available', async () => {
      const service = new EmbeddingService(createConfigService());
      await service.onModuleInit();
      const result = await service.embedBatch([]);
      expect(result).toBeUndefined();
    });
  });
});
