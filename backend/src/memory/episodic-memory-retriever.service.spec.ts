import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { EpisodicMemoryRetrieverService } from './episodic-memory-retriever.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-retriever' });
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

describe('EpisodicMemoryRetrieverService', () => {
  const service = new EpisodicMemoryRetrieverService();

  it('prioritizes episodic memories that lexically match the current user request', () => {
    const conversation = createConversationWithUserMessages([
      'Мы обсуждаем phase 3 retrieval для памяти.',
      'Продолжай про retrieval ranking.',
    ]);
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-1',
        kind: 'goal',
        summary: 'ship phase 3 memory retrieval',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'mem-2',
        kind: 'constraint',
        summary: 'use sqlite before adding vector storage',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-02-02T00:00:00.000Z',
      },
    ];

    expect(service.selectRelevantMemories(conversation, entries)).toEqual([entries[0]]);
  });

  it('falls back to most recent memories when the current request has no useful lexical signal', () => {
    const conversation = createConversationWithUserMessages(['Продолжай']);
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-older',
        kind: 'goal',
        summary: 'ship phase 3 memory retrieval',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'mem-newer',
        kind: 'task',
        summary: 'add e2e coverage',
        source: 'explicit_user_statement',
        salience: 0.8,
        updatedAt: '2026-02-03T00:00:00.000Z',
      },
    ];

    expect(service.selectRelevantMemories(conversation, entries, 1)).toEqual([entries[1]]);
  });

  it('includes high-value supporting context like constraints and decisions alongside the main relevant goal', () => {
    const conversation = createConversationWithUserMessages(['Продолжай план памяти между чатами']);
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-goal',
        kind: 'goal',
        summary: 'реализовать память между чатами',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'нельзя использовать vector database',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-02-01T00:05:00.000Z',
      },
      {
        id: 'mem-decision',
        kind: 'decision',
        summary: 'хранить managed memory в SQLite',
        source: 'explicit_user_statement',
        salience: 0.85,
        updatedAt: '2026-02-01T00:10:00.000Z',
      },
      {
        id: 'mem-task',
        kind: 'task',
        summary: 'добавить e2e тесты',
        source: 'explicit_user_statement',
        salience: 0.8,
        updatedAt: '2026-02-04T00:00:00.000Z',
      },
    ];

    expect(service.selectRelevantMemories(conversation, entries)).toEqual([entries[0], entries[1], entries[2]]);
  });

  it('does not fall back to unrelated episodic memories when the user asks a direct profile question', () => {
    const conversation = createConversationWithUserMessages([
      'Напомни, пожалуйста, кто я в рабочем контексте, как меня зовут и над чем я вообще сейчас работаю.',
    ]);
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'нельзя использовать vector database',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-02-01T00:05:00.000Z',
      },
      {
        id: 'mem-decision',
        kind: 'decision',
        summary: 'хранить managed memory в SQLite',
        source: 'explicit_user_statement',
        salience: 0.85,
        updatedAt: '2026-02-01T00:10:00.000Z',
      },
    ];

    expect(service.selectRelevantMemories(conversation, entries)).toEqual([]);
  });
});
