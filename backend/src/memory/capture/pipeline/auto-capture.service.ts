import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { EmbeddingService } from '../../../embedding/embedding.service';
import type { CreateMemoryEntryParams, MemoryEntry } from '../../core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../../core/memory-entry.repository';
import { MemoryStoreService } from '../../core/memory-store.service';
import { QdrantVectorService } from '../../qdrant/qdrant-vector.service';
import type { QdrantPoint } from '../../qdrant/qdrant-vector.types';
import { ContradictionResolverService } from '../reconciliation/contradiction-resolver.service';
import { MemoryExtractorV2Service, type MemoryExtractionResult } from './memory-extractor-v2.service';
import { KgAutoUpdateService } from '../../knowledge-graph/sync/kg-auto-update.service';
import {
  normalizeForDedup,
  jaccardSimilarity,
  extractSignificantTokens,
  significantTokenOverlap,
} from '../reconciliation/dedup-utils';

export interface CaptureResult {
  created: MemoryEntry[];
  superseded: string[];    // IDs of entries that were superseded
  invalidated: string[];   // IDs of entries that were invalidated
}

@Injectable()
export class AutoCaptureService {
  private readonly logger = new Logger(AutoCaptureService.name);

  constructor(
    private readonly extractor: MemoryExtractorV2Service,
    private readonly store: MemoryStoreService,
    private readonly contradictionResolver: ContradictionResolverService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantVectorService,
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
    @Optional() private readonly kgAutoUpdate?: KgAutoUpdateService,
  ) {}

  /**
   * Extract and store memories from a conversation turn.
   * Called after each assistant response.
   */
  async captureFromTurn(
    userMessage: string,
    assistantResponse: string,
    conversationId?: string,
    messageId?: string,
    scopeKey?: string,
  ): Promise<CaptureResult> {
    const result: CaptureResult = { created: [], superseded: [], invalidated: [] };

    const extraction = await this.extractor.extractFromTurn(userMessage, assistantResponse);
    if (!extraction) return result;

    // Process invalidations first
    await this.processInvalidations(extraction, result, scopeKey);

    // Process new items with contradiction checking
    await this.processNewItems(extraction, conversationId, messageId, result, scopeKey);

    // Embed new entries in Qdrant
    await this.embedEntries(result.created);

    // Update knowledge graph (fire-and-forget)
    this.fireAndForgetKgUpdate(result.created);

    this.logger.debug(
      `Capture: created=${result.created.length}, superseded=${result.superseded.length}, invalidated=${result.invalidated.length}`,
    );

    return result;
  }

  /**
   * Session-end deep reflection.
   */
  async captureFromSessionReflection(sessionSummary: string, scopeKey?: string): Promise<CaptureResult> {
    const result: CaptureResult = { created: [], superseded: [], invalidated: [] };

    const extraction = await this.extractor.reflectOnSession(sessionSummary);
    if (!extraction) return result;

    for (const item of extraction.items) {
      const params: CreateMemoryEntryParams = {
        kind: item.kind,
        content: item.content,
        source: 'agent_reflection',
        category: item.category,
        tags: item.tags,
        importance: item.importance,
        scopeKey,
      };
      const entry = await this.store.create(params);
      result.created.push(entry);
    }

    await this.embedEntries(result.created);

    // Update knowledge graph (fire-and-forget)
    this.fireAndForgetKgUpdate(result.created);

    return result;
  }

  // ─── Invalidations ────────────────────────────────────────────────────

  private async processInvalidations(
    extraction: MemoryExtractionResult,
    result: CaptureResult,
    scopeKey?: string,
  ): Promise<void> {
    for (const inv of extraction.invalidations) {
      // Find entries matching the content pattern
      const candidates = await this.repo.query({
        ...(inv.kind ? { kinds: [inv.kind] } : {}),
        ...(scopeKey ? { scopeKey } : {}),
        excludeSuperseded: true,
        limit: 10,
      });

      const pattern = inv.contentPattern.toLowerCase();
      const matches = candidates.filter((e) =>
        e.content.toLowerCase().includes(pattern),
      );

      for (const match of matches) {
        await this.store.update(match.id, {
          supersededBy: 'invalidated',
        });
        result.invalidated.push(match.id);
        this.logger.debug(`Invalidated memory ${match.id}: "${inv.reason}"`);
      }
    }
  }

  // ─── New Items ────────────────────────────────────────────────────────

  private async processNewItems(
    extraction: MemoryExtractionResult,
    conversationId: string | undefined,
    messageId: string | undefined,
    result: CaptureResult,
    scopeKey?: string,
  ): Promise<void> {
    for (const item of extraction.items) {
      // Check for contradictions with existing entries of the same kind
      const existing = await this.repo.query({
        kinds: [item.kind],
        ...(scopeKey ? { scopeKey } : {}),
        excludeSuperseded: true,
        limit: 20,
      });

      // Near-duplicate check: skip if an existing entry has very similar content
      if (this.isNearDuplicate(existing, item.content)) {
        this.logger.debug(`Skipped near-duplicate: "${item.content.slice(0, 60)}"`);
        continue;
      }

      const conflicts = await this.contradictionResolver.findConflicts(
        existing,
        item.content,
        item.kind,
        item.category,
      );

      const params: CreateMemoryEntryParams = {
        kind: item.kind,
        content: item.content,
        source: 'llm_extraction',
        category: item.category,
        tags: item.tags,
        importance: item.importance,
        scopeKey,
        provenance: {
          conversationId,
          messageId,
          timestamp: new Date().toISOString(),
        },
      };

      if (conflicts.length === 0) {
        // No conflict — just create
        const entry = await this.store.create(params);
        result.created.push(entry);
      } else {
        // Handle first actionable conflict only (avoid duplicating the same item)
        for (const conflict of conflicts) {
          if (!conflict.resolution) continue;

          switch (conflict.resolution.action) {
            case 'keep_new': {
              const entry = await this.store.supersede(conflict.existingEntry.id, params);
              if (entry) {
                result.created.push(entry);
                result.superseded.push(conflict.existingEntry.id);
              }
              break;
            }
            case 'keep_old':
              this.logger.debug(`Discarded new memory (keep_old): "${item.content.slice(0, 60)}"`);
              break;
            case 'merge': {
              const mergedParams = { ...params, content: conflict.resolution.merged };
              const entry = await this.store.supersede(conflict.existingEntry.id, mergedParams);
              if (entry) {
                result.created.push(entry);
                result.superseded.push(conflict.existingEntry.id);
              }
              break;
            }
            case 'keep_both': {
              const entry = await this.store.create(params);
              result.created.push(entry);
              break;
            }
          }
          // One resolution per extracted item — stop after first actionable conflict
          break;
        }
      }
    }
  }

  // ─── Near-duplicate detection ──────────────────────────────────────────

  private isNearDuplicate(existing: MemoryEntry[], newContent: string): boolean {
    const normalizedNew = normalizeForDedup(newContent);
    if (normalizedNew.length < 5) return false;

    const sigNew = extractSignificantTokens(newContent);

    for (const entry of existing) {
      const normalizedExisting = normalizeForDedup(entry.content);

      // Exact match after normalization
      if (normalizedNew === normalizedExisting) return true;

      // Substring containment (one fully contains the other)
      if (normalizedNew.length >= 10 && normalizedExisting.length >= 10) {
        if (normalizedNew.includes(normalizedExisting) || normalizedExisting.includes(normalizedNew)) {
          return true;
        }
      }

      // High token overlap for short entries
      if (normalizedNew.length < 100 && normalizedExisting.length < 100) {
        const similarity = jaccardSimilarity(normalizedNew, normalizedExisting);
        if (similarity >= 0.8) return true;
      }

      // Cross-language dedup: compare significant tokens (proper nouns, tech terms)
      if (sigNew.size >= 2) {
        const sigExisting = extractSignificantTokens(entry.content);
        if (sigExisting.size >= 2) {
          const sigOverlap = significantTokenOverlap(sigNew, sigExisting);
          if (sigOverlap >= 0.7) return true;
        }
      }
    }

    return false;
  }

  // ─── Embedding ────────────────────────────────────────────────────────

  private async embedEntries(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (!this.qdrantService.isReady() || !this.embeddingService.isAvailable()) return;

    try {
      const texts = entries.map((e) => `[${e.kind}] ${e.content}`);
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

      // Update embeddingId on entries
      for (const entry of entries) {
        await this.store.update(entry.id, { embeddingId: entry.id });
      }

      this.logger.debug(`Embedded ${points.length} entries in Qdrant`);
    } catch (error) {
      this.logger.warn(`Failed to embed entries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Backfill embeddings for all active entries that don't have one yet.
   * Safe to call multiple times — skips already-embedded entries.
   */
  async backfillEmbeddings(): Promise<{ embedded: number; skipped: number }> {
    if (!this.qdrantService.isReady() || !this.embeddingService.isAvailable()) {
      this.logger.warn('Backfill skipped: embedding or Qdrant not available');
      return { embedded: 0, skipped: 0 };
    }

    const allEntries = await this.repo.query({ excludeSuperseded: true, limit: 1000 });
    const toEmbed = allEntries.filter((e) => !e.embeddingId);

    if (toEmbed.length === 0) {
      this.logger.log('Backfill: all entries already embedded');
      return { embedded: 0, skipped: allEntries.length };
    }

    const BATCH = 32;
    let embedded = 0;

    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const batch = toEmbed.slice(i, i + BATCH);
      await this.embedEntries(batch);
      embedded += batch.length;
      this.logger.log(`Backfill progress: ${embedded}/${toEmbed.length}`);
    }

    this.logger.log(`Backfill complete: embedded=${embedded}, skipped=${allEntries.length - toEmbed.length}`);
    return { embedded, skipped: allEntries.length - toEmbed.length };
  }

  // ─── Knowledge Graph ───────────────────────────────────────────────────

  private fireAndForgetKgUpdate(entries: MemoryEntry[]): void {
    if (!this.kgAutoUpdate || entries.length === 0) return;

    this.kgAutoUpdate.processEntries(entries).catch((err) => {
      this.logger.warn(`KG auto-update failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
