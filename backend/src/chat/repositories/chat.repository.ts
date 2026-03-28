import { Conversation } from '../entities/conversation.entity';
import type { ArchivedChatMessageHit, ArchivedChatSearchRequest } from '../../memory/archive/archive-chat-retrieval.types';

export const CHAT_REPOSITORY = Symbol('CHAT_REPOSITORY');

export abstract class ChatRepository {
  abstract createConversation(scopeKey?: string): Promise<Conversation>;
  abstract getConversation(id: string, scopeKey?: string): Promise<Conversation | undefined>;
  abstract getAllConversations(scopeKey?: string): Promise<Conversation[]>;
  abstract saveConversation(conversation: Conversation): Promise<void>;
  abstract deleteConversation(id: string, scopeKey?: string): Promise<boolean>;
  abstract searchArchivedChatMessages(request: ArchivedChatSearchRequest): Promise<ArchivedChatMessageHit[]>;
  abstract checkHealth(): Promise<{
    status: 'up' | 'down';
    driver: string;
    target: string;
    conversationCount: number;
    error?: string;
  }>;
}
