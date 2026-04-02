import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmbeddingService } from '../../embedding/embedding.service';

import type {
  QdrantConfig,
  QdrantFilter,
  QdrantPoint,
  QdrantSearchResult,
} from './qdrant-vector.types';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 30_000;

type QdrantCollectionInfo = {
  config?: {
    params?: {
      vectors?: {
        size?: number;
      };
    };
  };
};

export interface QdrantRuntimeState {
  configured: boolean;
  ready: boolean;
  circuitOpen: boolean;
  url?: string;
  collectionName?: string;
  vectorSize?: number;
  consecutiveFailures: number;
}

@Injectable()
export class QdrantVectorService implements OnModuleInit {
  private readonly logger = new Logger(QdrantVectorService.name);
  private config?: QdrantConfig;
  private ready = false;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.configService.get<string>('memory.qdrant.url', '');
    if (!url) {
      this.logger.warn('Qdrant URL not configured — vector search disabled');
      return;
    }

    const configuredVectorSize = this.configService.get<number>('memory.qdrant.vectorSize', 768);
    const detectedVectorSize = this.embeddingService.getActualDimensions();
    const resolvedVectorSize = detectedVectorSize ?? configuredVectorSize;

    if (detectedVectorSize && detectedVectorSize !== configuredVectorSize) {
      this.logger.log(
        `Qdrant vector size resolved from embedding provider: ${detectedVectorSize} (configured=${configuredVectorSize})`,
      );
    }

    this.config = {
      url: url.replace(/\/+$/, ''),
      apiKey: this.configService.get<string>('memory.qdrant.apiKey', ''),
      collectionName: this.configService.get<string>('memory.qdrant.collectionName', 'argus_memory'),
      vectorSize: resolvedVectorSize,
    };

    await this.ensureCollection();
  }

  isReady(): boolean {
    return this.ready && !this.isCircuitOpen();
  }

  isConfigured(): boolean {
    return Boolean(this.config);
  }

  getRuntimeState(): QdrantRuntimeState {
    return {
      configured: Boolean(this.config),
      ready: this.ready,
      circuitOpen: this.isCircuitOpen(),
      ...(this.config
        ? {
            url: this.config.url,
            collectionName: this.config.collectionName,
            vectorSize: this.config.vectorSize,
          }
        : {}),
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  async upsertPoints(points: QdrantPoint[]): Promise<void> {
    if (!this.config || points.length === 0) return;
    if (!(await this.ensureReady())) return;

    await this.request('PUT', `/collections/${this.config.collectionName}/points`, {
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async deletePoints(ids: string[]): Promise<void> {
    if (!this.config || ids.length === 0) return;
    if (!(await this.ensureReady())) return;

    await this.request('POST', `/collections/${this.config.collectionName}/points/delete`, {
      points: ids,
    });
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  async search(
    vector: number[],
    limit: number = 10,
    filter?: QdrantFilter,
    scoreThreshold?: number,
  ): Promise<QdrantSearchResult[]> {
    if (!this.config) return [];
    if (!(await this.ensureReady())) return [];

    const body: Record<string, unknown> = {
      vector,
      limit,
      with_payload: true,
    };
    if (filter) body.filter = filter;
    if (scoreThreshold !== undefined) body.score_threshold = scoreThreshold;

    const response = await this.request(
      'POST',
      `/collections/${this.config.collectionName}/points/search`,
      body,
    );

    if (!response?.result) return [];

    return (response.result as Array<{ id: string; score: number; payload: Record<string, unknown> }>).map(
      (hit) => ({
        id: String(hit.id),
        score: hit.score,
        payload: hit.payload ?? {},
      }),
    );
  }

  // ─── Collection management ──────────────────────────────────────────────

  private async ensureReady(): Promise<boolean> {
    if (!this.config) return false;
    if (this.ready && !this.isCircuitOpen()) return true;
    if (this.isCircuitOpen()) return false;

    await this.ensureCollection();
    return this.ready;
  }

  private async ensureCollection(): Promise<void> {
    if (!this.config) return;

    try {
      const existing = await this.request('GET', `/collections/${this.config.collectionName}`);
      if (existing?.result) {
        const result = existing.result as QdrantCollectionInfo | undefined;
        const existingSize = result?.config?.params?.vectors?.size;
        if (existingSize && existingSize !== this.config.vectorSize) {
          this.logger.warn(
            `Qdrant collection dimension mismatch: existing=${existingSize}, configured=${this.config.vectorSize} — recreating`,
          );
          await this.request('DELETE', `/collections/${this.config.collectionName}`);
        } else {
          this.ready = true;
          this.logger.log(`Qdrant collection "${this.config.collectionName}" ready`);
          return;
        }
      }
    } catch {
      // collection doesn't exist, create it
    }

    try {
      await this.request('PUT', `/collections/${this.config.collectionName}`, {
        vectors: {
          size: this.config.vectorSize,
          distance: 'Cosine',
        },
      });

      // Create payload indexes for common filters
      for (const field of ['kind', 'horizon', 'category', 'source']) {
        await this.request(
          'PUT',
          `/collections/${this.config.collectionName}/index`,
          { field_name: field, field_schema: 'keyword' },
        ).catch(() => {/* index may already exist */});
      }

      await this.request(
        'PUT',
        `/collections/${this.config.collectionName}/index`,
        { field_name: 'importance', field_schema: 'float' },
      ).catch(() => {});

      await this.request(
        'PUT',
        `/collections/${this.config.collectionName}/index`,
        { field_name: 'tags', field_schema: 'keyword' },
      ).catch(() => {});

      this.ready = true;
      this.logger.log(`Created Qdrant collection "${this.config.collectionName}" (dim=${this.config.vectorSize})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create Qdrant collection: ${msg}`);
    }
  }

  // ─── HTTP client ────────────────────────────────────────────────────────

  private isCircuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
    if (Date.now() >= this.circuitOpenUntil) {
      this.consecutiveFailures = 0;
      this.logger.log('Qdrant circuit breaker reset — retrying');
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
      this.logger.warn(
        `Qdrant circuit breaker OPEN after ${this.consecutiveFailures} failures — skipping requests for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`,
      );
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.config) return undefined;

    if (this.isCircuitOpen()) {
      throw new Error('Qdrant circuit breaker is open — request skipped');
    }

    const url = `${this.config.url}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['api-key'] = this.config.apiKey;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body && method !== 'GET') {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.recordFailure();
        throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${text}`);
      }

      this.recordSuccess();

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as Record<string, unknown>;
      }

      return undefined;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.recordFailure();
        throw new Error(`Qdrant ${method} ${path} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`);
      }
      if (!(error instanceof Error && error.message.startsWith('Qdrant'))) {
        this.recordFailure();
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
