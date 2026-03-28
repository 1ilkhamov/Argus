import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { EmbeddingService } from '../../../embedding/embedding.service';
import type { CreateMemoryEntryParams, MemoryEntry } from '../../../memory/core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';
import { MemoryStoreService } from '../../../memory/core/memory-store.service';
import { QdrantVectorService } from '../../../memory/qdrant/qdrant-vector.service';
import type { QdrantFilter, QdrantPoint } from '../../../memory/qdrant/qdrant-vector.types';
import { ContradictionResolverService } from '../../../memory/capture/reconciliation/contradiction-resolver.service';
import {
  normalizeForDedup,
  jaccardSimilarity,
  extractSignificantTokens,
  significantTokenOverlap,
} from '../../../memory/capture/reconciliation/dedup-utils';
import { IdentityExtractorService, type ExtractedIdentityTrait } from './identity-extractor.service';

const SEMANTIC_DEDUP_THRESHOLD = 0.88;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IdentityCaptureResult {
  created: MemoryEntry[];
  superseded: string[];
  skipped: number;
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class IdentityCaptureService {
  private readonly logger = new Logger(IdentityCaptureService.name);

  constructor(
    private readonly extractor: IdentityExtractorService,
    private readonly store: MemoryStoreService,
    private readonly contradictionResolver: ContradictionResolverService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantVectorService,
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
  ) {}

  /**
   * Extract and store identity traits from a conversation turn.
   * Runs in parallel with general auto-capture — non-blocking.
   */
  async captureFromTurn(
    userMessage: string,
    assistantResponse: string,
    conversationId?: string,
    messageId?: string,
    scopeKey?: string,
  ): Promise<IdentityCaptureResult> {
    const result: IdentityCaptureResult = { created: [], superseded: [], skipped: 0 };

    if (!this.extractor.isAvailable()) return result;

    const extraction = await this.extractor.extractFromTurn(userMessage, assistantResponse);
    if (!extraction || extraction.traits.length === 0) return result;

    for (const trait of extraction.traits) {
      const stored = await this.processIdentityTrait(trait, conversationId, messageId, scopeKey);
      if (stored.entry) {
        result.created.push(stored.entry);
        if (stored.supersededId) {
          result.superseded.push(stored.supersededId);
        }
      } else {
        result.skipped++;
      }
    }

    // Embed new entries
    await this.embedEntries(result.created);

    if (result.created.length > 0) {
      this.logger.debug(
        `Identity capture: created=${result.created.length}, superseded=${result.superseded.length}, skipped=${result.skipped}`,
      );
    }

    return result;
  }

  // ─── Trait processing ─────────────────────────────────────────────────

  private async processIdentityTrait(
    trait: ExtractedIdentityTrait,
    conversationId?: string,
    messageId?: string,
    scopeKey?: string,
  ): Promise<{ entry?: MemoryEntry; supersededId?: string }> {
    // Find existing identity entries of the same category for this scope
    const existing = await this.repo.query({
      kinds: ['identity'],
      ...(scopeKey ? { scopeKey } : {}),
      excludeSuperseded: true,
      limit: 20,
    });

    const sameCategoryEntries = existing.filter((e) => e.category === trait.category);

    // Near-duplicate check: text-based against ALL identity entries (cross-category)
    if (this.isNearDuplicate(existing, trait.content)) {
      this.logger.debug(
        `Skipped near-duplicate identity trait [${trait.category}]: "${trait.content.slice(0, 50)}"`,
      );
      return {};
    }

    // Embedding-based semantic dedup (catches paraphrases like "кратко" vs "без лишних деталей")
    if (await this.isSemanticDuplicate(trait.content, trait.category, scopeKey)) {
      this.logger.debug(
        `Skipped semantic-duplicate identity trait [${trait.category}]: "${trait.content.slice(0, 50)}"`,
      );
      return {};
    }

    // Contradiction check within same category
    const conflicts = await this.contradictionResolver.findConflicts(
      sameCategoryEntries,
      trait.content,
      'identity',
      trait.category,
    );

    const params: CreateMemoryEntryParams = {
      kind: 'identity',
      content: trait.content,
      source: 'llm_extraction',
      category: trait.category,
      tags: ['identity', trait.category, ...(trait.confidence === 'high' ? ['explicit_signal'] : [])],
      importance: trait.confidence === 'high' ? 0.9 : 0.75,
      scopeKey,
      provenance: {
        conversationId,
        messageId,
        timestamp: new Date().toISOString(),
      },
    };

    if (conflicts.length === 0) {
      const entry = await this.store.create(params);
      return { entry };
    }

    // Handle the first actionable conflict
    for (const conflict of conflicts) {
      if (!conflict.resolution) continue;

      switch (conflict.resolution.action) {
        case 'keep_new': {
          const entry = await this.store.supersede(conflict.existingEntry.id, params);
          if (entry) {
            return { entry, supersededId: conflict.existingEntry.id };
          }
          break;
        }
        case 'keep_old':
          this.logger.debug(
            `Discarded identity trait (keep_old) [${trait.category}]: "${trait.content.slice(0, 50)}"`,
          );
          return {};
        case 'merge': {
          const mergedParams = { ...params, content: conflict.resolution.merged };
          const entry = await this.store.supersede(conflict.existingEntry.id, mergedParams);
          if (entry) {
            return { entry, supersededId: conflict.existingEntry.id };
          }
          break;
        }
        case 'keep_both': {
          const entry = await this.store.create(params);
          return { entry };
        }
      }
      break; // one resolution per trait
    }

    return {};
  }

  // ─── Near-duplicate detection ────────────────────────────────────────

  private isNearDuplicate(existing: MemoryEntry[], newContent: string): boolean {
    const normalizedNew = normalizeForDedup(newContent);
    if (normalizedNew.length < 5) return false;

    const sigNew = extractSignificantTokens(newContent);

    for (const entry of existing) {
      const normalizedExisting = normalizeForDedup(entry.content);

      // Exact match
      if (normalizedNew === normalizedExisting) return true;

      // Substring containment
      if (normalizedNew.length >= 10 && normalizedExisting.length >= 10) {
        if (normalizedNew.includes(normalizedExisting) || normalizedExisting.includes(normalizedNew)) {
          return true;
        }
      }

      // High Jaccard similarity
      const similarity = jaccardSimilarity(normalizedNew, normalizedExisting);
      if (similarity >= 0.75) return true;

      // Cross-language dedup via significant tokens
      if (sigNew.size >= 2) {
        const sigExisting = extractSignificantTokens(entry.content);
        if (sigExisting.size >= 2) {
          const overlap = significantTokenOverlap(sigNew, sigExisting);
          if (overlap >= 0.7) return true;
        }
      }
    }

    return false;
  }

  /**
   * Embedding-based semantic dedup: embed new trait, search Qdrant for
   * existing identity entries with high cosine similarity.
   * Returns true if a semantically near-duplicate exists.
   */
  private async isSemanticDuplicate(
    content: string,
    category: string,
    scopeKey?: string,
  ): Promise<boolean> {
    if (!this.qdrantService.isReady() || !this.embeddingService.isAvailable()) return false;

    try {
      const text = `[identity:${category}] ${content}`;
      const result = await this.embeddingService.embed(text);
      if (!result) return false;

      const filter: QdrantFilter = {
        must: [
          { key: 'kind', match: { value: 'identity' } },
          ...(scopeKey ? [{ key: 'scope_key', match: { value: scopeKey } }] : []),
        ],
      };

      const results = await this.qdrantService.search(
        result.embedding,
        5,
        filter,
        SEMANTIC_DEDUP_THRESHOLD,
      );

      return results.length > 0;
    } catch {
      return false;
    }
  }

  // ─── Embedding ───────────────────────────────────────────────────────

  private async embedEntries(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (!this.qdrantService.isReady() || !this.embeddingService.isAvailable()) return;

    try {
      const texts = entries.map((e) => `[identity:${e.category}] ${e.content}`);
      const batchResult = await this.embeddingService.embedBatch(texts);
      if (!batchResult) return;

      const points: QdrantPoint[] = entries.map((entry, idx) => ({
        id: entry.id,
        vector: batchResult.embeddings[idx]!,
        payload: {
          scope_key: entry.scopeKey ?? 'local:default',
          kind: entry.kind,
          horizon: entry.horizon,
          category: entry.category ?? '',
          source: entry.source,
          importance: entry.importance,
          tags: entry.tags,
          created_at: entry.createdAt,
        },
      }));

      await this.qdrantService.upsertPoints(points);

      for (const entry of entries) {
        await this.store.update(entry.id, { embeddingId: entry.id });
      }

      this.logger.debug(`Embedded ${points.length} identity entries in Qdrant`);
    } catch (error) {
      this.logger.warn(
        `Failed to embed identity entries: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
