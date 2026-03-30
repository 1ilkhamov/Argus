import { isDeterministicMemoryCommandMessage } from './conversational-memory-command.matchers';
import type { EpisodicMemoryLifecycleService } from './episodic-memory-lifecycle.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import type { ManagedMemoryAuditIssueCode } from './memory-audit.types';
import type { UserFactsLifecycleService } from './user-facts-lifecycle.service';
import type { UserProfileFact } from './user-profile-facts.types';

export interface SanitizedFactCommitResult {
  facts: UserProfileFact[];
  dropped: Array<{
    fact: UserProfileFact;
    reasons: ManagedMemoryAuditIssueCode[];
  }>;
  restored: UserProfileFact[];
}

export interface SanitizedEntryCommitResult {
  entries: EpisodicMemoryEntry[];
  dropped: Array<{
    entry: EpisodicMemoryEntry;
    reasons: ManagedMemoryAuditIssueCode[];
  }>;
  restored: EpisodicMemoryEntry[];
}

export function sanitizeFactsForCommit(
  facts: UserProfileFact[],
  persistedFacts: UserProfileFact[],
  userFactsLifecycleService: UserFactsLifecycleService,
): SanitizedFactCommitResult {
  const normalizedFacts = userFactsLifecycleService.prepareFactsForStorage(facts);
  const normalizedPersistedFacts = userFactsLifecycleService.prepareFactsForStorage(persistedFacts);
  const persistedFactsByKey = new Map(normalizedPersistedFacts.map((fact) => [fact.key, fact]));
  const acceptedFacts: UserProfileFact[] = [];
  const dropped: SanitizedFactCommitResult['dropped'] = [];

  for (const fact of normalizedFacts) {
    const reasons = getFactCommitBlockingIssueCodes(fact);
    if (reasons.length === 0) {
      acceptedFacts.push(fact);
      continue;
    }

    dropped.push({ fact, reasons });
  }

  const restored: UserProfileFact[] = [];
  for (const item of dropped) {
    const fallback = persistedFactsByKey.get(item.fact.key);
    if (!fallback) {
      continue;
    }

    if (acceptedFacts.some((fact) => fact.key === fallback.key) || restored.some((fact) => fact.key === fallback.key)) {
      continue;
    }

    if (getFactCommitBlockingIssueCodes(fallback).length > 0) {
      continue;
    }

    restored.push(fallback);
  }

  return {
    facts: userFactsLifecycleService.prepareFactsForStorage([...acceptedFacts, ...restored]),
    dropped,
    restored,
  };
}

export function sanitizeEntriesForCommit(
  entries: EpisodicMemoryEntry[],
  persistedEntries: EpisodicMemoryEntry[],
  episodicMemoryLifecycleService: EpisodicMemoryLifecycleService,
  now = new Date(),
): SanitizedEntryCommitResult {
  const normalizedEntries = episodicMemoryLifecycleService.prepareEntriesForStorage(entries, now);
  const normalizedPersistedEntries = episodicMemoryLifecycleService.prepareEntriesForStorage(persistedEntries, now);
  const acceptedEntries: EpisodicMemoryEntry[] = [];
  const dropped: SanitizedEntryCommitResult['dropped'] = [];
  let droppedGoalCandidate = false;

  for (const entry of normalizedEntries) {
    const reasons = getEntryCommitBlockingIssueCodes(entry);
    if (reasons.length === 0) {
      acceptedEntries.push(entry);
      continue;
    }

    dropped.push({ entry, reasons });
    if (entry.kind === 'goal') {
      droppedGoalCandidate = true;
    }
  }

  const restored: EpisodicMemoryEntry[] = [];
  if (droppedGoalCandidate && !acceptedEntries.some((entry) => entry.kind === 'goal')) {
    const fallbackGoal = pickPreferredGoalEntry(
      normalizedPersistedEntries.filter((entry) => entry.kind === 'goal' && getEntryCommitBlockingIssueCodes(entry).length === 0),
    );
    if (fallbackGoal) {
      restored.push(fallbackGoal);
    }
  }

  return {
    entries: episodicMemoryLifecycleService.prepareEntriesForStorage([...acceptedEntries, ...restored], now),
    dropped,
    restored,
  };
}

export function getFactCommitBlockingIssueCodes(fact: UserProfileFact): ManagedMemoryAuditIssueCode[] {
  const reasons: ManagedMemoryAuditIssueCode[] = [];

  if (isNegativeMemoryFragment(fact.value)) {
    reasons.push('negative_fragment');
  }

  if (isDeterministicMemoryCommandMessage(fact.value)) {
    reasons.push('deterministic_command');
  }

  if (isMetaMemoryDiscussion(fact.value)) {
    reasons.push('meta_memory_discussion');
  }

  return reasons;
}

export function getEntryCommitBlockingIssueCodes(entry: EpisodicMemoryEntry): ManagedMemoryAuditIssueCode[] {
  const reasons: ManagedMemoryAuditIssueCode[] = [];

  if (isNegativeMemoryFragment(entry.summary)) {
    reasons.push('negative_fragment');
  }

  if (isDeterministicMemoryCommandMessage(entry.summary)) {
    reasons.push('deterministic_command');
  }

  if (isMetaMemoryDiscussion(entry.summary)) {
    reasons.push('meta_memory_discussion');
  }

  return reasons;
}

export function isNegativeMemoryFragment(value: string): boolean {
  return /^(?:уже\s+не|больше\s+не|не\s+|no\s+longer\b|not\b)/iu.test(value.trim());
}

export function isMetaMemoryDiscussion(value: string): boolean {
  return /(?:memory command|memory snapshot|snapshot памяти|снэпшот памяти|команд(?:а|ы)\s+памяти|pin\/?unpin|forget\s+my|show\s+memory|покажи\s+(?:snapshot|снэпшот)|закрепи\s+мо|открепи\s+мо|забудь\s+мо)/iu.test(
    value,
  );
}

function pickPreferredGoalEntry(entries: EpisodicMemoryEntry[]): EpisodicMemoryEntry | undefined {
  return [...entries].sort((left, right) => {
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
