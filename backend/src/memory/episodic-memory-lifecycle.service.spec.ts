import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import { EpisodicMemoryLifecycleService } from './episodic-memory-lifecycle.service';
import type { EpisodicMemoryEntry } from './episodic-memory.types';

const expectEntry = (partial: Partial<EpisodicMemoryEntry>) => expect.objectContaining(partial);

const createConversationWithUserMessages = (contents: string[]): Conversation => {
  const conversation = new Conversation({ id: 'conv-episodic-lifecycle' });
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

describe('EpisodicMemoryLifecycleService', () => {
  const service = new EpisodicMemoryLifecycleService();

  it('merges duplicate episodic memories and boosts salience without changing stable identity', () => {
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-1',
        kind: 'goal',
        summary: 'Ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'mem-2',
        kind: 'goal',
        summary: ' ship phase 4 lifecycle ',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-02-02T00:00:00.000Z',
      },
    ];

    expect(service.prepareEntriesForStorage(entries, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectEntry({
        id: 'mem-1',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 1,
        updatedAt: '2026-02-02T00:00:00.000Z',
      }),
    ]);
  });

  it('filters stale low-value episodic memories out of prompt-visible entries', () => {
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-task',
        kind: 'task',
        summary: 'add temporary debug logging',
        source: 'explicit_user_statement',
        salience: 0.8,
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'mem-goal',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];

    expect(service.selectPromptEntries(entries, undefined, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectEntry({
        id: 'mem-goal',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);
  });

  it('promotes the most relevant high-value episodic memory for the current request', () => {
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-goal',
        kind: 'goal',
        summary: 'ship phase 6 memory promotion',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        id: 'mem-task',
        kind: 'task',
        summary: 'clean up temporary debug logging',
        source: 'explicit_user_statement',
        salience: 0.82,
        updatedAt: '2026-03-03T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Continue phase 6 memory promotion']);

    expect(service.selectPromptEntries(entries, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectEntry({
        id: 'mem-goal',
        kind: 'goal',
        summary: 'ship phase 6 memory promotion',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);
  });

  it('keeps a pinned episodic memory prompt-visible even when the request is not lexically related', () => {
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'use sqlite before adding vector storage',
        source: 'explicit_user_statement',
        salience: 0.9,
        pinned: true,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Continue']);

    expect(service.selectPromptEntries(entries, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectEntry({
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'use sqlite before adding vector storage',
        source: 'explicit_user_statement',
        salience: 0.9,
        pinned: true,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);
  });

  it('keeps a high-value episodic context cluster prompt-visible when the current request is about that goal', () => {
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-goal',
        kind: 'goal',
        summary: 'реализовать память между чатами',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'нельзя использовать vector database',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-03-02T00:05:00.000Z',
      },
      {
        id: 'mem-decision',
        kind: 'decision',
        summary: 'хранить managed memory в SQLite',
        source: 'explicit_user_statement',
        salience: 0.85,
        updatedAt: '2026-03-02T00:10:00.000Z',
      },
    ];
    const conversation = createConversationWithUserMessages(['Продолжай план памяти между чатами']);

    expect(service.selectPromptEntries(entries, conversation, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectEntry({
        id: 'mem-goal',
        kind: 'goal',
        summary: 'реализовать память между чатами',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-02T00:00:00.000Z',
      }),
      expectEntry({
        id: 'mem-constraint',
        kind: 'constraint',
        summary: 'нельзя использовать vector database',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-03-02T00:05:00.000Z',
      }),
      expectEntry({
        id: 'mem-decision',
        kind: 'decision',
        summary: 'хранить managed memory в SQLite',
        source: 'explicit_user_statement',
        salience: 0.85,
        updatedAt: '2026-03-02T00:10:00.000Z',
      }),
    ]);
  });

  it('preserves provenance and revision history when equivalent episodic memories are merged', () => {
    const entries: EpisodicMemoryEntry[] = [
      {
        id: 'mem-1',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        source: 'explicit_user_statement',
        salience: 0.9,
        updatedAt: '2026-03-01T00:00:00.000Z',
        revision: 2,
        provenance: {
          firstObservedAt: '2026-02-01T00:00:00.000Z',
          lastObservedAt: '2026-03-01T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-episodic-lifecycle',
            messageId: 'msg-origin',
            createdAt: '2026-02-01T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-episodic-lifecycle',
            messageId: 'msg-0',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        },
        revisionHistory: [
          {
            revision: 1,
            summary: 'ship phase 3 lifecycle',
            salience: 0.95,
            updatedAt: '2026-02-01T00:00:00.000Z',
            provenance: {
              firstObservedAt: '2026-02-01T00:00:00.000Z',
              lastObservedAt: '2026-02-01T00:00:00.000Z',
            },
          },
        ],
      },
      {
        id: 'mem-2',
        kind: 'goal',
        summary: ' ship phase 4 lifecycle ',
        source: 'explicit_user_statement',
        salience: 0.95,
        updatedAt: '2026-03-02T00:00:00.000Z',
        revision: 2,
        provenance: {
          firstObservedAt: '2026-03-02T00:00:00.000Z',
          lastObservedAt: '2026-03-02T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-episodic-lifecycle',
            messageId: 'msg-1',
            createdAt: '2026-03-02T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-episodic-lifecycle',
            messageId: 'msg-1',
            createdAt: '2026-03-02T00:00:00.000Z',
          },
        },
      },
    ];

    expect(service.prepareEntriesForStorage(entries, new Date('2026-03-18T00:00:00.000Z'))).toEqual([
      expectEntry({
        id: 'mem-1',
        kind: 'goal',
        summary: 'ship phase 4 lifecycle',
        revision: 2,
        provenance: {
          firstObservedAt: '2026-02-01T00:00:00.000Z',
          lastObservedAt: '2026-03-02T00:00:00.000Z',
          firstObservedIn: {
            conversationId: 'conv-episodic-lifecycle',
            messageId: 'msg-origin',
            createdAt: '2026-02-01T00:00:00.000Z',
          },
          lastObservedIn: {
            conversationId: 'conv-episodic-lifecycle',
            messageId: 'msg-1',
            createdAt: '2026-03-02T00:00:00.000Z',
          },
        },
        revisionHistory: [
          expect.objectContaining({
            revision: 1,
            summary: 'ship phase 3 lifecycle',
          }),
        ],
      }),
    ]);
  });
});
