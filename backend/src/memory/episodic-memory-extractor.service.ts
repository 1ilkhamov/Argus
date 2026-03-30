import { Injectable } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import type { Message } from '../chat/entities/message.entity';
import { isDeterministicMemoryCommandMessage } from './conversational-memory-command.matchers';
import {
  buildStructuredMemoryProvenance,
  ensureStructuredMemoryProvenance,
  mergeStructuredMemoryProvenance,
} from './structured-memory-metadata';
import type {
  EpisodicMemoryEntry,
  EpisodicMemoryEntryRevision,
  EpisodicMemoryKind,
} from './episodic-memory.types';
import { EPISODIC_MEMORY_KIND_ORDER } from './episodic-memory.types';

@Injectable()
export class EpisodicMemoryExtractorService {
  resolveMemories(
    conversation: Conversation,
    persistedEntries: EpisodicMemoryEntry[] = [],
  ): EpisodicMemoryEntry[] {
    const memoryMap = new Map<string, EpisodicMemoryEntry>();
    const invalidatedEntries = new Map<string, EpisodicMemoryEntry>();

    for (const entry of persistedEntries) {
      memoryMap.set(this.toMemoryMapKey(entry.kind, entry.summary), entry);
    }

    for (const message of conversation.messages) {
      if (message.role !== 'user') {
        continue;
      }

      if (isDeterministicMemoryCommandMessage(message.content)) {
        continue;
      }

      this.applyInvalidations(memoryMap, invalidatedEntries, message.content);

      let previousGoalCandidate: EpisodicMemoryEntry | undefined;

      for (const entry of this.extractMemoriesFromMessage(message)) {
        if (entry.kind === 'goal') {
          previousGoalCandidate = this.pickPreferredGoalEntry(Array.from(memoryMap.values()));
          this.clearEntriesByKind(memoryMap, 'goal');
        }

        const key = this.toMemoryMapKey(entry.kind, entry.summary);
        const existing = memoryMap.get(key) ?? invalidatedEntries.get(key) ?? (entry.kind === 'goal' ? previousGoalCandidate : undefined);
        const nextEntry = existing ? this.mergeObservedEntry(existing, entry) : entry;
        memoryMap.set(key, nextEntry);
        invalidatedEntries.delete(key);
        if (entry.kind === 'goal') {
          previousGoalCandidate = undefined;
        }
      }
    }

    return Array.from(memoryMap.values()).sort((left, right) => {
      const kindOrder =
        EPISODIC_MEMORY_KIND_ORDER.indexOf(left.kind) - EPISODIC_MEMORY_KIND_ORDER.indexOf(right.kind);
      if (kindOrder !== 0) {
        return kindOrder;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  private applyInvalidations(
    memoryMap: Map<string, EpisodicMemoryEntry>,
    invalidatedEntries: Map<string, EpisodicMemoryEntry>,
    content: string,
  ): void {
    this.maybeInvalidateEntries(memoryMap, invalidatedEntries, 'goal', this.extractGoalInvalidation(content));
    this.maybeInvalidateEntries(memoryMap, invalidatedEntries, 'constraint', this.extractConstraintInvalidation(content));
    this.maybeInvalidateEntries(memoryMap, invalidatedEntries, 'decision', this.extractDecisionInvalidation(content));
    this.maybeInvalidateEntries(memoryMap, invalidatedEntries, 'task', this.extractTaskInvalidation(content));
  }

  private maybeInvalidateEntries(
    memoryMap: Map<string, EpisodicMemoryEntry>,
    invalidatedEntries: Map<string, EpisodicMemoryEntry>,
    kind: EpisodicMemoryKind,
    targetSummary: string | undefined,
  ): void {
    if (!targetSummary) {
      return;
    }

    const normalizedTarget = this.normalizeForComparison(targetSummary);
    for (const [key, entry] of memoryMap.entries()) {
      if (entry.kind !== kind) {
        continue;
      }

      const normalizedSummary = this.normalizeForComparison(entry.summary);
      if (
        normalizedSummary === normalizedTarget ||
        normalizedSummary.includes(normalizedTarget) ||
        normalizedTarget.includes(normalizedSummary)
      ) {
        invalidatedEntries.set(key, entry);
        memoryMap.delete(key);
      }
    }
  }

  private clearEntriesByKind(memoryMap: Map<string, EpisodicMemoryEntry>, kind: EpisodicMemoryKind): void {
    for (const [key, entry] of memoryMap.entries()) {
      if (entry.kind === kind) {
        memoryMap.delete(key);
      }
    }
  }

  private extractMemoriesFromMessage(message: Message): EpisodicMemoryEntry[] {
    const extracted = new Map<EpisodicMemoryKind, EpisodicMemoryEntry>();
    const updatedAt = message.createdAt.toISOString();

    this.maybeSetMemory(extracted, 'goal', this.extractGoal(message.content), updatedAt, 0.95, message);
    this.maybeSetMemory(extracted, 'constraint', this.extractConstraint(message.content), updatedAt, 0.9, message);
    this.maybeSetMemory(extracted, 'decision', this.extractDecision(message.content), updatedAt, 0.85, message);
    this.maybeSetMemory(extracted, 'task', this.extractTask(message.content), updatedAt, 0.8, message);

    return Array.from(extracted.values());
  }

  private maybeSetMemory(
    extracted: Map<EpisodicMemoryKind, EpisodicMemoryEntry>,
    kind: EpisodicMemoryKind,
    summary: string | undefined,
    updatedAt: string,
    salience: number,
    message: Message,
  ): void {
    if (!summary) {
      return;
    }

    if (kind === 'goal' && this.hasNegativeActiveGoalLead(summary)) {
      return;
    }

    extracted.set(kind, {
      id: crypto.randomUUID(),
      kind,
      summary,
      source: 'explicit_user_statement',
      salience,
      updatedAt,
      provenance: buildStructuredMemoryProvenance(message),
      revision: 1,
    });
  }

  private mergeObservedEntry(existing: EpisodicMemoryEntry, incoming: EpisodicMemoryEntry): EpisodicMemoryEntry {
    const existingRevision = existing.revision ?? 1;
    const sameSummary = this.normalizeForComparison(existing.summary) === this.normalizeForComparison(incoming.summary);

    if (sameSummary) {
      const preferred = incoming.updatedAt.localeCompare(existing.updatedAt) >= 0 ? incoming : existing;

      return {
        ...preferred,
        id: existing.id,
        pinned: existing.pinned || incoming.pinned || undefined,
        salience: Math.max(existing.salience, incoming.salience),
        revision: existingRevision,
        revisionHistory: this.cloneRevisionHistory(existing.revisionHistory),
        updatedAt: preferred.updatedAt,
        provenance: mergeStructuredMemoryProvenance(
          existing.provenance,
          incoming.provenance,
          existing.updatedAt,
          incoming.updatedAt,
        ),
      };
    }

    return {
      ...incoming,
      id: existing.id,
      pinned: existing.pinned || incoming.pinned || undefined,
      revision: existingRevision + 1,
      revisionHistory: this.appendRevisionHistory(existing.revisionHistory, this.toEntryRevision(existing)),
      provenance: ensureStructuredMemoryProvenance(incoming.provenance, incoming.updatedAt),
    };
  }

  private toEntryRevision(entry: EpisodicMemoryEntry): EpisodicMemoryEntryRevision {
    return {
      revision: entry.revision ?? 1,
      summary: entry.summary,
      salience: entry.salience,
      updatedAt: entry.updatedAt,
      provenance: ensureStructuredMemoryProvenance(entry.provenance, entry.updatedAt),
    };
  }

  private appendRevisionHistory(
    history: EpisodicMemoryEntryRevision[] | undefined,
    revision: EpisodicMemoryEntryRevision,
  ): EpisodicMemoryEntryRevision[] {
    const nextHistory = [...(this.cloneRevisionHistory(history) ?? []), revision];
    return nextHistory.slice(-8);
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

  private pickPreferredGoalEntry(entries: EpisodicMemoryEntry[]): EpisodicMemoryEntry | undefined {
    return entries
      .filter((entry) => entry.kind === 'goal')
      .sort((left, right) => {
        const pinnedDifference = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
        if (pinnedDifference !== 0) {
          return pinnedDifference;
        }

        const updatedAtDifference = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedAtDifference !== 0) {
          return updatedAtDifference;
        }

        if (right.salience !== left.salience) {
          return right.salience - left.salience;
        }

        return left.id.localeCompare(right.id);
      })[0];
  }

  private extractGoal(content: string): string | undefined {
    return this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:my current goal is no longer|our current goal is no longer|my goal is no longer|our goal is no longer)\s+[^.!?\n]{4,160}[.!?\n]+\s*(?:now\s+)?(?:my|our)\s+(?:priority\s+goal|priority|main\s+focus|current\s+focus)(?:\s+is)?(?:\s*[—:-])?\s+([^.!?\n]{4,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:my priority goal is|my priority now is|our priority goal is|our priority now is|my current priority is|our current priority is)(?:\s*[—:-])?\s+([^.!?\n]{4,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:(?:сейчас|теперь)\s+(?:моя\s+)?приоритетная\s+цель(?:\s*[—:-])?|(?:моя\s+)?приоритетная\s+цель(?:\s*[—:-])?)\s+([^.!?\n]{4,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:my current goal is|our current goal is|my goal is|our goal is|my main focus is|our main focus is|my current focus is|our current focus is)\s+([^.!?\n]{4,160})/i,
      /(?:now\s+my main focus is|now\s+our main focus is|now\s+my current focus is|now\s+our current focus is)\s+([^.!?\n]{4,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:моя(?:\s+текущая)? цель(?:\s*[—:-])?|наша(?:\s+текущая)? цель(?:\s*[—:-])?|мой главный фокус(?:\s*[—:-])?|наш главный фокус(?:\s*[—:-])?|мой текущий фокус(?:\s*[—:-])?|наш текущий фокус(?:\s*[—:-])?)\s+([^.!?\n]{4,160})/i,
      /(?:теперь\s+мой главный фокус|теперь\s+наш главный фокус|теперь\s+мой текущий фокус|теперь\s+наш текущий фокус)(?:\s*[—:-])?\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractGoalInvalidation(content: string): string | undefined {
    return this.capture(content, [
      /\b(?:my current goal is no longer|our current goal is no longer|my goal is no longer|our goal is no longer|i no longer need to|we no longer need to)\s+([^.!?\n]{4,160})/i,
      /(?:моя(?:\s+текущая)? цель(?:\s+больше|\s+уже)? не|наша(?:\s+текущая)? цель(?:\s+больше|\s+уже)? не|мне больше не нужно|нам больше не нужно)\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractConstraint(content: string): string | undefined {
    const refinedConstraint = this.extractRefinedConstraint(content);
    if (refinedConstraint) {
      return refinedConstraint;
    }

    const negativeUse = this.capture(content, [
      /\b(?:we cannot|we can't|i cannot|i can't)\s+use\s+([^.!?\n]{4,160})/i,
      /\b(?:must not)\s+use\s+([^.!?\n]{4,160})/i,
      /\b([^.!?\n]{4,160})\s+must not be used\b/i,
      /(?:нельзя использовать|не можем использовать|не могу использовать)\s+([^.!?\n]{4,160})/i,
      /(?:мы не можем|я не могу)\s+использовать\s+([^.!?\n]{4,160})/i,
    ]);
    if (negativeUse) {
      return /[а-яё]/i.test(content) ? `нельзя использовать ${negativeUse}` : `cannot use ${negativeUse}`;
    }

    const englishNegativeAction = /\b(?:do not|don't|should not|shouldn't|must not|cannot|can't)\s+(bring|rely on|assume)\s+([^.!?\n]{4,160})/i.exec(content);
    if (englishNegativeAction) {
      const target = this.normalizeSummary(englishNegativeAction[2]);
      if (target) {
        return `must not ${englishNegativeAction[1]} ${target}`;
      }
    }

    const inverseEnglish = /\b([^.!?\n]{4,160})\s+(bring into|rely on|assume)\s+[^.!?\n]{0,40}\s+(?:is not allowed|must not happen)\b/i.exec(content);
    if (inverseEnglish) {
      const target = this.normalizeSummary(inverseEnglish[1]);
      if (target) {
        return `must not ${inverseEnglish[2]} ${target}`;
      }
    }

    const russianNegativeAction = /(?:нельзя|не нужно|не надо|не стоит)\s+(тащить|строить|полагаться на|делать)\s+([^.!?\n]{4,160})/i.exec(content);
    if (russianNegativeAction) {
      const target = this.normalizeSummary(russianNegativeAction[2]);
      if (target) {
        return `нельзя ${russianNegativeAction[1]} ${target}`;
      }
    }

    const inverseRussian = /(?:^|[.!?\n,;:]\s*)([^.!?\n]{2,160}?)\s+(тащить|использовать|строить|полагать(?:ся)?)\s+нельзя/i.exec(content);
    if (inverseRussian) {
      const target = this.normalizeSummary(inverseRussian[1]);
      if (target) {
        return `нельзя ${inverseRussian[2]} ${target}`;
      }
    }

    const genericNegative = this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:ограничение(?:\s*[—:-])?|у нас есть ограничение(?:\s*[—:-])?)\s+(нельзя\s+[^.!?\n]{4,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:constraint(?:\s*[—:-])?)\s+((?:cannot|must not|should not|don't)\s+[^.!?\n]{4,160})/i,
    ]);
    if (genericNegative) {
      return genericNegative;
    }

    const avoidance = this.capture(content, [
      /\b(?:need to avoid)\s+([^.!?\n]{4,160})/i,
      /(?:нужно избегать)\s+([^.!?\n]{4,160})/i,
    ]);
    if (avoidance) {
      return /[а-яё]/i.test(content) ? `избегать ${avoidance}` : `avoid ${avoidance}`;
    }

    return this.capture(content, [
      /(?:нужно сохранить|должны сохранить)\s+([^.!?\n]{4,160})/i,
      /\b(?:must keep)\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractConstraintInvalidation(content: string): string | undefined {
    const refinedSubject = this.extractConstraintSubject(content);
    if (refinedSubject) {
      return refinedSubject;
    }

    return this.capture(content, [
      /\b(?:we can use|i can use|we no longer need to avoid|i no longer need to avoid)\s+([^.!?\n]{4,160})/i,
      /(?:мы можем использовать|я могу использовать|больше не нужно избегать|теперь можно использовать)\s+([^.!?\n]{4,160})/i,
      /(?:использовать\s+)?([^,.!?\n]{2,120})\s+(?:уже\s+)?можно\s+для\s+[^,.!?\n]{2,80}(?:,|\s+но\b)/i,
    ]);
  }

  private extractDecision(content: string): string | undefined {
    return this.capture(content, [
      /\b(?:we decided to|we will use|we are going with|let's stick with)\s+([^.!?\n]{4,160})/i,
      /(?:мы приняли решение(?:\s*[—:-])?|мы решили|будем использовать|оставляем|остаемся на|давай остановимся на)\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractDecisionInvalidation(content: string): string | undefined {
    return this.capture(content, [
      /\b(?:we are no longer using|we are no longer going with|we changed our decision about)\s+([^.!?\n]{4,160})/i,
      /(?:мы больше не используем|мы передумали насчёт|мы больше не идём с)\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractTask(content: string): string | undefined {
    return this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:next i need to|next we need to|todo:?|we should)\s+([^.!?\n]{4,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:дальше нужно|следующим шагом нужно|надо|нужно|нужно сделать|задача(?:\s*[—:-])?)\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractTaskInvalidation(content: string): string | undefined {
    return this.capture(content, [
      /\b(?:we no longer need to|i no longer need to|that task is no longer needed)\s+([^.!?\n]{4,160})/i,
      /(?:больше не нужно|эта задача больше не нужна)\s+([^.!?\n]{4,160})/i,
    ]);
  }

  private extractRefinedConstraint(content: string): string | undefined {
    const russianRefinement =
      /(?:использовать\s+)?([^,.!?\n]{2,120}?)(?:\s+уже)?\s+можно\s+для\s+([^,.!?\n]{2,80}),\s*но\s+нельзя\s+делать\s+(?:его|е[её]|их)?\s*([^.!?\n]{4,160})/iu.exec(
        content,
      );
    if (russianRefinement) {
      const subject = this.normalizeSummary(russianRefinement[1]);
      const allowedUse = this.normalizeSummary(russianRefinement[2]);
      const restriction = this.normalizeSummary(russianRefinement[3]);
      if (subject && allowedUse && restriction) {
        return `${subject} можно использовать для ${allowedUse}, но нельзя делать ${subject} ${restriction}`;
      }
    }

    const englishRefinement =
      /(?:use\s+)?([^,.!?\n]{2,120}?)\s+can\s+(?:now\s+)?be\s+used\s+for\s+([^,.!?\n]{2,80}),\s*but\s+(?:it\s+)?(?:must\s+not|cannot|can't|should\s+not)\s+(?:be\s+made|become)\s+([^.!?\n]{4,160})/iu.exec(
        content,
      );
    if (englishRefinement) {
      const subject = this.normalizeSummary(englishRefinement[1]);
      const allowedUse = this.normalizeSummary(englishRefinement[2]);
      const restriction = this.normalizeSummary(englishRefinement[3]);
      if (subject && allowedUse && restriction) {
        return `${subject} can be used for ${allowedUse}, but must not become ${restriction}`;
      }
    }

    return undefined;
  }

  private extractConstraintSubject(content: string): string | undefined {
    const russianSubject =
      /(?:использовать\s+)?([^,.!?\n]{2,120}?)\s+(?:уже\s+)?можно\s+для\s+[^,.!?\n]{2,80}(?:,|\s+но\b)/iu.exec(content);
    const englishSubject =
      /(?:use\s+)?([^,.!?\n]{2,120}?)\s+can\s+(?:now\s+)?be\s+used\s+for\s+[^,.!?\n]{2,80}(?:,|\s+but\b)/iu.exec(content);
    return this.normalizeSummary(russianSubject?.[1] ?? englishSubject?.[1]);
  }

  private capture(content: string, patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      const summary = this.normalizeSummary(match?.[1]);
      if (summary) {
        return summary;
      }
    }

    return undefined;
  }

  private normalizeSummary(value: string | undefined): string | undefined {
    const normalized = value
      ?.replace(/^\s*(?:но|but)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return undefined;
    }

    return normalized.replace(/[.?!,:;]+$/g, '').trim() || undefined;
  }

  private hasNegativeActiveGoalLead(summary: string): boolean {
    return /^(?:уже\s+не|больше\s+не|no\s+longer\b|not\b)/iu.test(summary.trim());
  }

  private normalizeForComparison(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  private toMemoryMapKey(kind: EpisodicMemoryKind, summary: string): string {
    return `${kind}:${summary.toLocaleLowerCase()}`;
  }
}
