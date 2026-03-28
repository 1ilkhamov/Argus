/** A single part of multimodal message content (text or image). */
export interface LlmContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

/** Extract plain text from content (handles both string and multimodal parts). */
export function getTextContent(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n');
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text or multimodal content parts (for vision). */
  content: string | LlmContentPart[];
  /** Tool call ID — required when role is 'tool' (matches the call that produced this result) */
  toolCallId?: string;
  /** Tool name — set when role is 'tool' */
  name?: string;
  /** Tool calls made by the assistant — required on assistant messages that triggered tool execution */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
  /** Tool definitions in OpenAI-compatible format */
  tools?: LlmToolDefinition[];
  /** 'auto' (default) | 'none' | 'required' */
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface LlmToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmCompletionResult {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
  /** Tool calls requested by the model (present when finishReason is 'tool_calls') */
  toolCalls?: LlmToolCall[];
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
  /** Tool calls accumulated during streaming (only present on final chunk) */
  toolCalls?: LlmToolCall[];
  /** Tool execution status event (emitted by orchestrator during tool rounds) */
  toolEvent?: {
    type: 'tool_start' | 'tool_end';
    name: string;
    /** Duration in ms (only on tool_end) */
    durationMs?: number;
    /** Whether tool succeeded (only on tool_end) */
    success?: boolean;
  };
}
