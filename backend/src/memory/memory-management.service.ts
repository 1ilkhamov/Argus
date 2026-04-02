import { Injectable, Logger } from '@nestjs/common';

import type { AgentUserProfile } from '../agent/profile/user-profile.types';
import { Conversation } from '../chat/entities/conversation.entity';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import { EpisodicMemoryExtractorService } from './episodic-memory-extractor.service';
import { EpisodicMemoryLifecycleService } from './episodic-memory-lifecycle.service';
import { buildPendingManagedMemoryConversation, toManagedMemoryCursor } from './managed-memory-processing';
import {
  getEntryCommitBlockingIssueCodes,
  getFactCommitBlockingIssueCodes,
  sanitizeEntriesForCommit,
  sanitizeFactsForCommit,
} from './memory-commit-sanitizer';
import type {
  ManagedEpisodicMemoryAuditItem,
  ManagedMemoryAuditIssueCode,
  ManagedMemoryAuditIssue,
  ManagedMemoryAuditReport,
  ManagedMemoryCleanupChange,
  ManagedMemoryCleanupReport,
  ManagedUserFactAuditItem,
} from './memory-audit.types';
import { DEFAULT_LOCAL_MEMORY_SCOPE } from './memory.types';
import { MemoryService } from './memory.service';
import type { StructuredMemoryTurnReference } from './structured-memory-metadata.types';
import type { UserProfileFact, UserProfileFactKey } from './user-profile-facts.types';
import { UserFactsExtractorService } from './user-facts-extractor.service';
import { UserFactsLifecycleService } from './user-facts-lifecycle.service';

export interface ManagedMemorySnapshot {
  scopeKey: string;
  interactionPreferences?: AgentUserProfile;
  userFacts: UserProfileFact[];
  episodicMemories: EpisodicMemoryEntry[];
  processingState?: {
    expectedVersion: number;
    lastProcessedUserMessage?: StructuredMemoryTurnReference;
  };
}

interface EffectiveSnapshotOptions {
  excludeLatestUserMessage?: boolean;
  scopeKey?: string;
}

interface CleanupSnapshotOptions {
  dryRun?: boolean;
  now?: Date;
  scopeKey?: string;
}

@Injectable()
export class MemoryManagementService {
  private readonly logger = new Logger(MemoryManagementService.name);

  constructor(
    private readonly memoryService: MemoryService,
    private readonly userFactsExtractorService: UserFactsExtractorService,
    private readonly userFactsLifecycleService: UserFactsLifecycleService,
    private readonly episodicMemoryExtractorService: EpisodicMemoryExtractorService,
    private readonly episodicMemoryLifecycleService: EpisodicMemoryLifecycleService,
  ) {}

  async getSnapshot(scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE): Promise<ManagedMemorySnapshot> {
    const [interactionPreferences, userFacts, episodicMemories, metadata] = await Promise.all([
      this.memoryService.getInteractionPreferences(scopeKey),
      this.memoryService.getUserProfileFacts(scopeKey),
      this.memoryService.getEpisodicMemoryEntries(scopeKey),
      this.memoryService.getManagedMemoryStateMetadata(scopeKey),
    ]);

    this.logger.debug(
      `Managed snapshot load ${JSON.stringify({
        scopeKey,
        interactionPreferences: Boolean(interactionPreferences),
        userFacts: this.summarizeFacts(userFacts),
        episodicMemories: this.summarizeEntries(episodicMemories),
      })}`,
    );

    return {
      scopeKey,
      interactionPreferences,
      userFacts,
      episodicMemories,
      processingState: {
        expectedVersion: metadata.version,
        lastProcessedUserMessage: metadata.lastProcessedUserMessage,
      },
    };
  }

  async getEffectiveSnapshot(
    conversation?: Conversation,
    options: EffectiveSnapshotOptions = {},
  ): Promise<ManagedMemorySnapshot> {
    const scopeKey = options.scopeKey ?? DEFAULT_LOCAL_MEMORY_SCOPE;
    const [snapshot, metadata] = await Promise.all([
      this.getSnapshot(scopeKey),
      this.memoryService.getManagedMemoryStateMetadata(scopeKey),
    ]);
    if (!conversation) {
      const normalizedSnapshot = {
        ...snapshot,
        userFacts: this.userFactsLifecycleService.prepareFactsForStorage(snapshot.userFacts),
        episodicMemories: this.episodicMemoryLifecycleService.prepareEntriesForStorage(snapshot.episodicMemories),
        processingState: snapshot.processingState,
      };

      this.logger.debug(
        `Managed effective snapshot ${JSON.stringify({
          scopeKey,
          excludeLatestUserMessage: Boolean(options.excludeLatestUserMessage),
          conversationProvided: false,
          baseUserFacts: this.summarizeFacts(snapshot.userFacts),
          baseEpisodicMemories: this.summarizeEntries(snapshot.episodicMemories),
          effectiveUserFacts: this.summarizeFacts(normalizedSnapshot.userFacts),
          effectiveEpisodicMemories: this.summarizeEntries(normalizedSnapshot.episodicMemories),
        })}`,
      );

      return normalizedSnapshot;
    }

    const pendingConversation = buildPendingManagedMemoryConversation(conversation, metadata.lastProcessedUserMessage, {
      excludeLatestUserMessage: Boolean(options.excludeLatestUserMessage),
    });

    const effectiveSnapshot = {
      scopeKey,
      interactionPreferences: snapshot.interactionPreferences,
      userFacts: this.userFactsLifecycleService.prepareFactsForStorage(
        pendingConversation.userMessages.length > 0
          ? this.userFactsExtractorService.resolveFacts(pendingConversation.conversation, snapshot.userFacts)
          : snapshot.userFacts,
      ),
      episodicMemories: this.episodicMemoryLifecycleService.prepareEntriesForStorage(
        pendingConversation.userMessages.length > 0
          ? this.episodicMemoryExtractorService.resolveMemories(
              pendingConversation.conversation,
              snapshot.episodicMemories,
            )
          : snapshot.episodicMemories,
      ),
      processingState: {
        expectedVersion: metadata.version,
        lastProcessedUserMessage: toManagedMemoryCursor(pendingConversation.lastPendingUserMessage),
      },
    };

    this.logger.debug(
      `Managed effective snapshot ${JSON.stringify({
        scopeKey,
        excludeLatestUserMessage: Boolean(options.excludeLatestUserMessage),
        conversationProvided: true,
        userMessageCount: pendingConversation.userMessages.length,
        expectedVersion: metadata.version,
        lastProcessedUserMessageId: pendingConversation.lastPendingUserMessage?.id,
        baseUserFacts: this.summarizeFacts(snapshot.userFacts),
        baseEpisodicMemories: this.summarizeEntries(snapshot.episodicMemories),
        effectiveUserFacts: this.summarizeFacts(effectiveSnapshot.userFacts),
        effectiveEpisodicMemories: this.summarizeEntries(effectiveSnapshot.episodicMemories),
      })}`,
    );

    return effectiveSnapshot;
  }

  async saveSnapshot(snapshot: ManagedMemorySnapshot): Promise<ManagedMemorySnapshot> {
    const scopeKey = snapshot.scopeKey || DEFAULT_LOCAL_MEMORY_SCOPE;
    const [persistedFacts, persistedEntries] = await Promise.all([
      this.memoryService.getUserProfileFacts(scopeKey),
      this.memoryService.getEpisodicMemoryEntries(scopeKey),
    ]);
    const { facts: userFacts } = sanitizeFactsForCommit(
      snapshot.userFacts,
      persistedFacts,
      this.userFactsLifecycleService,
    );
    const { entries: episodicMemories } = sanitizeEntriesForCommit(
      snapshot.episodicMemories,
      persistedEntries,
      this.episodicMemoryLifecycleService,
    );

    await this.memoryService.saveManagedMemoryState({
      scopeKey,
      interactionPreferences: snapshot.interactionPreferences,
      userFacts,
      episodicMemories,
      expectedVersion: snapshot.processingState?.expectedVersion,
      lastProcessedUserMessage: snapshot.processingState?.lastProcessedUserMessage,
    });

    this.logger.debug(
      `Managed snapshot save ${JSON.stringify({
        scopeKey,
        expectedVersion: snapshot.processingState?.expectedVersion,
        lastProcessedUserMessageId: snapshot.processingState?.lastProcessedUserMessage?.messageId,
        interactionPreferences: Boolean(snapshot.interactionPreferences),
        userFacts: this.summarizeFacts(userFacts),
        episodicMemories: this.summarizeEntries(episodicMemories),
      })}`,
    );

    return {
      scopeKey,
      interactionPreferences: snapshot.interactionPreferences,
      userFacts,
      episodicMemories,
      processingState: snapshot.processingState,
    };
  }

  async getSnapshotAudit(scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE, now = new Date()): Promise<ManagedMemoryAuditReport> {
    const snapshot = await this.getSnapshot(scopeKey);
    const report = this.buildSnapshotAudit(snapshot, scopeKey, now);
    this.logSnapshotAudit(report);
    return report;
  }

  async cleanupSnapshot(options: CleanupSnapshotOptions = {}): Promise<ManagedMemoryCleanupReport> {
    const scopeKey = options.scopeKey ?? DEFAULT_LOCAL_MEMORY_SCOPE;
    const dryRun = options.dryRun ?? true;
    const now = options.now ?? new Date();
    const snapshot = await this.getSnapshot(scopeKey);
    const audit = this.buildSnapshotAudit(snapshot, scopeKey, now);
    const factAuditByKey = new Map(audit.userFacts.map((item) => [item.fact.key, item]));
    const entryAuditById = new Map(audit.episodicMemories.map((item) => [item.entry.id, item]));

    const retainedRawFacts = snapshot.userFacts.filter((fact) => !this.shouldDeleteFactInCleanup(factAuditByKey.get(fact.key)));
    const cleanedFacts = this.userFactsLifecycleService.prepareFactsForStorage(retainedRawFacts);
    const retainedRawEntries = snapshot.episodicMemories.filter(
      (entry) => !this.shouldDeleteEntryInCleanup(entryAuditById.get(entry.id)),
    );
    const cleanedEntries = this.episodicMemoryLifecycleService.prepareEntriesForStorage(retainedRawEntries, now);
    const cleanedSnapshot: ManagedMemorySnapshot = {
      scopeKey,
      interactionPreferences: snapshot.interactionPreferences,
      userFacts: cleanedFacts,
      episodicMemories: cleanedEntries,
    };
    const changes = [
      ...this.buildFactCleanupChanges(snapshot.userFacts, cleanedFacts, factAuditByKey),
      ...this.buildEntryCleanupChanges(snapshot.episodicMemories, cleanedEntries, entryAuditById),
    ];
    const persistedSnapshot = !dryRun && changes.length > 0 ? await this.saveSnapshot(cleanedSnapshot) : cleanedSnapshot;
    const report: ManagedMemoryCleanupReport = {
      scopeKey,
      dryRun,
      summary: {
        userFactsBefore: snapshot.userFacts.length,
        userFactsAfter: persistedSnapshot.userFacts.length,
        episodicMemoriesBefore: snapshot.episodicMemories.length,
        episodicMemoriesAfter: persistedSnapshot.episodicMemories.length,
        rewrites: changes.filter((change) => change.action === 'rewrite').length,
        deletions: changes.filter((change) => change.action === 'delete').length,
      },
      audit,
      changes,
      snapshot: {
        interactionPreferences: persistedSnapshot.interactionPreferences,
        userFacts: persistedSnapshot.userFacts,
        episodicMemories: persistedSnapshot.episodicMemories,
      },
    };

    this.logger.debug(
      `Managed snapshot cleanup ${JSON.stringify({
        scopeKey,
        dryRun,
        summary: report.summary,
        changes: changes.map((change) => `${change.target}:${change.action}:${change.reasons.join('|')}`),
      })}`,
    );

    return report;
  }

  async forgetUserFact(
    key: UserProfileFactKey,
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
    expectedValue?: string,
  ): Promise<boolean> {
    const facts = await this.memoryService.getUserProfileFacts(scopeKey);
    const nextFacts = facts.filter(
      (fact) =>
        fact.key !== key ||
        (expectedValue !== undefined && this.normalizeFactValue(fact.value) !== this.normalizeFactValue(expectedValue)),
    );
    if (nextFacts.length === facts.length) {
      this.logger.debug(
        `Managed fact mutation ${JSON.stringify({
          action: 'forget',
          scopeKey,
          key,
          status: 'not_found',
          ...(expectedValue !== undefined ? { targetValueLength: expectedValue.length } : {}),
        })}`,
      );
      return false;
    }

    const normalizedFacts = this.userFactsLifecycleService.prepareFactsForStorage(nextFacts);
    await this.memoryService.saveUserProfileFacts(scopeKey, normalizedFacts);
    this.logger.debug(
      `Managed fact mutation ${JSON.stringify({
        action: 'forget',
        scopeKey,
        key,
        status: 'deleted',
        ...(expectedValue !== undefined ? { targetValueLength: expectedValue.length } : {}),
        before: this.summarizeFacts(facts),
        after: this.summarizeFacts(normalizedFacts),
      })}`,
    );
    return true;
  }

  async setUserFactPinned(
    key: UserProfileFactKey,
    pinned: boolean,
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
    expectedValue?: string,
  ): Promise<UserProfileFact | undefined> {
    const facts = await this.memoryService.getUserProfileFacts(scopeKey);
    const updatedAt = new Date().toISOString();
    let found = false;
    let matchedValue: string | undefined;
    const nextFacts = facts.map((fact) => {
      if (
        fact.key !== key ||
        (expectedValue !== undefined && this.normalizeFactValue(fact.value) !== this.normalizeFactValue(expectedValue))
      ) {
        return fact;
      }

      found = true;
      matchedValue = fact.value;
      return {
        ...fact,
        pinned: pinned || undefined,
        updatedAt,
      };
    });

    if (!found) {
      this.logger.debug(
        `Managed fact mutation ${JSON.stringify({
          action: pinned ? 'pin' : 'unpin',
          scopeKey,
          key,
          status: 'not_found',
          ...(expectedValue !== undefined ? { targetValueLength: expectedValue.length } : {}),
        })}`,
      );
      return undefined;
    }

    const normalizedFacts = this.userFactsLifecycleService.prepareFactsForStorage(nextFacts);
    await this.memoryService.saveUserProfileFacts(scopeKey, normalizedFacts);
    this.logger.debug(
      `Managed fact mutation ${JSON.stringify({
        action: pinned ? 'pin' : 'unpin',
        scopeKey,
        key,
        status: 'updated',
        ...(expectedValue !== undefined ? { targetValueLength: expectedValue.length } : {}),
        after: this.summarizeFacts(normalizedFacts),
      })}`,
    );
    return normalizedFacts.find(
      (fact) => fact.key === key && (matchedValue === undefined || this.normalizeFactValue(fact.value) === this.normalizeFactValue(matchedValue)),
    );
  }

  async forgetEpisodicMemory(entryId: string, scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE): Promise<boolean> {
    const entries = await this.memoryService.getEpisodicMemoryEntries(scopeKey);
    const nextEntries = entries.filter((entry) => entry.id !== entryId);
    if (nextEntries.length === entries.length) {
      this.logger.debug(
        `Managed episodic mutation ${JSON.stringify({ action: 'forget', scopeKey, entryId, status: 'not_found' })}`,
      );
      return false;
    }

    const normalizedEntries = this.episodicMemoryLifecycleService.prepareEntriesForStorage(nextEntries);
    await this.memoryService.saveEpisodicMemoryEntries(scopeKey, normalizedEntries);
    this.logger.debug(
      `Managed episodic mutation ${JSON.stringify({
        action: 'forget',
        scopeKey,
        entryId,
        status: 'deleted',
        before: this.summarizeEntries(entries),
        after: this.summarizeEntries(normalizedEntries),
      })}`,
    );
    return true;
  }

  async setEpisodicMemoryPinned(
    entryId: string,
    pinned: boolean,
    scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE,
  ): Promise<EpisodicMemoryEntry | undefined> {
    const entries = await this.memoryService.getEpisodicMemoryEntries(scopeKey);
    const updatedAt = new Date().toISOString();
    let found = false;
    const nextEntries = entries.map((entry) => {
      if (entry.id !== entryId) {
        return entry;
      }

      found = true;
      return {
        ...entry,
        pinned: pinned || undefined,
        updatedAt,
      };
    });

    if (!found) {
      this.logger.debug(
        `Managed episodic mutation ${JSON.stringify({
          action: pinned ? 'pin' : 'unpin',
          scopeKey,
          entryId,
          status: 'not_found',
        })}`,
      );
      return undefined;
    }

    const normalizedEntries = this.episodicMemoryLifecycleService.prepareEntriesForStorage(nextEntries);
    await this.memoryService.saveEpisodicMemoryEntries(scopeKey, normalizedEntries);
    this.logger.debug(
      `Managed episodic mutation ${JSON.stringify({
        action: pinned ? 'pin' : 'unpin',
        scopeKey,
        entryId,
        status: 'updated',
        after: this.summarizeEntries(normalizedEntries),
      })}`,
    );
    return normalizedEntries.find((entry) => entry.id === entryId);
  }

  private summarizeFacts(facts: UserProfileFact[], max = 6): string[] {
    const items = facts.map((fact) => `${fact.key}{len=${fact.value.length}, pinned=${fact.pinned ? 'yes' : 'no'}}`);
    return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
  }

  private summarizeEntries(entries: EpisodicMemoryEntry[], max = 6): string[] {
    const items = entries.map((entry) => `${entry.kind}{len=${entry.summary.length}, pinned=${entry.pinned ? 'yes' : 'no'}}`);
    return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
  }

  private buildSnapshotAudit(
    snapshot: ManagedMemorySnapshot,
    scopeKey: string,
    now: Date,
  ): ManagedMemoryAuditReport {
    const factDuplicates = this.countFactKeys(snapshot.userFacts);
    const entryDuplicates = this.countEntryKeys(snapshot.episodicMemories);
    const retainedEntryKeys = new Set(
      this.episodicMemoryLifecycleService
        .prepareEntriesForStorage(snapshot.episodicMemories, now)
        .map((entry) => this.toEntryLifecycleKey(entry)),
    );
    const goalEntryCount = snapshot.episodicMemories.filter((entry) => entry.kind === 'goal').length;
    const userFacts = snapshot.userFacts
      .map((fact) => this.auditFact(fact, factDuplicates))
      .filter((item): item is ManagedUserFactAuditItem => item.issues.length > 0);
    const episodicMemories = snapshot.episodicMemories
      .map((entry) => this.auditEntry(entry, entryDuplicates, retainedEntryKeys, goalEntryCount, now))
      .filter((item): item is ManagedEpisodicMemoryAuditItem => item.issues.length > 0);
    const totalIssues =
      userFacts.reduce((sum, item) => sum + item.issues.length, 0) +
      episodicMemories.reduce((sum, item) => sum + item.issues.length, 0);

    return {
      scopeKey,
      summary: {
        scannedUserFacts: snapshot.userFacts.length,
        scannedEpisodicMemories: snapshot.episodicMemories.length,
        flaggedUserFacts: userFacts.length,
        flaggedEpisodicMemories: episodicMemories.length,
        totalIssues,
      },
      userFacts,
      episodicMemories,
    };
  }

  private logSnapshotAudit(report: ManagedMemoryAuditReport): void {
    this.logger.debug(
      `Managed snapshot audit ${JSON.stringify({
        scopeKey: report.scopeKey,
        summary: report.summary,
        flaggedUserFacts: report.userFacts.map((item) => `${item.fact.key}{issues=${item.issues.length}, pinned=${item.fact.pinned ? 'yes' : 'no'}}`),
        flaggedEpisodicMemories: report.episodicMemories.map((item) => `${item.entry.kind}{issues=${item.issues.length}, pinned=${item.entry.pinned ? 'yes' : 'no'}}`),
      })}`,
    );
  }

  private shouldDeleteFactInCleanup(auditItem: ManagedUserFactAuditItem | undefined): boolean {
    return this.hasAnyIssueCode(auditItem?.issues, ['deterministic_command', 'meta_memory_discussion', 'negative_fragment']);
  }

  private shouldDeleteEntryInCleanup(auditItem: ManagedEpisodicMemoryAuditItem | undefined): boolean {
    return this.hasAnyIssueCode(auditItem?.issues, ['deterministic_command', 'meta_memory_discussion', 'negative_fragment']);
  }

  private buildFactCleanupChanges(
    beforeFacts: UserProfileFact[],
    afterFacts: UserProfileFact[],
    auditByKey: Map<UserProfileFactKey, ManagedUserFactAuditItem>,
  ): ManagedMemoryCleanupChange[] {
    const afterMap = new Map(afterFacts.map((fact) => [fact.key, fact]));
    const changes: ManagedMemoryCleanupChange[] = [];

    for (const before of beforeFacts) {
      const after = afterMap.get(before.key);
      const reasons = (auditByKey.get(before.key)?.issues ?? []).map((issue) => issue.code);
      if (!after) {
        changes.push({
          target: 'user_fact',
          action: 'delete',
          factKey: before.key,
          before: this.formatFact(before),
          reasons: reasons.length > 0 ? reasons : ['negative_fragment'],
        });
        continue;
      }

      if (this.formatFactForComparison(before) !== this.formatFactForComparison(after)) {
        changes.push({
          target: 'user_fact',
          action: 'rewrite',
          factKey: before.key,
          before: this.formatFact(before),
          after: this.formatFact(after),
          reasons: reasons.length > 0 ? reasons : ['normalization_diff'],
        });
      }
    }

    return changes;
  }

  private buildEntryCleanupChanges(
    beforeEntries: EpisodicMemoryEntry[],
    afterEntries: EpisodicMemoryEntry[],
    auditById: Map<string, ManagedEpisodicMemoryAuditItem>,
  ): ManagedMemoryCleanupChange[] {
    const afterMap = new Map(afterEntries.map((entry) => [entry.id, entry]));
    const changes: ManagedMemoryCleanupChange[] = [];

    for (const before of beforeEntries) {
      const after = afterMap.get(before.id);
      const reasons = (auditById.get(before.id)?.issues ?? []).map((issue) => issue.code);
      if (!after) {
        changes.push({
          target: 'episodic_memory',
          action: 'delete',
          entryId: before.id,
          before: this.formatEntry(before),
          reasons: reasons.length > 0 ? reasons : ['retention_candidate'],
        });
        continue;
      }

      if (this.formatEntryForComparison(before) !== this.formatEntryForComparison(after)) {
        changes.push({
          target: 'episodic_memory',
          action: 'rewrite',
          entryId: before.id,
          before: this.formatEntry(before),
          after: this.formatEntry(after),
          reasons: reasons.length > 0 ? reasons : ['normalization_diff'],
        });
      }
    }

    return changes;
  }

  private auditFact(
    fact: UserProfileFact,
    duplicateKeyCounts: Map<UserProfileFactKey, number>,
  ): ManagedUserFactAuditItem {
    const normalizedFact = this.userFactsLifecycleService.prepareFactsForStorage([fact])[0];
    const issues: ManagedMemoryAuditIssue[] = [];

    if (normalizedFact && this.formatFactForComparison(normalizedFact) !== this.formatFactForComparison(fact)) {
      issues.push({
        code: 'normalization_diff',
        message: 'Stored fact differs from current lifecycle-normalized value and can be rewritten safely.',
        recommendedAction: 'rewrite',
        normalizedValue: normalizedFact.value,
      });
    }

    if ((duplicateKeyCounts.get(fact.key) ?? 0) > 1) {
      issues.push({
        code: 'duplicate_key',
        message: `Multiple stored facts share the key ${fact.key} and should be consolidated.`,
        recommendedAction: 'review',
      });
    }

    for (const code of getFactCommitBlockingIssueCodes(fact)) {
      issues.push(this.buildFactCommitIssue(code));
    }

    return { fact, issues };
  }

  private auditEntry(
    entry: EpisodicMemoryEntry,
    duplicateEntryCounts: Map<string, number>,
    retainedEntryKeys: Set<string>,
    goalEntryCount: number,
    now: Date,
  ): ManagedEpisodicMemoryAuditItem {
    const normalizedEntry = this.episodicMemoryLifecycleService.prepareEntriesForStorage([entry], now)[0];
    const issues: ManagedMemoryAuditIssue[] = [];
    const lifecycleKey = this.toEntryLifecycleKey(entry);

    if (normalizedEntry && this.formatEntryForComparison(normalizedEntry) !== this.formatEntryForComparison(entry)) {
      issues.push({
        code: 'normalization_diff',
        message: 'Stored episodic memory differs from lifecycle-normalized form and can be rewritten safely.',
        recommendedAction: 'rewrite',
        normalizedValue: normalizedEntry.summary,
      });
    }

    if ((duplicateEntryCounts.get(lifecycleKey) ?? 0) > 1) {
      issues.push({
        code: 'duplicate_entry',
        message: 'Multiple stored episodic entries normalize to the same kind/summary pair.',
        recommendedAction: 'review',
      });
    }

    if (entry.kind === 'goal' && goalEntryCount > 1) {
      issues.push({
        code: 'multiple_entries_same_kind',
        message: 'Multiple active goal entries are stored; older goal memory is a cleanup candidate.',
        recommendedAction: 'review',
      });
    }

    if (!retainedEntryKeys.has(lifecycleKey)) {
      issues.push({
        code: 'retention_candidate',
        message: 'Current lifecycle retention would drop this episodic memory from storage.',
        recommendedAction: 'delete',
      });
    }

    for (const code of getEntryCommitBlockingIssueCodes(entry)) {
      issues.push(this.buildEntryCommitIssue(code));
    }

    return { entry, issues };
  }

  private buildFactCommitIssue(code: ManagedMemoryAuditIssueCode): ManagedMemoryAuditIssue {
    switch (code) {
      case 'negative_fragment':
        return {
          code,
          message: 'Stored fact begins with a negated fragment and likely represents invalidated state.',
          recommendedAction: 'rewrite',
        };
      case 'deterministic_command':
        return {
          code,
          message: 'Stored fact looks like a deterministic memory command and should not live in managed memory.',
          recommendedAction: 'delete',
        };
      case 'meta_memory_discussion':
        return {
          code,
          message: 'Stored fact appears to describe memory-command mechanics rather than user state.',
          recommendedAction: 'review',
        };
      default:
        return {
          code,
          message: 'Stored fact has a commit-blocking issue.',
          recommendedAction: 'review',
        };
    }
  }

  private buildEntryCommitIssue(code: ManagedMemoryAuditIssueCode): ManagedMemoryAuditIssue {
    switch (code) {
      case 'negative_fragment':
        return {
          code,
          message: 'Stored episodic summary begins with a negated fragment and likely represents invalidated state.',
          recommendedAction: 'review',
        };
      case 'deterministic_command':
        return {
          code,
          message: 'Stored episodic summary looks like a deterministic memory command and should be removed.',
          recommendedAction: 'delete',
        };
      case 'meta_memory_discussion':
        return {
          code,
          message: 'Stored episodic summary appears to describe memory-command mechanics rather than domain context.',
          recommendedAction: 'review',
        };
      default:
        return {
          code,
          message: 'Stored episodic memory has a commit-blocking issue.',
          recommendedAction: 'review',
        };
    }
  }

  private countFactKeys(facts: UserProfileFact[]): Map<UserProfileFactKey, number> {
    const counts = new Map<UserProfileFactKey, number>();
    for (const fact of facts) {
      counts.set(fact.key, (counts.get(fact.key) ?? 0) + 1);
    }

    return counts;
  }

  private countEntryKeys(entries: EpisodicMemoryEntry[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const key = this.toEntryLifecycleKey(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return counts;
  }

  private toEntryLifecycleKey(entry: EpisodicMemoryEntry): string {
    return `${entry.kind}:${entry.summary.toLocaleLowerCase().replace(/\s+/g, ' ').trim()}`;
  }

  private formatFactForComparison(fact: UserProfileFact): string {
    return `${fact.key}:${fact.value}:${fact.pinned ? 'pinned' : 'unpinned'}`;
  }

  private normalizeFactValue(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  private formatFact(fact: UserProfileFact): string {
    return `${fact.key}=${fact.value}${fact.pinned ? ' [pinned]' : ''}`;
  }

  private formatEntryForComparison(entry: EpisodicMemoryEntry): string {
    return `${entry.kind}:${entry.summary}:${entry.pinned ? 'pinned' : 'unpinned'}:${entry.salience}`;
  }

  private formatEntry(entry: EpisodicMemoryEntry): string {
    return `${entry.kind}=${entry.summary}${entry.pinned ? ' [pinned]' : ''}`;
  }

  private hasAnyIssueCode(
    issues: ManagedMemoryAuditIssue[] | undefined,
    codes: readonly ManagedMemoryAuditIssueCode[],
  ): boolean {
    if (!issues || issues.length === 0) {
      return false;
    }

    const codeSet = new Set(codes);
    return issues.some((issue) => codeSet.has(issue.code));
  }

  private hasBlockingIssue(
    issues: ManagedMemoryAuditIssue[],
    blockingCodes: readonly ManagedMemoryAuditIssueCode[],
  ): boolean {
    const codeSet = new Set(blockingCodes);
    return issues.some((issue) => codeSet.has(issue.code));
  }
}
