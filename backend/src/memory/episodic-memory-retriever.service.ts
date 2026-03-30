import { Injectable } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import type { EpisodicMemoryEntry } from './episodic-memory.types';

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
  'мне',
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

const DIRECT_PROFILE_QUERY_PATTERNS = [
  /\b(?:what(?:'s| is)? my name|do you know my name|who am i|what(?:'s| is)? my role|what do i do|what is my job|what project am i working on|what is my project|which project am i on|what(?:'s| is)? my current goal|what is my goal)\b/i,
  /(?:как меня зовут|мо[её] имя|кто я|какая у меня роль|кем я работаю|какая у меня работа|над каким проектом я работаю|над чем я(?:\s+вообще)?(?:\s+сейчас)? работаю|какой у меня проект|какая у меня текущая цель|какая у меня цель)/i,
];

@Injectable()
export class EpisodicMemoryRetrieverService {
  private static readonly SUPPORT_CONTEXT_WINDOW_MS = 15 * 60 * 1000;

  selectRelevantMemories(
    conversation: Conversation,
    entries: EpisodicMemoryEntry[],
    limit = 3,
  ): EpisodicMemoryEntry[] {
    const query = this.buildQuery(conversation);
    const queryTokens = this.tokenize(query);
    const directProfileQuery = this.isDirectProfileQuery(query);

    if (entries.length === 0) {
      return [];
    }

    if (queryTokens.size === 0) {
      if (directProfileQuery) {
        return [];
      }

      return entries
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
    }

    const rankedEntries = entries.map((entry) => {
      const overlap = this.calculateOverlap(entry, queryTokens);
      return {
        entry,
        overlap,
        score: overlap + entry.salience + this.getSupportBonus(entry),
      };
    });

    if (rankedEntries.every((item) => item.overlap === 0)) {
      if (directProfileQuery) {
        return [];
      }

      return entries
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
    }

    const overlappingEntries = rankedEntries
      .filter((item) => item.overlap > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
      });

    const selected = new Map<string, EpisodicMemoryEntry>();
    const primaryMatch = overlappingEntries[0];
    if (primaryMatch) {
      selected.set(primaryMatch.entry.id, primaryMatch.entry);
    }

    for (const item of overlappingEntries) {
      if (selected.size >= limit) {
        break;
      }

      selected.set(item.entry.id, item.entry);
    }

    if (selected.size < limit) {
      const primaryTimestamp = primaryMatch ? this.getTimestamp(primaryMatch.entry.updatedAt) : 0;
      const supportEntries = rankedEntries
        .filter(
          (item) =>
            item.overlap === 0 &&
            item.entry.kind !== 'task' &&
            Math.abs(this.getTimestamp(item.entry.updatedAt) - primaryTimestamp) <=
              EpisodicMemoryRetrieverService.SUPPORT_CONTEXT_WINDOW_MS,
        )
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }

          return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
        });

      for (const item of supportEntries) {
        if (selected.size >= limit) {
          break;
        }

        selected.set(item.entry.id, item.entry);
      }
    }

    return Array.from(selected.values());
  }

  private buildQuery(conversation: Conversation): string {
    const userMessages = conversation.messages.filter((message) => message.role === 'user');
    return userMessages.slice(-2).map((message) => message.content).join(' ');
  }

  private calculateOverlap(entry: EpisodicMemoryEntry, queryTokens: Set<string>): number {
    const entryTokens = this.tokenize(entry.summary);
    if (entryTokens.size === 0) {
      return 0;
    }

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

  private isDirectProfileQuery(value: string): boolean {
    return DIRECT_PROFILE_QUERY_PATTERNS.some((pattern) => pattern.test(value));
  }

  private getSupportBonus(entry: EpisodicMemoryEntry): number {
    switch (entry.kind) {
      case 'constraint':
        return 0.18;
      case 'decision':
        return 0.12;
      case 'goal':
        return 0.08;
      case 'task':
        return 0;
    }
  }

  private getTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
