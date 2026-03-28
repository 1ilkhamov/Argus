// ─── Action Log Types ──────────────────────────────────────────────────────

/** Describes a tool/action invocation by the agent. */
export interface ActionLogEntry {
  /** Tool or action name (e.g. 'web_search', 'code_execute', 'memory_store'). */
  toolName: string;

  /** Serialized input arguments. */
  args: Record<string, unknown>;

  /** Result summary (truncated if needed). */
  result: string;

  /** Whether the action succeeded. */
  success: boolean;

  /** Error message if action failed. */
  error?: string;

  /** Duration in milliseconds. */
  durationMs?: number;

  /** Conversation context. */
  conversationId?: string;
  messageId?: string;

  /** Tenant scope key for memory isolation. */
  scopeKey?: string;
}

/** Result of action logging — the created MemoryEntry ids. */
export interface ActionLogResult {
  actionEntryId: string;
  learningEntryId?: string;
}

/** LLM reflection output after an action. */
export interface ActionReflection {
  outcome: string;        // что получилось
  issues?: string;        // что пошло не так
  learning?: string;      // какой вывод
  skillUpdate?: string;   // нужно ли обновить навыки/знания
}

/** Session reflection output. */
export interface SessionReflectionResult {
  summary: string;
  keyDecisions: string[];
  openQuestions: string[];
  learnings: string[];
  createdEntryIds: string[];
}
