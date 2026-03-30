import { Injectable } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import {
  isMemoryInspectCommand,
  MEMORY_COMMAND_SPLIT,
  startsWithDeterministicMemoryCommand,
  startsWithMemoryForgetVerb,
  startsWithMemoryPinVerb,
  startsWithMemoryUnpinVerb,
} from './conversational-memory-command.matchers';
import type { EpisodicMemoryEntry, EpisodicMemoryKind } from './episodic-memory.types';
import { MemoryManagementService, type ManagedMemorySnapshot } from './memory-management.service';
import { MemoryStateVersionConflictError } from './memory-state-version-conflict.error';
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
  constructor(private readonly memoryManagementService: MemoryManagementService) {}

  async handle(content: string, conversation?: Conversation): Promise<ConversationalMemoryCommandResult> {
    const commands = this.parseCommands(content);
    if (commands.length === 0) {
      return { handled: false };
    }

    const requiresSnapshotSync = commands.some((command) => command.action !== 'inspect');
    const syncedSnapshot = requiresSnapshotSync ? await this.syncSnapshotBeforeMutation(conversation) : undefined;
    const responses: string[] = [];
    for (const command of commands) {
      if (command.action === 'inspect') {
        responses.push(await this.buildSnapshotResponse());
        continue;
      }

      if (this.isFactCommand(command)) {
        responses.push(await this.executeFactCommand(command.action, command.key, command.expectedValue, syncedSnapshot));
        continue;
      }

      responses.push(
        await this.executeEpisodicCommand(
          command.action,
          command.kind,
          conversation,
          command.selectorText,
          syncedSnapshot,
        ),
      );
    }

    return {
      handled: true,
      response: responses.join('\n'),
    };
  }

  private async syncSnapshotBeforeMutation(conversation?: Conversation): Promise<ManagedMemorySnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.memoryManagementService.saveSnapshot(
          await this.memoryManagementService.getEffectiveSnapshot(conversation, {
            excludeLatestUserMessage: Boolean(conversation),
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

  private async buildSnapshotResponse(): Promise<string> {
    const snapshot = await this.memoryManagementService.getSnapshot();
    const facts =
      snapshot.userFacts.length > 0
        ? snapshot.userFacts
            .map((fact) => `${fact.key}=${fact.value}${fact.pinned ? ' [pinned]' : ''}`)
            .join('; ')
        : 'none';
    const episodicMemories =
      snapshot.episodicMemories.length > 0
        ? snapshot.episodicMemories
            .map((entry) => `${entry.kind}=${entry.summary}${entry.pinned ? ' [pinned]' : ''}`)
            .join('; ')
        : 'none';

    return `Managed memory snapshot: userFacts=${facts}. episodicMemories=${episodicMemories}.`;
  }

  private async executeFactCommand(
    action: FactAction,
    key: UserProfileFactKey,
    expectedValue?: string,
    snapshot?: ManagedMemorySnapshot,
  ): Promise<string> {
    const targetFact = snapshot?.userFacts.find((fact) => fact.key === key);

    if (action === 'forget_fact') {
      if (!targetFact) {
        return `I couldn't find a stored ${key} fact to forget.`;
      }

      if (expectedValue && this.normalizeForComparison(targetFact.value) !== this.normalizeForComparison(expectedValue)) {
        return `I couldn't find a stored ${key} fact matching ${expectedValue} to forget.`;
      }

      const deleted = await this.memoryManagementService.forgetUserFact(key);
      return deleted
        ? `Okay — I forgot your stored ${key} fact.`
        : `I couldn't find a stored ${key} fact to forget.`;
    }

    const pinned = action === 'pin_fact';
    const fact = await this.memoryManagementService.setUserFactPinned(key, pinned);
    if (!fact) {
      return `I couldn't find a stored ${key} fact to ${pinned ? 'pin' : 'unpin'}.`;
    }

    return pinned
      ? `Okay — I pinned your stored ${key} fact: ${fact.value}.`
      : `Okay — I unpinned your stored ${key} fact: ${fact.value}.`;
  }

  private async executeEpisodicCommand(
    action: EpisodicAction,
    kind: EpisodicMemoryKind,
    conversation?: Conversation,
    selectorText = '',
    snapshot?: ManagedMemorySnapshot,
  ): Promise<string> {
    const target = this.pickRelevantEntryByKind(snapshot?.episodicMemories ?? [], kind, conversation, selectorText);
    if (!target) {
      return `I couldn't find a stored ${kind} memory to ${action === 'pin_episodic' ? 'pin' : 'unpin'}.`;
    }

    const pinned = action === 'pin_episodic';
    const updated = await this.memoryManagementService.setEpisodicMemoryPinned(target.id, pinned);
    if (!updated) {
      return `I couldn't find a stored ${kind} memory to ${pinned ? 'pin' : 'unpin'}.`;
    }

    return pinned
      ? `Okay — I pinned the current ${kind} memory: ${updated.summary}.`
      : `Okay — I unpinned the current ${kind} memory: ${updated.summary}.`;
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
