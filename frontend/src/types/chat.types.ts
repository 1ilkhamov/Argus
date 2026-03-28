export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationPreview {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SendMessageRequest {
  content: string;
  conversationId?: string;
}

export interface ChatResponse {
  conversationId: string;
  message: Message;
}

export interface StreamEvent {
  event: 'token' | 'done' | 'error' | 'transcription' | 'tool_start' | 'tool_end';
  data?: string;
  conversationId?: string;
  messageId?: string;
  toolName?: string;
  toolDurationMs?: number;
  toolSuccess?: boolean;
}

export interface ToolCallStatus {
  name: string;
  startedAt: number;
  durationMs?: number;
  success?: boolean;
  done: boolean;
}
