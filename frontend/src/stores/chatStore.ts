import { create } from 'zustand';

import type { Message, ConversationPreview, StreamEvent } from '@/types/chat.types';
import { apiStream } from '@/api/client';
import { chatApi } from '@/api/chat.api';
import { API_ENDPOINTS } from '@/constants';

interface ChatState {
  conversations: ConversationPreview[];
  currentConversationId: string | null;
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  clearError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isLoading: false,
  isStreaming: false,
  error: null,

  loadConversations: async () => {
    try {
      const conversations = await chatApi.getConversations();
      set({ conversations });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load conversations' });
    }
  },

  selectConversation: async (id: string) => {
    if (get().isStreaming || get().isLoading) {
      set({
        error:
          'Wait for the current conversation to finish loading or responding before switching conversations',
      });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const conversation = await chatApi.getConversation(id);
      set({
        currentConversationId: conversation.id,
        messages: conversation.messages,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load conversation',
        isLoading: false,
      });
    }
  },

  newConversation: () => {
    if (get().isStreaming || get().isLoading) {
      set({
        error:
          'Wait for the current conversation to finish loading or responding before starting a new conversation',
      });
      return;
    }

    set({
      currentConversationId: null,
      messages: [],
      error: null,
    });
  },

  deleteConversation: async (id: string) => {
    if (get().isStreaming || get().isLoading) {
      set({
        error:
          'Wait for the current conversation to finish loading or responding before deleting a conversation',
      });
      return;
    }

    try {
      await chatApi.deleteConversation(id);
      const { currentConversationId } = get();
      if (currentConversationId === id) {
        set({ currentConversationId: null, messages: [] });
      }
      await get().loadConversations();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete conversation' });
    }
  },

  sendMessage: async (content: string) => {
    if (get().isLoading) {
      set({ error: 'Wait for the current conversation to finish loading before sending a message' });
      return;
    }

    if (get().isStreaming) {
      set({ error: 'Wait for the current response to finish before sending another message' });
      return;
    }

    const { currentConversationId, messages } = get();

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };

    set({
      messages: [...messages, userMessage],
      isStreaming: true,
      error: null,
    });

    let assistantContent = '';
    let newConversationId = currentConversationId;
    let hasReceivedStreamEvent = false;
    let transportError: Error | null = null;

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      messages: [...state.messages, assistantMessage],
    }));

    await apiStream(
      API_ENDPOINTS.chat.streamMessage,
      { content, conversationId: currentConversationId },
      (data: unknown) => {
        hasReceivedStreamEvent = true;
        const event = data as StreamEvent;

        if (event.conversationId && event.conversationId !== newConversationId) {
          newConversationId = event.conversationId;
          set({ currentConversationId: newConversationId });
        }

        if (event.event === 'token' && event.data) {
          assistantContent += event.data;
          set((state) => ({
            messages: state.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, content: assistantContent }
                : m,
            ),
          }));
        }

        if (event.event === 'done') {
          const { messageId } = event;
          if (messageId) {
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === assistantMessage.id
                  ? { ...m, id: messageId }
                  : m,
              ),
            }));
          }
        }

        if (event.event === 'error') {
          if (event.conversationId) {
            newConversationId = event.conversationId;
          }
          set({
            messages: assistantContent
              ? get().messages
              : get().messages.filter((message) => message.id !== assistantMessage.id),
            error: event.data || 'Stream error',
          });
        }
      },
      () => {
        set({
          isStreaming: false,
          currentConversationId: newConversationId,
        });
        get().loadConversations();
      },
      (error: Error) => {
        transportError = error;
        const currentMessages = get().messages;

        set({
          messages: hasReceivedStreamEvent
            ? assistantContent
              ? currentMessages
              : currentMessages.filter((message) => message.id !== assistantMessage.id)
            : currentMessages.filter(
                (message) => message.id !== assistantMessage.id && message.id !== userMessage.id,
              ),
          isStreaming: false,
          currentConversationId: hasReceivedStreamEvent ? newConversationId : currentConversationId,
          error: error.message,
        });

        if (hasReceivedStreamEvent) {
          void get().loadConversations();
        }
      },
    );

    if (transportError && !hasReceivedStreamEvent) {
      throw transportError;
    }
  },

  clearError: () => set({ error: null }),
}));
