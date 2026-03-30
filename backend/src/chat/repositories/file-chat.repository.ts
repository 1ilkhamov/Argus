import { Injectable, Logger } from '@nestjs/common';
import { stat } from 'fs/promises';

import type { ArchivedChatMessageHit, ArchivedChatSearchRequest } from '../../memory/archive/archive-chat-retrieval.types';
import type { SerializedConversation } from '../../storage/file-store.service';
import { FileStoreService } from '../../storage/file-store.service';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { ChatRepository } from './chat.repository';

@Injectable()
export class FileChatRepository extends ChatRepository {
  private readonly logger = new Logger(FileChatRepository.name);

  constructor(private readonly fileStoreService: FileStoreService) {
    super();
  }

  async createConversation(scopeKey?: string): Promise<Conversation> {
    const conversation = new Conversation({ scopeKey });
    await this.saveConversation(conversation);
    return conversation;
  }

  async getConversation(id: string, scopeKey?: string): Promise<Conversation | undefined> {
    const store = await this.fileStoreService.readStore();
    const rawConversation = store.conversations.find((conversation) => conversation.id === id);
    if (!rawConversation) {
      return undefined;
    }

    const conversation = this.deserializeConversation(rawConversation);
    if (scopeKey && conversation.scopeKey !== scopeKey) {
      return undefined;
    }

    return conversation;
  }

  async getAllConversations(scopeKey?: string): Promise<Conversation[]> {
    const store = await this.fileStoreService.readStore();
    const filtered = scopeKey
      ? store.conversations.filter((c) => (c.scopeKey ?? 'local:default') === scopeKey)
      : store.conversations;
    return filtered
      .map((conversation) => this.deserializeConversation(conversation))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      const serialized = this.serializeConversation(conversation);
      const existingIndex = store.conversations.findIndex((item) => item.id === serialized.id);

      if (existingIndex >= 0) {
        store.conversations[existingIndex] = serialized;
      } else {
        store.conversations.push(serialized);
      }

      await this.fileStoreService.writeStore(store);
    });
  }

  async deleteConversation(id: string, scopeKey?: string): Promise<boolean> {
    let deleted = false;

    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      const nextConversations = store.conversations.filter((conversation) => {
        if (conversation.id !== id) {
          return true;
        }

        const conversationScopeKey = conversation.scopeKey ?? 'local:default';
        if (scopeKey && conversationScopeKey !== scopeKey) {
          return true;
        }

        deleted = true;
        return false;
      });

      if (deleted) {
        await this.fileStoreService.writeStore({
          ...store,
          conversations: nextConversations,
        });
      }
    });

    return deleted;
  }

  async searchArchivedChatMessages(request: ArchivedChatSearchRequest): Promise<ArchivedChatMessageHit[]> {
    const store = await this.fileStoreService.readStore();
    const tokens = request.tokens.map((token) => token.toLocaleLowerCase()).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return [];
    }

    const hits: ArchivedChatMessageHit[] = [];
    for (const conversation of store.conversations) {
      const conversationScopeKey = conversation.scopeKey ?? 'local:default';
      if (request.scopeKey && conversationScopeKey !== request.scopeKey) {
        continue;
      }

      if (request.excludeConversationId && conversation.id === request.excludeConversationId) {
        continue;
      }

      for (const message of conversation.messages ?? []) {
        const content = message.content ?? '';
        const normalized = content.toLocaleLowerCase();
        let matchCount = 0;
        for (const token of tokens) {
          if (normalized.includes(token)) {
            matchCount += 1;
          }
        }

        if (matchCount === 0) {
          continue;
        }

        hits.push({
          conversationId: conversation.id,
          messageId: message.id,
          role: message.role,
          content,
          createdAt: message.createdAt,
          conversationUpdatedAt: conversation.updatedAt,
          matchCount,
        });
      }
    }

    return hits
      .sort((left, right) => {
        if (right.matchCount !== left.matchCount) {
          return right.matchCount - left.matchCount;
        }

        return right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt);
      })
      .slice(0, request.limit);
  }

  async checkHealth(): Promise<{
    status: 'up' | 'down';
    driver: string;
    target: string;
    conversationCount: number;
    error?: string;
  }> {
    try {
      const store = await this.fileStoreService.readStore();
      await stat(this.fileStoreService.getDataFilePath());
      return {
        status: 'up',
        driver: 'file',
        target: this.fileStoreService.getDataFilePath(),
        conversationCount: store.conversations.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown storage error';
      return {
        status: 'down',
        driver: 'file',
        target: this.fileStoreService.getDataFilePath(),
        conversationCount: 0,
        error: message,
      };
    }
  }

  private serializeConversation(conversation: Conversation): SerializedConversation {
    return {
      id: conversation.id,
      scopeKey: conversation.scopeKey,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: conversation.messages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  private deserializeConversation(conversation: SerializedConversation): Conversation {
    return new Conversation({
      id: conversation.id,
      scopeKey: conversation.scopeKey,
      title: conversation.title,
      createdAt: new Date(conversation.createdAt),
      updatedAt: new Date(conversation.updatedAt),
      messages: conversation.messages.map(
        (message) =>
          new Message({
            id: message.id,
            conversationId: message.conversationId,
            role: message.role,
            content: message.content,
            createdAt: new Date(message.createdAt),
          }),
      ),
    });
  }
}
