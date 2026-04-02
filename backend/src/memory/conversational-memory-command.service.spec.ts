import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import type { ManagedMemorySnapshot, MemoryManagementService } from './memory-management.service';
import { ConversationalMemoryCommandService } from './conversational-memory-command.service';

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-memory-command' });
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

const cloneSnapshot = (snapshot: ManagedMemorySnapshot): ManagedMemorySnapshot => ({
  scopeKey: snapshot.scopeKey,
  interactionPreferences: snapshot.interactionPreferences,
  userFacts: snapshot.userFacts.map((fact) => ({ ...fact })),
  episodicMemories: snapshot.episodicMemories.map((entry) => ({ ...entry })),
});

const createMemoryManagementServiceMock = (
  snapshot: ManagedMemorySnapshot,
  overrides: Partial<Record<keyof MemoryManagementService, jest.Mock>> = {},
) => {
  let stateSnapshot = cloneSnapshot(snapshot);

  const mock = {
    getSnapshot: jest.fn().mockImplementation(async () => cloneSnapshot(stateSnapshot)),
    getEffectiveSnapshot: jest.fn().mockImplementation(async () => cloneSnapshot(stateSnapshot)),
    saveSnapshot: jest.fn().mockImplementation(async (nextSnapshot: ManagedMemorySnapshot) => {
      stateSnapshot = cloneSnapshot(nextSnapshot);
      return cloneSnapshot(stateSnapshot);
    }),
    forgetUserFact: jest.fn().mockImplementation(async (key: string) => {
      const beforeCount = stateSnapshot.userFacts.length;
      stateSnapshot = {
        ...stateSnapshot,
        userFacts: stateSnapshot.userFacts.filter((item) => item.key !== key),
      };
      return stateSnapshot.userFacts.length !== beforeCount;
    }),
    setUserFactPinned: jest.fn().mockImplementation(async (key: string, pinned: boolean) => {
      let found = false;
      stateSnapshot = {
        ...stateSnapshot,
        userFacts: stateSnapshot.userFacts.map((item) => {
          if (item.key !== key) {
            return item;
          }

          found = true;
          return { ...item, pinned: pinned || undefined };
        }),
      };
      const fact = stateSnapshot.userFacts.find((item) => item.key === key);
      return found && fact ? { ...fact } : undefined;
    }),
    setEpisodicMemoryPinned: jest.fn().mockImplementation(async (id: string, pinned: boolean) => {
      let found = false;
      stateSnapshot = {
        ...stateSnapshot,
        episodicMemories: stateSnapshot.episodicMemories.map((item) => {
          if (item.id !== id) {
            return item;
          }

          found = true;
          return { ...item, pinned: pinned || undefined };
        }),
      };
      const entry = stateSnapshot.episodicMemories.find((item) => item.id === id);
      return found && entry ? { ...entry } : undefined;
    }),
    ...overrides,
  };

  return mock as unknown as MemoryManagementService;
};

const expectHandledResponseToContain = (
  result: { handled: boolean; response?: string },
  fragments: string[],
): void => {
  expect(result).toEqual(expect.objectContaining({ handled: true, response: expect.any(String) }));
  fragments.forEach((fragment) => {
    expect(result.response).toContain(fragment);
  });
};

describe('ConversationalMemoryCommandService', () => {
  const snapshot: ManagedMemorySnapshot = {
    scopeKey: 'local:default',
    interactionPreferences: undefined,
    userFacts: [
      {
        key: 'project',
        value: 'Argus',
        source: 'explicit_user_statement',
        confidence: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ],
    episodicMemories: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'goal',
        summary: 'ship phase 8 controls',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'constraint',
        summary: 'нельзя использовать vector database',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-03-02T00:05:00.000Z',
      },
    ],
  };

  it('returns a formatted snapshot for explicit inspect commands without syncing snapshot state', async () => {
    const memoryManagementService = createMemoryManagementServiceMock(snapshot);
    const service = new ConversationalMemoryCommandService(memoryManagementService);

    const result = await service.handle('Show memory snapshot');

    expectHandledResponseToContain(result, [
      'Managed memory snapshot:',
      'userFacts=project=Argus',
      'episodicMemories=goal=ship phase 8 controls; constraint=нельзя использовать vector database',
      'version=0',
      'lastProcessedUserMessage=none',
    ]);

    expect((memoryManagementService.getEffectiveSnapshot as jest.Mock)).not.toHaveBeenCalled();
    expect((memoryManagementService.saveSnapshot as jest.Mock)).not.toHaveBeenCalled();
  });

  it('does not treat natural recall questions as deterministic inspect commands', async () => {
    const memoryManagementService = createMemoryManagementServiceMock(snapshot);
    const service = new ConversationalMemoryCommandService(memoryManagementService);

    await expect(service.handle('What do you remember about me?')).resolves.toEqual({ handled: false });

    expect((memoryManagementService.getSnapshot as jest.Mock)).not.toHaveBeenCalled();
    expect((memoryManagementService.saveSnapshot as jest.Mock)).not.toHaveBeenCalled();
  });

  it('routes forget fact commands to managed memory operations', async () => {
    const forgetUserFact = jest.fn().mockResolvedValue(true);
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(snapshot, { forgetUserFact }),
    );

    const result = await service.handle('Forget my project');

    expect(forgetUserFact).toHaveBeenCalledWith('project', 'local:default', 'Argus');
    expectHandledResponseToContain(result, [
      'I forgot your stored project fact (was "Argus").',
      'Found:',
      'Changed:',
      'Unchanged:',
    ]);
  });

  it('keeps a trailing inspect request when a command-like message also asks to forget a mismatched older project', async () => {
    const inspectSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      userFacts: [
        {
          key: 'project',
          value: 'StressHeliosOnly',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2026-03-02T00:00:00.000Z',
        },
      ],
      episodicMemories: [],
    };
    const forgetUserFact = jest.fn().mockResolvedValue(true);
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(inspectSnapshot, { forgetUserFact }),
    );

    const result = await service.handle(
      'Забудь мой старый проект StressAtlasLegacy, не трогай новый проект StressHeliosOnly, покажи после этого обновлённую память.',
    );

    expect(forgetUserFact).not.toHaveBeenCalled();
    expectHandledResponseToContain(result, [
      'Я не нашёл сохранённый факт о проекте со значением StressAtlasLegacy, который можно забыть.',
      'Найдено: ничего.',
      'Снэпшот управляемой памяти:',
      'userFacts=project=StressHeliosOnly',
      'episodicMemories=none',
      'version=0',
    ]);
  });

  it('keeps a trailing inspect request when the user says и потом покажи snapshot памяти', async () => {
    const inspectSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      userFacts: [
        {
          key: 'project',
          value: 'StressHeliosOnly',
          source: 'explicit_user_statement',
          confidence: 1,
          updatedAt: '2026-03-02T00:00:00.000Z',
        },
      ],
      episodicMemories: [],
    };
    const service = new ConversationalMemoryCommandService(createMemoryManagementServiceMock(inspectSnapshot));

    const result = await service.handle('Забудь мой старый проект StressAtlasLegacy и потом покажи snapshot памяти.');

    expectHandledResponseToContain(result, [
      'Я не нашёл сохранённый факт о проекте со значением StressAtlasLegacy, который можно забыть.',
      'Найдено: ничего.',
      'Снэпшот управляемой памяти:',
      'userFacts=project=StressHeliosOnly',
      'episodicMemories=none',
      'version=0',
    ]);
  });

  it('routes current goal pin commands to the latest episodic goal memory', async () => {
    const setEpisodicMemoryPinned = jest.fn().mockResolvedValue({
      ...snapshot.episodicMemories[0],
      pinned: true,
    });
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(snapshot, { setEpisodicMemoryPinned }),
    );

    const result = await service.handle('Pin my current goal');

    expect(setEpisodicMemoryPinned).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', true, 'local:default');
    expectHandledResponseToContain(result, [
      'I pinned the current goal memory: ship phase 8 controls.',
      'Found:',
      'Changed:',
      'Unchanged:',
    ]);
  });

  it('ignores normal chat messages', async () => {
    const service = new ConversationalMemoryCommandService(createMemoryManagementServiceMock(snapshot));

    await expect(service.handle('Help me think through the rollout')).resolves.toEqual({ handled: false });
  });

  it('does not mistake normal prose mentioning forget pin and unpin for a deterministic memory command', async () => {
    const service = new ConversationalMemoryCommandService(createMemoryManagementServiceMock(snapshot));

    await expect(
      service.handle(
        'Следующая практическая задача такая: добавить e2e-покрытие для памяти между чатами и отдельно проверить recall имени, проекта, цели и корректную обработку forget/pin/unpin.',
      ),
    ).resolves.toEqual({ handled: false });
  });

  it('does not treat meta discussion about memory-command behavior as a deterministic command', async () => {
    const service = new ConversationalMemoryCommandService(createMemoryManagementServiceMock(snapshot));

    await expect(
      service.handle(
        'Я хочу обсудить дизайн команд памяти: фразы вида “можно было бы забыть старый проект” или “надо проверить pin/unpin” — это обсуждение, а не команда. Сможешь ли ты оставить это обычным диалогом, а не mutation в памяти?',
      ),
    ).resolves.toEqual({ handled: false });
  });

  it('handles multi-intent pin commands for the current goal and constraint in one message', async () => {
    const setEpisodicMemoryPinned = jest
      .fn()
      .mockResolvedValueOnce({ ...snapshot.episodicMemories[0], pinned: true })
      .mockResolvedValueOnce({ ...snapshot.episodicMemories[1], pinned: true });
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(snapshot, { setEpisodicMemoryPinned }),
    );
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель — реализовать память между чатами.',
      'У нас есть ограничение: нельзя использовать vector database.',
      'Закрепи мою текущую цель и отдельно закрепи ограничение про запрет vector database.',
    ]);

    const result = await service.handle(
      'Закрепи мою текущую цель и отдельно закрепи ограничение про запрет vector database.',
      conversation,
    );

    expect(setEpisodicMemoryPinned).toHaveBeenNthCalledWith(
      1,
      '11111111-1111-4111-8111-111111111111',
      true,
      'local:default',
    );
    expect(setEpisodicMemoryPinned).toHaveBeenNthCalledWith(
      2,
      '22222222-2222-4222-8222-222222222222',
      true,
      'local:default',
    );
    expectHandledResponseToContain(result, [
      'Я закрепил текущую запись об цели: ship phase 8 controls.',
      'Я закрепил текущую запись об ограничении: нельзя использовать vector database.',
      'Найдено:',
      'Изменено:',
      'Без изменений:',
    ]);
  });

  it('pins the current goal from the effective pre-command snapshot instead of a stale persisted goal', async () => {
    const staleSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      episodicMemories: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          kind: 'goal',
          summary: 'устаревшая цель по question-as-fact pollution',
          source: 'explicit_user_statement',
          salience: 0.95,
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    };
    const effectiveSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      episodicMemories: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          kind: 'goal',
          summary: 'стабилизировать command parsing и stream-resilience',
          source: 'explicit_user_statement',
          salience: 0.95,
          updatedAt: '2026-03-03T00:00:00.000Z',
        },
      ],
    };
    const setEpisodicMemoryPinned = jest.fn().mockResolvedValue({
      ...effectiveSnapshot.episodicMemories[0],
      pinned: true,
    });
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(staleSnapshot, {
        getEffectiveSnapshot: jest.fn().mockResolvedValue(effectiveSnapshot),
        setEpisodicMemoryPinned,
      }),
    );
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель — стабилизировать command parsing и stream-resilience.',
      'Закрепи мою текущую цель.',
    ]);

    const result = await service.handle('Закрепи мою текущую цель.', conversation);

    expect(setEpisodicMemoryPinned).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', true, 'local:default');
    expectHandledResponseToContain(result, [
      'Я закрепил текущую запись об цели: стабилизировать command parsing и stream-resilience.',
      'Найдено:',
      'Изменено:',
      'Без изменений:',
    ]);
  });

  it('syncs the effective pre-command snapshot before pinning the current goal when persisted memory is stale', async () => {
    const staleSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      episodicMemories: [],
    };
    const effectiveSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      episodicMemories: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          kind: 'goal',
          summary: 'внедрить universal response directives и compliance retry',
          source: 'explicit_user_statement',
          salience: 0.95,
          updatedAt: '2026-03-03T00:00:00.000Z',
        },
      ],
    };
    const memoryManagementService = createMemoryManagementServiceMock(staleSnapshot, {
      getEffectiveSnapshot: jest.fn().mockResolvedValue(effectiveSnapshot),
    });
    const service = new ConversationalMemoryCommandService(memoryManagementService);
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель уже не довести memory subsystem до production-ready состояния.',
      'Сейчас приоритетная цель — внедрить universal response directives и compliance retry.',
      'Закрепи мою текущую цель и покажи snapshot памяти.',
    ]);

    const result = await service.handle('Закрепи мою текущую цель и покажи snapshot памяти.', conversation);

    expect((memoryManagementService.saveSnapshot as jest.Mock)).toHaveBeenCalledWith(effectiveSnapshot);
    expectHandledResponseToContain(result, [
      'Я закрепил текущую запись об цели: внедрить universal response directives и compliance retry.',
      'Найдено:',
      'Изменено:',
      'Снэпшот управляемой памяти:',
      'userFacts=project=Argus',
      'episodicMemories=goal=внедрить universal response directives и compliance retry [pinned]',
      'version=0',
      'lastProcessedUserMessage=none',
    ]);
  });

  it('prefers the matching negative constraint over a stale positive variant when pinning the current constraint', async () => {
    const negativeConstraint = {
      id: '55555555-5555-4555-8555-555555555555',
      kind: 'constraint' as const,
      summary: 'нельзя тащить vector database в обязательный контур',
      source: 'explicit_user_statement' as const,
      salience: 0.9,
      updatedAt: '2026-03-03T00:00:00.000Z',
    };
    const positiveConstraint = {
      id: '66666666-6666-4666-8666-666666666666',
      kind: 'constraint' as const,
      summary: 'использовать vector database',
      source: 'explicit_user_statement' as const,
      salience: 0.9,
      pinned: true,
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    const effectiveSnapshot: ManagedMemorySnapshot = {
      ...snapshot,
      episodicMemories: [positiveConstraint, negativeConstraint],
    };
    const setEpisodicMemoryPinned = jest.fn().mockResolvedValue({
      ...negativeConstraint,
      pinned: true,
    });
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(snapshot, {
        getEffectiveSnapshot: jest.fn().mockResolvedValue(effectiveSnapshot),
        setEpisodicMemoryPinned,
      }),
    );
    const conversation = createConversationWithUserMessages([
      'Vector database в обязательный контур тащить нельзя.',
      'Закрепи ограничение про запрет vector database.',
    ]);

    const result = await service.handle('Закрепи ограничение про запрет vector database.', conversation);

    expect(setEpisodicMemoryPinned).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555', true, 'local:default');
    expectHandledResponseToContain(result, [
      'Я закрепил текущую запись об ограничении: нельзя тащить vector database в обязательный контур.',
      'Найдено:',
      'Изменено:',
      'Без изменений:',
    ]);
  });

  it('does not forget a fact when the user explicitly refers to an older mismatched value', async () => {
    const forgetUserFact = jest.fn().mockResolvedValue(true);
    const service = new ConversationalMemoryCommandService(
      createMemoryManagementServiceMock(
        {
          ...snapshot,
          userFacts: [
            {
              key: 'project',
              value: 'Helios',
              source: 'explicit_user_statement',
              confidence: 1,
              updatedAt: '2026-03-03T00:00:00.000Z',
            },
          ],
        },
        { forgetUserFact },
      ),
    );

    const result = await service.handle('Забудь мой старый проект Atlas');

    expect(forgetUserFact).not.toHaveBeenCalled();
    expectHandledResponseToContain(result, [
      'Я не нашёл сохранённый факт о проекте со значением Atlas, который можно забыть.',
      'Найдено: ничего.',
      'Изменено: ничего.',
      'Без изменений: ничего.',
    ]);
  });
});
