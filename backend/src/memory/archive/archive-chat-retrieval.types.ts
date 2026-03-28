export interface ArchivedChatMessageHit {
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  conversationUpdatedAt: string;
  matchCount: number;
}

export interface ArchivedChatEvidenceItem {
  conversationId: string;
  messageId: string;
  createdAt: string;
  role: 'user' | 'assistant';
  excerpt: string;
  score: number;
}

export interface ArchivedChatSearchRequest {
  scopeKey?: string;
  tokens: string[];
  excludeConversationId?: string;
  limit: number;
}
