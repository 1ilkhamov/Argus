import type { AgentUserProfile } from '../../agent/profile/user-profile.types';
import type { EpisodicMemoryEntry } from '../episodic-memory.types';
import type { ManagedMemoryStateMetadata, ManagedMemoryStateWrite } from '../memory.types';
import type { UserProfileFact } from '../user-profile-facts.types';

export const MEMORY_REPOSITORY = Symbol('MEMORY_REPOSITORY');

export abstract class MemoryRepository {
  abstract getInteractionPreferences(scopeKey: string): Promise<AgentUserProfile | undefined>;
  abstract saveInteractionPreferences(scopeKey: string, profile: AgentUserProfile): Promise<void>;
  abstract getManagedMemoryStateMetadata(scopeKey: string): Promise<ManagedMemoryStateMetadata>;
  abstract saveManagedMemoryState(state: ManagedMemoryStateWrite): Promise<void>;
  abstract getUserProfileFacts(scopeKey: string): Promise<UserProfileFact[]>;
  abstract saveUserProfileFacts(scopeKey: string, facts: UserProfileFact[]): Promise<void>;
  abstract getEpisodicMemoryEntries(scopeKey: string): Promise<EpisodicMemoryEntry[]>;
  abstract saveEpisodicMemoryEntries(scopeKey: string, entries: EpisodicMemoryEntry[]): Promise<void>;
}
