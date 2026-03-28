/** Supported HTTP methods for webhook endpoints */
export type HookMethod = 'POST' | 'PUT' | 'GET';

/** Hook execution status */
export type HookStatus = 'active' | 'paused';

export interface WebhookHook {
  id: string;
  /** Unique URL-safe name used in the endpoint path: POST /api/hooks/:name */
  name: string;
  /** Human-readable description */
  description: string;
  /**
   * Prompt template sent to the LLM when the hook fires.
   * Supports {{payload}} placeholder for the raw JSON body,
   * {{headers.X-GitHub-Event}} style for header interpolation,
   * and {{query.param}} for query string params.
   */
  promptTemplate: string;
  /** Shared secret — external callers must send this in Authorization header or x-hook-token */
  secret: string;
  /** Allowed HTTP methods (default: POST only) */
  methods: HookMethod[];
  /** Whether the hook is active */
  status: HookStatus;
  /** Whether to send notification after execution (default: true) */
  notifyOnFire: boolean;
  /** Maximum payload size in bytes (default: 100KB) */
  maxPayloadBytes: number;
  /** Number of times this hook has been triggered */
  fireCount: number;
  /** Last time this hook was triggered */
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHookParams {
  name: string;
  description?: string;
  promptTemplate: string;
  secret: string;
  methods?: HookMethod[];
  notifyOnFire?: boolean;
  maxPayloadBytes?: number;
}

export interface UpdateHookParams {
  description?: string;
  promptTemplate?: string;
  secret?: string;
  methods?: HookMethod[];
  status?: HookStatus;
  notifyOnFire?: boolean;
  maxPayloadBytes?: number;
}

/** Context passed to the executor when a hook fires */
export interface HookFireContext {
  hook: WebhookHook;
  /** Raw request body (string) */
  payload: string;
  /** Parsed JSON body (or null if not JSON) */
  parsedPayload: Record<string, unknown> | null;
  /** Request headers (lowercased keys) */
  headers: Record<string, string>;
  /** Query string parameters */
  query: Record<string, string>;
  /** HTTP method used */
  method: string;
  /** Source IP */
  sourceIp: string;
}

/** Result of hook execution */
export interface HookFireResult {
  hookName: string;
  success: boolean;
  /** LLM response content */
  content: string;
  /** Number of tool rounds used */
  toolRoundsUsed: number;
  /** Duration in ms */
  durationMs: number;
  error?: string;
}
