import { ToolRegistryService } from './tool-registry.service';
import type { ToolSafetyService } from '../safety/tool-safety.service';
import type { Tool, ToolDefinition, ToolSafetyLevel } from '../tool.types';

const createMockTool = (name: string, safety: ToolSafetyLevel = 'safe'): Tool => ({
  definition: {
    name,
    description: `Mock ${name} tool`,
    parameters: { type: 'object', properties: {} },
    safety,
  } as ToolDefinition,
  execute: jest.fn().mockResolvedValue('mock result'),
});

describe('ToolRegistryService', () => {
  let registry: ToolRegistryService;

  beforeEach(() => {
    registry = new ToolRegistryService();
  });

  it('registers a tool and retrieves it by name', () => {
    const tool = createMockTool('web_search');
    registry.register(tool);
    expect(registry.get('web_search')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('throws on duplicate registration', () => {
    const tool = createMockTool('web_search');
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow('already registered');
  });

  it('returns undefined for unknown tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('returns all definitions when no safety service is set', () => {
    registry.register(createMockTool('tool_a'));
    registry.register(createMockTool('tool_b'));
    const definitions = registry.getDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions.map((d) => d.name)).toEqual(['tool_a', 'tool_b']);
  });

  it('returns all names', () => {
    registry.register(createMockTool('x'));
    registry.register(createMockTool('y'));
    expect(registry.getNames()).toEqual(['x', 'y']);
  });

  // ── Safety-filtered getDefinitions ─────────────────────────────────────────

  it('filters definitions through safety service when set', () => {
    const mockSafety: ToolSafetyService = {
      isVisible: jest.fn((name: string, level: ToolSafetyLevel) => level === 'safe'),
    } as unknown as ToolSafetyService;

    registry.setSafetyService(mockSafety);
    registry.register(createMockTool('safe_tool', 'safe'));
    registry.register(createMockTool('moderate_tool', 'moderate'));
    registry.register(createMockTool('dangerous_tool', 'dangerous'));

    const definitions = registry.getDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.name).toBe('safe_tool');
  });

  it('returns all definitions when safety service allows everything', () => {
    const mockSafety: ToolSafetyService = {
      isVisible: jest.fn().mockReturnValue(true),
    } as unknown as ToolSafetyService;

    registry.setSafetyService(mockSafety);
    registry.register(createMockTool('a', 'safe'));
    registry.register(createMockTool('b', 'moderate'));
    registry.register(createMockTool('c', 'dangerous'));

    expect(registry.getDefinitions()).toHaveLength(3);
  });
});
