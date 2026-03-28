import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from './chat.store';
import type { StreamEvent } from '@/types/chat.types';

const chatApiMock = vi.hoisted(() => ({
  getConversations: vi.fn(),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
}));

const apiStreamMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/resources/chat.api', () => ({
  chatApi: chatApiMock,
}));

vi.mock('@/api/http/client', () => ({
  apiStream: apiStreamMock,
}));

describe('useChatStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      conversations: [],
      currentConversationId: null,
      messages: [],
      isLoading: false,
      isStreaming: false,
      error: null,
    });
  });

  it('loads conversations into store state', async () => {
    chatApiMock.getConversations.mockResolvedValue([
      {
        id: 'conv-1',
        title: 'Test conversation',
        messageCount: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);

    await useChatStore.getState().loadConversations();

    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useChatStore.getState().conversations[0]?.title).toBe('Test conversation');
  });

  it('handles streaming chat flow and updates conversation id', async () => {
    chatApiMock.getConversations.mockResolvedValue([]);

    apiStreamMock.mockImplementation(
      async (
        _endpoint: string,
        _body: unknown,
        onChunk: (data: unknown) => void,
        onDone: () => void,
      ) => {
        const events: StreamEvent[] = [
          { event: 'token', data: 'Hello' },
          { event: 'token', data: ' world' },
          { event: 'done', data: '', conversationId: 'conv-stream', messageId: 'assistant-1' },
        ];

        for (const event of events) {
          onChunk(event);
        }

        onDone();
      },
    );

    await useChatStore.getState().sendMessage('Hi');

    expect(useChatStore.getState().currentConversationId).toBe('conv-stream');
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(useChatStore.getState().messages[1]?.content).toBe('Hello world');
    expect(apiStreamMock).toHaveBeenCalledTimes(1);
  });

  it('removes empty assistant placeholder when stream returns an error event', async () => {
    chatApiMock.getConversations.mockResolvedValue([]);

    apiStreamMock.mockImplementation(
      async (
        _endpoint: string,
        _body: unknown,
        onChunk: (data: unknown) => void,
        onDone: () => void,
      ) => {
        onChunk({ event: 'error', data: 'Stream exploded', conversationId: 'conv-error' } satisfies StreamEvent);
        onDone();
      },
    );

    await useChatStore.getState().sendMessage('Hi');

    expect(useChatStore.getState().currentConversationId).toBe('conv-error');
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0]?.role).toBe('user');
    expect(useChatStore.getState().error).toBe('Stream exploded');
  });

  it('rolls back optimistic messages when the stream fails before any SSE event arrives', async () => {
    chatApiMock.getConversations.mockResolvedValue([]);

    apiStreamMock.mockImplementation(
      async (
        _endpoint: string,
        _body: unknown,
        _onChunk: (data: unknown) => void,
        _onDone: () => void,
        onError: (error: Error) => void,
      ) => {
        onError(new Error('Network down'));
      },
    );

    await expect(useChatStore.getState().sendMessage('Hi')).rejects.toThrow('Network down');

    expect(useChatStore.getState().currentConversationId).toBeNull();
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().error).toBe('Network down');
  });

  it('does not start streaming while a conversation is still loading', async () => {
    useChatStore.setState({
      currentConversationId: 'conv-1',
      isLoading: true,
    });

    await useChatStore.getState().sendMessage('Hi');

    expect(apiStreamMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().error).toBe(
      'Wait for the current conversation to finish loading before sending a message',
    );
  });
});
