import type { ToolCall } from '../tool.types';

/**
 * Parses tool calls from LLM output.
 *
 * Supports two formats:
 * 1. Native OpenAI-compatible tool_calls (structured JSON from API)
 * 2. Text-based fallback for local models that emit JSON in content
 *
 * The text-based parser looks for a fenced JSON block:
 * ```tool_call
 * {"name": "web_search", "arguments": {"query": "..."}}
 * ```
 * or an array of such objects.
 */

/** Raw tool call shape from OpenAI-compatible API */
export interface RawToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  // Anthropic format
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Parse tool calls from native API response (OpenAI / Anthropic).
 */
export function parseNativeToolCalls(raw: RawToolCall[]): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const item of raw) {
    // OpenAI format: { id, function: { name, arguments } }
    if (item.function?.name) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(item.function.arguments ?? '{}');
      } catch {
        // malformed arguments — keep empty
      }

      calls.push({
        id: item.id ?? generateCallId(),
        name: item.function.name,
        arguments: args,
      });
      continue;
    }

    // Anthropic format: { type: "tool_use", id, name, input }
    if (item.type === 'tool_use' && item.name) {
      calls.push({
        id: item.id ?? generateCallId(),
        name: item.name,
        arguments: item.input ?? {},
      });
    }
  }

  return calls;
}

/**
 * Parse tool calls from text content (for local LLMs without native function calling).
 *
 * Looks for:
 *   ```tool_call\n{...}\n```
 *   ```tool_calls\n[{...}]\n```
 *   or inline JSON blocks starting with {"name": "...", "arguments": ...}
 */
export function parseTextToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Pattern 1: fenced code block with tool_call(s) language tag
  const fencedPattern = /```(?:tool_calls?|json)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencedPattern.exec(content)) !== null) {
    const parsed = tryParseToolCallJson(match[1]!.trim());
    calls.push(...parsed);
  }

  if (calls.length > 0) return calls;

  // Pattern 2: standalone JSON object/array with "name" and "arguments" keys
  const jsonPattern = /(\{[\s\S]*?"name"\s*:\s*"[^"]+?"[\s\S]*?"arguments"\s*:[\s\S]*?\})/g;

  while ((match = jsonPattern.exec(content)) !== null) {
    const parsed = tryParseToolCallJson(match[1]!.trim());
    calls.push(...parsed);
  }

  return calls;
}

/**
 * Strips tool call blocks from text content, returning the "clean" text
 * that the user should see.
 */
export function stripToolCallBlocks(content: string): string {
  return content
    .replace(/```(?:tool_calls?|json)\s*\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryParseToolCallJson(raw: string): ToolCall[] {
  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed
        .filter(isToolCallShape)
        .map((item) => ({
          id: item.id ?? generateCallId(),
          name: item.name,
          arguments: item.arguments ?? {},
        }));
    }

    if (isToolCallShape(parsed)) {
      return [{
        id: parsed.id ?? generateCallId(),
        name: parsed.name,
        arguments: parsed.arguments ?? {},
      }];
    }
  } catch {
    // not valid JSON
  }

  return [];
}

function isToolCallShape(value: unknown): value is { id?: string; name: string; arguments?: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}

let callIdCounter = 0;

function generateCallId(): string {
  callIdCounter += 1;
  return `call_${Date.now()}_${callIdCounter}`;
}
