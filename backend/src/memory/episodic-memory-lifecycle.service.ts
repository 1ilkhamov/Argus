import { Injectable } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import { mergeStructuredMemoryProvenance } from './structured-memory-metadata';
import type {
  EpisodicMemoryEntry,
  EpisodicMemoryEntryRevision,
  EpisodicMemoryKind,
} from './episodic-memory.types';
import { EPISODIC_MEMORY_KIND_ORDER } from './episodic-memory.types';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'for',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'we',
  'with',
  'я',
  'мы',
  'мне',
  'моя',
  'мой',
  'мои',
  'и',
  'в',
  'на',
  'не',
  'что',
  'это',
  'как',
  'по',
  'для',
  'с',
  'над',
  'про',
]);

@Injectable()
export class EpisodicMemoryLifecycleService {
  private static readonly MAX_STORED_ENTRIES = 24;
  private static readonly MIN_STORED_SALIENCE = 0.3;
  private static readonly MIN_PROMPT_SALIENCE = 0.55;
  private static readonly MIN_PROMPT_SCORE = 0.8;
  private static readonly MAX_PROMPT_ENTRIES = 3;

  prepareEntriesForStorage(entries: EpisodicMemoryEntry[], now = new Date()): EpisodicMemoryEntry[] {
    const entryMap = new Map<string, EpisodicMemoryEntry>();

    for (const entry of entries) {
      const normalizedEntry = this.normalizeEntry(entry);
      const key = this.toLifecycleKey(normalizedEntry.kind, normalizedEntry.summary);
      const existing = entryMap.get(key);
      entryMap.set(key, existing ? this.mergeEntries(existing, normalizedEntry) : normalizedEntry);
    }

    return Array.from(entryMap.values())
      .filter((entry) => this.shouldRetainForStorage(entry, now))
      .sort((left, right) => this.calculateStorageScore(right, now) - this.calculateStorageScore(left, now))
      .slice(0, EpisodicMemoryLifecycleService.MAX_STORED_ENTRIES)
      .sort((left, right) => {
        const kindOrder =
          EPISODIC_MEMORY_KIND_ORDER.indexOf(left.kind) - EPISODIC_MEMORY_KIND_ORDER.indexOf(right.kind);
        if (kindOrder !== 0) {
          return kindOrder;
        }

        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  selectPromptEntries(
    entries: EpisodicMemoryEntry[],
    conversation?: Conversation,
    now = new Date(),
  ): EpisodicMemoryEntry[] {
    const queryTokens = this.buildQueryTokens(conversation);

    return entries
      .map((entry) => {
        const overlap = this.calculateOverlap(entry, queryTokens);
        return {
          entry: {
            ...entry,
            salience: this.getEffectiveSalience(entry, now),
          },
          overlap,
          score: this.calculatePromptScore(entry, queryTokens, now, overlap),
        };
      })
      .filter(
        (item) =>
          item.entry.salience >= EpisodicMemoryLifecycleService.MIN_PROMPT_SALIENCE &&
          item.score >= EpisodicMemoryLifecycleService.MIN_PROMPT_SCORE,
      )
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (right.overlap !== left.overlap) {
          return right.overlap - left.overlap;
        }

        const kindPriority =
          EPISODIC_MEMORY_KIND_ORDER.indexOf(left.entry.kind) - EPISODIC_MEMORY_KIND_ORDER.indexOf(right.entry.kind);
        if (kindPriority !== 0) {
          return kindPriority;
        }

        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
      })
      .slice(0, EpisodicMemoryLifecycleService.MAX_PROMPT_ENTRIES)
      .map((item) => item.entry);
  }

  private mergeEntries(existing: EpisodicMemoryEntry, incoming: EpisodicMemoryEntry): EpisodicMemoryEntry {
    const latest = this.getTimestamp(incoming.updatedAt) >= this.getTimestamp(existing.updatedAt) ? incoming : existing;
    const revision = Math.max(existing.revision ?? 1, incoming.revision ?? 1);

    return {
      ...latest,
      id: existing.id,
      pinned: existing.pinned || incoming.pinned || undefined,
      salience: this.roundSalience(
        Math.max(existing.salience, incoming.salience) + this.getReinforcementBoost(incoming.kind),
      ),
      revision,
      revisionHistory: this.mergeRevisionHistories(existing.revisionHistory, incoming.revisionHistory),
      provenance: mergeStructuredMemoryProvenance(existing.provenance, incoming.provenance),
    };
  }

  private calculateStorageScore(entry: EpisodicMemoryEntry, now: Date): number {
    return this.getEffectiveSalience(entry, now) + this.getImportanceBonus(entry.kind) + this.getPinnedBonus(entry);
  }

  private calculatePromptScore(
    entry: EpisodicMemoryEntry,
    queryTokens: Set<string>,
    now: Date,
    overlap = this.calculateOverlap(entry, queryTokens),
  ): number {
    let score =
      this.getEffectiveSalience(entry, now) + this.getImportanceBonus(entry.kind) + this.getPinnedBonus(entry);
    score += Math.min(0.36, overlap * 0.14);

    if (queryTokens.size > 0 && overlap === 0 && !entry.pinned) {
      score -= this.getIrrelevancePenalty(entry.kind);
    }

    return this.roundSalience(score);
  }

  private shouldRetainForStorage(entry: EpisodicMemoryEntry, now: Date): boolean {
    const ageInDays = this.getAgeInDays(entry.updatedAt, now);
    if (ageInDays > this.getHardRetentionDays(entry.kind)) {
      return Boolean(entry.pinned);
    }

    return entry.pinned || this.getEffectiveSalience(entry, now) >= EpisodicMemoryLifecycleService.MIN_STORED_SALIENCE;
  }

  private getEffectiveSalience(entry: EpisodicMemoryEntry, now: Date): number {
    const ageInDays = this.getAgeInDays(entry.updatedAt, now);
    const multiplier = this.getFreshnessMultiplier(entry.kind, ageInDays);
    return this.roundSalience(entry.salience * multiplier);
  }

  private getFreshnessMultiplier(kind: EpisodicMemoryKind, ageInDays: number): number {
    switch (kind) {
      case 'goal':
        if (ageInDays <= 30) {
          return 1;
        }
        if (ageInDays <= 120) {
          return 0.75;
        }
        return 0.45;
      case 'constraint':
        if (ageInDays <= 60) {
          return 1;
        }
        if (ageInDays <= 180) {
          return 0.8;
        }
        return 0.55;
      case 'decision':
        if (ageInDays <= 90) {
          return 1;
        }
        if (ageInDays <= 210) {
          return 0.75;
        }
        return 0.5;
      case 'task':
        if (ageInDays <= 14) {
          return 1;
        }
        if (ageInDays <= 45) {
          return 0.65;
        }
        return 0.35;
    }
  }

  private getImportanceBonus(kind: EpisodicMemoryKind): number {
    switch (kind) {
      case 'goal':
        return 0.24;
      case 'constraint':
        return 0.22;
      case 'decision':
        return 0.16;
      case 'task':
        return 0.08;
    }
  }

  private getIrrelevancePenalty(kind: EpisodicMemoryKind): number {
    switch (kind) {
      case 'task':
        return 0.35;
      case 'decision':
        return 0.18;
      case 'constraint':
        return 0.08;
      case 'goal':
        return 0.05;
    }
  }

  private getReinforcementBoost(kind: EpisodicMemoryKind): number {
    switch (kind) {
      case 'goal':
        return 0.06;
      case 'constraint':
        return 0.05;
      case 'decision':
        return 0.04;
      case 'task':
        return 0.03;
    }
  }

  private getHardRetentionDays(kind: EpisodicMemoryKind): number {
    switch (kind) {
      case 'task':
        return 120;
      default:
        return 365;
    }
  }

  private normalizeEntry(entry: EpisodicMemoryEntry): EpisodicMemoryEntry {
    return {
      ...entry,
      summary: entry.summary.replace(/\s+/g, ' ').trim(),
      pinned: entry.pinned || undefined,
      salience: this.roundSalience(entry.salience),
      provenance: entry.provenance,
      revision: entry.revision,
      revisionHistory: this.cloneRevisionHistory(entry.revisionHistory),
    };
  }

  private mergeRevisionHistories(
    left: EpisodicMemoryEntryRevision[] | undefined,
    right: EpisodicMemoryEntryRevision[] | undefined,
  ): EpisodicMemoryEntryRevision[] | undefined {
    const merged = [...(this.cloneRevisionHistory(left) ?? []), ...(this.cloneRevisionHistory(right) ?? [])];
    if (merged.length === 0) {
      return undefined;
    }

    const deduped = new Map<string, EpisodicMemoryEntryRevision>();
    for (const entry of merged) {
      deduped.set(`${entry.revision}:${entry.summary.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}:${entry.updatedAt}`, entry);
    }

    return Array.from(deduped.values())
      .sort((leftEntry, rightEntry) => leftEntry.revision - rightEntry.revision || leftEntry.updatedAt.localeCompare(rightEntry.updatedAt))
      .slice(-8);
  }

  private cloneRevisionHistory(
    history: EpisodicMemoryEntryRevision[] | undefined,
  ): EpisodicMemoryEntryRevision[] | undefined {
    if (!history || history.length === 0) {
      return undefined;
    }

    return history.map((entry) => ({
      revision: entry.revision,
      summary: entry.summary,
      salience: entry.salience,
      updatedAt: entry.updatedAt,
      provenance: entry.provenance
        ? {
            firstObservedAt: entry.provenance.firstObservedAt,
            lastObservedAt: entry.provenance.lastObservedAt,
            firstObservedIn: entry.provenance.firstObservedIn
              ? { ...entry.provenance.firstObservedIn }
              : undefined,
            lastObservedIn: entry.provenance.lastObservedIn
              ? { ...entry.provenance.lastObservedIn }
              : undefined,
          }
        : undefined,
    }));
  }

  private getPinnedBonus(entry: EpisodicMemoryEntry): number {
    return entry.pinned ? 0.24 : 0;
  }

  private toLifecycleKey(kind: EpisodicMemoryKind, summary: string): string {
    return `${kind}:${summary.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}`;
  }

  private buildQueryTokens(conversation?: Conversation): Set<string> {
    if (!conversation) {
      return new Set();
    }

    return this.tokenize(
      conversation.messages
        .filter((message) => message.role === 'user')
        .slice(-2)
        .map((message) => message.content)
        .join(' '),
    );
  }

  private calculateOverlap(entry: EpisodicMemoryEntry, queryTokens: Set<string>): number {
    if (queryTokens.size === 0) {
      return 0;
    }

    const entryTokens = this.tokenize(entry.summary);
    let overlap = 0;
    for (const token of entryTokens) {
      if (queryTokens.has(token)) {
        overlap += 1;
      }
    }

    return overlap;
  }

  private tokenize(value: string): Set<string> {
    return new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
    );
  }

  private getAgeInDays(updatedAt: string, now: Date): number {
    const timestamp = this.getTimestamp(updatedAt);
    return Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000));
  }

  private getTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private roundSalience(value: number): number {
    return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
  }
}
