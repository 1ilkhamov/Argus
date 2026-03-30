import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { EpisodicMemoryExtractorService } from './episodic-memory-extractor.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-episodic' });
  contents.forEach((content, index) => {
    conversation.addMessage(
      new Message({
        id: `msg-${index}`,
        conversationId: conversation.id,
        role: 'user',
        content,
        createdAt: new Date(`2026-02-0${index + 1}T00:00:00.000Z`),
      }),
    );
  });
  return conversation;
};

describe('EpisodicMemoryExtractorService', () => {
  const service = new EpisodicMemoryExtractorService();

  it('extracts durable episodic memories from explicit user statements', () => {
    const conversation = createConversationWithUserMessages([
      'My goal is ship phase 3 memory retrieval.',
      'We cannot use a vector database yet.',
      'Мы решили использовать sqlite как дефолт.',
      'Следующим шагом нужно добавить e2e покрытие.',
    ]);

    const memories = service.resolveMemories(conversation);

    expect(memories).toHaveLength(4);
    expect(memories.map((memory) => memory.kind)).toEqual(['goal', 'constraint', 'decision', 'task']);
    expect(memories.map((memory) => memory.summary)).toEqual([
      'ship phase 3 memory retrieval',
      'cannot use a vector database yet',
      'использовать sqlite как дефолт',
      'добавить e2e покрытие',
    ]);
    expect(memories.every((memory) => memory.source === 'explicit_user_statement')).toBe(true);
  });

  it('keeps persisted episodic memories and appends new distinct ones', () => {
    const conversation = createConversationWithUserMessages(['Следующим шагом нужно добавить retrieval ranking.']);
    const persisted: EpisodicMemoryEntry[] = [
      {
        id: 'mem-1',
        kind: 'goal',
        summary: 'ship phase 3 memory retrieval',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];

    expect(service.resolveMemories(conversation, persisted)).toEqual([
      persisted[0],
      expect.objectContaining({
        kind: 'task',
        summary: 'добавить retrieval ranking',
        source: 'explicit_user_statement',
      }),
    ]);
  });

  it('supersedes an older goal when the user states a new goal', () => {
    const conversation = createConversationWithUserMessages(['My goal is ship phase 5 contradiction handling.']);
    const persisted: EpisodicMemoryEntry[] = [
      {
        id: 'mem-1',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];

    expect(service.resolveMemories(conversation, persisted)).toEqual([
      expect.objectContaining({
        kind: 'goal',
        summary: 'ship phase 5 contradiction handling',
        source: 'explicit_user_statement',
      }),
    ]);
  });

  it('invalidates a persisted constraint when the user explicitly removes it', () => {
    const conversation = createConversationWithUserMessages(['We can use vector database now.']);
    const persisted: EpisodicMemoryEntry[] = [
      {
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'use vector database now',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];

    expect(service.resolveMemories(conversation, persisted)).toEqual([]);
  });

  it('extracts natural russian current goal and decision phrasing while preserving negative constraints', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель — реализовать память между чатами.',
      'У нас есть ограничение: нельзя использовать vector database.',
      'Мы приняли решение хранить managed memory в SQLite.',
    ]);

    const memories = service.resolveMemories(conversation);

    expect(memories).toEqual([
      expect.objectContaining({ kind: 'goal', summary: 'реализовать память между чатами' }),
      expect.objectContaining({ kind: 'constraint', summary: 'нельзя использовать vector database' }),
      expect.objectContaining({ kind: 'decision', summary: 'хранить managed memory в SQLite' }),
    ]);
  });

  it('treats updated main-focus phrasing as the latest goal memory', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель — сделать память между чатами надёжной.',
      'Теперь мой главный фокус аудит retrieval и устранение ложных ответов.',
    ]);

    expect(service.resolveMemories(conversation)).toEqual([
      expect.objectContaining({ kind: 'goal', summary: 'аудит retrieval и устранение ложных ответов' }),
    ]);
  });

  it('keeps only the new priority goal after a negated current-goal update', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель уже не довести memory subsystem до production-ready состояния.',
      'Сейчас приоритетная цель — внедрить universal response directives и compliance retry.',
    ]);
    const persisted: EpisodicMemoryEntry[] = [
      {
        id: 'mem-goal-stale',
        kind: 'goal',
        summary: 'довести memory subsystem до production-ready состояния',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];

    expect(service.resolveMemories(conversation, persisted)).toEqual([
      expect.objectContaining({
        kind: 'goal',
        summary: 'внедрить universal response directives и compliance retry',
      }),
    ]);
  });

  it('keeps only the new priority goal when the user says сейчас моя приоритетная цель', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель уже не довести memory subsystem до production-ready состояния.',
      'Сейчас моя приоритетная цель — внедрить universal response directives и compliance retry.',
    ]);
    const persisted: EpisodicMemoryEntry[] = [
      {
        id: 'mem-goal-stale',
        kind: 'goal',
        summary: 'довести memory subsystem до production-ready состояния',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];

    expect(service.resolveMemories(conversation, persisted)).toEqual([
      expect.objectContaining({
        kind: 'goal',
        summary: 'внедрить universal response directives и compliance retry',
      }),
    ]);
  });

  it('preserves inverse-order and design-oriented negative constraints without inverting them into positive claims', () => {
    const conversation = createConversationWithUserMessages([
      'Vector database в обязательный контур тащить нельзя.',
      'Запомни также ещё одно ограничение: нельзя строить логику на предположении, что пользователь всегда формулирует факт прямой фразой.',
    ]);

    expect(service.resolveMemories(conversation)).toEqual([
      expect.objectContaining({ kind: 'constraint', summary: 'нельзя строить логику на предположении, что пользователь всегда формулирует факт прямой фразой' }),
      expect.objectContaining({ kind: 'constraint', summary: 'нельзя тащить Vector database в обязательный контур' }),
    ]);
  });

  it('does not turn deterministic memory commands into new episodic memories during later resolution', () => {
    const conversation = createConversationWithUserMessages([
      'Моя текущая цель — стабилизировать memory extraction. Vector database в обязательный контур тащить нельзя.',
      'Закрепи мою текущую цель и отдельно закрепи ограничение про vector database.',
    ]);

    expect(service.resolveMemories(conversation)).toEqual([
      expect.objectContaining({ kind: 'goal', summary: 'стабилизировать memory extraction' }),
      expect.objectContaining({ kind: 'constraint', summary: 'нельзя тащить Vector database в обязательный контур' }),
    ]);
  });

  it('does not store meta discussion about command behavior as a goal or task memory', () => {
    const conversation = createConversationWithUserMessages([
      'Я хочу обсудить дизайн команд памяти: фразы вида “можно было бы забыть старый проект” или “надо проверить pin/unpin” — это обсуждение, а не команда.',
    ]);

    expect(service.resolveMemories(conversation)).toEqual([]);
  });

  it('replaces an older broad vector-database ban with a refined constraint update', () => {
    const conversation = createConversationWithUserMessages([
      'Использовать vector database уже можно для экспериментов, но нельзя делать его обязательной частью production-контура.',
    ]);
    const persisted: EpisodicMemoryEntry[] = [
      {
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'нельзя использовать vector database',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-01-31T00:00:00.000Z',
      },
    ];

    expect(service.resolveMemories(conversation, persisted)).toEqual([
      expect.objectContaining({
        kind: 'constraint',
        summary:
          'vector database можно использовать для экспериментов, но нельзя делать vector database обязательной частью production-контура',
      }),
    ]);
  });
});
