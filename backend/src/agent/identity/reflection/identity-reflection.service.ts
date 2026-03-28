import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { LlmService } from '../../../llm/llm.service';
import type { LlmMessage } from '../../../llm/interfaces/llm.interface';
import type { MemoryEntry } from '../../../memory/core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';
import { MemoryStoreService } from '../../../memory/core/memory-store.service';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IdentityReflectionResult {
  contradictionsResolved: number;
  consolidated: number;
  promoted: number;
  pruned: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REFLECTION_MAX_ENTRIES = 30;
const REFLECTION_MAX_TOKENS = 800;
const REFLECTION_TEMPERATURE = 0.15;
const CONSOLIDATION_MIN_PER_CATEGORY = 3;
const LOW_IMPORTANCE_THRESHOLD = 0.3;
const PROMOTION_ACCESS_THRESHOLD = 3;

const CONTRADICTION_PROMPT = `You are an identity trait analyzer for an AI assistant. Given a list of identity traits for the same category, find contradictions — traits that give OPPOSITE behavioral guidance.

Rules:
- Only flag TRUE contradictions (e.g., "be verbose" vs "be concise"), not complementary traits
- Return the IDs of the WEAKER trait in each contradicting pair (the one to remove)
- If no contradictions exist, return empty array

Response format (strict JSON, no markdown):
{"remove_ids": ["id1", "id2"]}

If no contradictions: {"remove_ids": []}`;

const CONSOLIDATION_PROMPT = `You are an identity trait consolidator. Given multiple similar identity traits, merge them into one concise, actionable trait.

Rules:
- Preserve distinct behavioral guidance — don't lose unique aspects
- Remove redundancy and overlapping advice
- Output a single merged trait text (under 200 chars)
- Respond ONLY with the consolidated text, no JSON, no markdown`;

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class IdentityReflectionService {
  private readonly logger = new Logger(IdentityReflectionService.name);

  constructor(
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
    private readonly store: MemoryStoreService,
    @Optional() private readonly llmService?: LlmService,
  ) {}

  /**
   * Run a full identity reflection cycle for a given scope (or globally).
   * Called periodically by the lifecycle scheduler.
   *
   * Pipeline: resolve contradictions → consolidate similar → promote strong → prune weak
   */
  async reflect(scopeKey?: string): Promise<IdentityReflectionResult> {
    const result: IdentityReflectionResult = {
      contradictionsResolved: 0,
      consolidated: 0,
      promoted: 0,
      pruned: 0,
    };

    try {
      const entries = await this.repo.query({
        kinds: ['identity'],
        excludeSuperseded: true,
        limit: REFLECTION_MAX_ENTRIES,
        ...(scopeKey ? { scopeKey } : {}),
      });

      if (entries.length === 0) return result;

      // Group by category
      const grouped = this.groupByCategory(entries);

      // 1. Resolve contradictions within each category
      for (const [category, group] of grouped) {
        if (group.length < 2) continue;
        const resolved = await this.resolveContradictions(category, group);
        result.contradictionsResolved += resolved;
      }

      // Re-fetch after contradiction resolution (entries may have been superseded)
      const refreshed = await this.repo.query({
        kinds: ['identity'],
        excludeSuperseded: true,
        limit: REFLECTION_MAX_ENTRIES,
        ...(scopeKey ? { scopeKey } : {}),
      });
      const refreshedGrouped = this.groupByCategory(refreshed);

      // 2. Consolidate categories with too many entries
      for (const [, group] of refreshedGrouped) {
        if (group.length < CONSOLIDATION_MIN_PER_CATEGORY) continue;
        const consolidated = await this.consolidateGroup(group);
        result.consolidated += consolidated;
      }

      // 3. Promote strong identity traits (high access count)
      result.promoted = await this.promoteStrong(refreshed);

      // 4. Prune weak identity traits (low importance, no access)
      result.pruned = await this.pruneWeak(refreshed);

      if (result.contradictionsResolved + result.consolidated + result.promoted + result.pruned > 0) {
        this.logger.log(
          `Identity reflection: contradictions=${result.contradictionsResolved}, consolidated=${result.consolidated}, promoted=${result.promoted}, pruned=${result.pruned}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Identity reflection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  }

  // ─── Contradiction resolution ─────────────────────────────────────────

  private async resolveContradictions(category: string, entries: MemoryEntry[]): Promise<number> {
    if (!this.llmService || entries.length < 2) return 0;

    try {
      const list = entries
        .map((e) => `[${e.id}] ${e.content}`)
        .join('\n');

      const messages: LlmMessage[] = [
        { role: 'system', content: CONTRADICTION_PROMPT },
        { role: 'user', content: `Category: ${category}\n\nTraits:\n${list}` },
      ];

      const result = await this.llmService.complete(messages, {
        maxTokens: 200,
        temperature: REFLECTION_TEMPERATURE,
      });

      const parsed = this.parseContradictionResult(result.content, entries);
      if (parsed.length === 0) return 0;

      for (const id of parsed) {
        await this.store.update(id, { supersededBy: 'contradiction_resolved' });
        this.logger.debug(`Resolved contradicting identity trait: ${id}`);
      }

      return parsed.length;
    } catch (error) {
      this.logger.warn(
        `Contradiction resolution failed for ${category}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  private parseContradictionResult(raw: string, validEntries: MemoryEntry[]): string[] {
    try {
      const cleaned = raw.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed || !Array.isArray(parsed.remove_ids)) return [];

      const validIds = new Set(validEntries.map((e) => e.id));
      return (parsed.remove_ids as unknown[])
        .filter((id): id is string => typeof id === 'string' && validIds.has(id));
    } catch {
      return [];
    }
  }

  // ─── Consolidation ───────────────────────────────────────────────────

  private async consolidateGroup(entries: MemoryEntry[]): Promise<number> {
    if (entries.length < CONSOLIDATION_MIN_PER_CATEGORY) return 0;

    // Sort by importance (lowest first) — consolidate the weakest
    const sorted = [...entries].sort((a, b) => a.importance - b.importance);
    const toConsolidate = sorted.slice(0, sorted.length - 1); // keep the strongest
    if (toConsolidate.length < 2) return 0;

    const consolidatedContent = await this.mergeTraits(toConsolidate);
    if (!consolidatedContent) return 0;

    // Create consolidated entry
    const source = toConsolidate[0]!;
    await this.store.create({
      kind: 'identity',
      content: consolidatedContent,
      source: 'consolidation',
      scopeKey: source.scopeKey,
      category: source.category,
      tags: [...new Set(toConsolidate.flatMap((e) => e.tags))].slice(0, 10),
      importance: Math.max(...toConsolidate.map((e) => e.importance)),
      consolidatedFrom: toConsolidate.map((e) => e.id),
    });

    // Supersede originals
    for (const entry of toConsolidate) {
      await this.store.update(entry.id, { supersededBy: 'consolidated' });
    }

    return toConsolidate.length;
  }

  private async mergeTraits(entries: MemoryEntry[]): Promise<string | undefined> {
    if (this.llmService) {
      try {
        const list = entries.map((e, i) => `${i + 1}. ${e.content}`).join('\n');
        const messages: LlmMessage[] = [
          { role: 'system', content: CONSOLIDATION_PROMPT },
          { role: 'user', content: `Merge these identity traits:\n\n${list}` },
        ];

        const result = await this.llmService.complete(messages, {
          maxTokens: REFLECTION_MAX_TOKENS,
          temperature: REFLECTION_TEMPERATURE,
        });

        const text = result.content.trim().slice(0, 300);
        if (text.length >= 5) return text;
      } catch (error) {
        this.logger.warn(
          `LLM trait merge failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Heuristic fallback: pick the most important entry
    const best = entries.reduce((a, b) => (b.importance > a.importance ? b : a));
    return best.content;
  }

  // ─── Promotion ───────────────────────────────────────────────────────

  private async promoteStrong(entries: MemoryEntry[]): Promise<number> {
    let count = 0;

    for (const entry of entries) {
      if (entry.pinned) continue;
      if (entry.accessCount >= PROMOTION_ACCESS_THRESHOLD) {
        // "Promote" by increasing importance and making it long-term
        const newImportance = Math.min(1, entry.importance + 0.05);
        if (entry.horizon !== 'long_term' || newImportance > entry.importance) {
          await this.store.update(entry.id, {
            horizon: 'long_term',
            importance: newImportance,
          });
          count++;
        }
      }
    }

    return count;
  }

  // ─── Pruning ─────────────────────────────────────────────────────────

  private async pruneWeak(entries: MemoryEntry[]): Promise<number> {
    let count = 0;

    for (const entry of entries) {
      if (entry.pinned) continue;

      // Prune low-importance identity traits with no access
      if (entry.importance < LOW_IMPORTANCE_THRESHOLD && entry.accessCount === 0) {
        await this.store.update(entry.id, { supersededBy: 'pruned_weak' });
        count++;
        this.logger.debug(
          `Pruned weak identity trait: ${entry.id} (importance=${entry.importance.toFixed(2)})`,
        );
      }
    }

    return count;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private groupByCategory(entries: MemoryEntry[]): Map<string, MemoryEntry[]> {
    const grouped = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const cat = entry.category ?? 'personality';
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(entry);
    }
    return grouped;
  }
}
