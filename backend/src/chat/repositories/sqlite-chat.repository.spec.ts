import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { SqliteChatRepository } from './sqlite-chat.repository';

describe('SqliteChatRepository', () => {
  let tempDir: string;
  let repository: SqliteChatRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'argus-sqlite-chat-'));
    repository = new SqliteChatRepository(
      new ConfigService({
        storage: {
          driver: 'sqlite',
          dbFilePath: join(tempDir, 'chat-store.db'),
          dataFilePath: join(tempDir, 'chat-store.json'),
        },
      }),
    );
    repository.onModuleInit();
  });

  afterEach(async () => {
    (repository as unknown as { database?: { close: () => void } }).database?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists a saved conversation with ordered messages', async () => {
    const conversation = new Conversation();
    conversation.addMessage(
      new Message({
        conversationId: conversation.id,
        role: 'user',
        content: 'Hello',
      }),
    );
    conversation.addMessage(
      new Message({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Hi there',
      }),
    );

    await repository.saveConversation(conversation);

    const stored = await repository.getConversation(conversation.id);
    expect(stored?.id).toBe(conversation.id);
    expect(stored?.messages.map((message) => message.content)).toEqual(['Hello', 'Hi there']);
  });

  it('sorts conversations by updatedAt descending', async () => {
    const older = new Conversation({
      id: crypto.randomUUID(),
      title: 'Older',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const newer = new Conversation({
      id: crypto.randomUUID(),
      title: 'Newer',
      createdAt: new Date('2024-01-02T00:00:00.000Z'),
      updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    });

    await repository.saveConversation(older);
    await repository.saveConversation(newer);

    const conversations = await repository.getAllConversations();
    expect(conversations.map((item) => item.title)).toEqual(['Newer', 'Older']);
  });

});
