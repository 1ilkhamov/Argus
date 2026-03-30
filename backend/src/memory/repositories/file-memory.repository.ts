import { Injectable } from '@nestjs/common';

import type { AgentUserProfile } from '../../agent/profile/user-profile.types';
import { FileStoreService } from '../../storage/file-store.service';
import type { EpisodicMemoryEntry } from '../episodic-memory.types';
import { MemoryStateVersionConflictError } from '../memory-state-version-conflict.error';
import type { ManagedMemoryStateMetadata, ManagedMemoryStateWrite } from '../memory.types';
import type { StructuredMemoryTurnReference } from '../structured-memory-metadata.types';
import type { UserProfileFact } from '../user-profile-facts.types';
import { MemoryRepository } from './memory.repository';

@Injectable()
export class FileMemoryRepository extends MemoryRepository {
  constructor(private readonly fileStoreService: FileStoreService) {
    super();
  }

  async getInteractionPreferences(scopeKey: string): Promise<AgentUserProfile | undefined> {
    const store = await this.fileStoreService.readStore();
    return store.userProfiles.find((entry) => entry.profileKey === scopeKey)?.profile;
  }

  async saveInteractionPreferences(scopeKey: string, profile: AgentUserProfile): Promise<void> {
    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      const updatedAt = new Date().toISOString();
      const existingIndex = store.userProfiles.findIndex((entry) => entry.profileKey === scopeKey);

      if (existingIndex >= 0) {
        store.userProfiles[existingIndex] = { profileKey: scopeKey, profile, updatedAt };
      } else {
        store.userProfiles.push({ profileKey: scopeKey, profile, updatedAt });
      }

      this.bumpStateVersion(store, scopeKey);
      await this.fileStoreService.writeStore(store);
    });
  }

  async getManagedMemoryStateMetadata(scopeKey: string): Promise<ManagedMemoryStateMetadata> {
    const store = await this.fileStoreService.readStore();
    const state = store.managedMemoryStates.find((entry) => entry.scopeKey === scopeKey);
    return {
      version: state?.version ?? 0,
      lastProcessedUserMessage: state?.lastProcessedUserMessage,
    };
  }

  async saveManagedMemoryState(state: ManagedMemoryStateWrite): Promise<void> {
    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      const currentState = store.managedMemoryStates.find((entry) => entry.scopeKey === state.scopeKey);
      const currentVersion = currentState?.version ?? 0;

      if (state.expectedVersion !== undefined && state.expectedVersion !== currentVersion) {
        throw new MemoryStateVersionConflictError(state.scopeKey, state.expectedVersion, currentVersion);
      }

      if (state.interactionPreferences) {
        this.upsertProfile(store, state.scopeKey, state.interactionPreferences);
      } else {
        store.userProfiles = store.userProfiles.filter((entry) => entry.profileKey !== state.scopeKey);
      }

      this.replaceFacts(store, state.scopeKey, state.userFacts);
      this.replaceEntries(store, state.scopeKey, state.episodicMemories);
      this.setManagedState(
        store,
        state.scopeKey,
        currentVersion + 1,
        state.lastProcessedUserMessage ?? currentState?.lastProcessedUserMessage,
      );

      await this.fileStoreService.writeStore(store);
    });
  }

  async getUserProfileFacts(scopeKey: string): Promise<UserProfileFact[]> {
    const store = await this.fileStoreService.readStore();
    return store.userFacts.filter((entry) => entry.scopeKey === scopeKey).map((entry) => entry.fact);
  }

  async saveUserProfileFacts(scopeKey: string, facts: UserProfileFact[]): Promise<void> {
    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      this.replaceFacts(store, scopeKey, facts);
      this.bumpStateVersion(store, scopeKey);
      await this.fileStoreService.writeStore(store);
    });
  }

  async getEpisodicMemoryEntries(scopeKey: string): Promise<EpisodicMemoryEntry[]> {
    const store = await this.fileStoreService.readStore();
    return store.episodicMemories.filter((entry) => entry.scopeKey === scopeKey).map((entry) => entry.entry);
  }

  async saveEpisodicMemoryEntries(scopeKey: string, entries: EpisodicMemoryEntry[]): Promise<void> {
    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      this.replaceEntries(store, scopeKey, entries);
      this.bumpStateVersion(store, scopeKey);
      await this.fileStoreService.writeStore(store);
    });
  }

  private upsertProfile(store: Awaited<ReturnType<FileStoreService['readStore']>>, scopeKey: string, profile: AgentUserProfile): void {
    const updatedAt = new Date().toISOString();
    const existingIndex = store.userProfiles.findIndex((entry) => entry.profileKey === scopeKey);

    if (existingIndex >= 0) {
      store.userProfiles[existingIndex] = { profileKey: scopeKey, profile, updatedAt };
      return;
    }

    store.userProfiles.push({ profileKey: scopeKey, profile, updatedAt });
  }

  private replaceFacts(
    store: Awaited<ReturnType<FileStoreService['readStore']>>,
    scopeKey: string,
    facts: UserProfileFact[],
  ): void {
    store.userFacts = [
      ...store.userFacts.filter((entry) => entry.scopeKey !== scopeKey),
      ...facts.map((fact) => ({ scopeKey, fact })),
    ];
  }

  private replaceEntries(
    store: Awaited<ReturnType<FileStoreService['readStore']>>,
    scopeKey: string,
    entries: EpisodicMemoryEntry[],
  ): void {
    store.episodicMemories = [
      ...store.episodicMemories.filter((entry) => entry.scopeKey !== scopeKey),
      ...entries.map((entry) => ({ scopeKey, entry })),
    ];
  }

  private bumpStateVersion(store: Awaited<ReturnType<FileStoreService['readStore']>>, scopeKey: string): void {
    const currentState = store.managedMemoryStates.find((entry) => entry.scopeKey === scopeKey);
    this.setManagedState(store, scopeKey, (currentState?.version ?? 0) + 1, currentState?.lastProcessedUserMessage);
  }

  private setManagedState(
    store: Awaited<ReturnType<FileStoreService['readStore']>>,
    scopeKey: string,
    version: number,
    lastProcessedUserMessage?: StructuredMemoryTurnReference,
  ): void {
    const updatedAt = new Date().toISOString();
    const nextState = {
      scopeKey,
      version,
      lastProcessedUserMessage,
      updatedAt,
    };
    const existingIndex = store.managedMemoryStates.findIndex((entry) => entry.scopeKey === scopeKey);

    if (existingIndex >= 0) {
      store.managedMemoryStates[existingIndex] = nextState;
      return;
    }

    store.managedMemoryStates.push(nextState);
  }
}
