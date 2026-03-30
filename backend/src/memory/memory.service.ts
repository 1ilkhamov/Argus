import { Inject, Injectable } from '@nestjs/common';

import type { AgentUserProfile } from '../agent/profile/user-profile.types';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import type { ManagedMemoryStateMetadata, ManagedMemoryStateWrite } from './memory.types';
import { MEMORY_REPOSITORY, MemoryRepository } from './repositories/memory.repository';
import type { UserProfileFact } from './user-profile-facts.types';

@Injectable()
export class MemoryService {
  constructor(@Inject(MEMORY_REPOSITORY) private readonly memoryRepository: MemoryRepository) {}

  getInteractionPreferences(scopeKey: string): Promise<AgentUserProfile | undefined> {
    return this.memoryRepository.getInteractionPreferences(scopeKey);
  }

  saveInteractionPreferences(scopeKey: string, profile: AgentUserProfile): Promise<void> {
    return this.memoryRepository.saveInteractionPreferences(scopeKey, profile);
  }

  getManagedMemoryStateMetadata(scopeKey: string): Promise<ManagedMemoryStateMetadata> {
    return this.memoryRepository.getManagedMemoryStateMetadata(scopeKey);
  }

  getUserProfileFacts(scopeKey: string): Promise<UserProfileFact[]> {
    return this.memoryRepository.getUserProfileFacts(scopeKey);
  }

  saveUserProfileFacts(scopeKey: string, facts: UserProfileFact[]): Promise<void> {
    return this.memoryRepository.saveUserProfileFacts(scopeKey, facts);
  }

  getEpisodicMemoryEntries(scopeKey: string): Promise<EpisodicMemoryEntry[]> {
    return this.memoryRepository.getEpisodicMemoryEntries(scopeKey);
  }

  saveEpisodicMemoryEntries(scopeKey: string, entries: EpisodicMemoryEntry[]): Promise<void> {
    return this.memoryRepository.saveEpisodicMemoryEntries(scopeKey, entries);
  }

  saveManagedMemoryState(state: ManagedMemoryStateWrite): Promise<void> {
    return this.memoryRepository.saveManagedMemoryState(state);
  }
}
