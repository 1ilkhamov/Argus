import type { AgentUserProfile } from '../agent/profile/user-profile.types';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import type { UserProfileFact, UserProfileFactKey } from './user-profile-facts.types';

export type ManagedMemoryAuditIssueCode =
  | 'normalization_diff'
  | 'duplicate_key'
  | 'duplicate_entry'
  | 'deterministic_command'
  | 'meta_memory_discussion'
  | 'negative_fragment'
  | 'retention_candidate'
  | 'multiple_entries_same_kind';

export type ManagedMemoryAuditRecommendedAction = 'rewrite' | 'delete' | 'review';

export interface ManagedMemoryAuditIssue {
  code: ManagedMemoryAuditIssueCode;
  message: string;
  recommendedAction: ManagedMemoryAuditRecommendedAction;
  normalizedValue?: string;
}

export interface ManagedUserFactAuditItem {
  fact: UserProfileFact;
  issues: ManagedMemoryAuditIssue[];
}

export interface ManagedEpisodicMemoryAuditItem {
  entry: EpisodicMemoryEntry;
  issues: ManagedMemoryAuditIssue[];
}

export interface ManagedMemoryAuditReport {
  scopeKey: string;
  summary: {
    scannedUserFacts: number;
    scannedEpisodicMemories: number;
    flaggedUserFacts: number;
    flaggedEpisodicMemories: number;
    totalIssues: number;
  };
  userFacts: ManagedUserFactAuditItem[];
  episodicMemories: ManagedEpisodicMemoryAuditItem[];
}

export type ManagedMemoryCleanupChangeAction = 'rewrite' | 'delete';

export interface ManagedMemoryCleanupChange {
  target: 'user_fact' | 'episodic_memory';
  action: ManagedMemoryCleanupChangeAction;
  factKey?: UserProfileFactKey;
  entryId?: string;
  before: string;
  after?: string;
  reasons: ManagedMemoryAuditIssueCode[];
}

export interface ManagedMemoryCleanupReport {
  scopeKey: string;
  dryRun: boolean;
  summary: {
    userFactsBefore: number;
    userFactsAfter: number;
    episodicMemoriesBefore: number;
    episodicMemoriesAfter: number;
    rewrites: number;
    deletions: number;
  };
  audit: ManagedMemoryAuditReport;
  changes: ManagedMemoryCleanupChange[];
  snapshot: {
    interactionPreferences?: AgentUserProfile;
    userFacts: UserProfileFact[];
    episodicMemories: EpisodicMemoryEntry[];
  };
}
