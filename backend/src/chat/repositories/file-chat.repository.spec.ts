import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileStoreService } from '../../storage/file-store.service';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { FileChatRepository } from './file-chat.repository';

describe('FileChatRepository', () => {
  let tempDir: string;
  let repository: FileChatRepository;
  let fileStoreService: FileStoreService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'argus-chat-store-'));
    fileStoreService = new FileStoreService(
      new ConfigService({
        storage: {
          driver: 'file',
          dataFilePath: join(tempDir, 'chat-store.json'),
        },
      }),
    );
    await fileStoreService.onModuleInit();
    repository = new FileChatRepository(fileStoreService);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists a saved conversation', async () => {
    const conversation = new Conversation();
    conversation.addMessage(
      new Message({
        conversationId: conversation.id,
        role: 'user',
        content: 'Hello',
      }),
    );

    await repository.saveConversation(conversation);

    const stored = await repository.getConversation(conversation.id);
    expect(stored?.id).toBe(conversation.id);
    expect(stored?.messages).toHaveLength(1);
    expect(stored?.messages[0]?.content).toBe('Hello');
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
