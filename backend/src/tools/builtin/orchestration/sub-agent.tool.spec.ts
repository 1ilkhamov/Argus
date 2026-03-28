import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { SubAgentTool } from './sub-agent.tool';
import { SubAgentService, type SubAgentResult } from './sub-agent.service';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

describe('SubAgentTool', () => {
  let tool: SubAgentTool;
  let service: jest.Mocked<SubAgentService>;
  let registry: jest.Mocked<ToolRegistryService>;

  const mockResults: SubAgentResult[] = [
    { label: 'task1', success: true, output: 'Result for task 1', durationMs: 500 },
    { label: 'task2', success: true, output: 'Result for task 2', durationMs: 300 },
  ];

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SubAgentTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
        {
          provide: SubAgentService,
          useValue: { runTasks: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, fallback?: unknown) => fallback),
          },
        },
      ],
    }).compile();

    tool = module.get(SubAgentTool);
    service = module.get(SubAgentService) as jest.Mocked<SubAgentService>;
    registry = module.get(ToolRegistryService) as jest.Mocked<ToolRegistryService>;
  });

  describe('definition', () => {
    it('should have correct name and parameters', () => {
      expect(tool.definition.name).toBe('sub_agent');
      expect(tool.definition.parameters.required).toEqual(['action', 'tasks']);
      expect(tool.definition.safety).toBe('moderate');
    });
  });

  describe('onModuleInit', () => {
    it('should register with the tool registry', () => {
      tool.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(tool);
    });
  });

  describe('run', () => {
    it('should run tasks and return formatted results', async () => {
      service.runTasks.mockResolvedValue(mockResults);

      const result = await tool.execute({
        action: 'run',
        tasks: [
          { label: 'task1', prompt: 'Do thing 1' },
          { label: 'task2', prompt: 'Do thing 2' },
        ],
      });

      expect(result).toContain('2/2 tasks succeeded');
      expect(result).toContain('task1');
      expect(result).toContain('Result for task 1');
      expect(result).toContain('task2');
      expect(result).toContain('Result for task 2');
      expect(service.runTasks).toHaveBeenCalledWith(
        [
          { label: 'task1', prompt: 'Do thing 1', context: undefined },
          { label: 'task2', prompt: 'Do thing 2', context: undefined },
        ],
        { useTools: false, maxTokens: undefined, temperature: undefined },
      );
    });

    it('should pass use_tools option', async () => {
      service.runTasks.mockResolvedValue(mockResults);

      await tool.execute({
        action: 'run',
        tasks: [{ label: 't', prompt: 'test' }],
        use_tools: true,
      });

      expect(service.runTasks).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ useTools: true }),
      );
    });

    it('should pass context to tasks', async () => {
      service.runTasks.mockResolvedValue([mockResults[0]!]);

      await tool.execute({
        action: 'run',
        tasks: [{ label: 'task1', prompt: 'Analyze', context: 'Some shared data' }],
      });

      expect(service.runTasks).toHaveBeenCalledWith(
        [{ label: 'task1', prompt: 'Analyze', context: 'Some shared data' }],
        expect.any(Object),
      );
    });

    it('should show failed tasks', async () => {
      service.runTasks.mockResolvedValue([
        { label: 'ok', success: true, output: 'Done', durationMs: 100 },
        { label: 'fail', success: false, output: '', durationMs: 50, error: 'Timeout' },
      ]);

      const result = await tool.execute({
        action: 'run',
        tasks: [
          { label: 'ok', prompt: 'test' },
          { label: 'fail', prompt: 'test' },
        ],
      });

      expect(result).toContain('1/2 tasks succeeded');
      expect(result).toContain('✅');
      expect(result).toContain('❌');
      expect(result).toContain('Timeout');
    });

    it('should show tools used', async () => {
      service.runTasks.mockResolvedValue([
        { label: 'research', success: true, output: 'Found info', durationMs: 2000, toolsUsed: ['web_search', 'web_fetch'] },
      ]);

      const result = await tool.execute({
        action: 'run',
        tasks: [{ label: 'research', prompt: 'Search for X' }],
        use_tools: true,
      });

      expect(result).toContain('web_search, web_fetch');
    });

    it('should require tasks array', async () => {
      const result = await tool.execute({ action: 'run' });
      expect(result).toContain('Error');
      expect(result).toContain('tasks');
    });

    it('should require non-empty tasks', async () => {
      const result = await tool.execute({ action: 'run', tasks: [] });
      expect(result).toContain('Error');
    });

    it('should validate task labels', async () => {
      const result = await tool.execute({
        action: 'run',
        tasks: [{ label: '', prompt: 'test' }],
      });
      expect(result).toContain('Error');
      expect(result).toContain('label');
    });

    it('should validate task prompts', async () => {
      const result = await tool.execute({
        action: 'run',
        tasks: [{ label: 'task1', prompt: '' }],
      });
      expect(result).toContain('Error');
      expect(result).toContain('prompt');
    });

    it('should handle service errors', async () => {
      service.runTasks.mockRejectedValue(new Error('Too many tasks (25, max 20)'));

      const result = await tool.execute({
        action: 'run',
        tasks: [{ label: 't', prompt: 'test' }],
      });
      expect(result).toContain('Error');
      expect(result).toContain('Too many');
    });
  });

  describe('error handling', () => {
    it('should handle unknown action', async () => {
      const result = await tool.execute({ action: 'unknown', tasks: [] });
      expect(result).toContain('Unknown action');
    });
  });
});
