import { apiFetch } from './client';
import { API_ENDPOINTS } from '@/constants';
import type { ConversationPreview, Conversation } from '@/types/chat.types';

export const chatApi = {
  getConversations(): Promise<ConversationPreview[]> {
    return apiFetch<ConversationPreview[]>(API_ENDPOINTS.chat.conversations);
  },

  getConversation(id: string): Promise<Conversation> {
    return apiFetch<Conversation>(API_ENDPOINTS.chat.conversation(id));
  },

  deleteConversation(id: string): Promise<void> {
    return apiFetch<void>(API_ENDPOINTS.chat.conversation(id), { method: 'DELETE' });
  },
};
