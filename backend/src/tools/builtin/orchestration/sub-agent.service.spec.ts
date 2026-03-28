import { Test } from '@nestjs/testing';

import { SubAgentService } from './sub-agent.service';
import { LlmService } from '../../../llm/llm.service';
import { ToolOrchestratorService } from '../../core/tool-orchestrator.service';

describe('SubAgentService', () => {
  let service: SubAgentService;
  let llmService: jest.Mocked<LlmService>;
  let orchestrator: jest.Mocked<ToolOrchestratorService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SubAgentService,
        {
          provide: LlmService,
          useValue: {
            complete: jest.fn().mockResolvedValue({
              content: 'LLM response',
              model: 'test',
              usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
              finishReason: 'stop',
            }),
          },
        },
        {
          provide: ToolOrchestratorService,
          useValue: {
            completeWithTools: jest.fn().mockResolvedValue({
              content: 'Tool-augmented response',
              messages: [],
              toolRoundsUsed: 1,
              toolCallLog: [{ name: 'web_search', success: true, durationMs: 500 }],
            }),
          },
        },
      ],
    }).compile();

    service = module.get(SubAgentService);
    llmService = module.get(LlmService) as jest.Mocked<LlmService>;
    orchestrator = module.get(ToolOrchestratorService) as jest.Mocked<ToolOrchestratorService>;
  });

  describe('runTasks', () => {
    it('should run tasks in parallel without tools', async () => {
      const results = await service.runTasks([
        { label: 'task1', prompt: 'Do thing 1' },
        { label: 'task2', prompt: 'Do thing 2' },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]!.label).toBe('task1');
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.output).toBe('LLM response');
      expect(results[1]!.label).toBe('task2');
      expect(llmService.complete).toHaveBeenCalledTimes(2);
      expect(orchestrator.completeWithTools).not.toHaveBeenCalled();
    });

    it('should run tasks with tools when useTools=true', async () => {
      const results = await service.runTasks(
        [{ label: 'research', prompt: 'Search for X' }],
        { useTools: true },
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.output).toBe('Tool-augmented response');
      expect(results[0]!.toolsUsed).toEqual(['web_search']);
      expect(orchestrator.completeWithTools).toHaveBeenCalledTimes(1);
      expect(llmService.complete).not.toHaveBeenCalled();
    });

    it('should include context in system message', async () => {
      await service.runTasks([
        { label: 'task', prompt: 'Analyze', context: 'Important data here' },
      ]);

      const call = llmService.complete.mock.calls[0]!;
      const systemMsg = call[0][0]!;
      expect(systemMsg.content).toContain('Important data here');
    });

    it('should handle LLM errors gracefully', async () => {
      llmService.complete
        .mockResolvedValueOnce({
          content: 'OK result',
          model: 'test',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: 'stop',
        })
        .mockRejectedValueOnce(new Error('Rate limit exceeded'));

      const results = await service.runTasks([
        { label: 'ok', prompt: 'test' },
        { label: 'fail', prompt: 'test' },
      ]);

      expect(results).toHaveLength(2);
      const ok = results.find((r) => r.label === 'ok')!;
      const fail = results.find((r) => r.label === 'fail')!;
      expect(ok.success).toBe(true);
      expect(fail.success).toBe(false);
      expect(fail.error).toContain('Rate limit');
    });

    it('should return empty array for empty tasks', async () => {
      const results = await service.runTasks([]);
      expect(results).toEqual([]);
    });

    it('should throw for too many tasks', async () => {
      const tasks = Array.from({ length: 21 }, (_, i) => ({
        label: `task${i}`,
        prompt: 'test',
      }));

      await expect(service.runTasks(tasks)).rejects.toThrow('Too many tasks');
    });

    it('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      llmService.complete.mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return {
          content: 'done',
          model: 'test',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        };
      });

      const tasks = Array.from({ length: 10 }, (_, i) => ({
        label: `task${i}`,
        prompt: 'test',
      }));

      await service.runTasks(tasks, { concurrency: 3 });

      // Should never exceed concurrency of 3 (capped to DEFAULT_CONCURRENCY=5, but we set 3)
      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(llmService.complete).toHaveBeenCalledTimes(10);
    });

    it('should pass maxTokens and temperature options', async () => {
      await service.runTasks(
        [{ label: 'task', prompt: 'test' }],
        { maxTokens: 4096, temperature: 0.7 },
      );

      expect(llmService.complete).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ maxTokens: 4096, temperature: 0.7 }),
      );
    });

    it('should track duration for each task', async () => {
      llmService.complete.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return {
          content: 'done',
          model: 'test',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        };
      });

      const results = await service.runTasks([
        { label: 'task', prompt: 'test' },
      ]);

      expect(results[0]!.durationMs).toBeGreaterThanOrEqual(20);
    });
  });
});
