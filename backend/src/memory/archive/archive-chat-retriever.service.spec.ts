import { ArchiveChatRetrieverService } from './archive-chat-retriever.service';
import type { ChatRepository } from '../../chat/repositories/chat.repository';
import { Conversation } from '../../chat/entities/conversation.entity';
import { Message } from '../../chat/entities/message.entity';

const createConversationWithUserMessages = (id: string, contents: string[]) => {
  const conversation = new Conversation({ id });
  contents.forEach((content, index) => {
    conversation.addMessage(
      new Message({
        id: `msg-${id}-${index}`,
        conversationId: id,
        role: 'user',
        content,
        createdAt: new Date(`2026-03-0${index + 1}T00:00:00.000Z`),
      }),
    );
  });
  return conversation;
};

describe('ArchiveChatRetrieverService', () => {
  it('returns empty evidence when no tokens are extracted', async () => {
    const service = new ArchiveChatRetrieverService({
      searchArchivedChatMessages: jest.fn().mockResolvedValue([]),
    } as unknown as ChatRepository);

    const conversation = new Conversation({ id: 'conv-1' });
    await expect(service.retrieveEvidence(conversation)).resolves.toEqual([]);
  });

  it('prioritizes tokens from the latest archive-recall question over earlier generic context', async () => {
    const searchArchivedChatMessages = jest.fn().mockResolvedValue([]);
    const service = new ArchiveChatRetrieverService({
      searchArchivedChatMessages,
    } as unknown as ChatRepository);

    const conversation = createConversationWithUserMessages('conv-current', [
      'Я открыл новый чат. Напомни, как называется мой проект, какая у меня роль и какая у меня текущая цель.',
      'Какое кодовое слово и какая тестовая ветка упоминались мной в прошлом разговоре?',
    ]);

    await service.retrieveEvidence(conversation, { limit: 3 });

    expect(searchArchivedChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeConversationId: 'conv-current',
        tokens: expect.arrayContaining(['кодовое', 'слово', 'тестовая', 'ветка']),
      }),
    );
  });

  it('excludes current conversation hits and ranks by token overlap + recency', async () => {
    const searchArchivedChatMessages = jest.fn().mockResolvedValue([
      {
        conversationId: 'conv-other',
        messageId: 'm-1',
        role: 'user',
        content: 'My project is Alpha.',
        createdAt: '2026-03-01T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-01T00:00:00.000Z',
        matchCount: 2,
      },
      {
        conversationId: 'conv-current',
        messageId: 'm-2',
        role: 'user',
        content: 'My project is SHOULD NOT APPEAR.',
        createdAt: '2026-03-02T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-02T00:00:00.000Z',
        matchCount: 2,
      },
      {
        conversationId: 'conv-other',
        messageId: 'm-3',
        role: 'assistant',
        content: 'Noted: project=Alpha.',
        createdAt: '2026-03-03T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-03T00:00:00.000Z',
        matchCount: 1,
      },
    ]);

    const service = new ArchiveChatRetrieverService({
      searchArchivedChatMessages,
    } as unknown as ChatRepository);

    const conversation = createConversationWithUserMessages('conv-current', [
      'What about my project?',
      'Tell me about project Alpha.',
    ]);

    const evidence = await service.retrieveEvidence(conversation, { limit: 3 });

    expect(searchArchivedChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeConversationId: 'conv-current',
      }),
    );

    expect(evidence.some((item) => item.conversationId === 'conv-current')).toBe(false);
    expect(evidence[0]?.excerpt).toContain('Alpha');
  });

  it('filters archived evidence that matches a suppressed forgotten fact value', async () => {
    const searchArchivedChatMessages = jest.fn().mockResolvedValue([
      {
        conversationId: 'conv-other',
        messageId: 'm-name',
        role: 'user',
        content: 'Меня зовут Кирилл Новиков.',
        createdAt: '2026-03-01T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-01T00:00:00.000Z',
        matchCount: 2,
      },
      {
        conversationId: 'conv-other',
        messageId: 'm-safe',
        role: 'assistant',
        content: 'Ты работаешь над проектом Argus.',
        createdAt: '2026-03-02T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-02T00:00:00.000Z',
        matchCount: 1,
      },
    ]);

    const service = new ArchiveChatRetrieverService({
      searchArchivedChatMessages,
    } as unknown as ChatRepository);

    const conversation = createConversationWithUserMessages('conv-current', ['Как меня зовут и над чем я работаю?']);
    const evidence = await service.retrieveEvidence(conversation, {
      limit: 3,
      suppressedFacts: [{ key: 'name', value: 'Кирилл Новиков' }],
    });

    expect(evidence.map((item) => item.messageId)).toEqual(['m-safe']);
    expect(evidence[0]?.excerpt).toContain('Argus');
  });

  it('filters generic archived recall questions when the user asks what the system remembers about them', async () => {
    const searchArchivedChatMessages = jest.fn().mockResolvedValue([
      {
        conversationId: 'conv-older-a',
        messageId: 'm-generic-question',
        role: 'user',
        content: 'Что ты помнишь обо мне?',
        createdAt: '2026-03-03T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-03T00:00:00.000Z',
        matchCount: 3,
      },
      {
        conversationId: 'conv-older-b',
        messageId: 'm-fact-like',
        role: 'assistant',
        content: 'Ты работаешь как backend engineer и ведёшь проект Argus.',
        createdAt: '2026-03-02T00:00:00.000Z',
        conversationUpdatedAt: '2026-03-02T00:00:00.000Z',
        matchCount: 1,
      },
    ]);

    const service = new ArchiveChatRetrieverService({
      searchArchivedChatMessages,
    } as unknown as ChatRepository);

    const conversation = createConversationWithUserMessages('conv-current', ['Что ты помнишь обо мне?']);
    const evidence = await service.retrieveEvidence(conversation, { limit: 3 });

    expect(evidence.map((item) => item.messageId)).toEqual(['m-fact-like']);
    expect(evidence[0]?.excerpt).toContain('backend engineer');
  });

  it('trims excerpts and adds ellipsis for long content', async () => {
    const longText = 'A'.repeat(2000) + ' project alpha ' + 'B'.repeat(2000);
    const service = new ArchiveChatRetrieverService({
      searchArchivedChatMessages: jest.fn().mockResolvedValue([
        {
          conversationId: 'conv-2',
          messageId: 'm-long',
          role: 'user',
          content: longText,
          createdAt: '2026-03-01T00:00:00.000Z',
          conversationUpdatedAt: '2026-03-01T00:00:00.000Z',
          matchCount: 1,
        },
      ]),
    } as unknown as ChatRepository);

    const conversation = createConversationWithUserMessages('conv-current', ['project alpha']);
    const evidence = await service.retrieveEvidence(conversation, { limit: 1 });

    expect(evidence[0]?.excerpt.length).toBeLessThanOrEqual(241);
    expect(evidence[0]?.excerpt).toContain('…');
  });
});
