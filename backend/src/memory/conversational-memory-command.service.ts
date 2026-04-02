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
  buildForgetEpisodicDeletedNote,
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
type EpisodicAction = 'forget_episodic' | 'pin_episodic' | 'unpin_episodic';
type CandidateSource = 'managed' | 'store';
type FactMutationCandidate = {
  source: CandidateSource;
  key: UserProfileFactKey;
  value: string;
  pinned?: boolean;
  storeEntryId?: string;
};
type EpisodicMutationCandidate = {
  source: CandidateSource;
  id?: string;
  kind: EpisodicMemoryKind;
  summary: string;
  updatedAt: string;
  pinned?: boolean;
  overlap: number;
  polarityScore: number;
  storeEntryId?: string;
};
type CandidateResolution<T> =
  | {
      status: 'resolved';
      strategy: 'exact' | 'scoped';
      target: T;
      candidates: T[];
    }
  | {
      status: 'ambiguous';
      strategy: 'exact' | 'scoped';
      candidates: T[];
    }
  | {
      status: 'not_found';
      strategy: 'exact' | 'scoped';
      candidates: T[];
    };
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
      return {
        action: action === 'forget_fact' ? 'forget_episodic' : action === 'pin' ? 'pin_episodic' : 'unpin_episodic',
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
      expectedValue: this.extractExpectedFactValue(clause, factKey),
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
    const quotedMatch = /["“«](.+?)["”»]/u.exec(content);
    if (quotedMatch?.[1]) {
      const quoted = this.normalizeTargetValue(quotedMatch[1]);
      if (quoted) {
        return quoted;
      }
    }

    const keyPattern =
      key === 'name'
        ? '(?:\\bname\\b|имя)'
        : key === 'role'
          ? '(?:\\brole\\b|роль)'
          : key === 'goal'
            ? '(?:\\bgoal\\b|цель)'
            : '(?:\\bproject\\b|проект)';

    const match = new RegExp(`${keyPattern}\\s+([^,.!?;:]+(?:\\s+[^,.!?;:]+){0,5})`, 'iu').exec(content);
    const normalized = this.normalizeTargetValue(match?.[1]);
    return normalized && normalized !== 'project' && normalized !== 'name' && normalized !== 'role' && normalized !== 'goal'
      ? normalized
      : undefined;
  }

  private normalizeTargetValue(value: string | undefined): string | undefined {
    const normalized = value
      ?.replace(/^(?:named|called|fact|memory|мой|моя|моё|мои|my|the|old|new|стар(?:ый|ое|ую)?|нов(?:ый|ое|ую)?|stored|current|текущ(?:ий|ая|ее|ую))\s+/iu, '')
      .replace(/^(?:project|проект|name|имя|role|роль|goal|цель)\s+/iu, '')
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

    return `${command.action}:${command.kind}:${this.normalizeForComparison(command.selectorText)}`;
  }

  private isFactCommand(
    command: ParsedMemoryCommand,
  ): command is Extract<ParsedMemoryCommand, { action: FactAction }> {
    return 'key' in command;
  }

  private async buildSnapshotResponse(language: CommandResponseLanguage, scopeKey: string): Promise<string> {
    const snapshot = await this.memoryManagementService.getSnapshot(scopeKey);
    const storeEntries = this.isSnapshotEmpty(snapshot) ? await this.loadStoreEntries(scopeKey) : [];
    const interactionPreferences = snapshot.interactionPreferences
      ? [
          `language=${snapshot.interactionPreferences.communication.preferredLanguage}`,
          `tone=${snapshot.interactionPreferences.communication.tone}`,
          `detail=${snapshot.interactionPreferences.communication.detail}`,
          `structure=${snapshot.interactionPreferences.communication.structure}`,
          `pushback=${snapshot.interactionPreferences.interaction.allowPushback ? 'yes' : 'no'}`,
          `proactive=${snapshot.interactionPreferences.interaction.allowProactiveSuggestions ? 'yes' : 'no'}`,
        ].join(', ')
      : 'none';
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
    const version = snapshot.processingState?.expectedVersion ?? 0;
    const lastProcessedUserMessage = snapshot.processingState?.lastProcessedUserMessage?.messageId ?? 'none';

    const prefix = language === 'ru' ? 'Снэпшот управляемой памяти' : 'Managed memory snapshot';
    return `${prefix}: interactionPreferences=${interactionPreferences}. userFacts=${facts}. episodicMemories=${episodicMemories}. version=${version}. lastProcessedUserMessage=${lastProcessedUserMessage}.`;
  }

  private async executeFactCommand(
    action: FactAction,
    key: UserProfileFactKey,
    expectedValue?: string,
    snapshot?: ManagedMemorySnapshot,
    language: CommandResponseLanguage = 'en',
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<string> {
    const resolution = await this.resolveFactCandidate(key, expectedValue, snapshot, scopeKey);
    if (resolution.status === 'ambiguous') {
      const candidates = resolution.candidates.map((candidate) => this.describeFactCandidate(candidate));
      return this.composeMutationResponse(
        language,
        this.buildFactAmbiguousNote(language, key, expectedValue),
        candidates,
        [],
        candidates,
        this.buildAmbiguityReason(language, resolution.strategy),
      );
    }

    if (action === 'forget_fact') {
      if (resolution.status === 'not_found') {
        return this.composeMutationResponse(
          language,
          expectedValue
            ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
            : buildForgetFactNotFoundNote(language, key),
          [],
          [],
          [],
        );
      }

      const targetFact = resolution.target;
      if (targetFact.source === 'managed') {
        const deleted = await this.memoryManagementService.forgetUserFact(key, scopeKey, targetFact.value);
        await this.deleteStoreFactByExactValue(scopeKey, key, targetFact.value);
        if (!deleted) {
          return this.composeMutationResponse(
            language,
            expectedValue
              ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
              : buildForgetFactNotFoundNote(language, key),
            [],
            [],
            [],
          );
        }

        return this.composeMutationResponse(
          language,
          expectedValue
            ? buildForgetFactByValueDeletedNote(language, key, expectedValue)
            : buildForgetFactDeletedNote(language, key, targetFact.value),
          [this.describeFactCandidate(targetFact)],
          [this.describeFactCandidate(targetFact)],
          [],
        );
      }

      if (!this.memoryStoreService || !targetFact.storeEntryId) {
        return this.composeMutationResponse(
          language,
          expectedValue
            ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
            : buildForgetFactNotFoundNote(language, key),
          [],
          [],
          [],
        );
      }

      const deleted = await this.memoryStoreService.delete(targetFact.storeEntryId);
      if (!deleted) {
        return this.composeMutationResponse(
          language,
          expectedValue
            ? buildForgetFactValueNotFoundNote(language, key, expectedValue)
            : buildForgetFactNotFoundNote(language, key),
          [],
          [],
          [],
        );
      }

      return this.composeMutationResponse(
        language,
        expectedValue
          ? buildForgetFactByValueDeletedNote(language, key, expectedValue)
          : buildForgetFactDeletedNote(language, key, targetFact.value),
        [this.describeFactCandidate(targetFact)],
        [this.describeFactCandidate(targetFact)],
        [],
      );
    }

    const pinned = action === 'pin_fact';
    if (resolution.status === 'not_found') {
      return this.composeMutationResponse(
        language,
        buildFactPinNotFoundNote(language, key, pinned),
        [],
        [],
        [],
      );
    }

    const targetFact = resolution.target;
    if (targetFact.source === 'managed') {
      const fact = await this.memoryManagementService.setUserFactPinned(key, pinned, scopeKey, targetFact.value);
      await this.setStoreFactPinnedByExactValue(scopeKey, key, targetFact.value, pinned);
      if (!fact) {
        return this.composeMutationResponse(
          language,
          buildFactPinNotFoundNote(language, key, pinned),
          [],
          [],
          [],
        );
      }

      return this.composeMutationResponse(
        language,
        pinned ? buildFactPinnedNote(language, key, fact.value) : buildFactUnpinnedNote(language, key, fact.value),
        [this.describeFactCandidate(targetFact)],
        [this.describeFactCandidate({ ...targetFact, value: fact.value, pinned: fact.pinned })],
        [],
      );
    }

    if (!this.memoryStoreService || !targetFact.storeEntryId) {
      return this.composeMutationResponse(
        language,
        buildFactPinNotFoundNote(language, key, pinned),
        [],
        [],
        [],
      );
    }

    const updated = await this.memoryStoreService.update(targetFact.storeEntryId, { pinned });
    if (!updated) {
      return this.composeMutationResponse(
        language,
        buildFactPinNotFoundNote(language, key, pinned),
        [],
        [],
        [],
      );
    }

    return this.composeMutationResponse(
      language,
      pinned ? buildFactPinnedNote(language, key, updated.content) : buildFactUnpinnedNote(language, key, updated.content),
      [this.describeFactCandidate(targetFact)],
      [this.describeFactCandidate({ ...targetFact, value: updated.content, pinned: updated.pinned })],
      [],
    );
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
    const resolution = await this.resolveEpisodicCandidate(kind, conversation, selectorText, snapshot, scopeKey);
    if (resolution.status === 'ambiguous') {
      const candidates = resolution.candidates.map((candidate) => this.describeEpisodicCandidate(candidate));
      return this.composeMutationResponse(
        language,
        this.buildEpisodicAmbiguousNote(language, kind),
        candidates,
        [],
        candidates,
        this.buildAmbiguityReason(language, resolution.strategy),
      );
    }

    const mutationAction = action === 'forget_episodic' ? 'delete' : action === 'pin_episodic' ? 'pin' : 'unpin';
    if (resolution.status === 'not_found') {
      return this.composeMutationResponse(
        language,
        buildEpisodicNotFoundNote(language, kind, mutationAction),
        [],
        [],
        [],
      );
    }

    const target = resolution.target;
    if (action === 'forget_episodic') {
      if (target.source === 'managed' && target.id) {
        const deleted = await this.memoryManagementService.forgetEpisodicMemory(target.id, scopeKey);
        await this.deleteStoreEpisodicByExactSummary(scopeKey, kind, target.summary);
        if (!deleted) {
          return this.composeMutationResponse(
            language,
            buildEpisodicNotFoundNote(language, kind, 'delete'),
            [],
            [],
            [],
          );
        }

        return this.composeMutationResponse(
          language,
          buildForgetEpisodicDeletedNote(language, kind, target.summary),
          [this.describeEpisodicCandidate(target)],
          [this.describeEpisodicCandidate(target)],
          [],
        );
      }

      if (!this.memoryStoreService || !target.storeEntryId) {
        return this.composeMutationResponse(
          language,
          buildEpisodicNotFoundNote(language, kind, 'delete'),
          [],
          [],
          [],
        );
      }

      const deleted = await this.memoryStoreService.delete(target.storeEntryId);
      if (!deleted) {
        return this.composeMutationResponse(
          language,
          buildEpisodicNotFoundNote(language, kind, 'delete'),
          [],
          [],
          [],
        );
      }

      return this.composeMutationResponse(
        language,
        buildForgetEpisodicDeletedNote(language, kind, target.summary),
        [this.describeEpisodicCandidate(target)],
        [this.describeEpisodicCandidate(target)],
        [],
      );
    }

    const pinned = action === 'pin_episodic';
    if (target.source === 'managed' && target.id) {
      const updated = await this.memoryManagementService.setEpisodicMemoryPinned(target.id, pinned, scopeKey);
      await this.setStoreEpisodicPinnedByExactSummary(scopeKey, kind, target.summary, pinned);
      if (!updated) {
        return this.composeMutationResponse(
          language,
          buildEpisodicNotFoundNote(language, kind, pinned ? 'pin' : 'unpin'),
          [],
          [],
          [],
        );
      }

      return this.composeMutationResponse(
        language,
        pinned ? buildEpisodicPinnedNote(language, kind, updated.summary) : buildEpisodicUnpinnedNote(language, kind, updated.summary),
        [this.describeEpisodicCandidate(target)],
        [this.describeEpisodicCandidate({ ...target, summary: updated.summary, pinned: updated.pinned })],
        [],
      );
    }

    if (!this.memoryStoreService || !target.storeEntryId) {
      return this.composeMutationResponse(
        language,
        buildEpisodicNotFoundNote(language, kind, pinned ? 'pin' : 'unpin'),
        [],
        [],
        [],
      );
    }

    const updated = await this.memoryStoreService.update(target.storeEntryId, { pinned });
    if (!updated) {
      return this.composeMutationResponse(
        language,
        buildEpisodicNotFoundNote(language, kind, pinned ? 'pin' : 'unpin'),
        [],
        [],
        [],
      );
    }

    const summary = updated.summary ?? updated.content;
    return this.composeMutationResponse(
      language,
      pinned ? buildEpisodicPinnedNote(language, kind, summary) : buildEpisodicUnpinnedNote(language, kind, summary),
      [this.describeEpisodicCandidate(target)],
      [this.describeEpisodicCandidate({ ...target, summary, pinned: updated.pinned })],
      [],
    );
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

  private async resolveFactCandidate(
    key: UserProfileFactKey,
    expectedValue: string | undefined,
    snapshot?: ManagedMemorySnapshot,
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<CandidateResolution<FactMutationCandidate>> {
    const managedCandidates = (snapshot?.userFacts ?? [])
      .filter((fact) => fact.key === key)
      .map((fact) => ({
        source: 'managed' as const,
        key,
        value: fact.value,
        pinned: fact.pinned,
      }));

    if (expectedValue) {
      const managedExact = managedCandidates.filter(
        (candidate) => this.normalizeForComparison(candidate.value) === this.normalizeForComparison(expectedValue),
      );
      if (managedExact.length === 1) {
        const [managedTarget] = managedExact;
        if (managedTarget) {
          return { status: 'resolved', strategy: 'exact', target: managedTarget, candidates: managedExact };
        }
      }
      if (managedExact.length > 1) {
        return { status: 'ambiguous', strategy: 'exact', candidates: managedExact };
      }

      const storeCandidates = await this.listStoreFactCandidates(scopeKey, key);
      const storeExact = storeCandidates.filter(
        (candidate) => this.normalizeForComparison(candidate.value) === this.normalizeForComparison(expectedValue),
      );
      if (storeExact.length === 1) {
        const [storeTarget] = storeExact;
        if (storeTarget) {
          return { status: 'resolved', strategy: 'exact', target: storeTarget, candidates: storeExact };
        }
      }
      if (storeExact.length > 1) {
        return { status: 'ambiguous', strategy: 'exact', candidates: storeExact };
      }

      return { status: 'not_found', strategy: 'exact', candidates: [] };
    }

    if (managedCandidates.length === 1) {
      const [managedTarget] = managedCandidates;
      if (managedTarget) {
        return { status: 'resolved', strategy: 'scoped', target: managedTarget, candidates: managedCandidates };
      }
    }
    if (managedCandidates.length > 1) {
      return { status: 'ambiguous', strategy: 'scoped', candidates: managedCandidates };
    }

    const storeCandidates = await this.listStoreFactCandidates(scopeKey, key);
    if (storeCandidates.length === 1) {
      const [storeTarget] = storeCandidates;
      if (storeTarget) {
        return { status: 'resolved', strategy: 'scoped', target: storeTarget, candidates: storeCandidates };
      }
    }
    if (storeCandidates.length > 1) {
      return { status: 'ambiguous', strategy: 'scoped', candidates: storeCandidates };
    }

    return { status: 'not_found', strategy: 'scoped', candidates: [] };
  }

  private async listStoreFactCandidates(
    scopeKey: string,
    key: UserProfileFactKey,
  ): Promise<FactMutationCandidate[]> {
    const entries = await this.loadStoreEntries(scopeKey);
    return entries
      .filter((entry) => entry.kind === 'fact' && this.matchesStoreFactKey(entry, key))
      .map((entry) => ({
        source: 'store' as const,
        key,
        value: entry.content,
        pinned: entry.pinned,
        storeEntryId: entry.id,
      }));
  }

  private async deleteStoreFactByExactValue(
    scopeKey: string,
    key: UserProfileFactKey,
    expectedValue: string,
  ): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const matches = (await this.listStoreFactCandidates(scopeKey, key)).filter(
      (candidate) => this.normalizeForComparison(candidate.value) === this.normalizeForComparison(expectedValue),
    );
    const [match] = matches;
    if (matches.length === 1 && match?.storeEntryId) {
      await this.memoryStoreService.delete(match.storeEntryId);
    }
  }

  private async setStoreFactPinnedByExactValue(
    scopeKey: string,
    key: UserProfileFactKey,
    expectedValue: string,
    pinned: boolean,
  ): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const matches = (await this.listStoreFactCandidates(scopeKey, key)).filter(
      (candidate) => this.normalizeForComparison(candidate.value) === this.normalizeForComparison(expectedValue),
    );
    const [match] = matches;
    if (matches.length === 1 && match?.storeEntryId) {
      await this.memoryStoreService.update(match.storeEntryId, { pinned });
    }
  }

  private async resolveEpisodicCandidate(
    kind: EpisodicMemoryKind,
    conversation?: Conversation,
    selectorText = '',
    snapshot?: ManagedMemorySnapshot,
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<CandidateResolution<EpisodicMutationCandidate>> {
    const queryContext = `${this.buildRecentConversationContext(conversation)} ${selectorText}`.trim();
    const queryTokens = this.tokenize(queryContext);
    const desiredConstraintPolarity = kind === 'constraint' ? this.inferConstraintPolarity(queryContext) : 'unknown';
    const managedCandidates = (snapshot?.episodicMemories ?? [])
      .filter((entry) => entry.kind === kind)
      .map((entry) => ({
        source: 'managed' as const,
        id: entry.id,
        kind,
        summary: entry.summary,
        updatedAt: entry.updatedAt,
        pinned: entry.pinned,
        overlap: this.calculateOverlap(entry.summary, queryTokens),
        polarityScore: this.getConstraintPolarityScore(entry.summary, desiredConstraintPolarity),
      }));
    const managedResolution = this.resolveEpisodicCandidates(managedCandidates, selectorText);
    if (managedResolution.status !== 'not_found' || managedCandidates.length > 0) {
      return managedResolution;
    }

    const storeCandidates = (await this.loadStoreEntries(scopeKey))
      .filter((entry) => this.inferStoreEpisodicKind(entry) === kind)
      .map((entry) => ({
        source: 'store' as const,
        kind,
        summary: entry.summary ?? entry.content,
        updatedAt: entry.updatedAt,
        pinned: entry.pinned,
        overlap: this.calculateOverlap(entry.summary ?? entry.content, queryTokens),
        polarityScore: this.getConstraintPolarityScore(entry.summary ?? entry.content, desiredConstraintPolarity),
        storeEntryId: entry.id,
      }));
    return this.resolveEpisodicCandidates(storeCandidates, selectorText);
  }

  private resolveEpisodicCandidates(
    candidates: EpisodicMutationCandidate[],
    selectorText: string,
  ): CandidateResolution<EpisodicMutationCandidate> {
    if (candidates.length === 0) {
      return { status: 'not_found', strategy: 'scoped', candidates: [] };
    }

    const exactCandidates = candidates.filter((candidate) => this.matchesExactEpisodicCandidate(candidate.summary, selectorText));
    if (exactCandidates.length === 1) {
      const [exactTarget] = exactCandidates;
      if (exactTarget) {
        return { status: 'resolved', strategy: 'exact', target: exactTarget, candidates: exactCandidates };
      }
    }
    if (exactCandidates.length > 1) {
      return { status: 'ambiguous', strategy: 'exact', candidates: exactCandidates };
    }

    const ranked = [...candidates].sort((left, right) => this.compareEpisodicCandidates(right, left));
    const top = ranked[0];
    const second = ranked[1];
    if (!top) {
      return { status: 'not_found', strategy: 'scoped', candidates: [] };
    }
    if (top.overlap === 0 && ranked.length > 1) {
      return { status: 'ambiguous', strategy: 'scoped', candidates: ranked.slice(0, 3) };
    }
    if (second && this.compareEpisodicCandidates(top, second) === 0) {
      return {
        status: 'ambiguous',
        strategy: 'scoped',
        candidates: ranked.filter((candidate) => this.compareEpisodicCandidates(top, candidate) === 0).slice(0, 3),
      };
    }
    return { status: 'resolved', strategy: 'scoped', target: top, candidates: [top] };
  }

  private compareEpisodicCandidates(
    left: EpisodicMutationCandidate,
    right: EpisodicMutationCandidate,
  ): number {
    const overlapDelta = left.overlap - right.overlap;
    if (overlapDelta !== 0) {
      return overlapDelta;
    }

    const polarityDelta = left.polarityScore - right.polarityScore;
    if (polarityDelta !== 0) {
      return polarityDelta;
    }

    const recencyDelta = left.updatedAt.localeCompare(right.updatedAt);
    if (recencyDelta !== 0) {
      return recencyDelta;
    }

    return Number(Boolean(left.pinned)) - Number(Boolean(right.pinned));
  }

  private matchesExactEpisodicCandidate(summary: string, selectorText: string): boolean {
    const quoted = this.extractQuotedSelector(selectorText);
    if (quoted) {
      return this.normalizeForComparison(summary) === this.normalizeForComparison(quoted);
    }

    const normalizedSelector = this.normalizeForComparison(selectorText);
    const normalizedSummary = this.normalizeForComparison(summary);
    return normalizedSelector.length > normalizedSummary.length && normalizedSelector.includes(normalizedSummary);
  }

  private extractQuotedSelector(value: string): string | undefined {
    const quotedMatch = /["“«](.+?)["”»]/u.exec(value);
    const normalized = quotedMatch?.[1]?.trim().replace(/[.!?]+$/g, '').trim();
    return normalized || undefined;
  }

  private async deleteStoreEpisodicByExactSummary(
    scopeKey: string,
    kind: EpisodicMemoryKind,
    summary: string,
  ): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const matches = (await this.loadStoreEntries(scopeKey)).filter(
      (entry) =>
        this.inferStoreEpisodicKind(entry) === kind &&
        this.normalizeForComparison(entry.summary ?? entry.content) === this.normalizeForComparison(summary),
    );
    const [match] = matches;
    if (matches.length === 1 && match) {
      await this.memoryStoreService.delete(match.id);
    }
  }

  private async setStoreEpisodicPinnedByExactSummary(
    scopeKey: string,
    kind: EpisodicMemoryKind,
    summary: string,
    pinned: boolean,
  ): Promise<void> {
    if (!this.memoryStoreService) {
      return;
    }

    const matches = (await this.loadStoreEntries(scopeKey)).filter(
      (entry) =>
        this.inferStoreEpisodicKind(entry) === kind &&
        this.normalizeForComparison(entry.summary ?? entry.content) === this.normalizeForComparison(summary),
    );
    const [match] = matches;
    if (matches.length === 1 && match) {
      await this.memoryStoreService.update(match.id, { pinned });
    }
  }

  private composeMutationResponse(
    language: CommandResponseLanguage,
    note: string,
    found: string[],
    changed: string[],
    unchanged: string[],
    reason?: string,
  ): string {
    const none = language === 'ru' ? 'ничего' : 'none';
    const parts = [
      note,
      language === 'ru' ? `Найдено: ${found.length > 0 ? found.join('; ') : none}.` : `Found: ${found.length > 0 ? found.join('; ') : none}.`,
      language === 'ru'
        ? `Изменено: ${changed.length > 0 ? changed.join('; ') : none}.`
        : `Changed: ${changed.length > 0 ? changed.join('; ') : none}.`,
      language === 'ru'
        ? `Без изменений: ${unchanged.length > 0 ? unchanged.join('; ') : none}.`
        : `Unchanged: ${unchanged.length > 0 ? unchanged.join('; ') : none}.`,
    ];
    if (reason) {
      parts.push(language === 'ru' ? `Причина: ${reason}.` : `Reason: ${reason}.`);
    }
    return parts.join(' ');
  }

  private buildFactAmbiguousNote(
    language: CommandResponseLanguage,
    key: UserProfileFactKey,
    expectedValue?: string,
  ): string {
    if (language === 'ru') {
      return expectedValue
        ? `Я нашёл несколько сохранённых фактов о ${key} со значением, похожим на "${expectedValue}", и ничего не изменил.`
        : `Я нашёл несколько сохранённых фактов о ${key} и ничего не изменил.`;
    }

    return expectedValue
      ? `I found multiple stored ${key} facts matching "${expectedValue}" and changed nothing.`
      : `I found multiple stored ${key} facts and changed nothing.`;
  }

  private buildEpisodicAmbiguousNote(language: CommandResponseLanguage, kind: EpisodicMemoryKind): string {
    if (language === 'ru') {
      return `Я нашёл несколько подходящих записей об ${kind} и ничего не изменил.`;
    }

    return `I found multiple matching ${kind} memories and changed nothing.`;
  }

  private buildAmbiguityReason(language: CommandResponseLanguage, strategy: 'exact' | 'scoped'): string {
    if (language === 'ru') {
      return strategy === 'exact'
        ? 'несколько точных совпадений; уточни одно конкретное сохранённое значение'
        : 'несколько scoped-кандидатов; укажи точное сохранённое значение или процитируй запись';
    }

    return strategy === 'exact'
      ? 'multiple exact matches were found; specify one exact stored value'
      : 'multiple scoped candidates were found; specify the exact stored value or quote the target entry';
  }

  private describeFactCandidate(candidate: FactMutationCandidate): string {
    return `${candidate.key}="${candidate.value}"${candidate.pinned ? ' [pinned]' : ''}`;
  }

  private describeEpisodicCandidate(candidate: EpisodicMutationCandidate): string {
    return `${candidate.kind}="${candidate.summary}"${candidate.pinned ? ' [pinned]' : ''}`;
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
