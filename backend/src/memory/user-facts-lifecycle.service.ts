import { Injectable } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import { ensureStructuredMemoryProvenance, mergeStructuredMemoryProvenance } from './structured-memory-metadata';
import type { UserProfileFact, UserProfileFactKey, UserProfileFactRevision } from './user-profile-facts.types';
import { USER_PROFILE_FACT_ORDER } from './user-profile-facts.types';

const FACT_QUERY_PATTERNS: Record<UserProfileFactKey, RegExp[]> = {
  name: [
    /\b(?:what(?:'s| is)? my name|do you know my name|who am i)\b/i,
    /(?:как меня зовут|мо[её] имя|кто я)/i,
  ],
  role: [
    /\b(?:what(?:'s| is)? my role|what do i do|what is my job)\b/i,
    /(?:какая у меня роль|кем я работаю|какая у меня работа|моя роль|кто я(?:\s+в рабочем контексте)?|как\s+о\s+специалисте|как\s+специалист(?:е|а)|в\s+профессиональном\s+контексте|в\s+рабочем\s+контексте)/i,
  ],
  project: [
    /\b(?:what project am i working on|what is my current project|what is my project|which project am i on(?: now)?)\b/i,
    /(?:над каким проектом я работаю|над чем я(?:\s+вообще)?(?:\s+сейчас)? работаю|какой у меня(?:\s+текущий)? проект|мой(?:\s+текущий)? проект)/i,
  ],
  goal: [
    /\b(?:what(?:'s| is)? my current goal|what is my current goal|what is my goal|what am i trying to do)\b/i,
    /(?:какая у меня(?:\s+текущая)? цель|моя(?:\s+текущая)? цель)/i,
  ],
};

@Injectable()
export class UserFactsLifecycleService {
  private static readonly MIN_PROMPT_CONFIDENCE = 0.5;
  private static readonly MAX_PROMPT_FACTS = 3;

  prepareFactsForStorage(facts: UserProfileFact[]): UserProfileFact[] {
    const factMap = new Map<UserProfileFactKey, UserProfileFact>();

    for (const fact of facts) {
      const normalizedFact = this.normalizeFact(fact);
      const existing = factMap.get(normalizedFact.key);
      factMap.set(
        normalizedFact.key,
        existing ? this.mergeFacts(existing, normalizedFact) : normalizedFact,
      );
    }

    return USER_PROFILE_FACT_ORDER.map((key) => factMap.get(key)).filter(
      (fact): fact is UserProfileFact => Boolean(fact),
    );
  }

  selectPromptFacts(
    facts: UserProfileFact[],
    conversation?: Conversation,
    now = new Date(),
  ): UserProfileFact[] {
    const queryTokens = this.buildQueryTokens(conversation);
    const requestedFactKeys = this.buildRequestedFactKeys(conversation);

    return this.prepareFactsForStorage(facts)
      .map((fact) => {
        const promptFact = this.applyFreshness(fact, now);
        return {
          fact: promptFact,
          score: this.calculatePromptScore(promptFact, queryTokens, requestedFactKeys),
        };
      })
      .filter((item) => requestedFactKeys.size === 0 || item.fact.pinned || requestedFactKeys.has(item.fact.key))
      .filter(
        (item) =>
          item.fact.confidence >= UserFactsLifecycleService.MIN_PROMPT_CONFIDENCE && item.score >= 0.75,
      )
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.fact.updatedAt.localeCompare(left.fact.updatedAt);
      })
      .slice(0, UserFactsLifecycleService.MAX_PROMPT_FACTS)
      .map((item) => item.fact);
  }

  private mergeFacts(existing: UserProfileFact, incoming: UserProfileFact): UserProfileFact {
    const sameValue = this.normalizeForComparison(existing.value) === this.normalizeForComparison(incoming.value);
    const revision = Math.max(existing.revision ?? 1, incoming.revision ?? 1);
    const revisionHistory = this.mergeRevisionHistories(existing.revisionHistory, incoming.revisionHistory);
    const provenance = mergeStructuredMemoryProvenance(existing.provenance, incoming.provenance);

    if (sameValue) {
      const latest = this.pickLatest(existing, incoming);
      return {
        ...latest,
        confidence: this.roundConfidence(Math.max(existing.confidence, incoming.confidence) + 0.05),
        pinned: existing.pinned || incoming.pinned || undefined,
        revision,
        revisionHistory,
        provenance,
      };
    }

    const latest = this.pickLatest(existing, incoming);
    return {
      ...latest,
      pinned: latest.pinned || existing.pinned || incoming.pinned || undefined,
      revision: latest.revision ?? revision,
      revisionHistory,
      provenance: latest.provenance
        ? ensureStructuredMemoryProvenance(latest.provenance, latest.updatedAt)
        : provenance,
    };
  }

  private calculatePromptScore(
    fact: UserProfileFact,
    queryTokens: Set<string>,
    requestedFactKeys: Set<UserProfileFactKey>,
  ): number {
    const overlap = this.calculateOverlap(fact, queryTokens);
    const directMatch = requestedFactKeys.has(fact.key);
    let score =
      fact.confidence +
      this.getImportanceBonus(fact.key) +
      this.getPinnedBonus(fact) +
      Math.min(0.24, overlap * 0.12) +
      (directMatch ? 0.35 : 0);

    if (queryTokens.size > 0 && overlap === 0 && !fact.pinned && !directMatch) {
      score -= this.getIrrelevancePenalty(fact.key);
    }

    return this.roundConfidence(score);
  }

  private applyFreshness(fact: UserProfileFact, now: Date): UserProfileFact {
    const multiplier = this.getFreshnessMultiplier(fact.key, this.getAgeInDays(fact.updatedAt, now));
    return {
      ...fact,
      confidence: this.roundConfidence(fact.confidence * multiplier),
    };
  }

  private getFreshnessMultiplier(key: UserProfileFactKey, ageInDays: number): number {
    switch (key) {
      case 'name':
        return 1;
      case 'role':
        if (ageInDays <= 180) {
          return 1;
        }
        if (ageInDays <= 365) {
          return 0.8;
        }
        return 0.45;
      case 'project':
        if (ageInDays <= 120) {
          return 1;
        }
        if (ageInDays <= 240) {
          return 0.75;
        }
        return 0.45;
      case 'goal':
        if (ageInDays <= 30) {
          return 1;
        }
        if (ageInDays <= 90) {
          return 0.7;
        }
        return 0.45;
    }
  }

  private getImportanceBonus(key: UserProfileFactKey): number {
    switch (key) {
      case 'project':
        return 0.22;
      case 'goal':
        return 0.18;
      case 'role':
        return 0.14;
      case 'name':
        return 0.08;
    }
  }

  private getIrrelevancePenalty(key: UserProfileFactKey): number {
    switch (key) {
      case 'name':
        return 0.45;
      case 'role':
        return 0.25;
      case 'goal':
        return 0.1;
      case 'project':
        return 0.05;
    }
  }

  private normalizeFact(fact: UserProfileFact): UserProfileFact {
    const normalizedValue = this.normalizeFactValue(fact.key, fact.value);
    return {
      ...fact,
      value: normalizedValue,
      confidence: this.roundConfidence(fact.confidence),
      pinned: fact.pinned || undefined,
      provenance: fact.provenance,
      revision: fact.revision,
      revisionHistory: this.cloneRevisionHistory(fact.revisionHistory),
    };
  }

  private mergeRevisionHistories(
    left: UserProfileFactRevision[] | undefined,
    right: UserProfileFactRevision[] | undefined,
  ): UserProfileFactRevision[] | undefined {
    const merged = [...(this.cloneRevisionHistory(left) ?? []), ...(this.cloneRevisionHistory(right) ?? [])];
    if (merged.length === 0) {
      return undefined;
    }

    const deduped = new Map<string, UserProfileFactRevision>();
    for (const entry of merged) {
      deduped.set(`${entry.revision}:${this.normalizeForComparison(entry.value)}:${entry.updatedAt}`, entry);
    }

    return Array.from(deduped.values())
      .sort((leftEntry, rightEntry) => leftEntry.revision - rightEntry.revision || leftEntry.updatedAt.localeCompare(rightEntry.updatedAt))
      .slice(-8);
  }

  private cloneRevisionHistory(history: UserProfileFactRevision[] | undefined): UserProfileFactRevision[] | undefined {
    if (!history || history.length === 0) {
      return undefined;
    }

    return history.map((entry) => ({
      revision: entry.revision,
      value: entry.value,
      confidence: entry.confidence,
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

  private normalizeFactValue(key: UserProfileFactKey, value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const replacementValue = this.extractReplacementValue(normalized);

    switch (key) {
      case 'role':
        return this.trimTrailingStructuredClause(replacementValue)
          .replace(/^(?:роль\s*[—:-]?\s*|role\s*[—:-]?\s*|по\s+роли\s+я\s+|role-wise\s+i\s+am\s+|i\s+am\s+more\s+of\s+a\s+|i'm\s+more\s+of\s+a\s+|скорее\s+)/i, '')
          .trim();
      case 'project':
        return this.trimTrailingStructuredClause(replacementValue)
          .replace(/^(?:project\s+|проект(?:ом)?\s+)/i, '')
          .replace(/^(?:теперь\s+|now\s+)/i, '')
          .trim();
      case 'goal':
        return this.trimTrailingStructuredClause(replacementValue)
          .replace(/^(?:теперь\s+|now\s+|конкретно\s+)/i, '')
          .trim();
      default:
        return replacementValue;
    }
  }

  private extractReplacementValue(value: string): string {
    const contrastMatch = /^(?:теперь\s+|now\s+)?(?:не|not)\s+.+?,\s*(?:а|but)\s+(?:конкретно\s+)?(.+)$/iu.exec(value);
    return contrastMatch?.[1]?.trim() || value;
  }

  private trimTrailingStructuredClause(value: string): string {
    return value
      .replace(/\s*;\s+.*$/u, '')
      .replace(/\s+(?:but|но)\s+(?=(?:role|роль|project|проект|goal|цель|focus|фокус|name|имя)\b).*$/iu, '')
      .trim();
  }

  private getPinnedBonus(fact: UserProfileFact): number {
    return fact.pinned ? 0.2 : 0;
  }

  private pickLatest(left: UserProfileFact, right: UserProfileFact): UserProfileFact {
    return this.getTimestamp(right.updatedAt) >= this.getTimestamp(left.updatedAt) ? right : left;
  }

  private normalizeForComparison(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
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

  private buildRequestedFactKeys(conversation?: Conversation): Set<UserProfileFactKey> {
    if (!conversation) {
      return new Set();
    }

    const query = conversation.messages
      .filter((message) => message.role === 'user')
      .slice(-2)
      .map((message) => message.content)
      .join(' ');

    const requestedKeys = new Set<UserProfileFactKey>();
    for (const key of USER_PROFILE_FACT_ORDER) {
      if (FACT_QUERY_PATTERNS[key].some((pattern) => pattern.test(query))) {
        requestedKeys.add(key);
      }
    }

    return requestedKeys;
  }

  private calculateOverlap(fact: UserProfileFact, queryTokens: Set<string>): number {
    if (queryTokens.size === 0) {
      return 0;
    }

    const factTokens = this.tokenize(`${fact.key} ${fact.value}`);
    let overlap = 0;
    for (const token of factTokens) {
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
        .filter((token) => token.length >= 2),
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

  private roundConfidence(value: number): number {
    return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
  }
}
