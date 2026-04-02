import { Logger } from '@nestjs/common';
import { Conversation } from '../chat/entities/conversation.entity';
import { DEFAULT_AGENT_USER_PROFILE, type AgentUserProfile } from '../agent/profile/user-profile.types';
import { UserProfileService } from '../agent/profile/user-profile.service';
import { EpisodicMemoryExtractorService } from './episodic-memory-extractor.service';
import { EpisodicMemoryLifecycleService } from './episodic-memory-lifecycle.service';
import { EpisodicMemoryRetrieverService } from './episodic-memory-retriever.service';
import { MemoryResolverService } from './memory-resolver.service';
import { MemoryService } from './memory.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import { UserFactsLifecycleService } from './user-facts-lifecycle.service';
import { UserFactsExtractorService } from './user-facts-extractor.service';
import type { UserProfileFact } from './user-profile-facts.types';

const resolvedProfile: AgentUserProfile = {
  communication: {
    preferredLanguage: 'ru',
    tone: 'warm',
    detail: 'concise',
    structure: 'structured',
  },
  interaction: {
    allowPushback: true,
    allowProactiveSuggestions: false,
  },
};

const resolvedFacts: UserProfileFact[] = [
  {
    key: 'name',
    value: 'Alex',
    source: 'explicit_user_statement',
    confidence: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const resolvedEpisodicEntries: EpisodicMemoryEntry[] = [
  {
    id: 'mem-1',
    kind: 'goal',
    summary: 'ship phase 3 memory retrieval',
    source: 'explicit_user_statement',
    salience: 0.95,
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
];

const createMemoryServiceMock = (overrides: Partial<Record<keyof MemoryService, jest.Mock>> = {}) =>
  ({
    getInteractionPreferences: jest.fn().mockResolvedValue(undefined),
    saveInteractionPreferences: jest.fn().mockResolvedValue(undefined),
    getManagedMemoryStateMetadata: jest.fn().mockResolvedValue({ version: 0 }),
    getUserProfileFacts: jest.fn().mockResolvedValue([]),
    saveUserProfileFacts: jest.fn().mockResolvedValue(undefined),
    getEpisodicMemoryEntries: jest.fn().mockResolvedValue([]),
    saveEpisodicMemoryEntries: jest.fn().mockResolvedValue(undefined),
    saveManagedMemoryState: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as MemoryService;

const expectDebugMessagesToContain = (debugSpy: jest.SpyInstance, fragments: string[]): void => {
  const messages = debugSpy.mock.calls.map(([message]) => String(message)).join('\n');
  fragments.forEach((fragment) => {
    expect(messages).toContain(fragment);
  });
};

describe('MemoryResolverService', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves interaction preferences from recent context when no persisted scope exists', async () => {
    const conversation = new Conversation({ id: 'conv-1' });
    const getInteractionPreferences = jest.fn().mockResolvedValue(undefined);
    const saveInteractionPreferences = jest.fn().mockResolvedValue(undefined);
    const resolveProfile = jest.fn().mockReturnValue(resolvedProfile);
    const service = new MemoryResolverService(
      { resolveProfile } as unknown as UserProfileService,
      createMemoryServiceMock({
        getInteractionPreferences,
        saveInteractionPreferences,
      }),
      { resolveFacts: jest.fn().mockReturnValue([]) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockImplementation((facts: UserProfileFact[]) => facts),
        selectPromptFacts: jest.fn().mockReturnValue([]),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockImplementation((entries: EpisodicMemoryEntry[]) => entries),
        selectPromptEntries: jest.fn().mockReturnValue([]),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await expect(service.resolveInteractionPreferences(conversation)).resolves.toEqual({
      keyKind: 'local_default',
      source: 'recent_context',
      userProfile: resolvedProfile,
    });
    expect(getInteractionPreferences).toHaveBeenCalledWith('local:default');
    expect(resolveProfile).toHaveBeenCalledWith(conversation, DEFAULT_AGENT_USER_PROFILE);
    expect(saveInteractionPreferences).not.toHaveBeenCalled();
  });

  it('resolves user facts from recent context when none are persisted yet', async () => {
    const conversation = new Conversation({ id: 'conv-2' });
    const getUserProfileFacts = jest.fn().mockResolvedValue([]);
    const saveUserProfileFacts = jest.fn().mockResolvedValue(undefined);
    const resolveFacts = jest.fn().mockReturnValue(resolvedFacts);
    const prepareFactsForStorage = jest.fn().mockReturnValue(resolvedFacts);
    const selectPromptFacts = jest.fn().mockReturnValue(resolvedFacts);
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getUserProfileFacts,
        saveUserProfileFacts,
      }),
      { resolveFacts } as unknown as UserFactsExtractorService,
      { prepareFactsForStorage, selectPromptFacts } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockReturnValue([]),
        selectPromptEntries: jest.fn().mockReturnValue([]),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await expect(service.resolveUserFacts(conversation)).resolves.toEqual({
      scopeKey: 'local:default',
      source: 'recent_context',
      facts: resolvedFacts,
      storedFacts: resolvedFacts,
    });
    expect(getUserProfileFacts).toHaveBeenCalledWith('local:default');
    expect(resolveFacts).toHaveBeenCalledWith(conversation, []);
    expect(prepareFactsForStorage).toHaveBeenCalledWith(resolvedFacts);
    expect(saveUserProfileFacts).not.toHaveBeenCalled();
    expect(selectPromptFacts).toHaveBeenCalledWith(resolvedFacts, conversation);
  });

  it('stores normalized facts but returns only prompt-visible facts after lifecycle filtering', async () => {
    const conversation = new Conversation({ id: 'conv-2b' });
    const resolvedRawFacts: UserProfileFact[] = [
      {
        key: 'name',
        value: 'Alex',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        key: 'goal',
        value: 'ship old prototype',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const storedFacts = resolvedRawFacts;
    const promptFacts = [resolvedRawFacts[0]];
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue([]),
        saveUserProfileFacts: jest.fn().mockResolvedValue(undefined),
      }),
      { resolveFacts: jest.fn().mockReturnValue(resolvedRawFacts) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockReturnValue(storedFacts),
        selectPromptFacts: jest.fn().mockReturnValue(promptFacts),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockReturnValue([]),
        selectPromptEntries: jest.fn().mockReturnValue([]),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await expect(service.resolveUserFacts(conversation)).resolves.toEqual({
      scopeKey: 'local:default',
      source: 'recent_context',
      facts: promptFacts,
      storedFacts,
    });
  });

  it('logs the fact pipeline with persisted resolved stored and prompt-visible summaries', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const conversation = new Conversation({ id: 'conv-2c' });
    const persistedFacts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Legacy project',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2025-12-31T00:00:00.000Z',
      },
    ];
    const resolvedRawFacts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Orbit Notes',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        key: 'role',
        value: 'platform engineer',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    const storedFacts = resolvedRawFacts;
    const promptFacts = [resolvedRawFacts[0]];
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue(persistedFacts),
        saveUserProfileFacts: jest.fn().mockResolvedValue(undefined),
      }),
      { resolveFacts: jest.fn().mockReturnValue(resolvedRawFacts) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockReturnValue(storedFacts),
        selectPromptFacts: jest.fn().mockReturnValue(promptFacts),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockReturnValue([]),
        selectPromptEntries: jest.fn().mockReturnValue([]),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await service.resolveUserFacts(conversation);

    expectDebugMessagesToContain(debugSpy, [
      'User facts pipeline',
      'persisted_facts_and_recent_context',
      'project{len=14, pinned=no}',
      'project{len=11, pinned=no}',
      'role{len=17, pinned=no}',
    ]);
  });

  it('resolves episodic memories and selects relevant prior context', async () => {
    const conversation = new Conversation({ id: 'conv-3' });
    const persistedEntries: EpisodicMemoryEntry[] = [
      {
        id: 'persisted-1',
        kind: 'constraint',
        summary: 'use sqlite before adding vector storage',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];
    const getEpisodicMemoryEntries = jest.fn().mockResolvedValue(persistedEntries);
    const saveEpisodicMemoryEntries = jest.fn().mockResolvedValue(undefined);
    const resolveMemories = jest.fn().mockReturnValue(resolvedEpisodicEntries);
    const prepareEntriesForStorage = jest.fn().mockReturnValue(resolvedEpisodicEntries);
    const selectRelevantMemories = jest.fn().mockReturnValue(resolvedEpisodicEntries);
    const selectPromptEntries = jest.fn().mockReturnValue(resolvedEpisodicEntries);
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getEpisodicMemoryEntries,
        saveEpisodicMemoryEntries,
      }),
      { resolveFacts: jest.fn().mockReturnValue([]) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockReturnValue([]),
        selectPromptFacts: jest.fn().mockReturnValue([]),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories } as unknown as EpisodicMemoryRetrieverService,
      { prepareEntriesForStorage, selectPromptEntries } as unknown as EpisodicMemoryLifecycleService,
    );

    await expect(service.resolveEpisodicMemory(conversation)).resolves.toEqual({
      scopeKey: 'local:default',
      source: 'persisted_memories_and_recent_context',
      entries: resolvedEpisodicEntries,
      relevantEntries: resolvedEpisodicEntries,
    });
    expect(getEpisodicMemoryEntries).toHaveBeenCalledWith('local:default');
    expect(resolveMemories).toHaveBeenCalledWith(conversation, persistedEntries);
    expect(prepareEntriesForStorage).toHaveBeenCalledWith(resolvedEpisodicEntries);
    expect(saveEpisodicMemoryEntries).not.toHaveBeenCalled();
    expect(selectRelevantMemories).toHaveBeenCalledWith(conversation, resolvedEpisodicEntries);
    expect(selectPromptEntries).toHaveBeenCalledWith(resolvedEpisodicEntries, conversation);
  });

  it('logs the episodic pipeline with persisted resolved stored retrieved and prompt-visible summaries', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const conversation = new Conversation({ id: 'conv-3c' });
    const persistedEntries: EpisodicMemoryEntry[] = [
      {
        id: 'persisted-1',
        kind: 'goal',
        summary: 'ship old memory flow',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];
    const resolvedEntries: EpisodicMemoryEntry[] = [
      {
        id: 'resolved-1',
        kind: 'goal',
        summary: 'ship stable memory flow',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'resolved-2',
        kind: 'constraint',
        summary: 'нельзя делать vector database обязательным',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    const retrievedEntries = [resolvedEntries[0]];
    const promptEntries = retrievedEntries;
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue(persistedEntries),
        saveEpisodicMemoryEntries: jest.fn().mockResolvedValue(undefined),
      }),
      { resolveFacts: jest.fn().mockReturnValue([]) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockReturnValue([]),
        selectPromptFacts: jest.fn().mockReturnValue([]),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue(resolvedEntries) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue(retrievedEntries) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockReturnValue(resolvedEntries),
        selectPromptEntries: jest.fn().mockReturnValue(promptEntries),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await service.resolveEpisodicMemory(conversation);

    expectDebugMessagesToContain(debugSpy, [
      'Episodic memory pipeline',
      'persisted_memories_and_recent_context',
      'goal{len=20, pinned=no, salience=0.95}',
      'goal{len=23, pinned=no, salience=0.95}',
      'constraint{len=42, pinned=no, salience=0.90}',
    ]);
  });

  it('stores normalized episodic memory but returns only prompt-visible relevant entries after lifecycle filtering', async () => {
    const conversation = new Conversation({ id: 'conv-3b' });
    const storedEntries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-active',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'mem-stale',
        kind: 'task',
        summary: 'clean up temporary debug logging',
        source: 'explicit_user_statement',
        salience: 0.8,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const promptEntries = [storedEntries[0]];
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue([]),
        saveEpisodicMemoryEntries: jest.fn().mockResolvedValue(undefined),
      }),
      { resolveFacts: jest.fn().mockReturnValue([]) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockReturnValue([]),
        selectPromptFacts: jest.fn().mockReturnValue([]),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue(storedEntries) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue(storedEntries) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockReturnValue(storedEntries),
        selectPromptEntries: jest.fn().mockReturnValue(promptEntries),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await expect(service.resolveEpisodicMemory(conversation)).resolves.toEqual({
      scopeKey: 'local:default',
      source: 'recent_context',
      entries: storedEntries,
      relevantEntries: promptEntries,
    });
  });

  it('resolves combined user memory with preferences, facts, and episodic memories', async () => {
    const conversation = new Conversation({ id: 'conv-4' });
    const persistedProfile: AgentUserProfile = {
      communication: {
        preferredLanguage: 'en',
        tone: 'direct',
        detail: 'adaptive',
        structure: 'adaptive',
      },
      interaction: {
        allowPushback: true,
        allowProactiveSuggestions: true,
      },
    };
    const persistedFacts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2025-12-31T00:00:00.000Z',
      },
    ];
    const persistedEntries: EpisodicMemoryEntry[] = [
      {
        id: 'persisted-2',
        kind: 'goal',
        summary: 'ship phase 3 memory retrieval',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-01-30T00:00:00.000Z',
      },
    ];
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn().mockReturnValue(resolvedProfile) } as unknown as UserProfileService,
      createMemoryServiceMock({
        getInteractionPreferences: jest.fn().mockResolvedValue(persistedProfile),
        saveInteractionPreferences: jest.fn().mockResolvedValue(undefined),
        getUserProfileFacts: jest.fn().mockResolvedValue(persistedFacts),
        saveUserProfileFacts: jest.fn().mockResolvedValue(undefined),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue(persistedEntries),
        saveEpisodicMemoryEntries: jest.fn().mockResolvedValue(undefined),
      }),
      { resolveFacts: jest.fn().mockReturnValue(resolvedFacts) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockReturnValue(resolvedFacts),
        selectPromptFacts: jest.fn().mockReturnValue(resolvedFacts),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue(resolvedEpisodicEntries) } as unknown as EpisodicMemoryExtractorService,
      {
        selectRelevantMemories: jest.fn().mockReturnValue(resolvedEpisodicEntries),
      } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockReturnValue(resolvedEpisodicEntries),
        selectPromptEntries: jest.fn().mockReturnValue(resolvedEpisodicEntries),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await expect(service.resolveUserMemory(conversation)).resolves.toEqual({
      interactionPreferences: {
        keyKind: 'local_default',
        source: 'persisted_profile_and_recent_context',
        userProfile: resolvedProfile,
      },
      userFacts: {
        scopeKey: 'local:default',
        source: 'persisted_facts_and_recent_context',
        facts: resolvedFacts,
        storedFacts: resolvedFacts,
      },
      episodicMemory: {
        scopeKey: 'local:default',
        source: 'persisted_memories_and_recent_context',
        entries: resolvedEpisodicEntries,
        relevantEntries: resolvedEpisodicEntries,
      },
    });
  });

  it('commits resolved user memory explicitly after resolution', async () => {
    const saveManagedMemoryState = jest.fn().mockResolvedValue(undefined);
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        saveManagedMemoryState,
      }),
      { resolveFacts: jest.fn().mockReturnValue([]) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockImplementation((facts: UserProfileFact[]) => facts),
        selectPromptFacts: jest.fn().mockReturnValue([]),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockImplementation((entries: EpisodicMemoryEntry[]) => entries),
        selectPromptEntries: jest.fn().mockReturnValue([]),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await service.commitResolvedUserMemory({
      interactionPreferences: {
        keyKind: 'local_default',
        source: 'recent_context',
        userProfile: resolvedProfile,
      },
      userFacts: {
        scopeKey: 'local:default',
        source: 'recent_context',
        facts: resolvedFacts,
        storedFacts: resolvedFacts,
      },
      episodicMemory: {
        scopeKey: 'local:default',
        source: 'recent_context',
        entries: resolvedEpisodicEntries,
        relevantEntries: resolvedEpisodicEntries,
      },
    });

    expect(saveManagedMemoryState).toHaveBeenCalledWith({
      scopeKey: 'local:default',
      interactionPreferences: resolvedProfile,
      userFacts: resolvedFacts,
      episodicMemories: resolvedEpisodicEntries,
    });
  });

  it('restores persisted current state when noisy replacement candidates are blocked during commit', async () => {
    const saveManagedMemoryState = jest.fn().mockResolvedValue(undefined);
    const persistedFacts: UserProfileFact[] = [
      {
        key: 'goal',
        value: 'ship stable memory flow',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];
    const persistedEntries: EpisodicMemoryEntry[] = [
      {
        id: 'persisted-goal',
        kind: 'goal',
        summary: 'ship stable memory flow',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];
    const service = new MemoryResolverService(
      { resolveProfile: jest.fn() } as unknown as UserProfileService,
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue(persistedFacts),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue(persistedEntries),
        saveManagedMemoryState,
      }),
      { resolveFacts: jest.fn().mockReturnValue([]) } as unknown as UserFactsExtractorService,
      {
        prepareFactsForStorage: jest.fn().mockImplementation((facts: UserProfileFact[]) => facts),
        selectPromptFacts: jest.fn().mockReturnValue([]),
      } as unknown as UserFactsLifecycleService,
      { resolveMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryExtractorService,
      { selectRelevantMemories: jest.fn().mockReturnValue([]) } as unknown as EpisodicMemoryRetrieverService,
      {
        prepareEntriesForStorage: jest.fn().mockImplementation((entries: EpisodicMemoryEntry[]) => entries),
        selectPromptEntries: jest.fn().mockReturnValue([]),
      } as unknown as EpisodicMemoryLifecycleService,
    );

    await service.commitResolvedUserMemory({
      interactionPreferences: {
        keyKind: 'local_default',
        source: 'recent_context',
        userProfile: resolvedProfile,
      },
      userFacts: {
        scopeKey: 'local:default',
        source: 'recent_context',
        facts: [],
        storedFacts: [
          {
            key: 'goal',
            value: 'show memory snapshot',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
      },
      episodicMemory: {
        scopeKey: 'local:default',
        source: 'recent_context',
        entries: [
          {
            id: 'noisy-goal',
            kind: 'goal',
            summary: 'show memory snapshot',
            source: 'explicit_user_statement',
            salience: 0.95,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
        relevantEntries: [],
      },
    });

    expect(saveManagedMemoryState).toHaveBeenCalledWith({
      scopeKey: 'local:default',
      interactionPreferences: resolvedProfile,
      userFacts: persistedFacts,
      episodicMemories: persistedEntries,
    });
  });
});
