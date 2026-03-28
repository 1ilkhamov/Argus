import { Injectable, Logger } from '@nestjs/common';

import type { MemoryEntry } from '../../core/memory-entry.types';
import { KnowledgeGraphService } from '../knowledge-graph.service';

// Kinds that are worth extracting entities from
const EXTRACTABLE_KINDS = new Set<string>(['fact', 'episode', 'learning', 'skill']);

// Minimum content length to attempt extraction
const MIN_CONTENT_LENGTH = 15;

@Injectable()
export class KgAutoUpdateService {
  private readonly logger = new Logger(KgAutoUpdateService.name);

  constructor(private readonly kgService: KnowledgeGraphService) {}

  /**
   * Process newly created memory entries and extract KG entities/relations.
   * Designed to be called fire-and-forget after auto-capture.
   */
  async processEntries(entries: MemoryEntry[]): Promise<void> {
    const extractable = entries.filter(
      (e) => EXTRACTABLE_KINDS.has(e.kind) && e.content.length >= MIN_CONTENT_LENGTH,
    );

    if (extractable.length === 0) return;

    for (const entry of extractable) {
      try {
        const text = this.buildExtractionText(entry);
        const result = await this.kgService.extractAndUpsert(text);

        if (result.nodes.length > 0 || result.edges.length > 0) {
          this.logger.debug(
            `KG auto-update for ${entry.id} [${entry.kind}]: ${result.nodes.length} nodes, ${result.edges.length} edges`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `KG auto-update failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Process a single entry.
   */
  async processEntry(entry: MemoryEntry): Promise<void> {
    return this.processEntries([entry]);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private buildExtractionText(entry: MemoryEntry): string {
    const parts: string[] = [];

    parts.push(`[${entry.kind}]`);
    if (entry.category) parts.push(`(${entry.category})`);
    parts.push(entry.content);

    if (entry.tags.length > 0) {
      parts.push(`Tags: ${entry.tags.join(', ')}`);
    }

    return parts.join(' ');
  }
}
