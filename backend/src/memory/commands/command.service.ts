import { Injectable, Logger } from '@nestjs/common';

import type { MemoryEntry, MemoryKind } from '../core/memory-entry.types';
import { MemoryStoreService } from '../core/memory-store.service';
import type { EpisodicMemoryKind, UserProfileFactKey } from './memory-command.types';
import {
  type FactAction,
  isFactCommand,
  isForgetAllQualifier,
  parseCommands,
} from './command.parser';
import * as CommandNoteLocalizer from './command.localizer';

export interface ConversationalMemoryCommandResult {
  handled: boolean;
  operationNote?: string;
}

// Map legacy episodic kinds → v2 MemoryKind
// Map UserProfileFactKey → categories the LLM extractor might assign
const FACT_KEY_CATEGORIES: Record<UserProfileFactKey, string[]> = {
  name: ['name', 'identity'],
  role: ['role', 'identity', 'professional'],
  project: ['project', 'work'],
  goal: ['goal', 'objective'],
  stack: ['stack', 'tech', 'technology', 'professional'],
};

// Content patterns to match when category-based lookup fails
const FACT_KEY_CONTENT_PATTERNS: Record<UserProfileFactKey, RegExp> = {
  name: /(?:(?:меня\s+)?зовут|имя|name\s*[:=]|my\s+name)/i,
  role: /(?:роль|должность|role|position|работа[юеш]\S*|developer|разработчик|инженер|engineer|staff|lead|senior|junior|head|CTO|CEO|VP)/i,
  project: /(?:проект|project|назван|называ|name[ds]?\b)/i,
  goal: /(?:цель|goal|objective|задача)/i,
  stack: /(?:стек|технолог|stack|tech|typescript|nestjs|react|python|django|postgresql|\bJS\b|\bTS\b)/i,
};

// Content patterns to find episodic entries by keyword when category doesn't match
const EPISODIC_KIND_CONTENT_PATTERNS: Record<EpisodicMemoryKind, RegExp | undefined> = {
  goal: /(?:цель|goal|objective)/i,
  constraint: /(?:ограничен|constraint|запрещ|нельзя)/i,
  decision: /(?:решени|decision|выбрал|отклонил)/i,
  task: /(?:задач|task|todo)/i,
  background: undefined,
  working_context: undefined,
};

const EPISODIC_KIND_MAP: Record<EpisodicMemoryKind, MemoryKind> = {
  goal: 'episode',
  constraint: 'preference',
  decision: 'episode',
  background: 'fact',
  task: 'action',
  working_context: 'episode',
};

@Injectable()
export class ConversationalMemoryCommandService {
  private readonly logger = new Logger(ConversationalMemoryCommandService.name);

  constructor(private readonly store: MemoryStoreService) {}

  async handle(content: string, scopeKey?: string): Promise<ConversationalMemoryCommandResult> {
    const commands = parseCommands(content);
    if (commands.length === 0) {
      return { handled: false };
    }

    const language = CommandNoteLocalizer.detectCommandResponseLanguage(content);
    const notes: string[] = [];

    for (const command of commands) {
      if (command.action === 'inspect') {
        notes.push(await this.buildSnapshotNote(language, scopeKey));
        continue;
      }

      if (isFactCommand(command)) {
        const expectedValue = command.action === 'forget_fact' ? command.expectedValue : undefined;
        notes.push(await this.executeFactCommand(command.action, command.key, language, expectedValue, scopeKey));
        continue;
      }

      notes.push(await this.executeEpisodicCommand(command.action, command.kind, command.selectorText, language, scopeKey));
    }

    return {
      handled: true,
      operationNote: notes.join(' '),
    };
  }

  private async buildSnapshotNote(
    language: CommandNoteLocalizer.CommandResponseLanguage,
    scopeKey?: string,
  ): Promise<string> {
    const entries = await this.store.query({ excludeSuperseded: true, limit: 100, ...(scopeKey ? { scopeKey } : {}) });

    const facts = entries
      .filter((e) => e.kind === 'fact')
      .map((e) => `${e.category ?? 'general'}=${e.content}${e.pinned ? ' [pinned]' : ''}`);
    const others = entries
      .filter((e) => e.kind !== 'fact')
      .map((e) => `[${e.kind}] ${e.summary ?? e.content}${e.pinned ? ' [pinned]' : ''}`);

    const factsStr = facts.length > 0 ? facts.join('; ') : 'none';
    const memoriesStr = others.length > 0 ? others.join('; ') : 'none';

    return CommandNoteLocalizer.buildSnapshotOperationNote(language, factsStr, memoriesStr);
  }

  private async executeFactCommand(
    action: FactAction,
    key: UserProfileFactKey,
    language: CommandNoteLocalizer.CommandResponseLanguage = 'en',
    expectedValue?: string,
    scopeKey?: string,
  ): Promise<string> {
    const matchingEntries = await this.store.query({
      kinds: ['fact'],
      excludeSuperseded: true,
      limit: 50,
      ...(scopeKey ? { scopeKey } : {}),
    });

    if (action === 'forget_fact' && expectedValue) {
      // Value-specific forget: find entry matching the expected value
      const lowerExpected = expectedValue.toLowerCase();
      const target = matchingEntries.find((e) => e.content.toLowerCase().includes(lowerExpected));
      if (!target) {
        return CommandNoteLocalizer.buildForgetFactValueNotFoundNote(language, key, expectedValue);
      }
      const deleted = await this.store.delete(target.id);
      return deleted
        ? CommandNoteLocalizer.buildForgetFactByValueDeletedNote(language, key, expectedValue)
        : CommandNoteLocalizer.buildForgetFactValueNotFoundNote(language, key, expectedValue);
    }

    const target = this.findFactByKey(matchingEntries, key);

    if (action === 'forget_fact') {
      if (!target) {
        return CommandNoteLocalizer.buildForgetFactNotFoundNote(language, key);
      }
      const deleted = await this.store.delete(target.id);
      return deleted
        ? CommandNoteLocalizer.buildForgetFactDeletedNote(language, key, target.content)
        : CommandNoteLocalizer.buildForgetFactNotFoundNote(language, key);
    }

    if (!target) {
      const pinned = action === 'pin_fact';
      return CommandNoteLocalizer.buildFactPinNotFoundNote(language, key, pinned);
    }

    const pinned = action === 'pin_fact';
    const updated = await this.store.update(target.id, { pinned });
    if (!updated) {
      return CommandNoteLocalizer.buildFactPinNotFoundNote(language, key, pinned);
    }

    return pinned
      ? CommandNoteLocalizer.buildFactPinnedNote(language, key, updated.content)
      : CommandNoteLocalizer.buildFactUnpinnedNote(language, key, updated.content);
  }

  private async executeEpisodicCommand(
    action: 'pin_episodic' | 'unpin_episodic' | 'forget_episodic',
    kind: EpisodicMemoryKind,
    selectorText = '',
    language: CommandNoteLocalizer.CommandResponseLanguage = 'en',
    scopeKey?: string,
  ): Promise<string> {
    const v2Kind = EPISODIC_KIND_MAP[kind] ?? 'episode';
    const entries = await this.store.query({
      kinds: [v2Kind],
      excludeSuperseded: true,
      limit: 50,
      ...(scopeKey ? { scopeKey } : {}),
    });

    // Filter by category OR content keyword matching the legacy episodic kind
    const kindContentPattern = EPISODIC_KIND_CONTENT_PATTERNS[kind];
    const matching = entries.filter(
      (e) =>
        e.category === kind ||
        (kindContentPattern && kindContentPattern.test(e.content)) ||
        (!e.category && v2Kind === 'episode'),
    );

    if (action === 'forget_episodic' && isForgetAllQualifier(selectorText)) {
      let deletedCount = 0;
      for (const entry of matching) {
        if (await this.store.delete(entry.id)) {
          deletedCount += 1;
        }
      }
      return deletedCount > 0
        ? CommandNoteLocalizer.buildForgetAllEpisodicDeletedNote(language, kind, deletedCount)
        : CommandNoteLocalizer.buildForgetAllEpisodicNotFoundNote(language, kind);
    }

    const target = this.pickBestMatch(matching, selectorText);
    if (!target) {
      const verb = action === 'forget_episodic' ? 'delete' : action === 'pin_episodic' ? 'pin' : 'unpin';
      return CommandNoteLocalizer.buildEpisodicNotFoundNote(language, kind, verb);
    }

    const summary = target.summary ?? target.content;

    if (action === 'forget_episodic') {
      const deleted = await this.store.delete(target.id);
      return deleted
        ? CommandNoteLocalizer.buildForgetEpisodicDeletedNote(language, kind, summary)
        : CommandNoteLocalizer.buildEpisodicNotFoundNote(language, kind, 'delete');
    }

    const pinned = action === 'pin_episodic';
    const updated = await this.store.update(target.id, { pinned });
    if (!updated) {
      return CommandNoteLocalizer.buildEpisodicNotFoundNote(language, kind, pinned ? 'pin' : 'unpin');
    }

    return pinned
      ? CommandNoteLocalizer.buildEpisodicPinnedNote(language, kind, summary)
      : CommandNoteLocalizer.buildEpisodicUnpinnedNote(language, kind, summary);
  }

  private findFactByKey(entries: MemoryEntry[], key: UserProfileFactKey): MemoryEntry | undefined {
    const pattern = FACT_KEY_CONTENT_PATTERNS[key];
    const altCategories = FACT_KEY_CATEGORIES[key];

    // 1. Exact category match + content pattern (strongest signal)
    const byExactCategoryAndContent = entries.find((e) => e.category === key && pattern.test(e.content));
    if (byExactCategoryAndContent) return byExactCategoryAndContent;

    // 2. Content pattern match — high signal regardless of category
    const byContent = entries.find((e) => pattern.test(e.content));
    if (byContent) return byContent;

    // 3. Alt-category match confirmed by content pattern
    const byCategoryAndContent = entries.find(
      (e) => e.category != null && altCategories.includes(e.category) && pattern.test(e.content),
    );
    if (byCategoryAndContent) return byCategoryAndContent;

    // 4. Exact category match (no content confirmation — weaker signal)
    const byExactCategory = entries.find((e) => e.category === key);
    if (byExactCategory) return byExactCategory;

    // 5. Tag-based fallback
    return entries.find((e) => e.tags.some((t) => t === key || altCategories.includes(t)));
  }

  private pickBestMatch(entries: MemoryEntry[], selectorText: string): MemoryEntry | undefined {
    if (entries.length === 0) return undefined;
    if (!selectorText || selectorText.trim().length === 0) {
      return entries[0];
    }

    const lowerSelector = selectorText.toLowerCase();
    const scored = entries.map((e) => ({
      entry: e,
      score: (e.summary ?? e.content).toLowerCase().includes(lowerSelector) ? 1 : 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.entry;
  }
}
