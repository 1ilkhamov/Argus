import { Injectable } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import type { Message } from '../chat/entities/message.entity';
import { isDeterministicMemoryCommandMessage } from './conversational-memory-command.matchers';
import {
  buildStructuredMemoryProvenance,
  ensureStructuredMemoryProvenance,
  mergeStructuredMemoryProvenance,
} from './structured-memory-metadata';
import type { UserProfileFact, UserProfileFactKey, UserProfileFactRevision } from './user-profile-facts.types';
import { USER_PROFILE_FACT_ORDER } from './user-profile-facts.types';

@Injectable()
export class UserFactsExtractorService {
  resolveFacts(conversation: Conversation, persistedFacts: UserProfileFact[] = []): UserProfileFact[] {
    const factMap = new Map<UserProfileFactKey, UserProfileFact>();
    const invalidatedFacts = new Map<UserProfileFactKey, UserProfileFact>();

    for (const fact of persistedFacts) {
      factMap.set(fact.key, fact);
    }

    for (const message of conversation.messages) {
      if (message.role !== 'user') {
        continue;
      }

      if (isDeterministicMemoryCommandMessage(message.content)) {
        continue;
      }

      this.applyInvalidations(factMap, invalidatedFacts, message.content);

      for (const fact of this.extractFactsFromMessage(message)) {
        const existing = factMap.get(fact.key) ?? invalidatedFacts.get(fact.key);
        factMap.set(fact.key, existing ? this.mergeObservedFact(existing, fact) : fact);
        invalidatedFacts.delete(fact.key);
      }
    }

    return USER_PROFILE_FACT_ORDER.map((key) => factMap.get(key)).filter(
      (fact): fact is UserProfileFact => Boolean(fact),
    );
  }

  private applyInvalidations(
    factMap: Map<UserProfileFactKey, UserProfileFact>,
    invalidatedFacts: Map<UserProfileFactKey, UserProfileFact>,
    content: string,
  ): void {
    this.maybeInvalidateFact(factMap, invalidatedFacts, 'role', this.extractRoleInvalidation(content));
    this.maybeInvalidateFact(factMap, invalidatedFacts, 'project', this.extractProjectInvalidation(content));
    this.maybeInvalidateFact(factMap, invalidatedFacts, 'goal', this.extractGoalInvalidation(content));
  }

  private maybeInvalidateFact(
    factMap: Map<UserProfileFactKey, UserProfileFact>,
    invalidatedFacts: Map<UserProfileFactKey, UserProfileFact>,
    key: UserProfileFactKey,
    targetValue: string | undefined,
  ): void {
    if (!targetValue) {
      return;
    }

    const existing = factMap.get(key);
    if (!existing) {
      return;
    }

    if (targetValue === '*' || this.normalizeForComparison(existing.value) === this.normalizeForComparison(targetValue)) {
      factMap.delete(key);
      invalidatedFacts.set(key, existing);
    }
  }

  private extractFactsFromMessage(message: Message): UserProfileFact[] {
    const facts = new Map<UserProfileFactKey, UserProfileFact>();

    this.maybeSetFact(facts, 'name', this.extractName(message.content), message);
    this.maybeSetFact(facts, 'role', this.extractRole(message.content), message);
    this.maybeSetFact(facts, 'project', this.extractProject(message.content), message);
    this.maybeSetFact(facts, 'goal', this.extractGoal(message.content), message);

    return Array.from(facts.values());
  }

  private maybeSetFact(
    facts: Map<UserProfileFactKey, UserProfileFact>,
    key: UserProfileFactKey,
    value: string | undefined,
    message: Message,
  ): void {
    const normalizedValue = this.normalizeFactValue(key, value);
    if (!normalizedValue) {
      return;
    }

    facts.set(key, {
      key,
      value: normalizedValue,
      source: 'explicit_user_statement',
      confidence: 1,
      updatedAt: message.createdAt.toISOString(),
      provenance: buildStructuredMemoryProvenance(message),
      revision: 1,
    });
  }

  private mergeObservedFact(existing: UserProfileFact, incoming: UserProfileFact): UserProfileFact {
    const existingRevision = existing.revision ?? 1;
    const sameValue = this.normalizeForComparison(existing.value) === this.normalizeForComparison(incoming.value);

    if (sameValue) {
      const preferred = incoming.updatedAt.localeCompare(existing.updatedAt) >= 0 ? incoming : existing;

      return {
        ...preferred,
        pinned: existing.pinned || incoming.pinned || undefined,
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
      pinned: existing.pinned || incoming.pinned || undefined,
      revision: existingRevision + 1,
      revisionHistory: this.appendRevisionHistory(existing.revisionHistory, this.toFactRevision(existing)),
      provenance: ensureStructuredMemoryProvenance(incoming.provenance, incoming.updatedAt),
    };
  }

  private toFactRevision(fact: UserProfileFact): UserProfileFactRevision {
    return {
      revision: fact.revision ?? 1,
      value: fact.value,
      confidence: fact.confidence,
      updatedAt: fact.updatedAt,
      provenance: ensureStructuredMemoryProvenance(fact.provenance, fact.updatedAt),
    };
  }

  private appendRevisionHistory(
    history: UserProfileFactRevision[] | undefined,
    revision: UserProfileFactRevision,
  ): UserProfileFactRevision[] {
    const nextHistory = [...(this.cloneRevisionHistory(history) ?? []), revision];
    return nextHistory.slice(-8);
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

  private extractName(content: string): string | undefined {
    return this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:my name is)\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)(?:меня зовут)\s+([^.!?\n,;:]{2,80})/i,
    ]);
  }

  private extractRole(content: string): string | undefined {
    return this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:по роли я(?:\s+скорее)?|я(?:\s+скорее)?\s+по роли)\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)(?:role-wise i am|i am more of a|i'm more of a)\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)my role(?: is)?(?:\s*[—:-])?\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)(?:моя роль(?:\s*[—:-])?)\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)i am an?\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)i work as\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)я работаю как\s+([^.!?\n,;:]{2,80})/i,
      /(?:^|[.!?\n,;:]\s*)я\s+([^.!?\n,;:]{2,80}(?:разработчик|инженер|дизайнер|менеджер|аналитик))/i,
    ]);
  }

  private extractRoleInvalidation(content: string): string | undefined {
    return this.capture(content, [
      /\bi am no longer an?\s+([^.!?\n,;:]{2,80})/i,
      /\bi no longer work as\s+([^.!?\n,;:]{2,80})/i,
      /я(?:\s+уже)?\s+не\s+([^.!?\n,;:]{2,80}(?:разработчик|инженер|дизайнер|менеджер|аналитик))/i,
      /я больше не\s+([^.!?\n,;:]{2,80}(?:разработчик|инженер|дизайнер|менеджер|аналитик))/i,
    ]);
  }

  private extractProject(content: string): string | undefined {
    return this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:my project is no longer|my current project is no longer)\s+[^,.!?\n]{2,120},\s*(?:but|instead)\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:проект\s+у\s+меня(?:\s+уже)?\s+не|текущий\s+проект\s+у\s+меня(?:\s+уже)?\s+не)\s+[^,.!?\n]{2,120},\s*а\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:теперь\s+мой\s+(?:основной|главный|текущий)\s+проект(?:\s*[—:-])?)\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:а\s+)?(?:(?:сейчас\s+|теперь\s+)?мой\s+(?:основной|главный|текущий)\s+(?:рабочий\s+)?проект(?:\s*[—:-])?)\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:сейчас\s+)?(?:основной|главный|текущий)\s+(?:рабочий\s+)?проект\s+у\s+меня(?:\s*[—:-])?\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:проект\s+у\s+меня|текущий\s+проект\s+у\s+меня)(?:\s*[—:-])?\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:i am working on|i'm working on)\s+(?:the\s+)?project\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:i am working on|i'm working on|my project is|my current project is|my project is now|my current project is now)\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:я работаю над проектом)\s+([^.!?\n,;]{2,120})/i,
      /(?:^|[.!?\n,;:]\s*)(?:я работаю над|мой проект(?: сейчас)?(?:\s*[—:-])?|мой текущий проект(?:\s*[—:-])?|мой проект теперь|мой текущий проект теперь|теперь мой проект(?:\s*[—:-])?|теперь мой текущий проект(?:\s*[—:-])?)\s+([^.!?\n,;]{2,120})/i,
    ]);
  }

  private extractProjectInvalidation(content: string): string | undefined {
    return this.capture(content, [
      /\b(?:i am no longer working on|i'm no longer working on|my project is no longer)\s+([^.!?\n]{2,120})/i,
      /(?:я(?:\s+уже)?\s+не\s+работаю\s+над|я больше не работаю над|мой(?:\s+(?:основной|главный|текущий))? проект(?:\s+больше|\s+уже)? не)\s+([^.!?\n]{2,120})/i,
    ]);
  }

  private extractGoal(content: string): string | undefined {
    return this.capture(content, [
      /(?:^|[.!?\n,;:]\s*)(?:my goal(?: is now)?|my current goal(?: is now)?|моя(?:\s+текущая)? цель(?:\s+теперь)?)\s+(?:не|not)\s+[^.!?\n]{2,160},\s*(?:а|but)\s+(?:конкретно\s+)?([^.!?\n]{2,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:my next goal is|my near-term goal is)\s+([^.!?\n]{2,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:моя\s+ближайшая\s+цель(?:\s*[—:-])?|моя\s+основная\s+цель(?:\s*[—:-])?)\s+([^.!?\n]{2,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:(?:сейчас|теперь)\s+(?:моя\s+)?приоритетная\s+цель(?:\s*[—:-])?|(?:моя\s+)?приоритетная\s+цель(?:\s*[—:-])?)\s+([^.!?\n]{2,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:my priority goal is|my priority now is|my current priority is|the priority now is)(?:\s*[—:-])?\s+([^.!?\n]{2,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:my current goal is|my goal is|my main focus is|my current focus is)\s+([^.!?\n]{2,160})/i,
      /(?:теперь\s+my main focus is|now\s+my main focus is|now\s+my current focus is)\s+([^.!?\n]{2,160})/i,
      /(?:^|[.!?\n,;:]\s*)(?:моя(?:\s+текущая)? цель(?:\s*[—:-])?|мой главный фокус(?:\s*[—:-])?|мой текущий фокус(?:\s*[—:-])?)\s+([^.!?\n]{2,160})/i,
      /(?:теперь\s+мой главный фокус|теперь\s+мой текущий фокус)(?:\s*[—:-])?\s+([^.!?\n]{2,160})/i,
    ]);
  }

  private extractGoalInvalidation(content: string): string | undefined {
    return this.capture(content, [
      /\b(?:my goal is no longer|i no longer need to)\s+([^.!?\n]{2,120})/i,
      /(?:моя(?:\s+текущая)? цель(?:\s+больше|\s+уже)? не|моя цель больше не|мне больше не нужно)\s+([^.!?\n]{2,120})/i,
      /(?:это больше не моя цель)/i,
    ]);
  }

  private capture(content: string, patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      const value = this.normalizeValue(match?.[1]);
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  private normalizeValue(value: string | undefined): string | undefined {
    const normalized = value
      ?.replace(/^\s*(?:но|but)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/["'`]+$/g, '')
      .trim();
    if (!normalized) {
      return undefined;
    }

    return normalized.replace(/[.?!,:;]+$/g, '').trim() || undefined;
  }

  private normalizeFactValue(key: UserProfileFactKey, value: string | undefined): string | undefined {
    const normalized = this.normalizeValue(value);
    if (!normalized) {
      return undefined;
    }

    const replacementValue = this.extractReplacementValue(normalized);

    switch (key) {
      case 'role':
        return this.normalizeActiveFactCandidate(
          key,
          this.trimTrailingStructuredClause(replacementValue)
            .replace(/^(?:роль\s*[—:-]?\s*|по\s+роли\s+я\s+|role-wise\s+i\s+am\s+|i\s+am\s+more\s+of\s+a\s+|i'm\s+more\s+of\s+a\s+|скорее\s+)/i, '')
            .trim(),
        );
      case 'project':
        return this.normalizeActiveFactCandidate(
          key,
          this.trimTrailingStructuredClause(replacementValue)
            .replace(/^(?:проект(?:ом)?\s+)/i, '')
            .replace(/^(?:теперь\s+)/i, '')
            .replace(/^(?:now\s+)/i, '')
            .trim(),
        );
      case 'goal':
        return this.normalizeActiveFactCandidate(
          key,
          this.trimTrailingStructuredClause(replacementValue)
            .replace(/^(?:теперь\s+)/i, '')
            .replace(/^(?:now\s+)/i, '')
            .replace(/^(?:конкретно\s+)/i, '')
            .trim(),
        );
      default:
        return replacementValue;
    }
  }

  private normalizeActiveFactCandidate(
    key: Exclude<UserProfileFactKey, 'name'>,
    value: string,
  ): string | undefined {
    if (!value) {
      return undefined;
    }

    if (this.hasNegativeActiveLead(value)) {
      return undefined;
    }

    return value;
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

  private hasNegativeActiveLead(value: string): boolean {
    return /^(?:уже\s+не|больше\s+не|no\s+longer\b|not\b)/iu.test(value.trim());
  }

  private normalizeForComparison(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }
}
