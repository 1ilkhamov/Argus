import { ToolExecutorService } from './tool-executor.service';
import { ToolRegistryService } from '../registry/tool-registry.service';
import { ToolSafetyService, type ToolSafetyDecision } from '../safety/tool-safety.service';
import type { Tool, ToolDefinition, ToolCall, ToolSafetyLevel } from '../tool.types';

const createMockTool = (name: string, executeFn?: () => Promise<string>, safety: ToolSafetyLevel = 'safe'): Tool => ({
  definition: {
    name,
    description: `Mock ${name}`,
    parameters: { type: 'object', properties: {} },
    safety,
    timeoutMs: 5000,
  } as ToolDefinition,
  execute: executeFn ?? jest.fn().mockResolvedValue('result'),
});

const createPermissiveSafety = (): ToolSafetyService =>
  ({ evaluate: jest.fn().mockReturnValue({ allowed: true }) }) as unknown as ToolSafetyService;

const createBlockingSafety = (reason = 'blocked by test'): ToolSafetyService =>
  ({ evaluate: jest.fn().mockReturnValue({ allowed: false, reason }) }) as unknown as ToolSafetyService;

describe('ToolExecutorService', () => {
  let registry: ToolRegistryService;
  let safety: ToolSafetyService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    safety = createPermissiveSafety();
    executor = new ToolExecutorService(registry, safety);
  });

  it('executes a registered tool successfully', async () => {
    registry.register(createMockTool('web_search', async () => 'search result'));
    const call: ToolCall = { id: 'c1', name: 'web_search', arguments: { query: 'test' } };
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.output).toBe('search result');
    expect(result.callId).toBe('c1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error for unknown tool', async () => {
    const call: ToolCall = { id: 'c2', name: 'nonexistent', arguments: {} };
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('catches tool execution errors', async () => {
    registry.register(createMockTool('failing', async () => { throw new Error('boom'); }));
    const call: ToolCall = { id: 'c3', name: 'failing', arguments: {} };
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('times out slow tools', async () => {
    const slowTool = createMockTool('slow', () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve('late'), 10000);
      timer.unref();
    }));
    (slowTool.definition as { timeoutMs: number }).timeoutMs = 50;
    registry.register(slowTool);
    const call: ToolCall = { id: 'c4', name: 'slow', arguments: {} };
    const result = await executor.execute(call);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('executes multiple calls in parallel', async () => {
    registry.register(createMockTool('t1', async () => 'r1'));
    registry.register(createMockTool('t2', async () => 'r2'));
    const calls: ToolCall[] = [
      { id: 'a', name: 't1', arguments: {} },
      { id: 'b', name: 't2', arguments: {} },
    ];
    const results = await executor.executeAll(calls);
    expect(results).toHaveLength(2);
    expect(results[0]!.output).toBe('r1');
    expect(results[1]!.output).toBe('r2');
  });

  // ── Safety enforcement ─────────────────────────────────────────────────────

  it('blocks a tool when safety service denies it', async () => {
    const blockingSafety = createBlockingSafety('Tool "process" is blocked by policy "strict"');
    const blockedExecutor = new ToolExecutorService(registry, blockingSafety);
    registry.register(createMockTool('process', async () => 'should not run', 'dangerous'));

    const call: ToolCall = { id: 'c5', name: 'process', arguments: { action: 'start' } };
    const result = await blockedExecutor.execute(call);

    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked by policy');
    expect(result.output).toBe('');
  });

  it('does not invoke tool.execute when safety blocks', async () => {
    const blockingSafety = createBlockingSafety();
    const blockedExecutor = new ToolExecutorService(registry, blockingSafety);
    const executeFn = jest.fn().mockResolvedValue('nope');
    registry.register(createMockTool('process', executeFn, 'dangerous'));

    const call: ToolCall = { id: 'c6', name: 'process', arguments: {} };
    await blockedExecutor.execute(call);

    expect(executeFn).not.toHaveBeenCalled();
  });

  it('calls safety.evaluate with tool name and safety level', async () => {
    registry.register(createMockTool('file_ops', async () => 'ok', 'moderate'));
    const call: ToolCall = { id: 'c7', name: 'file_ops', arguments: {} };
    await executor.execute(call);

    expect(safety.evaluate).toHaveBeenCalledWith('file_ops', 'moderate');
  });
});
