import {
  parseNativeToolCalls,
  parseTextToolCalls,
  stripToolCallBlocks,
} from './tool-call.parser';

describe('parseNativeToolCalls', () => {
  it('parses OpenAI format', () => {
    const raw = [
      {
        id: 'call_1',
        function: { name: 'web_search', arguments: '{"query":"test"}' },
      },
    ];
    const result = parseNativeToolCalls(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('call_1');
    expect(result[0]!.name).toBe('web_search');
    expect(result[0]!.arguments).toEqual({ query: 'test' });
  });

  it('parses Anthropic format', () => {
    const raw = [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'web_search',
        input: { query: 'test' },
      },
    ];
    const result = parseNativeToolCalls(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('web_search');
    expect(result[0]!.arguments).toEqual({ query: 'test' });
  });

  it('handles malformed arguments gracefully', () => {
    const raw = [
      {
        id: 'call_2',
        function: { name: 'web_search', arguments: 'not-json' },
      },
    ];
    const result = parseNativeToolCalls(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.arguments).toEqual({});
  });

  it('skips items without function name', () => {
    const raw = [
      { id: 'call_3', function: { arguments: '{}' } },
      { id: 'call_4' },
    ];
    const result = parseNativeToolCalls(raw);
    expect(result).toHaveLength(0);
  });
});

describe('parseTextToolCalls', () => {
  it('parses fenced tool_call block', () => {
    const content = 'Let me search for that.\n\n```tool_call\n{"name": "web_search", "arguments": {"query": "NestJS"}}\n```';
    const result = parseTextToolCalls(content);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('web_search');
    expect(result[0]!.arguments).toEqual({ query: 'NestJS' });
  });

  it('parses fenced tool_calls array', () => {
    const content = '```tool_calls\n[{"name": "web_search", "arguments": {"query": "a"}}, {"name": "web_search", "arguments": {"query": "b"}}]\n```';
    const result = parseTextToolCalls(content);
    expect(result).toHaveLength(2);
  });

  it('parses json fenced block', () => {
    const content = '```json\n{"name": "web_search", "arguments": {"query": "test"}}\n```';
    const result = parseTextToolCalls(content);
    expect(result).toHaveLength(1);
  });

  it('returns empty for plain text', () => {
    const content = 'This is a normal response without any tool calls.';
    const result = parseTextToolCalls(content);
    expect(result).toHaveLength(0);
  });

  it('returns empty for malformed JSON in fenced block', () => {
    const content = '```tool_call\n{not valid json}\n```';
    const result = parseTextToolCalls(content);
    expect(result).toHaveLength(0);
  });
});

describe('stripToolCallBlocks', () => {
  it('removes fenced tool_call blocks', () => {
    const content = 'Let me search.\n\n```tool_call\n{"name": "web_search", "arguments": {}}\n```\n\nDone.';
    const result = stripToolCallBlocks(content);
    expect(result).toBe('Let me search.\n\nDone.');
  });

  it('preserves content without tool blocks', () => {
    const content = 'Just a normal response.';
    expect(stripToolCallBlocks(content)).toBe(content);
  });
});
