import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { PostgresConnectionService } from '../../storage/postgres-connection.service';
import { PostgresChatRepository } from './postgres-chat.repository';

const createMockPool = () => ({
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn(),
});

const createMockClient = () => ({
  query: jest.fn(),
  release: jest.fn(),
});

const createMockConnectionService = (pool: ReturnType<typeof createMockPool>) => ({
  getPool: jest.fn().mockResolvedValue(pool),
  getMaskedPostgresUrl: jest.fn().mockReturnValue('postgres://***@localhost:5432/argus'),
});

describe('PostgresChatRepository', () => {
  let repository: PostgresChatRepository;
  let pool: ReturnType<typeof createMockPool>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    pool = createMockPool();
    client = createMockClient();
    const connectionService = createMockConnectionService(pool);
    repository = new PostgresChatRepository(connectionService as unknown as PostgresConnectionService);
  });

  it('hydrates stored conversations with ordered messages', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'conv-1',
          title: 'Conversation',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
          scope_key: 'local:default',
        },
      ],
    });
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'msg-1',
          conversation_id: 'conv-1',
          role: 'user',
          content: 'Hello',
          created_at: '2024-01-01T00:00:01.000Z',
        },
        {
          id: 'msg-2',
          conversation_id: 'conv-1',
          role: 'assistant',
          content: 'Hi there',
          created_at: '2024-01-01T00:00:02.000Z',
        },
      ],
    });

    const conversation = await repository.getConversation('conv-1');

    expect(conversation?.id).toBe('conv-1');
    expect(conversation?.messages.map((message) => message.content)).toEqual(['Hello', 'Hi there']);
  });

  it('saves conversations transactionally with ordered message positions', async () => {
    pool.connect.mockResolvedValue(client);
    client.query.mockResolvedValue({});

    const conversation = new Conversation({
      id: 'conv-1',
      title: 'Conversation',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    });
    const firstMessage = new Message({
      id: 'msg-1',
      conversationId: conversation.id,
      role: 'user',
      content: 'Hello',
      createdAt: new Date('2024-01-01T00:00:01.000Z'),
    });
    const secondMessage = new Message({
      id: 'msg-2',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Hi there',
      createdAt: new Date('2024-01-01T00:00:02.000Z'),
    });
    conversation.addMessage(firstMessage);
    conversation.addMessage(secondMessage);
    conversation.updatedAt = new Date('2024-01-02T00:00:00.000Z');

    await repository.saveConversation(conversation);

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO conversations'),
      [
        'conv-1',
        'local:default',
        'Conversation',
        '2024-01-01T00:00:00.000Z',
        '2024-01-02T00:00:00.000Z',
      ],
    );
    expect(client.query).toHaveBeenNthCalledWith(3, 'DELETE FROM messages WHERE conversation_id = $1', ['conv-1']);
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO messages'),
      ['msg-1', 'conv-1', 'user', 'Hello', '2024-01-01T00:00:01.000Z', 0],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('INSERT INTO messages'),
      ['msg-2', 'conv-1', 'assistant', 'Hi there', '2024-01-01T00:00:02.000Z', 1],
    );
    expect(client.query).toHaveBeenNthCalledWith(6, 'COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
