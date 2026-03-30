import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EmbeddingBatchResult, EmbeddingResult } from './embedding.types';
import { LocalEmbeddingProvider } from './local-embedding.provider';

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

type ErrorResponse = {
  error?: { message?: string } | string;
  message?: string;
};

const EMBEDDING_TIMEOUT_MS = 30_000;
const MAX_BATCH_SIZE = 64;
const FAILURE_THRESHOLD = 3;
const FAILURE_RESET_MS = 60_000;

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);

  private readonly enabled: boolean;
  private readonly provider: string;
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number | undefined;
  private readonly localModel: string;

  private available = false;
  private consecutiveFailures = 0;
  private unavailableUntil = 0;
  private localProvider: LocalEmbeddingProvider | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get<boolean>('embedding.enabled', false);
    this.provider = this.configService.get<string>('embedding.provider', 'api');
    this.apiBase = this.configService.get<string>(
      'embedding.apiBase',
      this.configService.get<string>('llm.apiBase', 'http://localhost:8317/v1'),
    );
    this.apiKey = this.configService.get<string>(
      'embedding.apiKey',
      this.configService.get<string>('llm.apiKey', ''),
    );
    this.model = this.configService.get<string>('embedding.model', '');
    const dimensionsValue = this.configService.get<number>('embedding.dimensions', 0);
    this.dimensions = dimensionsValue > 0 ? dimensionsValue : undefined;
    this.localModel = this.configService.get<string>('embedding.localModel', 'Xenova/multilingual-e5-small');
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Embedding service disabled (EMBEDDING_ENABLED=false)');
      return;
    }

    if (this.provider === 'local') {
      await this.initLocalProvider();
      return;
    }

    if (!this.model) {
      this.logger.warn('Embedding service enabled but EMBEDDING_MODEL is not set — disabling');
      return;
    }

    this.logger.log(`Embedding service configured: model=${this.model}, dimensions=${this.dimensions ?? 'auto'}`);

    await this.probeAvailability();
  }

  private async initLocalProvider(): Promise<void> {
    this.localProvider = new LocalEmbeddingProvider(this.localModel);
    const ok = await this.localProvider.init();
    if (ok) {
      this.available = true;
      this.logger.log(
        `Local embedding ready: model=${this.localProvider.getModelName()}, dimensions=${this.localProvider.getDimensions()}`,
      );
    } else {
      this.available = false;
      this.logger.warn('Local embedding model failed to load — embedding unavailable');
    }
  }

  /**
   * Returns the actual vector dimensions (useful for Qdrant collection auto-config).
   */
  getActualDimensions(): number | undefined {
    if (this.localProvider?.isReady()) return this.localProvider.getDimensions();
    return this.dimensions;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isAvailable(): boolean {
    if (!this.enabled || !this.available) return false;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      if (Date.now() < this.unavailableUntil) return false;
      this.consecutiveFailures = 0;
      this.logger.log('Embedding failure counter reset — retrying');
    }
    return true;
  }

  async embed(text: string): Promise<EmbeddingResult | undefined> {
    if (!this.isAvailable()) {
      return undefined;
    }

    if (this.localProvider?.isReady()) {
      return this.localEmbed(text);
    }

    try {
      const response = await this.callEmbeddingApi([text]);
      const vector = response.data?.[0]?.embedding;
      if (!vector || vector.length === 0) {
        this.logger.warn('Embedding API returned empty vector');
        return undefined;
      }

      return {
        embedding: vector,
        model: response.model ?? this.model,
        tokenCount: response.usage?.prompt_tokens ?? 0,
      };
    } catch (error) {
      this.recordFailure();
      this.logEmbeddingError('embed', error);
      return undefined;
    }
  }

  /**
   * Embed a search query (uses "query:" prefix for E5 models in local mode).
   */
  async embedQuery(text: string): Promise<EmbeddingResult | undefined> {
    if (!this.isAvailable()) return undefined;
    if (this.localProvider?.isReady()) {
      return this.localEmbedQuery(text);
    }
    // API mode: queries and documents use the same endpoint
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult | undefined> {
    if (!this.isAvailable() || texts.length === 0) {
      return undefined;
    }

    if (this.localProvider?.isReady()) {
      return this.localEmbedBatch(texts);
    }

    try {
      const allEmbeddings: number[][] = [];
      let totalTokens = 0;
      let resolvedModel = this.model;

      for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + MAX_BATCH_SIZE);
        const response = await this.callEmbeddingApi(batch);

        if (!response.data || response.data.length === 0) {
          this.logger.warn(`Embedding batch returned empty data for chunk at offset ${offset}`);
          return undefined;
        }

        const sorted = response.data
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

        for (const item of sorted) {
          if (!item.embedding || item.embedding.length === 0) {
            this.logger.warn('Embedding batch returned empty vector for one item');
            return undefined;
          }
          allEmbeddings.push(item.embedding);
        }

        totalTokens += response.usage?.total_tokens ?? 0;
        resolvedModel = response.model ?? this.model;
      }

      if (allEmbeddings.length !== texts.length) {
        this.logger.warn(
          `Embedding batch size mismatch: expected ${texts.length}, got ${allEmbeddings.length}`,
        );
        return undefined;
      }

      return {
        embeddings: allEmbeddings,
        model: resolvedModel,
        totalTokens,
      };
    } catch (error) {
      this.recordFailure();
      this.logEmbeddingError('embedBatch', error);
      return undefined;
    }
  }

  // ─── Local Provider Helpers ──────────────────────────────────────────────

  private async localEmbed(text: string): Promise<EmbeddingResult | undefined> {
    const vector = await this.localProvider!.embed(text);
    if (!vector) return undefined;
    return {
      embedding: vector,
      model: this.localProvider!.getModelName(),
      tokenCount: 0,
    };
  }

  private async localEmbedQuery(text: string): Promise<EmbeddingResult | undefined> {
    const vector = await this.localProvider!.embedQuery(text);
    if (!vector) return undefined;
    return {
      embedding: vector,
      model: this.localProvider!.getModelName(),
      tokenCount: 0,
    };
  }

  private async localEmbedBatch(texts: string[]): Promise<EmbeddingBatchResult | undefined> {
    const vectors = await this.localProvider!.embedBatch(texts);
    if (!vectors) return undefined;
    return {
      embeddings: vectors,
      model: this.localProvider!.getModelName(),
      totalTokens: 0,
    };
  }

  private async callEmbeddingApi(input: string[]): Promise<OpenAiEmbeddingResponse> {
    const url = this.buildApiUrl('/embeddings');

    const body: Record<string, unknown> = {
      model: this.model,
      input,
    };
    if (this.dimensions !== undefined) {
      body.dimensions = this.dimensions;
    }

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorMessage = await this.readErrorResponse(response);
      throw new Error(`Embedding API error (${response.status}): ${errorMessage}`);
    }

    return (await response.json()) as OpenAiEmbeddingResponse;
  }

  private async probeAvailability(): Promise<void> {
    try {
      const result = await this.embed('health check');
      if (result && result.embedding.length > 0) {
        this.available = true;
        this.logger.log(
          `Embedding service available: dimensions=${result.embedding.length}, model=${result.model}`,
        );
      } else {
        this.available = false;
        this.logger.warn('Embedding service probe returned empty result — service unavailable');
      }
    } catch (error) {
      this.available = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Embedding service probe failed — service unavailable: ${message}`);
    }
  }

  private buildApiUrl(path: string): string {
    const base = this.apiBase.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private buildHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(EMBEDDING_TIMEOUT_MS);
    return fetch(url, { ...init, signal });
  }

  private async readErrorResponse(response: Response): Promise<string> {
    const fallback = `status ${response.status}`;
    try {
      const body = (await response.json()) as ErrorResponse;
      if (typeof body.error === 'string' && body.error) {
        return body.error;
      }
      if (body.error && typeof body.error === 'object' && body.error.message) {
        return body.error.message;
      }
      if (body.message) {
        return body.message;
      }
    } catch {
      try {
        const text = await response.text();
        if (text) {
          return text;
        }
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.unavailableUntil = Date.now() + FAILURE_RESET_MS;
      this.logger.warn(
        `Embedding marked unavailable after ${this.consecutiveFailures} consecutive failures — cooldown ${FAILURE_RESET_MS / 1000}s`,
      );
    }
  }

  private logEmbeddingError(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unknown embedding error';
    this.logger.warn(`Embedding ${operation} failed: ${message}`);
  }
}
