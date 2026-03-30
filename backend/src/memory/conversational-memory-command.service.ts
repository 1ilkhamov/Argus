import { Injectable, Optional } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import type { MemoryEntry } from './core/memory-entry.types';
import { MemoryStoreService } from './core/memory-store.service';
import {
  isMemoryInspectCommand,
  MEMORY_COMMAND_SPLIT,
  startsWithDeterministicMemoryCommand,
  startsWithMemoryForgetVerb,
  startsWithMemoryPinVerb,
  startsWithMemoryUnpinVerb,
} from './conversational-memory-command.matchers';
import {
  buildEpisodicNotFoundNote,
  buildEpisodicPinnedNote,
  buildEpisodicUnpinnedNote,
  buildFactPinNotFoundNote,
  buildFactPinnedNote,
  buildFactUnpinnedNote,
  buildForgetFactByValueDeletedNote,
  buildForgetFactDeletedNote,
  buildForgetFactNotFoundNote,
  buildForgetFactValueNotFoundNote,
  detectCommandResponseLanguage,
  type CommandResponseLanguage,
} from './commands/command.localizer';
import type { EpisodicMemoryEntry, EpisodicMemoryKind } from './episodic-memory.types';
import { MemoryManagementService, type ManagedMemorySnapshot } from './memory-management.service';
import { MemoryStateVersionConflictError } from './memory-state-version-conflict.error';
import { DEFAULT_LOCAL_MEMORY_SCOPE } from './memory.types';
import type { UserProfileFactKey } from './user-profile-facts.types';

export interface ConversationalMemoryCommandResult {
  handled: boolean;
  response?: string;
}

type FactAction = 'forget_fact' | 'pin_fact' | 'unpin_fact';
type EpisodicAction = 'pin_episodic' | 'unpin_episodic';
type ParsedMemoryCommand =
  | {
      action: 'inspect';
    }
  | {
      action: FactAction;
      key: UserProfileFactKey;
      expectedValue?: string;
    }
  | {
      action: EpisodicAction;
      kind: EpisodicMemoryKind;
      selectorText: string;
    };

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'my',
  'our',
  'is',
  'are',
  'me',
  'you',
  'i',
  'we',
  'что',
  'это',
  'как',
  'мой',
  'моя',
  'мою',
  'мои',
  'мне',
  'наш',
  'наша',
  'и',
  'или',
  'не',
  'по',
  'для',
  'про',
  'это',
]);

@Injectable()
export class ConversationalMemoryCommandService {
  constructor(
    private readonly memoryManagementService: MemoryManagementService,
    @Optional() private readonly memoryStoreService?: MemoryStoreService,
  ) {}

  async handle(content: string, conversation?: Conversation): Promise<ConversationalMemoryCommandResult> {
    const commands = this.parseCommands(content);
    if (commands.length === 0) {
      return { handled: false };
    }

    const language = detectCommandResponseLanguage(content);
    const scopeKey = this.getScopeKey(conversation);
    const requiresSnapshotSync = commands.some((command) => command.action !== 'inspect');
    const syncedSnapshot = requiresSnapshotSync ? await this.syncSnapshotBeforeMutation(conversation, scopeKey) : undefined;
    const responses: string[] = [];
    for (const command of commands) {
      if (command.action === 'inspect') {
        responses.push(await this.buildSnapshotResponse(language, scopeKey));
        continue;
      }

      if (this.isFactCommand(command)) {
        responses.push(
          await this.executeFactCommand(command.action, command.key, command.expectedValue, syncedSnapshot, language, scopeKey),
        );
        continue;
      }

      responses.push(
        await this.executeEpisodicCommand(
          command.action,
          command.kind,
          conversation,
          command.selectorText,
          syncedSnapshot,
          language,
          scopeKey,
        ),
      );
    }

    return {
      handled: true,
      response: responses.join('\n'),
    };
  }

  private async syncSnapshotBeforeMutation(conversation: Conversation | undefined, scopeKey: string): Promise<ManagedMemorySnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.memoryManagementService.saveSnapshot(
          await this.memoryManagementService.getEffectiveSnapshot(conversation, {
            excludeLatestUserMessage: Boolean(conversation),
            scopeKey,
          }),
        );
      } catch (error) {
        if (!(error instanceof MemoryStateVersionConflictError) || attempt === 2) {
          throw error;
        }
      }
    }

    throw new Error('Unreachable managed memory snapshot sync state');
  }

  private parseCommands(content: string): ParsedMemoryCommand[] {
    if (!startsWithDeterministicMemoryCommand(content)) {
      return [];
    }

    const clauses = this.splitIntoClauses(content);
    const parsedCommands = clauses
      .map((clause) => this.parseClause(clause))
      .filter((command): command is ParsedMemoryCommand => Boolean(command));

    if (parsedCommands.length === 0 && isMemoryInspectCommand(content)) {
      return [{ action: 'inspect' }];
    }

    if (
      parsedCommands.length > 0 &&
      !parsedCommands.some((command) => command.action === 'inspect') &&
      this.containsInspectClause(content)
    ) {
      parsedCommands.push({ action: 'inspect' });
    }

    return parsedCommands.filter(
      (command, index, commands) =>
        commands.findIndex((candidate) => this.toCommandKey(candidate) === this.toCommandKey(command)) === index,
    );
  }

  private splitIntoClauses(content: string): string[] {
    return content
      .split(MEMORY_COMMAND_SPLIT)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
  }

  private parseClause(clause: string): ParsedMemoryCommand | undefined {
    if (isMemoryInspectCommand(clause)) {
      return { action: 'inspect' };
    }

    if (startsWithMemoryForgetVerb(clause)) {
      return this.parseMutationClause(clause, 'forget_fact');
    }

    if (startsWithMemoryUnpinVerb(clause)) {
      return this.parseMutationClause(clause, 'unpin');
    }

    if (startsWithMemoryPinVerb(clause)) {
      return this.parseMutationClause(clause, 'pin');
    }

    return undefined;
  }

  private containsInspectClause(content: string): boolean {
    return this.splitIntoClauses(content).some((clause) => isMemoryInspectCommand(clause));
  }

  private parseMutationClause(
    clause: string,
    action: 'forget_fact' | 'pin' | 'unpin',
  ): ParsedMemoryCommand | undefined {
    const episodicKind = this.extractEpisodicKind(clause);
    if (episodicKind) {
      if (action === 'forget_fact') {
        return undefined;
      }

      return {
        action: action === 'pin' ? 'pin_episodic' : 'unpin_episodic',
        kind: episodicKind,
        selectorText: clause,
      };
    }

    const factKey = this.extractFactKey(clause);
    if (!factKey) {
      return undefined;
    }

    if (factKey === 'goal' && action !== 'forget_fact') {
      return {
        action: action === 'pin' ? 'pin_episodic' : 'unpin_episodic',
        kind: 'goal',
        selectorText: clause,
      };
    }

    return {
      action: action === 'pin' ? 'pin_fact' : action === 'unpin' ? 'unpin_fact' : 'forget_fact',
      key: factKey,
      expectedValue: action === 'forget_fact' ? this.extractExpectedFactValue(clause, factKey) : undefined,
    };
  }

  private extractFactKey(content: string): UserProfileFactKey | undefined {
    if (/\bname\b|имя/i.test(content)) {
      return 'name';
    }
    if (/\brole\b|роль/i.test(content)) {
      return 'role';
    }
    if (/\bproject\b|проект/i.test(content)) {
      return 'project';
    }
    if (/\bgoal\b|цель/i.test(content)) {
      return 'goal';
    }

    return undefined;
  }

  private extractEpisodicKind(content: string): EpisodicMemoryKind | undefined {
    if (/\bconstraint\b|ограничен/i.test(content)) {
      return 'constraint';
    }
    if (/\bdecision\b|решени/i.test(content)) {
      return 'decision';
    }
    if (/\btask\b|задач/i.test(content)) {
      return 'task';
    }
    if (/\bgoal\b|цель/i.test(content) && /\b(?:current|latest|that|memory)\b|текущ|последн|памят/i.test(content)) {
      return 'goal';
    }

    return undefined;
  }

  private extractExpectedFactValue(content: string, key: UserProfileFactKey): string | undefined {
    if (key !== 'project') {
      return undefined;
    }

    const match = /(?:\bproject\b|проект)\s+([^,.!?;:]+(?:\s+[^,.!?;:]+){0,5})/i.exec(content);
    const normalized = this.normalizeTargetValue(match?.[1]);
    return normalized && normalized !== 'project' ? normalized : undefined;
  }

  private normalizeTargetValue(value: string | undefined): string | undefined {
    const normalized = value
      ?.replace(/^(?:named|called|fact|memory|мой|моя|моё|мои|my|the|old|new|стар(?:ый|ое|ую)?|нов(?:ый|ое|ую)?|stored|current|текущ(?:ий|ая|ее|ую))\s+/iu, '')
      .replace(/^(?:project|проект)\s+/iu, '')
      .replace(/\s*,\s*(?:не трогай|don't touch|но|but)\b.*$/iu, '')
      .replace(
        /\s+(?:and|и)\s+(?:(?:please|then|after that|afterwards|later|now|just)\s+|(?:пожалуйста|тогда|потом|затем|после этого|теперь|отдельно)\s+)*(?:show|покажи)\b.*$/iu,
        '',
      )
      .replace(/[.!?]+$/g, '')
      .trim();

    return normalized ? normalized : undefined;
  }

  private toCommandKey(command: ParsedMemoryCommand): string {
    if (command.action === 'inspect') {
      return 'inspect';
    }

    if (this.isFactCommand(command)) {
      return `${command.action}:${command.key}:${command.expectedValue ?? ''}`;
    }

    return `${command.action}:${command.kind}`;
  }

  private isFactCommand(
    command: ParsedMemoryCommand,
  ): command is Extract<ParsedMemoryCommand, { action: FactAction }> {
    return 'key' in command;
  }

  private async buildSnapshotResponse(language: CommandResponseLanguage, scopeKey: string): Promise<string> {
    const snapshot = await this.memoryManagementService.getSnapshot(scopeKey);
    const storeEntries = this.isSnapshotEmpty(snapshot) ? await this.loadStoreEntries(scopeKey) : [];
    const facts =
      snapshot.userFacts.length > 0
        ? snapshot.userFacts
            .map((fact) => `${fact.key}=${fact.value}${fact.pinned ? ' [pinned]' : ''}`)
            .join('; ')
        : this.formatStoreFacts(storeEntries);
    const episodicMemories =
      snapshot.episodicMemories.length > 0
        ? snapshot.episodicMemories
            .map((entry) => `${entry.kind}=${entry.summary}${entry.pinned ? ' [pinned]' : ''}`)
            .join('; ')
        : this.formatStoreEpisodicMemories(storeEntries);

    const prefix = language === 'ru' ? 'Снэпшот управляемой памяти' : 'Managed memory snapshot';
    return `${prefix}: userFacts=${facts}. episodicMemories=${episodicMemories}.`;
  }

  private async executeFactCommand(
    action: FactAction,
    key: UserProfileFactKey,
    expectedValue?: string,
    snapshot?: ManagedMemorySnapshot,
    language: CommandResponseLanguage = 'en',
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<string> {
    const targetFact = snapshot?.userFacts.find((fact) => fact.key === key);
    const fallbackFact = !targetFact ? await this.findStoreFactEntry(scopeKey, key, expectedValue) : undefined;

    if (action === 'forget_fact') {
      if (!targetFact && !fallbackFact) {
        return expectedValue
          ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
          : buildForgetFactNotFoundNote(language, key);
      }

      if (
        targetFact &&
        expectedValue &&
        this.normalizeForComparison(targetFact.value) !== this.normalizeForComparison(expectedValue)
      ) {
        return buildForgetFactValueNotFoundNote(language, key, expectedValue);
      }

      if (targetFact) {
        const deleted = await this.memoryManagementService.forgetUserFact(key, scopeKey);
        await this.deleteStoreFact(scopeKey, key, expectedValue ?? targetFact.value);
        if (!deleted) {
          return expectedValue
            ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
            : buildForgetFactNotFoundNote(language, key);
        }

        return expectedValue
          ? buildForgetFactByValueDeletedNote(language, key, expectedValue)
          : buildForgetFactDeletedNote(language, key, targetFact.value);
      }

      if (!fallbackFact || !this.memoryStoreService) {
        return expectedValue
          ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
          : buildForgetFactNotFoundNote(language, key);
      }

      const deleted = await this.memoryStoreService.delete(fallbackFact.id);
      if (!deleted) {
        return expectedValue
          ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
          : buildForgetFactNotFoundNote(language, key);
      }

      return expectedValue
        ? buildForgetFactByValueDeletedNote(language, key, expectedValue)
        : buildForgetFactDeletedNote(language, key, fallbackFact.content);
    }

    const pinned = action === 'pin_fact';
    if (targetFact) {
      const fact = await this.memoryManagementService.setUserFactPinned(key, pinned, scopeKey);
      await this.setStoreFactPinned(scopeKey, key, targetFact.value, pinned);
      if (!fact) {
        return buildFactPinNotFoundNote(language, key, pinned);
      }

      return pinned
        ? buildFactPinnedNote(language, key, fact.value)
        : buildFactUnpinnedNote(language, key, fact.value);
    }

    if (!fallbackFact || !this.memoryStoreService) {
      return buildFactPinNotFoundNote(language, key, pinned);
    }

    const updated = await this.memoryStoreService.update(fallbackFact.id, { pinned });
    if (!updated) {
      return buildFactPinNotFoundNote(language, key, pinned);
    }

    return pinned
      ? buildFactPinnedNote(language, key, updated.content)
      : buildFactUnpinnedNote(language, key, updated.content);
  }

  private async executeEpisodicCommand(
    action: EpisodicAction,
    kind: EpisodicMemoryKind,
    conversation?: Conversation,
    selectorText = '',
    snapshot?: ManagedMemorySnapshot,
    language: CommandResponseLanguage = 'en',
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<string> {
    const target = this.pickRelevantEntryByKind(snapshot?.episodicMemories ?? [], kind, conversation, selectorText);
    const pinned = action === 'pin_episodic';
    if (target) {
      const updated = await this.memoryManagementService.setEpisodicMemoryPinned(target.id, pinned, scopeKey);
      await this.setStoreEpisodicPinned(scopeKey, kind, conversation, selectorText, pinned, target.summary);
      if (updated) {
        return pinned
          ? buildEpisodicPinnedNote(language, kind, updated.summary)
          : buildEpisodicUnpinnedNote(language, kind, updated.summary);
      }
    }

    const fallbackEntry = await this.findStoreEpisodicEntry(scopeKey, kind, conversation, selectorText);
    if (!fallbackEntry || !this.memoryStoreService) {
      return buildEpisodicNotFoundNote(language, kind, pinned ? 'pin' : 'unpin');
    }

    const updated = await this.memoryStoreService.update(fallbackEntry.id, { pinned });
    if (!updated) {
      return buildEpisodicNotFoundNote(language, kind, pinned ? 'pin' : 'unpin');
    }

    const summary = updated.summary ?? updated.content;
    return pinned
      ? buildEpisodicPinnedNote(language, kind, summary)
      : buildEpisodicUnpinnedNote(language, kind, summary);
  }

  private getScopeKey(conversation?: Conversation): string {
    return conversation?.scopeKey || DEFAULT_LOCAL_MEMORY_SCOPE;
  }

  private isSnapshotEmpty(snapshot: ManagedMemorySnapshot): boolean {
    return snapshot.userFacts.length === 0 && snapshot.episodicMemories.length === 0;
  }

  private async loadStoreEntries(scopeKey: string): Promise<MemoryEntry[]> {
    if (!this.memoryStoreService) {
      return [];
    }

    return this.memoryStoreService.query({
      scopeKey,
      excludeSuperseded: true,
      limit: 100,
    });
  }

  private formatStoreFacts(entries: MemoryEntry[]): string {
    const facts = entries
      .filter((entry) => entry.kind === 'fact')
      .map((entry) => {
        const key = entry.category ?? this.inferFactKeyFromStoreEntry(entry) ?? 'general';
        return `${key}=${entry.content}${entry.pinned ? ' [pinned]' : ''}`;
      });

    return facts.length > 0 ? facts.join('; ') : 'none';
  }

  private formatStoreEpisodicMemories(entries: MemoryEntry[]): string {
    const episodic = entries
      .map((entry) => {
        const kind = this.inferStoreEpisodicKind(entry);
        if (!kind) {
          return undefined;
        }

        const summary = entry.summary ?? entry.content;
        const pinnedSuffix = entry.pinned ? ' [pinned]' : '';
        return `${kind}=${summary}${pinnedSuffix} ([${entry.kind}] ${summary}${pinnedSuffix})`;
      })
      .filter((entry): entry is string => Boolean(entry));

    return episodic.length > 0 ? episodic.join('; ') : 'none';
  }

  private async findStoreFactEntry(
    scopeKey: string,
    key: UserProfileFactKey,
    expectedValue?: string,
  ): Promise<MemoryEntry | undefined> {
    const entries = await this.loadStoreEntries(scopeKey);
    return entries.find((entry) => {
      if (entry.kind !== 'fact' || !this.matchesStoreFactKey(entry, key)) {
        return false;
      }

      if (!expectedValue) {
        return true;
      }

      return this.normalizeForComparison(entry.content) === this.normalizeForComparison(expectedValue);
    });
  }

  private async deleteStoreFact(scopeKey: string, key: UserProfileFactKey, expectedValue?: string): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const target = await this.findStoreFactEntry(scopeKey, key, expectedValue);
    if (target) {
      await this.memoryStoreService.delete(target.id);
    }
  }

  private async setStoreFactPinned(
    scopeKey: string,
    key: UserProfileFactKey,
    expectedValue: string,
    pinned: boolean,
  ): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const target = await this.findStoreFactEntry(scopeKey, key, expectedValue);
    if (target) {
      await this.memoryStoreService.update(target.id, { pinned });
    }
  }

  private async findStoreEpisodicEntry(
    scopeKey: string,
    kind: EpisodicMemoryKind,
    conversation?: Conversation,
    selectorText = '',
  ): Promise<MemoryEntry | undefined> {
    const entries = (await this.loadStoreEntries(scopeKey)).filter((entry) => this.inferStoreEpisodicKind(entry) === kind);
    return this.pickRelevantStoreEntry(entries, conversation, selectorText);
  }

  private async setStoreEpisodicPinned(
    scopeKey: string,
    kind: EpisodicMemoryKind,
    conversation: Conversation | undefined,
    selectorText: string,
    pinned: boolean,
    expectedSummary: string,
  ): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const target =
      (await this.findStoreEpisodicEntry(scopeKey, kind, conversation, selectorText)) ??
      (await this.findStoreEpisodicEntry(scopeKey, kind, conversation, expectedSummary));
    if (target) {
      await this.memoryStoreService.update(target.id, { pinned });
    }
  }

  private inferFactKeyFromStoreEntry(entry: MemoryEntry): UserProfileFactKey | undefined {
    if (entry.category === 'name') {
      return 'name';
    }
    if (entry.category === 'role') {
      return 'role';
    }
    if (entry.category === 'project') {
      return 'project';
    }
    if (entry.category === 'goal') {
      return 'goal';
    }

    if (entry.tags.includes('name')) {
      return 'name';
    }
    if (entry.tags.includes('role')) {
      return 'role';
    }
    if (entry.tags.includes('project')) {
      return 'project';
    }
    if (entry.tags.includes('goal')) {
      return 'goal';
    }

    return undefined;
  }

  private matchesStoreFactKey(entry: MemoryEntry, key: UserProfileFactKey): boolean {
    return this.inferFactKeyFromStoreEntry(entry) === key;
  }

  private inferStoreEpisodicKind(entry: MemoryEntry): EpisodicMemoryKind | undefined {
    if (entry.category === 'goal' || entry.tags.includes('goal')) {
      return 'goal';
    }
    if (entry.category === 'constraint' || entry.tags.includes('constraint')) {
      return 'constraint';
    }
    if (entry.category === 'decision' || entry.tags.includes('decision')) {
      return 'decision';
    }
    if (entry.category === 'task' || entry.tags.includes('task')) {
      return 'task';
    }

    if (entry.kind === 'preference') {
      return 'constraint';
    }
    if (entry.kind === 'action') {
      return 'task';
    }

    return undefined;
  }

  private pickRelevantStoreEntry(
    entries: MemoryEntry[],
    conversation?: Conversation,
    selectorText = '',
  ): MemoryEntry | undefined {
    const queryContext = `${this.buildRecentConversationContext(conversation)} ${selectorText}`;
    const queryTokens = this.tokenize(queryContext);

    return entries
      .sort((left, right) => {
        const rightText = right.summary ?? right.content;
        const leftText = left.summary ?? left.content;
        const overlapDelta = this.calculateOverlap(rightText, queryTokens) - this.calculateOverlap(leftText, queryTokens);
        if (overlapDelta !== 0) {
          return overlapDelta;
        }

        const recencyDelta = right.updatedAt.localeCompare(left.updatedAt);
        if (recencyDelta !== 0) {
          return recencyDelta;
        }

        return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
      })[0];
  }

  private pickRelevantEntryByKind(
    entries: EpisodicMemoryEntry[],
    kind: EpisodicMemoryKind,
    conversation?: Conversation,
    selectorText = '',
  ): EpisodicMemoryEntry | undefined {
    const queryContext = `${this.buildRecentConversationContext(conversation)} ${selectorText}`;
    const queryTokens = this.tokenize(queryContext);
    const desiredConstraintPolarity = kind === 'constraint' ? this.inferConstraintPolarity(queryContext) : 'unknown';

    return entries
      .filter((entry) => entry.kind === kind)
      .sort((left, right) => {
        const overlapDelta = this.calculateOverlap(right.summary, queryTokens) - this.calculateOverlap(left.summary, queryTokens);
        if (overlapDelta !== 0) {
          return overlapDelta;
        }

        const polarityDelta =
          this.getConstraintPolarityScore(right.summary, desiredConstraintPolarity) -
          this.getConstraintPolarityScore(left.summary, desiredConstraintPolarity);
        if (polarityDelta !== 0) {
          return polarityDelta;
        }

        const recencyDelta = right.updatedAt.localeCompare(left.updatedAt);
        if (recencyDelta !== 0) {
          return recencyDelta;
        }

        return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
      })[0];
  }

  private buildRecentConversationContext(conversation?: Conversation): string {
    if (!conversation) {
      return '';
    }

    const userMessages = conversation.messages.filter((message) => message.role === 'user');
    const contextMessages = userMessages.length > 1 ? userMessages.slice(-5, -1) : userMessages.slice(-4);
    return contextMessages.map((message) => message.content).join(' ');
  }

  private calculateOverlap(value: string, queryTokens: Set<string>): number {
    if (queryTokens.size === 0) {
      return 0;
    }

    const valueTokens = this.tokenize(value);
    let overlap = 0;
    for (const token of valueTokens) {
      if (queryTokens.has(token)) {
        overlap += 1;
      }
    }

    return overlap;
  }

  private inferConstraintPolarity(value: string): 'negative' | 'positive' | 'unknown' {
    const normalized = value.toLocaleLowerCase();
    if (/(?:cannot|can't|must not|should not|don't|avoid|forbid|forbidden|нельзя|не стоит|не надо|не нужно|избегать|запрет)/iu.test(normalized)) {
      return 'negative';
    }

    if (/(?:can use|can now use|allowed|may use|можно использовать|теперь можно использовать|можем использовать|разрешено)/iu.test(normalized)) {
      return 'positive';
    }

    return 'unknown';
  }

  private getConstraintPolarityScore(
    summary: string,
    desired: 'negative' | 'positive' | 'unknown',
  ): number {
    if (desired === 'unknown') {
      return 0;
    }

    const normalized = summary.toLocaleLowerCase();
    const hasNegative = /(?:cannot|can't|must not|should not|don't|avoid|нельзя|не стоит|не надо|не нужно|избегать|запрет)/iu.test(
      normalized,
    );
    const hasPositive = /(?:can use|can be used|можно использовать|можно для|allowed|разрешено)/iu.test(normalized);

    if (hasNegative && hasPositive) {
      return 1;
    }

    if (desired === 'negative') {
      if (hasNegative) {
        return 2;
      }

      if (hasPositive) {
        return -2;
      }
    }

    if (desired === 'positive') {
      if (hasPositive) {
        return 2;
      }

      if (hasNegative) {
        return -2;
      }
    }

    return 0;
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

  private normalizeForComparison(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }
}
