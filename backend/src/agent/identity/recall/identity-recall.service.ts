import { Inject, Injectable, Logger } from '@nestjs/common';

import type { MemoryEntry } from '../../../memory/core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';
import { MemoryStoreService } from '../../../memory/core/memory-store.service';
import type { IdentityCategory } from '../../../memory/core/memory-entry.types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecalledIdentityTrait {
  entry: MemoryEntry;
  category: IdentityCategory;
}

export interface IdentityRecallResult {
  traits: RecalledIdentityTrait[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum identity entries to recall per scope. Safety cap to prevent prompt bloat. */
const MAX_IDENTITY_ENTRIES = 20;

/**
 * Category priority for prompt ordering.
 * Higher-priority categories appear first in the prompt so the LLM weights them more.
 */
const CATEGORY_PRIORITY: Record<IdentityCategory, number> = {
  boundary: 0,    // most critical — what NOT to do
  value: 1,       // prioritization rules
  style: 2,       // how to communicate
  personality: 3, // character traits
  relationship: 4,// user-agent dynamics
  expertise: 5,   // strengths
  weakness: 6,    // known failures
};

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class IdentityRecallService {
  private readonly logger = new Logger(IdentityRecallService.name);

  constructor(
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
    private readonly store: MemoryStoreService,
  ) {}

  /**
   * Recall all active identity traits for a given scope.
   * Unlike general recall, identity recall is NOT query-driven —
   * ALL identity traits for the user are always relevant.
   */
  async recall(scopeKey?: string): Promise<IdentityRecallResult> {
    try {
      const entries = await this.repo.query({
        kinds: ['identity'],
        excludeSuperseded: true,
        limit: MAX_IDENTITY_ENTRIES,
        ...(scopeKey ? { scopeKey } : {}),
      });

      if (entries.length === 0) {
        return { traits: [] };
      }

      // Sort by category priority, then by importance (desc), then by creation date (newest first)
      const sorted = [...entries].sort((a, b) => {
        const priorityA = CATEGORY_PRIORITY[a.category as IdentityCategory] ?? 99;
        const priorityB = CATEGORY_PRIORITY[b.category as IdentityCategory] ?? 99;
        if (priorityA !== priorityB) return priorityA - priorityB;
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.createdAt.localeCompare(a.createdAt);
      });

      const traits: RecalledIdentityTrait[] = sorted.map((entry) => ({
        entry,
        category: (entry.category as IdentityCategory) ?? 'personality',
      }));

      // Track access for lifecycle promotion
      const ids = traits.map((t) => t.entry.id);
      this.store.recordAccess(ids).catch((err) => {
        this.logger.warn(`recordAccess failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      this.logger.debug(
        `Identity recall: scope=${scopeKey ?? 'all'}, entries=${traits.length}`,
      );

      return { traits };
    } catch (error) {
      this.logger.warn(
        `Identity recall failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { traits: [] };
    }
  }
}
