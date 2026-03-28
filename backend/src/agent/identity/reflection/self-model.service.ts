import { Inject, Injectable, Logger } from '@nestjs/common';

import type { MemoryEntry, IdentityCategory } from '../../../memory/core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../../../memory/core/memory-entry.repository';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SelfModelSummary {
  strengths: string[];
  improving: string[];
  boundaries: string[];
  style: string[];
  values: string[];
  raw: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max entries to fetch per kind for the self-model computation */
const MAX_ENTRIES_PER_KIND = 15;
/** Max total length of the self-model raw text (tokens ≈ chars/4, budget ~200 tokens) */
const MAX_RAW_LENGTH = 800;

/** Maps identity categories to self-model facets */
const STRENGTH_CATEGORIES: IdentityCategory[] = ['expertise'];
const IMPROVING_CATEGORIES: IdentityCategory[] = ['weakness'];
const BOUNDARY_CATEGORIES: IdentityCategory[] = ['boundary'];
const STYLE_CATEGORIES: IdentityCategory[] = ['style', 'personality', 'relationship'];
const VALUE_CATEGORIES: IdentityCategory[] = ['value'];

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class SelfModelService {
  private readonly logger = new Logger(SelfModelService.name);

  constructor(
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
  ) {}

  /**
   * Build a self-model summary by aggregating identity, learning, and skill entries.
   * This is a pure computation — no new storage created.
   */
  async buildSelfModelSummary(scopeKey?: string): Promise<SelfModelSummary> {
    try {
      // Fetch identity + learning + skill entries in parallel
      const [identityEntries, learningEntries, skillEntries] = await Promise.all([
        this.repo.query({
          kinds: ['identity'],
          excludeSuperseded: true,
          limit: MAX_ENTRIES_PER_KIND,
          ...(scopeKey ? { scopeKey } : {}),
        }),
        this.repo.query({
          kinds: ['learning'],
          excludeSuperseded: true,
          limit: MAX_ENTRIES_PER_KIND,
          ...(scopeKey ? { scopeKey } : {}),
        }),
        this.repo.query({
          kinds: ['skill'],
          excludeSuperseded: true,
          limit: MAX_ENTRIES_PER_KIND,
          ...(scopeKey ? { scopeKey } : {}),
        }),
      ]);

      const strengths = this.extractStrengths(identityEntries, skillEntries);
      const improving = this.extractImproving(identityEntries, learningEntries);
      const boundaries = this.extractBoundaries(identityEntries);
      const style = this.extractStyle(identityEntries);
      const values = this.extractValues(identityEntries);

      const raw = this.renderRawSummary(strengths, improving, boundaries, style, values);

      return { strengths, improving, boundaries, style, values, raw };
    } catch (error) {
      this.logger.warn(
        `Self-model build failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { strengths: [], improving: [], boundaries: [], style: [], values: [], raw: '' };
    }
  }

  // ─── Facet extractors ────────────────────────────────────────────────

  private extractStrengths(identityEntries: MemoryEntry[], skillEntries: MemoryEntry[]): string[] {
    const fromIdentity = identityEntries
      .filter((e) => STRENGTH_CATEGORIES.includes(e.category as IdentityCategory))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map((e) => e.content);

    const fromSkills = skillEntries
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3)
      .map((e) => e.content);

    return this.dedup([...fromIdentity, ...fromSkills]).slice(0, 5);
  }

  private extractImproving(identityEntries: MemoryEntry[], learningEntries: MemoryEntry[]): string[] {
    const fromIdentity = identityEntries
      .filter((e) => IMPROVING_CATEGORIES.includes(e.category as IdentityCategory))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3)
      .map((e) => e.content);

    // Learnings that indicate something didn't work
    const fromLearnings = learningEntries
      .filter((e) => {
        const lower = e.content.toLowerCase();
        return lower.includes('не работа') || lower.includes('ошибк') ||
               lower.includes('failed') || lower.includes('wrong') ||
               lower.includes('mistake') || lower.includes('improve');
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3)
      .map((e) => e.content);

    return this.dedup([...fromIdentity, ...fromLearnings]).slice(0, 4);
  }

  private extractBoundaries(identityEntries: MemoryEntry[]): string[] {
    return identityEntries
      .filter((e) => BOUNDARY_CATEGORIES.includes(e.category as IdentityCategory))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 4)
      .map((e) => e.content);
  }

  private extractStyle(identityEntries: MemoryEntry[]): string[] {
    return identityEntries
      .filter((e) => STYLE_CATEGORIES.includes(e.category as IdentityCategory))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 4)
      .map((e) => e.content);
  }

  private extractValues(identityEntries: MemoryEntry[]): string[] {
    return identityEntries
      .filter((e) => VALUE_CATEGORIES.includes(e.category as IdentityCategory))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3)
      .map((e) => e.content);
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  private renderRawSummary(
    strengths: string[],
    improving: string[],
    boundaries: string[],
    style: string[],
    values: string[],
  ): string {
    const lines: string[] = [];

    if (strengths.length > 0) {
      lines.push(`Strong in: ${strengths.join('; ')}`);
    }
    if (improving.length > 0) {
      lines.push(`Improving: ${improving.join('; ')}`);
    }
    if (boundaries.length > 0) {
      lines.push(`Watch out: ${boundaries.join('; ')}`);
    }
    if (style.length > 0) {
      lines.push(`Communication style: ${style.join('; ')}`);
    }
    if (values.length > 0) {
      lines.push(`Priorities: ${values.join('; ')}`);
    }

    const raw = lines.join('\n');
    return raw.length > MAX_RAW_LENGTH ? raw.slice(0, MAX_RAW_LENGTH) + '…' : raw;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private dedup(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
      const normalized = item.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(item);
      }
    }
    return result;
  }
}
