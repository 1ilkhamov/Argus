import type { AgentUserProfile, AgentUserProfileSource } from '../agent/profile/user-profile.types';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import type { StructuredMemoryTurnReference } from './structured-memory-metadata.types';
import type { UserProfileFact } from './user-profile-facts.types';

export const DEFAULT_LOCAL_MEMORY_SCOPE = 'local:default';

export type ManagedMemoryState = {
  scopeKey: string;
  interactionPreferences?: AgentUserProfile;
  userFacts: UserProfileFact[];
  episodicMemories: EpisodicMemoryEntry[];
};

export type ManagedMemoryStateMetadata = {
  version: number;
  lastProcessedUserMessage?: StructuredMemoryTurnReference;
};

export type ManagedMemoryStateWrite = ManagedMemoryState & {
  expectedVersion?: number;
  lastProcessedUserMessage?: StructuredMemoryTurnReference;
};

export type ResolvedInteractionPreferencesContext = {
  keyKind: 'local_default';
  source: AgentUserProfileSource;
  userProfile: AgentUserProfile;
};

export type ResolvedUserFactsContext = {
  scopeKey: string;
  source: 'recent_context' | 'persisted_facts_and_recent_context';
  facts: UserProfileFact[];
  storedFacts: UserProfileFact[];
};

export type ResolvedEpisodicMemoryContext = {
  scopeKey: string;
  source: 'recent_context' | 'persisted_memories_and_recent_context';
  entries: EpisodicMemoryEntry[];
  relevantEntries: EpisodicMemoryEntry[];
};

export type ResolvedUserMemoryContext = {
  interactionPreferences: ResolvedInteractionPreferencesContext;
  userFacts: ResolvedUserFactsContext;
  episodicMemory: ResolvedEpisodicMemoryContext;
};
