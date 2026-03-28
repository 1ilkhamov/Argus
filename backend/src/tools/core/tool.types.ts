// ─── Tool System Core Types ──────────────────────────────────────────────────

/**
 * Safety level determines whether a tool can be auto-executed.
 * - safe: auto-execute, no side-effects (e.g. datetime, web_search)
 * - moderate: auto-execute but log prominently (e.g. read_file)
 * - dangerous: requires explicit user approval (e.g. run_command, write_file)
 */
export type ToolSafetyLevel = 'safe' | 'moderate' | 'dangerous';

/**
 * JSON Schema subset for tool parameter definitions.
 */
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
}

/**
 * Describes a tool's parameters in OpenAI-compatible format.
 */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterSchema>;
  required?: string[];
}

/**
 * Static definition of a tool — what it does, what parameters it accepts.
 */
export interface ToolDefinition {
  /** Unique tool name (snake_case, e.g. "web_search") */
  name: string;

  /** Human-readable description for the LLM */
  description: string;

  /** Parameter schema (OpenAI function calling format) */
  parameters: ToolParameters;

  /** Safety classification */
  safety: ToolSafetyLevel;

  /** Maximum execution time in milliseconds */
  timeoutMs?: number;
}

/**
 * A tool call requested by the LLM.
 */
export interface ToolCall {
  /** Unique call ID (for matching results back) */
  id: string;

  /** Tool name */
  name: string;

  /** Parsed arguments */
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a tool.
 */
export interface ToolResult {
  /** Matching call ID */
  callId: string;

  /** Tool name */
  name: string;

  /** Whether execution succeeded */
  success: boolean;

  /** Output content (stringified for LLM consumption) */
  output: string;

  /** Execution duration in milliseconds */
  durationMs: number;

  /** Error message if failed */
  error?: string;
}

/**
 * Execution context passed through the tool pipeline.
 * Carries tenant scope and provenance for memory/logging operations.
 */
export interface ToolExecutionContext {
  /** Tenant scope key (e.g. "key:62af8704764faf8e" or "local:default") */
  scopeKey?: string;
  /** Tool names to exclude from this execution (won't be visible to LLM) */
  excludeTools?: string[];
  /** Active conversation ID for provenance tracking */
  conversationId?: string;
  /** Active message ID for provenance tracking */
  messageId?: string;
  /** Arbitrary key-value metadata for tools (e.g. sourceChatId, sourceChatTitle) */
  meta?: Record<string, string>;
}

/**
 * Interface that every tool implementation must satisfy.
 */
export interface Tool {
  /** Static definition */
  readonly definition: ToolDefinition;

  /**
   * Execute the tool with validated arguments.
   * Must return a string suitable for LLM consumption.
   * Context carries tenant scope and provenance — tools that access
   * memory or external state should use it for proper isolation.
   */
  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string>;
}

/** Maximum number of tool call rounds per single user turn */
export const MAX_TOOL_ROUNDS = 5;

/** Default tool execution timeout */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
