import { Conversation } from '../chat/entities/conversation.entity';
import type { Message } from '../chat/entities/message.entity';
import { buildStructuredMemoryTurnReference } from './structured-memory-metadata';
import type { StructuredMemoryTurnReference } from './structured-memory-metadata.types';

export interface PendingManagedMemoryConversation {
  conversation: Conversation;
  userMessages: Message[];
  lastPendingUserMessage?: Message;
}

export function buildPendingManagedMemoryConversation(
  conversation: Conversation,
  lastProcessedUserMessage?: StructuredMemoryTurnReference,
  options: { excludeLatestUserMessage?: boolean } = {},
): PendingManagedMemoryConversation {
  const candidateMessages = [...conversation.messages];
  if (options.excludeLatestUserMessage && candidateMessages[candidateMessages.length - 1]?.role === 'user') {
    candidateMessages.pop();
  }

  const userMessages = candidateMessages.filter(
    (message): message is Message =>
      message.role === 'user' && isMessagePendingForManagedMemory(message, lastProcessedUserMessage),
  );

  return {
    conversation: new Conversation({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: userMessages,
    }),
    userMessages,
    lastPendingUserMessage: userMessages[userMessages.length - 1],
  };
}

export function toManagedMemoryCursor(message?: Message): StructuredMemoryTurnReference | undefined {
  return message ? buildStructuredMemoryTurnReference(message) : undefined;
}

export function isMessagePendingForManagedMemory(
  message: Message,
  lastProcessedUserMessage?: StructuredMemoryTurnReference,
): boolean {
  if (!lastProcessedUserMessage) {
    return true;
  }

  const messageCreatedAt = message.createdAt.toISOString();
  if (messageCreatedAt > lastProcessedUserMessage.createdAt) {
    return true;
  }

  if (messageCreatedAt < lastProcessedUserMessage.createdAt) {
    return false;
  }

  return !(
    message.conversationId === lastProcessedUserMessage.conversationId && message.id === lastProcessedUserMessage.messageId
  );
}
