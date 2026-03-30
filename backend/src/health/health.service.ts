import { Inject, Injectable } from '@nestjs/common';

import { AgentMetricsService, type AgentMetricsSnapshot } from '../agent/metrics/metrics.service';
import { CHAT_REPOSITORY, ChatRepository } from '../chat/repositories/chat.repository';
import { EmbeddingService } from '../embedding/embedding.service';
import { LlmService } from '../llm/llm.service';
import { MemoryStoreService } from '../memory/core/memory-store.service';
import { QdrantVectorService } from '../memory/qdrant/qdrant-vector.service';

export interface PublicHealthCheckPayload {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  checks: {
    storage: {
      status: 'up' | 'down';
    };
    llm: {
      status: 'up' | 'down';
    };
    embedding: {
      status: 'up' | 'down' | 'disabled';
    };
    qdrant: {
      status: 'up' | 'down' | 'disabled';
    };
  };
}

export interface MemoryMetricsSnapshot {
  totalEntries: number;
}

export interface HealthCheckPayload {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  checks: {
    storage: {
      status: 'up' | 'down';
      driver: string;
      target: string;
      conversationCount: number;
      error?: string;
    };
    llm: {
      status: 'up' | 'down';
      model: string;
      responseTimeMs: number;
      error?: string;
    };
    embedding: {
      status: 'up' | 'down' | 'disabled';
    };
    qdrant: {
      status: 'up' | 'down' | 'disabled';
    };
  };
  metrics: {
    agent: AgentMetricsSnapshot;
    memory: MemoryMetricsSnapshot;
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly llmService: LlmService,
    private readonly agentMetricsService: AgentMetricsService,
    private readonly memoryStoreService: MemoryStoreService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantVectorService,
    @Inject(CHAT_REPOSITORY) private readonly chatRepository: ChatRepository,
  ) {}

  async check(): Promise<PublicHealthCheckPayload> {
    const runtimeHealth = await this.checkRuntime();

    return {
      status: runtimeHealth.status,
      timestamp: runtimeHealth.timestamp,
      uptime: runtimeHealth.uptime,
      checks: {
        storage: {
          status: runtimeHealth.checks.storage.status,
        },
        llm: {
          status: runtimeHealth.checks.llm.status,
        },
        embedding: runtimeHealth.checks.embedding,
        qdrant: runtimeHealth.checks.qdrant,
      },
    };
  }

  async checkRuntime(): Promise<HealthCheckPayload> {
    const [storage, llm] = await Promise.all([
      this.chatRepository.checkHealth(),
      this.llmService.checkHealth(),
    ]);

    const embeddingStatus: 'up' | 'down' | 'disabled' = this.embeddingService.isEnabled()
      ? (this.embeddingService.isAvailable() ? 'up' : 'down')
      : 'disabled';
    const qdrantStatus: 'up' | 'down' | 'disabled' = this.qdrantService.isConfigured()
      ? (this.qdrantService.isReady() ? 'up' : 'down')
      : 'disabled';

    const coreUp = storage.status === 'up' && llm.status === 'up';

    return {
      status: coreUp ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        storage,
        llm,
        embedding: { status: embeddingStatus },
        qdrant: { status: qdrantStatus },
      },
      metrics: {
        agent: this.agentMetricsService.getSnapshot(),
        memory: { totalEntries: await this.memoryStoreService.count() },
      },
    };
  }
}
