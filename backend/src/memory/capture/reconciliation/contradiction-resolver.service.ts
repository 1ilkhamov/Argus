import { Injectable, Logger, Optional } from '@nestjs/common';

import { LlmService } from '../../../llm/llm.service';
import type { LlmMessage } from '../../../llm/interfaces/llm.interface';
import type { MemoryEntry } from '../../core/memory-entry.types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContradictionResolution =
  | { action: 'keep_new'; reason: string }        // new replaces old (supersede)
  | { action: 'keep_old'; reason: string }         // old is still valid, discard new
  | { action: 'merge'; merged: string; reason: string } // combine both into new content
  | { action: 'keep_both'; reason: string };       // both are valid (different contexts)

export interface ContradictionCheck {
  existingEntry: MemoryEntry;
  newContent: string;
  isContradiction: boolean;
  resolution?: ContradictionResolution;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const CONTRADICTION_PROMPT = `You are a memory consistency checker. Given an EXISTING memory entry and a NEW piece of information, determine if they contradict each other and how to resolve it.

Respond ONLY with valid JSON:
{
  "isContradiction": true/false,
  "action": "keep_new" | "keep_old" | "merge" | "keep_both",
  "merged": "...",  // only if action is "merge" — the combined content
  "reason": "brief explanation"
}

Rules:
- "keep_new" = new info replaces old (e.g., user changed jobs)
- "keep_old" = old info is still correct, new info is noise or error
- "merge" = both contain useful parts, combine them (provide merged text)
- "keep_both" = not actually contradictory, both valid in different contexts
- If isContradiction is false, action must be "keep_both"
- Be conservative: only flag as contradiction if they truly conflict`;

const MAX_RESOLUTION_TOKENS = 300;

@Injectable()
export class ContradictionResolverService {
  private readonly logger = new Logger(ContradictionResolverService.name);

  constructor(@Optional() private readonly llmService?: LlmService) {}

  isAvailable(): boolean {
    return this.llmService !== undefined && this.llmService !== null;
  }

  /**
   * Check if new content contradicts an existing entry and resolve.
   */
  async checkAndResolve(
    existingEntry: MemoryEntry,
    newContent: string,
  ): Promise<ContradictionCheck> {
    if (!this.isAvailable()) {
      return { existingEntry, newContent, isContradiction: false };
    }

    try {
      const messages: LlmMessage[] = [
        { role: 'system', content: CONTRADICTION_PROMPT },
        {
          role: 'user',
          content: `EXISTING [${existingEntry.kind}]: ${existingEntry.content}\n\nNEW: ${newContent}`,
        },
      ];

      const result = await this.llmService!.complete(messages, {
        maxTokens: MAX_RESOLUTION_TOKENS,
        temperature: 0.1,
      });

      return this.parseResolution(existingEntry, newContent, result.content);
    } catch (error) {
      this.logger.warn(`Contradiction check failed: ${error instanceof Error ? error.message : String(error)}`);
      return { existingEntry, newContent, isContradiction: false };
    }
  }

  /**
   * Find entries that might conflict with new content, using content similarity.
   */
  async findConflicts(
    existingEntries: MemoryEntry[],
    newContent: string,
    newKind: MemoryEntry['kind'],
    newCategory?: string,
  ): Promise<ContradictionCheck[]> {
    // Pre-filter: only check same-kind entries with some word overlap
    // Use lower threshold for short entries where word overlap is naturally small
    const isShort = newContent.length < 80;
    const minOverlap = isShort ? 1 : 2;

    // Same-category fallback only for kinds where supersession is meaningful.
    // Episodes are historical events — they don't cancel each other.
    const categoryFallbackKinds = new Set<string>(['fact', 'preference']);
    const useCategoryFallback = categoryFallbackKinds.has(newKind) && !!newCategory;

    const withOverlap: MemoryEntry[] = [];
    const categoryOnly: MemoryEntry[] = [];

    for (const entry of existingEntries) {
      if (entry.kind !== newKind) continue;
      if (entry.supersededBy) continue;

      if (this.hasWordOverlap(entry.content, newContent, minOverlap)) {
        withOverlap.push(entry);
      } else if (useCategoryFallback && entry.category && entry.category === newCategory) {
        categoryOnly.push(entry);
      }
    }

    // For preferences, category-only candidates are equally important because
    // semantic contradictions often lack word overlap (e.g., "warm tone" vs "no emotions").
    // Interleave them so both get fair coverage within the check limit.
    const candidates = useCategoryFallback
      ? this.interleave(withOverlap, categoryOnly)
      : [...withOverlap, ...categoryOnly];
    if (candidates.length === 0) return [];

    // Preferences and facts are typically few — allow more checks to catch semantic contradictions.
    // Other kinds (episode, action, learning) use the lower default to limit LLM cost.
    const maxChecks = categoryFallbackKinds.has(newKind) ? 10 : 5;
    const results: ContradictionCheck[] = [];

    for (const candidate of candidates.slice(0, maxChecks)) {
      const check = await this.checkAndResolve(candidate, newContent);
      if (check.isContradiction) {
        results.push(check);
      }
    }

    return results;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private interleave<T>(a: T[], b: T[]): T[] {
    const result: T[] = [];
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < a.length) result.push(a[i]!);
      if (i < b.length) result.push(b[i]!);
    }
    return result;
  }

  private hasWordOverlap(textA: string, textB: string, minOverlap: number): boolean {
    const wordsA = new Set(this.tokenize(textA));
    const wordsB = this.tokenize(textB);
    let overlap = 0;
    for (const word of wordsB) {
      if (wordsA.has(word)) overlap++;
      if (overlap >= minOverlap) return true;
    }
    return false;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  }

  private parseResolution(
    existingEntry: MemoryEntry,
    newContent: string,
    raw: string,
  ): ContradictionCheck {
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      const isContradiction = parsed.isContradiction === true;

      if (!isContradiction) {
        return { existingEntry, newContent, isContradiction: false };
      }

      const action = parsed.action as string;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'LLM resolution';

      let resolution: ContradictionResolution;
      switch (action) {
        case 'keep_new':
          resolution = { action: 'keep_new', reason };
          break;
        case 'keep_old':
          resolution = { action: 'keep_old', reason };
          break;
        case 'merge':
          resolution = {
            action: 'merge',
            merged: typeof parsed.merged === 'string' ? parsed.merged.trim() : newContent,
            reason,
          };
          break;
        default:
          resolution = { action: 'keep_both', reason };
      }

      return { existingEntry, newContent, isContradiction: true, resolution };
    } catch {
      return { existingEntry, newContent, isContradiction: false };
    }
  }
}
