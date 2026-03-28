import type { LlmToolDefinition } from '../../../llm/interfaces/llm.interface';
import type { ToolDefinition, ToolParameters, ToolParameterSchema } from '../tool.types';

/**
 * Builds the tool description section for the system prompt.
 *
 * For providers with native function calling, this is not needed —
 * tools are passed via the API `tools` parameter.
 *
 * For local/text-based models, this injects tool descriptions into
 * the system prompt and instructs the LLM how to invoke them.
 */
export function buildToolPromptSection(definitions: ToolDefinition[]): string {
  if (definitions.length === 0) return '';

  const toolDescriptions = definitions
    .map((def) => formatToolDefinition(def))
    .join('\n\n');

  return [
    '# Available Tools',
    '',
    'You have access to the following tools. To use a tool, respond with a fenced JSON block:',
    '',
    '```tool_call',
    '{"name": "tool_name", "arguments": {"param": "value"}}',
    '```',
    '',
    'You may call multiple tools at once by using an array:',
    '',
    '```tool_call',
    '[{"name": "tool1", "arguments": {...}}, {"name": "tool2", "arguments": {...}}]',
    '```',
    '',
    'After each tool call, you will receive the tool result and can then formulate your response.',
    'Only use a tool when it genuinely helps answer the user\'s question.',
    'Do NOT fabricate tool results — always call the tool and wait for the actual output.',
    '',
    '---',
    '',
    toolDescriptions,
  ].join('\n');
}

/**
 * Converts tool definitions to OpenAI-compatible `tools` parameter format.
 */
export function toOpenAiToolsParam(definitions: ToolDefinition[]): LlmToolDefinition[] {
  return definitions.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as unknown as Record<string, unknown>,
    },
  }));
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatToolDefinition(def: ToolDefinition): string {
  const params = formatParameters(def.parameters);

  return [
    `## ${def.name}`,
    '',
    def.description,
    '',
    '**Parameters:**',
    params || '_(none)_',
  ].join('\n');
}

function formatParameters(params: ToolParameters, indent = 0): string {
  const entries = Object.entries(params.properties);
  if (entries.length === 0) return '';

  const required = new Set(params.required ?? []);
  const prefix = '  '.repeat(indent);

  return entries
    .map(([name, schema]) => {
      const req = required.has(name) ? ' **(required)**' : '';
      const desc = schema.description ? ` — ${schema.description}` : '';
      const enumValues = schema.enum ? ` (one of: ${schema.enum.join(', ')})` : '';
      const nested = formatNestedSchema(schema, indent + 1);

      return `${prefix}- \`${name}\` (${schema.type})${req}${desc}${enumValues}${nested}`;
    })
    .join('\n');
}

function formatNestedSchema(schema: ToolParameterSchema, indent: number): string {
  if (schema.type === 'object' && schema.properties) {
    const nested = formatParameters(
      { type: 'object', properties: schema.properties, required: schema.required },
      indent,
    );
    return nested ? '\n' + nested : '';
  }

  if (schema.type === 'array' && schema.items) {
    return ` (items: ${schema.items.type})`;
  }

  return '';
}
