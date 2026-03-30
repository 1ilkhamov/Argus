import { AgentMetricsService } from '../agent/metrics/metrics.service';
import type { ChatRepository } from '../chat/repositories/chat.repository';
import { EmbeddingService } from '../embedding/embedding.service';
import { LlmService } from '../llm/llm.service';
import { MemoryStoreService } from '../memory/core/memory-store.service';
import { QdrantVectorService } from '../memory/qdrant/qdrant-vector.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns a minimal public health payload without internal diagnostics', async () => {
    const service = new HealthService(
      {
        checkHealth: jest.fn().mockResolvedValue({
          status: 'up',
          model: 'test-model',
          responseTimeMs: 4,
        }),
      } as unknown as LlmService,
      {
        getSnapshot: jest.fn().mockReturnValue({
          startedAt: '2026-01-01T00:00:00.000Z',
          totalContextResolutions: 3,
          mode: {
            byId: { assistant: 3, operator: 0, strategist: 0, researcher: 0, reflective: 0 },
            bySource: { explicit: 0, inferred: 3 },
          },
          profile: {
            bySource: { recent_context: 3, persisted_profile_and_recent_context: 0 },
            byKeyKind: { local_default: 3 },
            communication: {
              preferredLanguage: { auto: 3, ru: 0, en: 0 },
              tone: { direct: 3, warm: 0, formal: 0 },
              detail: { adaptive: 3, concise: 0, detailed: 0 },
              structure: { adaptive: 3, structured: 0 },
            },
            interaction: {
              allowPushback: { enabled: 3, disabled: 0 },
              allowProactiveSuggestions: { enabled: 3, disabled: 0 },
            },
          },
        }),
      } as unknown as AgentMetricsService,
      {
        count: jest.fn().mockResolvedValue(5),
      } as unknown as MemoryStoreService,
      {
        isEnabled: jest.fn().mockReturnValue(true),
        isAvailable: jest.fn().mockReturnValue(true),
      } as unknown as EmbeddingService,
      {
        isConfigured: jest.fn().mockReturnValue(true),
        isReady: jest.fn().mockReturnValue(true),
      } as unknown as QdrantVectorService,
      {
        checkHealth: jest.fn().mockResolvedValue({
          status: 'up',
          driver: 'sqlite',
          target: '/tmp/test.db',
          conversationCount: 4,
        }),
      } as unknown as ChatRepository,
    );

    const payload = await service.check();

    expect(payload.status).toBe('ok');
    expect(payload.checks.storage).toEqual({ status: 'up' });
    expect(payload.checks.llm).toEqual({ status: 'up' });
    expect(payload.checks.embedding).toEqual({ status: 'up' });
    expect(payload.checks.qdrant).toEqual({ status: 'up' });
    expect(payload).not.toHaveProperty('metrics');
  });

  it('returns detailed runtime diagnostics including memory entry count', async () => {
    const agentMetricsSnapshot = {
      startedAt: '2026-01-01T00:00:00.000Z',
      totalContextResolutions: 2,
      mode: {
        byId: { assistant: 1, operator: 0, strategist: 1, researcher: 0, reflective: 0 },
        bySource: { explicit: 1, inferred: 1 },
      },
      profile: {
        bySource: { recent_context: 1, persisted_profile_and_recent_context: 1 },
        byKeyKind: { local_default: 1 },
        communication: {
          preferredLanguage: { auto: 1, ru: 1, en: 0 },
          tone: { direct: 1, warm: 1, formal: 0 },
          detail: { adaptive: 1, concise: 0, detailed: 1 },
          structure: { adaptive: 1, structured: 1 },
        },
        interaction: {
          allowPushback: { enabled: 1, disabled: 1 },
          allowProactiveSuggestions: { enabled: 1, disabled: 1 },
        },
      },
    };
    const service = new HealthService(
      {
        checkHealth: jest.fn().mockResolvedValue({
          status: 'down',
          model: 'test-model',
          responseTimeMs: 7,
          error: 'upstream unavailable',
        }),
      } as unknown as LlmService,
      {
        getSnapshot: jest.fn().mockReturnValue(agentMetricsSnapshot),
      } as unknown as AgentMetricsService,
      {
        count: jest.fn().mockResolvedValue(12),
      } as unknown as MemoryStoreService,
      {
        isEnabled: jest.fn().mockReturnValue(true),
        isAvailable: jest.fn().mockReturnValue(false),
      } as unknown as EmbeddingService,
      {
        isConfigured: jest.fn().mockReturnValue(true),
        isReady: jest.fn().mockReturnValue(false),
      } as unknown as QdrantVectorService,
      {
        checkHealth: jest.fn().mockResolvedValue({
          status: 'up',
          driver: 'sqlite',
          target: '/tmp/test.db',
          conversationCount: 7,
        }),
      } as unknown as ChatRepository,
    );

    const payload = await service.checkRuntime();

    expect(payload.status).toBe('degraded');
    expect(payload.checks.storage.driver).toBe('sqlite');
    expect(payload.checks.llm.error).toBe('upstream unavailable');
    expect(payload.checks.embedding).toEqual({ status: 'down' });
    expect(payload.checks.qdrant).toEqual({ status: 'down' });
    expect(payload.metrics.agent).toEqual(agentMetricsSnapshot);
    expect(payload.metrics.memory).toEqual({ totalEntries: 12 });
  });
});
