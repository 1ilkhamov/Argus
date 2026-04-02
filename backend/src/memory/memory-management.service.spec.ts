import { Logger } from '@nestjs/common';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import type { AgentUserProfile } from '../agent/profile/user-profile.types';
import { EpisodicMemoryExtractorService } from './episodic-memory-extractor.service';
import { EpisodicMemoryLifecycleService } from './episodic-memory-lifecycle.service';
import { MemoryManagementService } from './memory-management.service';
import type { MemoryService } from './memory.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';
import type { UserProfileFact } from './user-profile-facts.types';
import { UserFactsExtractorService } from './user-facts-extractor.service';
import { UserFactsLifecycleService } from './user-facts-lifecycle.service';

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-memory-management' });
  contents.forEach((content, index) => {
    conversation.addMessage(
      new Message({
        id: `msg-${index}`,
        conversationId: conversation.id,
        role: 'user',
        content,
        createdAt: new Date(`2026-03-0${index + 1}T00:00:00.000Z`),
      }),
    );
  });

  return conversation;
};

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

describe('MemoryManagementService', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a complete memory snapshot for the default scope', async () => {
    const interactionPreferences: AgentUserProfile = {
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
    const facts: UserProfileFact[] = [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    const entries: EpisodicMemoryEntry[] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'goal',
        summary: 'ship phase 7 controls',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getInteractionPreferences: jest.fn().mockResolvedValue(interactionPreferences),
        getUserProfileFacts: jest.fn().mockResolvedValue(facts),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue(entries),
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    await expect(service.getSnapshot()).resolves.toEqual({
      scopeKey: 'local:default',
      interactionPreferences,
      userFacts: facts,
      episodicMemories: entries,
      processingState: {
        expectedVersion: 0,
        lastProcessedUserMessage: undefined,
      },
    });
  });

  it('audits stored managed memory and flags cleanup candidates without mutating storage', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue([
          {
            key: 'project',
            value: 'project Orbit Notes',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            key: 'project',
            value: 'show memory snapshot',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-02T00:00:00.000Z',
          },
          {
            key: 'goal',
            value: 'уже не ship legacy memory flow',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-03T00:00:00.000Z',
          },
        ]),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'goal',
            summary: 'ship old memory flow',
            source: 'explicit_user_statement',
            salience: 0.95,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            kind: 'goal',
            summary: 'ship stable memory flow',
            source: 'explicit_user_statement',
            salience: 0.95,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            kind: 'task',
            summary: 'show memory snapshot',
            source: 'explicit_user_statement',
            salience: 0.2,
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ]),
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    const report = await service.getSnapshotAudit('local:default', new Date('2026-03-18T00:00:00.000Z'));

    expect(report.summary).toEqual(
      expect.objectContaining({
        scannedUserFacts: 3,
        scannedEpisodicMemories: 3,
        flaggedUserFacts: 3,
        flaggedEpisodicMemories: 3,
      }),
    );
    expect(report.userFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: expect.objectContaining({ key: 'project', value: 'project Orbit Notes' }),
          issues: expect.arrayContaining([expect.objectContaining({ code: 'normalization_diff' })]),
        }),
        expect.objectContaining({
          fact: expect.objectContaining({ key: 'project', value: 'show memory snapshot' }),
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'duplicate_key' }),
            expect.objectContaining({ code: 'deterministic_command' }),
          ]),
        }),
        expect.objectContaining({
          fact: expect.objectContaining({ key: 'goal', value: 'уже не ship legacy memory flow' }),
          issues: expect.arrayContaining([expect.objectContaining({ code: 'negative_fragment' })]),
        }),
      ]),
    );
    expect(report.episodicMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111', kind: 'goal' }),
          issues: expect.arrayContaining([expect.objectContaining({ code: 'multiple_entries_same_kind' })]),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ id: '22222222-2222-4222-8222-222222222222', kind: 'goal' }),
          issues: expect.arrayContaining([expect.objectContaining({ code: 'multiple_entries_same_kind' })]),
        }),
        expect.objectContaining({
          entry: expect.objectContaining({ id: '33333333-3333-4333-8333-333333333333', kind: 'task' }),
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'retention_candidate' }),
            expect.objectContaining({ code: 'deterministic_command' }),
          ]),
        }),
      ]),
    );
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Managed snapshot audit'));
  });

  it('returns a dry-run cleanup report without mutating stored memory', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const saveManagedMemoryState = jest.fn().mockResolvedValue(undefined);
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue([
          {
            key: 'project',
            value: 'project Orbit Notes',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            key: 'goal',
            value: 'show memory snapshot',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-02T00:00:00.000Z',
          },
        ]),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'constraint',
            summary: 'keep   audit trail',
            source: 'explicit_user_statement',
            salience: 0.9,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            kind: 'task',
            summary: 'show memory snapshot',
            source: 'explicit_user_statement',
            salience: 0.8,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            kind: 'task',
            summary: 'clean temporary debug files',
            source: 'explicit_user_statement',
            salience: 0.2,
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ]),
        saveManagedMemoryState,
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    const report = await service.cleanupSnapshot({ dryRun: true, now: new Date('2026-03-18T00:00:00.000Z') });

    expect(report.dryRun).toBe(true);
    expect(report.summary).toEqual(
      expect.objectContaining({
        userFactsBefore: 2,
        userFactsAfter: 1,
        episodicMemoriesBefore: 3,
        episodicMemoriesAfter: 1,
      }),
    );
    expect(report.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'user_fact',
          action: 'rewrite',
          before: 'project=project Orbit Notes',
          after: 'project=Orbit Notes',
        }),
        expect.objectContaining({
          target: 'user_fact',
          action: 'delete',
          before: 'goal=show memory snapshot',
        }),
        expect.objectContaining({
          target: 'episodic_memory',
          action: 'rewrite',
          before: 'constraint=keep   audit trail',
          after: 'constraint=keep audit trail',
        }),
        expect.objectContaining({
          target: 'episodic_memory',
          action: 'delete',
          before: 'task=show memory snapshot',
        }),
        expect.objectContaining({
          target: 'episodic_memory',
          action: 'delete',
          before: 'task=clean temporary debug files',
        }),
      ]),
    );
    expect(report.snapshot.userFacts).toEqual([expect.objectContaining({ key: 'project', value: 'Orbit Notes' })]);
    expect(report.snapshot.episodicMemories).toEqual([
      expect.objectContaining({ kind: 'constraint', summary: 'keep audit trail' }),
    ]);
    expect(saveManagedMemoryState).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Managed snapshot cleanup'));
  });

  it('applies managed memory cleanup and persists the cleaned snapshot when dryRun is false', async () => {
    const saveManagedMemoryState = jest.fn().mockResolvedValue(undefined);
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue([
          {
            key: 'project',
            value: 'project Orbit Notes',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            key: 'goal',
            value: 'show memory snapshot',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-02T00:00:00.000Z',
          },
        ]),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue([
          {
            id: '44444444-4444-4444-8444-444444444444',
            kind: 'constraint',
            summary: 'keep   audit trail',
            source: 'explicit_user_statement',
            salience: 0.9,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            id: '55555555-5555-4555-8555-555555555555',
            kind: 'task',
            summary: 'show memory snapshot',
            source: 'explicit_user_statement',
            salience: 0.8,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        ]),
        saveManagedMemoryState,
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    const report = await service.cleanupSnapshot({ dryRun: false, now: new Date('2026-03-18T00:00:00.000Z') });

    expect(report.dryRun).toBe(false);
    expect(saveManagedMemoryState).toHaveBeenCalledWith({
      scopeKey: 'local:default',
      interactionPreferences: undefined,
      userFacts: [expect.objectContaining({ key: 'project', value: 'Orbit Notes' })],
      episodicMemories: [
        expect.objectContaining({ id: '44444444-4444-4444-8444-444444444444', kind: 'constraint', summary: 'keep audit trail' }),
      ],
      expectedVersion: undefined,
      lastProcessedUserMessage: undefined,
    });
    expect(report.snapshot.userFacts).toEqual([expect.objectContaining({ key: 'project', value: 'Orbit Notes' })]);
    expect(report.snapshot.episodicMemories).toEqual([
      expect.objectContaining({ id: '44444444-4444-4444-8444-444444444444', summary: 'keep audit trail' }),
    ]);
  });

  it('forgets an explicit user fact by key', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const saveUserProfileFacts = jest.fn().mockResolvedValue(undefined);
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue([
          {
            key: 'name',
            value: 'Alex',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            key: 'project',
            value: 'Argus',
            source: 'explicit_user_statement',
            confidence: 1,
            updatedAt: '2026-03-02T00:00:00.000Z',
          },
        ]),
        saveUserProfileFacts,
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    await expect(service.forgetUserFact('name')).resolves.toBe(true);
    expect(saveUserProfileFacts).toHaveBeenCalledWith('local:default', [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ]);
    expectDebugMessagesToContain(debugSpy, [
      'Managed fact mutation',
      '"action":"forget"',
      'name{len=4, pinned=no}',
      'project{len=5, pinned=no}',
    ]);
  });

  it('pins an episodic memory entry and persists the updated state', async () => {
    const saveEpisodicMemoryEntries = jest.fn().mockResolvedValue(undefined);
    const entryId = '11111111-1111-4111-8111-111111111111';
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue([
          {
            id: entryId,
            kind: 'task',
            summary: 'clean up temporary debug logging',
            source: 'explicit_user_statement',
            salience: 0.82,
            updatedAt: '2026-03-02T00:00:00.000Z',
          },
        ]),
        saveEpisodicMemoryEntries,
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    const result = await service.setEpisodicMemoryPinned(entryId, true);

    expect(result).toEqual(
      expect.objectContaining({
        id: entryId,
        pinned: true,
      }),
    );
    expect(saveEpisodicMemoryEntries).toHaveBeenCalledWith(
      'local:default',
      expect.arrayContaining([
        expect.objectContaining({
          id: entryId,
          pinned: true,
        }),
      ]),
    );
  });

  it('builds an effective snapshot from prior conversation context while excluding the latest user command message', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const service = new MemoryManagementService(
      createMemoryServiceMock(),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );
    const conversation = createConversationWithUserMessages([
      'Меня зовут Илья. Мой текущий проект — Orbit Notes. Моя текущая цель — стабилизировать memory extraction.',
      'Закрепи мою текущую цель и отдельно закрепи ограничение про vector database.',
    ]);

    await expect(service.getEffectiveSnapshot(conversation, { excludeLatestUserMessage: true })).resolves.toEqual(
      expect.objectContaining({
        scopeKey: 'local:default',
        userFacts: expect.arrayContaining([
          expect.objectContaining({ key: 'name', value: 'Илья' }),
          expect.objectContaining({ key: 'project', value: 'Orbit Notes' }),
          expect.objectContaining({ key: 'goal', value: 'стабилизировать memory extraction' }),
        ]),
        processingState: expect.objectContaining({
          expectedVersion: 0,
          lastProcessedUserMessage: expect.objectContaining({
            messageId: 'msg-0',
          }),
        }),
      }),
    );
    expectDebugMessagesToContain(debugSpy, [
      'Managed effective snapshot',
      '"excludeLatestUserMessage":true',
      'project{len=11, pinned=no}',
      'goal{len=33, pinned=no}',
    ]);
  });

  it('persists a normalized managed-memory snapshot through saveSnapshot', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const saveManagedMemoryState = jest.fn().mockResolvedValue(undefined);
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        saveManagedMemoryState,
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );
    const snapshot = {
      scopeKey: 'local:default',
      interactionPreferences: {
        communication: {
          preferredLanguage: 'ru' as const,
          tone: 'direct' as const,
          detail: 'adaptive' as const,
          structure: 'adaptive' as const,
        },
        interaction: {
          allowPushback: true,
          allowProactiveSuggestions: true,
        },
      },
      userFacts: [
        {
          key: 'goal' as const,
          value: 'внедрить universal response directives',
          source: 'explicit_user_statement' as const,
          confidence: 1,
          updatedAt: '2026-03-02T00:00:00.000Z',
        },
      ],
      episodicMemories: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          kind: 'goal' as const,
          summary: 'внедрить universal response directives',
          source: 'explicit_user_statement' as const,
          salience: 0.95,
          updatedAt: '2026-03-02T00:00:00.000Z',
        },
      ],
    };

    await expect(service.saveSnapshot(snapshot)).resolves.toEqual({
      ...snapshot,
      processingState: undefined,
    });
    expect(saveManagedMemoryState).toHaveBeenCalledWith({
      scopeKey: 'local:default',
      interactionPreferences: snapshot.interactionPreferences,
      userFacts: snapshot.userFacts,
      episodicMemories: snapshot.episodicMemories,
      expectedVersion: undefined,
      lastProcessedUserMessage: undefined,
    });
    expectDebugMessagesToContain(debugSpy, [
      'Managed snapshot save',
      'goal{len=38, pinned=no}',
    ]);
  });

  it('blocks noisy replacements during saveSnapshot and restores persisted current state', async () => {
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
    const service = new MemoryManagementService(
      createMemoryServiceMock({
        getUserProfileFacts: jest.fn().mockResolvedValue(persistedFacts),
        getEpisodicMemoryEntries: jest.fn().mockResolvedValue(persistedEntries),
        saveManagedMemoryState,
      }),
      new UserFactsExtractorService(),
      new UserFactsLifecycleService(),
      new EpisodicMemoryExtractorService(),
      new EpisodicMemoryLifecycleService(),
    );

    const snapshot = {
      scopeKey: 'local:default',
      userFacts: [
        {
          key: 'goal' as const,
          value: 'show memory snapshot',
          source: 'explicit_user_statement' as const,
          confidence: 1,
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      ],
      episodicMemories: [
        {
          id: 'noisy-goal',
          kind: 'goal' as const,
          summary: 'show memory snapshot',
          source: 'explicit_user_statement' as const,
          salience: 0.95,
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    };

    await expect(service.saveSnapshot(snapshot)).resolves.toEqual({
      scopeKey: 'local:default',
      interactionPreferences: undefined,
      userFacts: persistedFacts,
      episodicMemories: persistedEntries,
      processingState: undefined,
    });
    expect(saveManagedMemoryState).toHaveBeenCalledWith({
      scopeKey: 'local:default',
      interactionPreferences: undefined,
      userFacts: persistedFacts,
      episodicMemories: persistedEntries,
      expectedVersion: undefined,
      lastProcessedUserMessage: undefined,
    });
  });
});
