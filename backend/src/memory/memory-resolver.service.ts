import { Injectable, Logger } from '@nestjs/common';

import { Conversation } from '../chat/entities/conversation.entity';
import { DEFAULT_AGENT_USER_PROFILE } from '../agent/profile/user-profile.types';
import { UserProfileService } from '../agent/profile/user-profile.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import { EpisodicMemoryExtractorService } from './episodic-memory-extractor.service';
import { EpisodicMemoryLifecycleService } from './episodic-memory-lifecycle.service';
import { EpisodicMemoryRetrieverService } from './episodic-memory-retriever.service';
import { sanitizeEntriesForCommit, sanitizeFactsForCommit } from './memory-commit-sanitizer';
import {
  DEFAULT_LOCAL_MEMORY_SCOPE,
  type ResolvedEpisodicMemoryContext,
  type ResolvedInteractionPreferencesContext,
  type ResolvedUserFactsContext,
  type ResolvedUserMemoryContext,
} from './memory.types';
import { buildPendingManagedMemoryConversation, toManagedMemoryCursor } from './managed-memory-processing';
import { MemoryStateVersionConflictError } from './memory-state-version-conflict.error';
import { MemoryService } from './memory.service';
import type { StructuredMemoryTurnReference } from './structured-memory-metadata.types';
import type { UserProfileFact } from './user-profile-facts.types';
import { UserFactsLifecycleService } from './user-facts-lifecycle.service';
import { UserFactsExtractorService } from './user-facts-extractor.service';

type ManagedUserMemoryCommitContext = {
  scopeKey: string;
  conversation: Conversation;
  expectedVersion: number;
  hasPendingUserMessages: boolean;
  lastProcessedUserMessage?: StructuredMemoryTurnReference;
};

@Injectable()
export class MemoryResolverService {
  private readonly logger = new Logger(MemoryResolverService.name);
  private readonly commitContextByResolution = new WeakMap<ResolvedUserMemoryContext, ManagedUserMemoryCommitContext>();

  constructor(
    private readonly userProfileService: UserProfileService,
    private readonly memoryService: MemoryService,
    private readonly userFactsExtractorService: UserFactsExtractorService,
    private readonly userFactsLifecycleService: UserFactsLifecycleService,
    private readonly episodicMemoryExtractorService: EpisodicMemoryExtractorService,
    private readonly episodicMemoryRetrieverService: EpisodicMemoryRetrieverService,
    private readonly episodicMemoryLifecycleService: EpisodicMemoryLifecycleService,
  ) {}

  async resolveInteractionPreferences(
    conversation: Conversation,
    sourceConversation: Conversation = conversation,
    scopeKey = conversation.scopeKey || DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<ResolvedInteractionPreferencesContext> {
    const persistedProfile = await this.memoryService.getInteractionPreferences(scopeKey);
    const userProfile = this.userProfileService.resolveProfile(
      sourceConversation,
      persistedProfile ?? DEFAULT_AGENT_USER_PROFILE,
    );

    const source = persistedProfile ? 'persisted_profile_and_recent_context' : 'recent_context';
    this.logger.debug(
      `Interaction preferences pipeline ${JSON.stringify({
        scopeKey,
        source,
        sourceUserMessages: sourceConversation.messages.filter((message) => message.role === 'user').length,
        persistedProfile: this.describeUserProfile(persistedProfile),
        resolvedProfile: this.describeUserProfile(userProfile),
      })}`,
    );

    return {
      keyKind: 'local_default',
      source,
      userProfile,
    };
  }

  async resolveUserFacts(
    conversation: Conversation,
    sourceConversation: Conversation = conversation,
    scopeKey = conversation.scopeKey || DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<ResolvedUserFactsContext> {
    const persistedFacts = await this.memoryService.getUserProfileFacts(scopeKey);
    const shouldExtractFromConversation = sourceConversation === conversation || this.hasUserMessages(sourceConversation);
    const resolvedFacts = shouldExtractFromConversation
      ? this.userFactsExtractorService.resolveFacts(sourceConversation, persistedFacts)
      : persistedFacts;
    const preparedFacts = this.userFactsLifecycleService.prepareFactsForStorage(resolvedFacts);
    const { facts: factsForStorage } = sanitizeFactsForCommit(
      preparedFacts,
      persistedFacts,
      this.userFactsLifecycleService,
    );
    const promptFacts = this.userFactsLifecycleService.selectPromptFacts(factsForStorage, conversation);
    const source = persistedFacts.length > 0 ? 'persisted_facts_and_recent_context' : 'recent_context';

    this.logger.debug(
      `User facts pipeline ${JSON.stringify({
        scopeKey,
        source,
        persisted: this.summarizeFacts(persistedFacts),
        resolved: this.summarizeFacts(resolvedFacts),
        stored: this.summarizeFacts(factsForStorage),
        promptVisible: this.summarizeFacts(promptFacts),
        extractionDelta: this.describeFactDelta(persistedFacts, resolvedFacts),
        storageDelta: this.describeFactDelta(resolvedFacts, factsForStorage),
        commitSanitizationDelta: this.describeFactDelta(preparedFacts, factsForStorage),
        promptDelta: this.describeFactDelta(factsForStorage, promptFacts),
      })}`,
    );

    return {
      scopeKey,
      source,
      facts: promptFacts,
      storedFacts: factsForStorage,
    };
  }

  async resolveEpisodicMemory(
    conversation: Conversation,
    sourceConversation: Conversation = conversation,
    scopeKey = conversation.scopeKey || DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<ResolvedEpisodicMemoryContext> {
    const persistedEntries = await this.memoryService.getEpisodicMemoryEntries(scopeKey);
    const shouldExtractFromConversation = sourceConversation === conversation || this.hasUserMessages(sourceConversation);
    const resolvedEntries = shouldExtractFromConversation
      ? this.episodicMemoryExtractorService.resolveMemories(sourceConversation, persistedEntries)
      : persistedEntries;
    const preparedEntries = this.episodicMemoryLifecycleService.prepareEntriesForStorage(resolvedEntries);
    const { entries } = sanitizeEntriesForCommit(
      preparedEntries,
      persistedEntries,
      this.episodicMemoryLifecycleService,
    );
    const retrievedEntries = this.episodicMemoryRetrieverService.selectRelevantMemories(conversation, entries);
    const relevantEntries = this.episodicMemoryLifecycleService.selectPromptEntries(retrievedEntries, conversation);
    const source = persistedEntries.length > 0 ? 'persisted_memories_and_recent_context' : 'recent_context';

    this.logger.debug(
      `Episodic memory pipeline ${JSON.stringify({
        scopeKey,
        source,
        persisted: this.summarizeEntries(persistedEntries),
        resolved: this.summarizeEntries(resolvedEntries),
        stored: this.summarizeEntries(entries),
        retrieved: this.summarizeEntries(retrievedEntries),
        promptVisible: this.summarizeEntries(relevantEntries),
        extractionDelta: this.describeEntryDelta(persistedEntries, resolvedEntries),
        storageDelta: this.describeEntryDelta(resolvedEntries, entries),
        commitSanitizationDelta: this.describeEntryDelta(preparedEntries, entries),
        retrievalDelta: this.describeEntryDelta(entries, retrievedEntries),
        promptDelta: this.describeEntryDelta(retrievedEntries, relevantEntries),
      })}`,
    );

    return {
      scopeKey,
      source,
      entries,
      relevantEntries,
    };
  }

  async resolveUserMemory(conversation: Conversation): Promise<ResolvedUserMemoryContext> {
    const { resolvedUserMemory, commitContext } = await this.resolveUserMemoryInternal(conversation);
    this.commitContextByResolution.set(resolvedUserMemory, commitContext);
    return resolvedUserMemory;
  }

  async commitResolvedUserMemory(resolvedUserMemory: ResolvedUserMemoryContext): Promise<void> {
    const commitContext = this.commitContextByResolution.get(resolvedUserMemory);
    if (commitContext) {
      this.commitContextByResolution.delete(resolvedUserMemory);
      await this.commitResolvedUserMemoryWithRetry(resolvedUserMemory, commitContext);
      return;
    }

    await this.persistResolvedUserMemory(resolvedUserMemory);
  }

  private async resolveUserMemoryInternal(
    conversation: Conversation,
  ): Promise<{ resolvedUserMemory: ResolvedUserMemoryContext; commitContext: ManagedUserMemoryCommitContext }> {
    const scopeKey = conversation.scopeKey || DEFAULT_LOCAL_MEMORY_SCOPE;
    const metadata = await this.memoryService.getManagedMemoryStateMetadata(scopeKey);
    const pendingConversation = buildPendingManagedMemoryConversation(conversation, metadata.lastProcessedUserMessage);
    const [interactionPreferences, userFacts, episodicMemory] = await Promise.all([
      this.resolveInteractionPreferences(conversation, pendingConversation.conversation, scopeKey),
      this.resolveUserFacts(conversation, pendingConversation.conversation, scopeKey),
      this.resolveEpisodicMemory(conversation, pendingConversation.conversation, scopeKey),
    ]);

    return {
      resolvedUserMemory: {
        interactionPreferences,
        userFacts,
        episodicMemory,
      },
      commitContext: {
        scopeKey,
        conversation,
        expectedVersion: metadata.version,
        hasPendingUserMessages: pendingConversation.userMessages.length > 0,
        lastProcessedUserMessage: toManagedMemoryCursor(pendingConversation.lastPendingUserMessage),
      },
    };
  }

  private async commitResolvedUserMemoryWithRetry(
    resolvedUserMemory: ResolvedUserMemoryContext,
    commitContext: ManagedUserMemoryCommitContext,
  ): Promise<void> {
    let currentResolved = resolvedUserMemory;
    let currentCommitContext = commitContext;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!currentCommitContext.hasPendingUserMessages) {
        return;
      }

      try {
        await this.persistResolvedUserMemory(currentResolved, currentCommitContext);
        return;
      } catch (error) {
        if (!(error instanceof MemoryStateVersionConflictError) || attempt === 2) {
          throw error;
        }

        const refreshed = await this.resolveUserMemoryInternal(currentCommitContext.conversation);
        currentResolved = refreshed.resolvedUserMemory;
        currentCommitContext = refreshed.commitContext;
      }
    }
  }

  private async persistResolvedUserMemory(
    resolvedUserMemory: ResolvedUserMemoryContext,
    commitContext?: ManagedUserMemoryCommitContext,
  ): Promise<void> {
    const scopeKey =
      commitContext?.scopeKey ||
      resolvedUserMemory.userFacts.scopeKey ||
      resolvedUserMemory.episodicMemory.scopeKey ||
      DEFAULT_LOCAL_MEMORY_SCOPE;
    const [persistedFacts, persistedEntries] = await Promise.all([
      this.memoryService.getUserProfileFacts(scopeKey),
      this.memoryService.getEpisodicMemoryEntries(scopeKey),
    ]);
    const { facts: storedFacts } = sanitizeFactsForCommit(
      resolvedUserMemory.userFacts.storedFacts,
      persistedFacts,
      this.userFactsLifecycleService,
    );
    const { entries: storedEntries } = sanitizeEntriesForCommit(
      resolvedUserMemory.episodicMemory.entries,
      persistedEntries,
      this.episodicMemoryLifecycleService,
    );

    await this.memoryService.saveManagedMemoryState({
      scopeKey,
      interactionPreferences: resolvedUserMemory.interactionPreferences.userProfile,
      userFacts: storedFacts,
      episodicMemories: storedEntries,
      expectedVersion: commitContext?.expectedVersion,
      lastProcessedUserMessage: commitContext?.lastProcessedUserMessage,
    });

    this.logger.debug(
      `Resolved user memory commit ${JSON.stringify({
        scopeKey,
        expectedVersion: commitContext?.expectedVersion,
        lastProcessedUserMessageId: commitContext?.lastProcessedUserMessage?.messageId,
        interactionPreferences: this.describeUserProfile(resolvedUserMemory.interactionPreferences.userProfile),
        userFacts: this.summarizeFacts(storedFacts),
        episodicMemories: this.summarizeEntries(storedEntries),
      })}`,
    );
  }

  private hasUserMessages(conversation: Conversation): boolean {
    return conversation.messages.some((message) => message.role === 'user');
  }

  private describeUserProfile(profile: typeof DEFAULT_AGENT_USER_PROFILE | undefined): Record<string, unknown> | undefined {
    if (!profile) {
      return undefined;
    }

    return {
      language: profile.communication.preferredLanguage,
      tone: profile.communication.tone,
      detail: profile.communication.detail,
      structure: profile.communication.structure,
      allowPushback: profile.interaction.allowPushback,
      allowProactiveSuggestions: profile.interaction.allowProactiveSuggestions,
    };
  }

  private summarizeFacts(facts: UserProfileFact[]): string[] {
    return this.limitItems(facts.map((fact) => this.formatFact(fact)));
  }

  private summarizeEntries(entries: EpisodicMemoryEntry[]): string[] {
    return this.limitItems(entries.map((entry) => this.formatEntry(entry)));
  }

  private describeFactDelta(before: UserProfileFact[], after: UserProfileFact[]): string[] {
    const beforeMap = new Map(before.map((fact) => [fact.key, fact]));
    const afterMap = new Map(after.map((fact) => [fact.key, fact]));
    const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const delta: string[] = [];

    for (const key of keys) {
      const previous = beforeMap.get(key);
      const next = afterMap.get(key);
      if (!previous && next) {
        delta.push(`+${this.formatFact(next)}`);
        continue;
      }

      if (previous && !next) {
        delta.push(`-${this.formatFact(previous)}`);
        continue;
      }

      if (previous && next && this.formatFact(previous) !== this.formatFact(next)) {
        delta.push(`${key}: ${this.formatFact(previous)} -> ${this.formatFact(next)}`);
      }
    }

    return this.limitItems(delta);
  }

  private describeEntryDelta(before: EpisodicMemoryEntry[], after: EpisodicMemoryEntry[]): string[] {
    const beforeMap = new Map(before.map((entry) => [this.toEntryComparisonKey(entry), entry]));
    const afterMap = new Map(after.map((entry) => [this.toEntryComparisonKey(entry), entry]));
    const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const delta: string[] = [];

    for (const key of keys) {
      const previous = beforeMap.get(key);
      const next = afterMap.get(key);
      if (!previous && next) {
        delta.push(`+${this.formatEntry(next)}`);
        continue;
      }

      if (previous && !next) {
        delta.push(`-${this.formatEntry(previous)}`);
        continue;
      }

      if (previous && next && this.formatEntry(previous) !== this.formatEntry(next)) {
        delta.push(`${previous.kind}: ${this.formatEntry(previous)} -> ${this.formatEntry(next)}`);
      }
    }

    return this.limitItems(delta);
  }

  private formatFact(fact: UserProfileFact): string {
    return `${fact.key}{len=${fact.value.length}, pinned=${fact.pinned ? 'yes' : 'no'}}`;
  }

  private formatEntry(entry: EpisodicMemoryEntry): string {
    return `${entry.kind}{len=${entry.summary.length}, pinned=${entry.pinned ? 'yes' : 'no'}, salience=${entry.salience.toFixed(2)}}`;
  }

  private toEntryComparisonKey(entry: EpisodicMemoryEntry): string {
    return `${entry.kind}:${this.normalizeForComparison(entry.summary)}`;
  }

  private normalizeForComparison(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  private limitItems(items: string[], max = 6): string[] {
    if (items.length <= max) {
      return items;
    }

    return [...items.slice(0, max), `+${items.length - max} more`];
  }
}
