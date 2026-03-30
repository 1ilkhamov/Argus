import { create } from 'zustand';

import type { Message, ConversationPreview, StreamEvent, ToolCallStatus } from '@/types/chat.types';
import { apiStream, apiStreamFormData } from '@/api/http/client';
import { chatApi } from '@/api/resources/chat.api';
import { API_ENDPOINTS } from '@/config';

function createClientMessageId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ChatState {
  conversations: ConversationPreview[];
  currentConversationId: string | null;
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  activeToolCalls: ToolCallStatus[];
  error: string | null;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  sendVoiceMessage: (audioBlob: Blob) => Promise<void>;
  setError: (message: string) => void;
  clearError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isLoading: false,
  isStreaming: false,
  activeToolCalls: [],
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
      id: createClientMessageId(),
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
      id: createClientMessageId(),
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

        if (event.event === 'tool_start' && event.toolName) {
          set((state) => ({
            activeToolCalls: [
              ...state.activeToolCalls,
              { name: event.toolName!, startedAt: Date.now(), done: false },
            ],
          }));
        }

        if (event.event === 'tool_end' && event.toolName) {
          set((state) => ({
            activeToolCalls: state.activeToolCalls.map((tc) =>
              tc.name === event.toolName && !tc.done
                ? { ...tc, done: true, durationMs: event.toolDurationMs, success: event.toolSuccess }
                : tc,
            ),
          }));
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
          activeToolCalls: [],
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
          activeToolCalls: [],
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

  sendVoiceMessage: async (audioBlob: Blob) => {
    if (get().isLoading) {
      set({ error: 'Wait for the current conversation to finish loading before sending a message' });
      return;
    }

    if (get().isStreaming) {
      set({ error: 'Wait for the current response to finish before sending another message' });
      return;
    }

    const { currentConversationId, messages } = get();

    set({
      isStreaming: true,
      error: null,
    });

    let transcribedText = '';
    let assistantContent = '';
    let newConversationId = currentConversationId;
    let hasReceivedStreamEvent = false;
    let transportError: Error | null = null;

    const assistantMessage: Message = {
      id: createClientMessageId(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };

    const formData = new FormData();
    formData.append('audio', audioBlob, 'voice.webm');
    if (currentConversationId) {
      formData.append('conversationId', currentConversationId);
    }

    await apiStreamFormData(
      API_ENDPOINTS.chat.voiceStream,
      formData,
      (data: unknown) => {
        hasReceivedStreamEvent = true;
        const event = data as StreamEvent;

        if (event.conversationId && event.conversationId !== newConversationId) {
          newConversationId = event.conversationId;
          set({ currentConversationId: newConversationId });
        }

        if (event.event === 'transcription' && event.data) {
          transcribedText = event.data;
          const userMessage: Message = {
            id: createClientMessageId(),
            role: 'user',
            content: transcribedText,
            createdAt: new Date().toISOString(),
          };
          set((state) => ({
            messages: [...state.messages, userMessage, assistantMessage],
          }));
        }

        if (event.event === 'tool_start' && event.toolName) {
          set((state) => ({
            activeToolCalls: [
              ...state.activeToolCalls,
              { name: event.toolName!, startedAt: Date.now(), done: false },
            ],
          }));
        }

        if (event.event === 'tool_end' && event.toolName) {
          set((state) => ({
            activeToolCalls: state.activeToolCalls.map((tc) =>
              tc.name === event.toolName && !tc.done
                ? { ...tc, done: true, durationMs: event.toolDurationMs, success: event.toolSuccess }
                : tc,
            ),
          }));
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
            error: event.data || 'Voice message error',
          });
        }
      },
      () => {
        set({
          isStreaming: false,
          activeToolCalls: [],
          currentConversationId: newConversationId,
        });
        get().loadConversations();
      },
      (error: Error) => {
        transportError = error;
        set({
          messages: hasReceivedStreamEvent
            ? get().messages
            : messages,
          isStreaming: false,
          activeToolCalls: [],
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

  setError: (message: string) => set({ error: message }),
  clearError: () => set({ error: null }),
}));
