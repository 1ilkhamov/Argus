import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { LlmService } from '../../llm/llm.service';
import type { LlmMessage } from '../../llm/interfaces/llm.interface';
import type {
  MemoryEntry,
  MemoryKind,
} from '../core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../core/memory-entry.repository';
import { MemoryStoreService } from '../core/memory-store.service';
import { QdrantVectorService } from '../qdrant/qdrant-vector.service';

// ─── Config ──────────────────────────────────────────────────────────────────

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day baseline
const PROMOTION_ACCESS_THRESHOLD = 5;
const PROMOTION_IMPORTANCE_THRESHOLD = 0.6;
const PRUNING_IMPORTANCE_THRESHOLD = 0.05;
const PRUNING_SUPERSEDED_AGE_DAYS = 7;
const CONSOLIDATION_MIN_ENTRIES = 3;
const CONSOLIDATION_MAX_TOKENS = 600;
const CONSOLIDATION_TEMPERATURE = 0.2;

const CONSOLIDATION_PROMPT = `You are a memory consolidation engine. Given multiple memory entries of the same kind, merge them into a single concise entry that preserves the most important information.

Rules:
- Preserve distinct facts, don't lose unique details
- Remove exact duplicates and redundancy
- Prefer the most recent information when entries contradict
- Output a single consolidated text (under 300 chars)
- Respond ONLY with the consolidated text, no JSON, no markdown`;

// ─── Result types ────────────────────────────────────────────────────────────

export interface LifecycleRunResult {
  decayed: number;
  promoted: number;
  pruned: number;
  consolidated: number;
}

export interface ConsolidationV2Result {
  kind: MemoryKind;
  category?: string;
  originalIds: string[];
  consolidatedContent: string;
  method: 'llm' | 'heuristic';
}

@Injectable()
export class MemoryLifecycleV2Service {
  private readonly logger = new Logger(MemoryLifecycleV2Service.name);

  constructor(
    private readonly store: MemoryStoreService,
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
    private readonly qdrantService: QdrantVectorService,
    @Optional() private readonly llmService?: LlmService,
  ) {}

  /**
   * Run a full lifecycle pass: decay → promote → consolidate → prune.
   */
  async runFullCycle(): Promise<LifecycleRunResult> {
    const decayed = await this.applyDecay();
    const promoted = await this.applyPromotion();
    const consolidated = await this.applyConsolidation();
    const pruned = await this.applyPruning();

    this.logger.debug(
      `Lifecycle: decayed=${decayed}, promoted=${promoted}, consolidated=${consolidated}, pruned=${pruned}`,
    );

    return { decayed, promoted, consolidated, pruned };
  }

  // ─── Decay ──────────────────────────────────────────────────────────────

  /**
   * Apply importance decay to short_term entries based on their decayRate and age.
   * importance_new = importance * (1 - decayRate)^days_since_update
   * Access recency bonus: +0.02 per access in last 7 days.
   */
  async applyDecay(): Promise<number> {
    const entries = await this.repo.query({
      horizons: ['short_term'],
      excludeSuperseded: true,
    });

    const now = Date.now();
    let count = 0;

    for (const entry of entries) {
      if (entry.pinned || entry.decayRate === 0) continue;

      const ageMs = now - new Date(entry.updatedAt).getTime();
      const ageDays = ageMs / DECAY_INTERVAL_MS;
      if (ageDays < 1) continue; // skip entries less than a day old

      const decayFactor = Math.pow(1 - entry.decayRate, ageDays);
      let newImportance = entry.importance * decayFactor;

      // Access recency bonus
      if (entry.lastAccessedAt) {
        const accessAgeMs = now - new Date(entry.lastAccessedAt).getTime();
        const accessAgeDays = accessAgeMs / DECAY_INTERVAL_MS;
        if (accessAgeDays < 7) {
          newImportance += 0.02 * entry.accessCount;
        }
      }

      newImportance = Math.max(0, Math.min(1, newImportance));

      if (Math.abs(newImportance - entry.importance) > 0.001) {
        await this.store.update(entry.id, { importance: newImportance });
        count++;
      }
    }

    return count;
  }

  // ─── Promotion ──────────────────────────────────────────────────────────

  /**
   * Promote short_term entries to long_term if they've been accessed enough
   * and have sufficiently high importance.
   */
  async applyPromotion(): Promise<number> {
    const entries = await this.repo.query({
      horizons: ['short_term'],
      excludeSuperseded: true,
      minImportance: PROMOTION_IMPORTANCE_THRESHOLD,
    });

    let count = 0;

    for (const entry of entries) {
      if (entry.accessCount >= PROMOTION_ACCESS_THRESHOLD) {
        await this.store.update(entry.id, { horizon: 'long_term' });
        count++;
        this.logger.debug(
          `Promoted ${entry.id} [${entry.kind}] to long_term (access=${entry.accessCount}, importance=${entry.importance.toFixed(2)})`,
        );
      }
    }

    return count;
  }

  // ─── Consolidation ──────────────────────────────────────────────────────

  /**
   * Consolidate similar entries of the same kind+category
   * when there are too many (>CONSOLIDATION_MIN_ENTRIES).
   */
  async applyConsolidation(): Promise<number> {
    const entries = await this.repo.query({
      horizons: ['long_term'],
      excludeSuperseded: true,
    });

    // Group by scopeKey+kind+category to ensure tenant isolation
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      if (entry.pinned) continue;
      const key = `${entry.scopeKey}:${entry.kind}:${entry.category ?? '_'}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }

    let totalConsolidated = 0;

    for (const [, group] of groups) {
      if (group.length < CONSOLIDATION_MIN_ENTRIES) continue;

      // Sort oldest first, consolidate the oldest entries
      group.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const toConsolidate = group.slice(0, group.length - 1); // keep newest
      if (toConsolidate.length < 2) continue;

      const result = await this.consolidateGroup(toConsolidate);
      if (!result) continue;

      // Create consolidated entry with provenance back to originals
      // Inherit scopeKey from source entries (all same scope due to grouping)
      const consolidatedEntry = await this.store.create({
        kind: result.kind,
        content: result.consolidatedContent,
        source: 'consolidation',
        scopeKey: toConsolidate[0]!.scopeKey,
        category: result.category,
        tags: [...new Set(toConsolidate.flatMap((e) => e.tags))].slice(0, 10),
        horizon: 'long_term',
        importance: Math.max(...toConsolidate.map((e) => e.importance)),
        consolidatedFrom: result.originalIds,
      });

      // Mark originals as superseded by the real consolidated entry ID
      for (const entry of toConsolidate) {
        await this.store.update(entry.id, { supersededBy: consolidatedEntry.id });
      }

      totalConsolidated += toConsolidate.length;
      this.logger.debug(
        `Consolidated ${toConsolidate.length} ${result.kind} entries: "${result.consolidatedContent.slice(0, 80)}"`,
      );
    }

    return totalConsolidated;
  }

  private async consolidateGroup(entries: MemoryEntry[]): Promise<ConsolidationV2Result | undefined> {
    if (entries.length < 2) return undefined;

    const kind = entries[0]!.kind;
    const category = entries[0]!.category;

    if (this.llmService) {
      try {
        return await this.consolidateWithLlm(entries, kind, category);
      } catch (error) {
        this.logger.warn(`LLM consolidation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return this.consolidateHeuristic(entries, kind, category);
  }

  private async consolidateWithLlm(
    entries: MemoryEntry[],
    kind: MemoryKind,
    category: string | undefined,
  ): Promise<ConsolidationV2Result> {
    const list = entries
      .map((e, i) => `${i + 1}. [${e.kind}] ${e.content}`)
      .join('\n');

    const messages: LlmMessage[] = [
      { role: 'system', content: CONSOLIDATION_PROMPT },
      { role: 'user', content: `Consolidate these ${kind} memories:\n\n${list}` },
    ];

    const result = await this.llmService!.complete(messages, {
      maxTokens: CONSOLIDATION_MAX_TOKENS,
      temperature: CONSOLIDATION_TEMPERATURE,
    });

    return {
      kind,
      category,
      originalIds: entries.map((e) => e.id),
      consolidatedContent: result.content.trim().slice(0, 500),
      method: 'llm',
    };
  }

  private consolidateHeuristic(
    entries: MemoryEntry[],
    kind: MemoryKind,
    category: string | undefined,
  ): ConsolidationV2Result {
    // Pick the most important / most recent entry as representative
    const sorted = entries.slice().sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    return {
      kind,
      category,
      originalIds: entries.map((e) => e.id),
      consolidatedContent: sorted[0]!.content.slice(0, 500),
      method: 'heuristic',
    };
  }

  // ─── Pruning ────────────────────────────────────────────────────────────

  /**
   * Remove entries that are:
   * 1. Superseded and older than PRUNING_SUPERSEDED_AGE_DAYS
   * 2. Non-pinned with importance below threshold
   */
  async applyPruning(): Promise<number> {
    const now = Date.now();
    const cutoffMs = PRUNING_SUPERSEDED_AGE_DAYS * DECAY_INTERVAL_MS;

    // 1. Old superseded entries
    const superseded = await this.repo.query({});
    const toDelete: string[] = [];

    for (const entry of superseded) {
      if (!entry.supersededBy) continue;
      const ageMs = now - new Date(entry.updatedAt).getTime();
      if (ageMs > cutoffMs) {
        toDelete.push(entry.id);
      }
    }

    // 2. Near-zero importance non-pinned short_term entries
    const lowImportance = await this.repo.query({
      horizons: ['short_term'],
      excludeSuperseded: true,
    });

    for (const entry of lowImportance) {
      if (entry.pinned) continue;
      if (entry.importance < PRUNING_IMPORTANCE_THRESHOLD) {
        toDelete.push(entry.id);
      }
    }

    if (toDelete.length === 0) return 0;

    const uniqueIds = [...new Set(toDelete)];
    const deleted = await this.repo.deleteBatch(uniqueIds);

    // Also remove from Qdrant
    if (this.qdrantService.isReady()) {
      try {
        await this.qdrantService.deletePoints(uniqueIds);
      } catch (error) {
        this.logger.warn(`Failed to prune vectors: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return deleted;
  }
}
