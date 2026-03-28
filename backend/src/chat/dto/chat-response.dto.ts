export interface MessageResponseDto {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ConversationResponseDto {
  id: string;
  title: string;
  messages: MessageResponseDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationPreviewDto {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatResponseDto {
  conversationId: string;
  message: MessageResponseDto;
}

export interface StreamEventDto {
  event: 'token' | 'done' | 'error' | 'transcription' | 'tool_start' | 'tool_end';
  data: string;
  conversationId?: string;
  messageId?: string;
  /** Tool name (present on tool_start and tool_end events) */
  toolName?: string;
  /** Tool execution duration in ms (present on tool_end) */
  toolDurationMs?: number;
  /** Whether the tool succeeded (present on tool_end) */
  toolSuccess?: boolean;
}

export interface VoiceChatResponseDto {
  conversationId: string;
  transcription: string;
  transcriptionDurationMs: number;
  message: MessageResponseDto;
}
