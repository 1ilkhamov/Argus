import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { ProcessTool } from './process.tool';
import { ProcessManagerService, type ProcessInfo } from './process-manager.service';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

describe('ProcessTool', () => {
  let tool: ProcessTool;
  let manager: jest.Mocked<ProcessManagerService>;
  let registry: jest.Mocked<ToolRegistryService>;

  const mockInfo: ProcessInfo = {
    id: 'abc12345',
    command: 'npm run dev',
    cwd: '/workspace',
    pid: 9999,
    startedAt: '2026-03-26T10:00:00.000Z',
    status: 'running',
    exitCode: null,
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ProcessTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
        {
          provide: ProcessManagerService,
          useValue: {
            start: jest.fn(),
            poll: jest.fn(),
            send: jest.fn(),
            kill: jest.fn(),
            list: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'tools.systemRun.enabled') return true;
              return fallback;
            }),
          },
        },
      ],
    }).compile();

    tool = module.get(ProcessTool);
    manager = module.get(ProcessManagerService) as jest.Mocked<ProcessManagerService>;
    registry = module.get(ToolRegistryService) as jest.Mocked<ToolRegistryService>;
  });

  describe('definition', () => {
    it('should have correct name and parameters', () => {
      expect(tool.definition.name).toBe('process');
      expect(tool.definition.parameters.properties).toHaveProperty('action');
      expect(tool.definition.parameters.required).toEqual(['action']);
      expect(tool.definition.safety).toBe('dangerous');
    });
  });

  describe('onModuleInit', () => {
    it('should register with the tool registry', () => {
      tool.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(tool);
    });
  });

  describe('start', () => {
    it('should start a background process', async () => {
      manager.start.mockReturnValue(mockInfo);

      const result = await tool.execute({
        action: 'start',
        command: 'npm run dev',
        working_directory: '/workspace',
      });

      expect(result).toContain('Process started');
      expect(result).toContain('abc12345');
      expect(result).toContain('9999');
      expect(result).toContain('npm run dev');
      expect(manager.start).toHaveBeenCalledWith('npm run dev', '/workspace');
    });

    it('should require command', async () => {
      const result = await tool.execute({ action: 'start' });
      expect(result).toContain('Error');
      expect(result).toContain('command');
    });

    it('should handle start errors', async () => {
      manager.start.mockImplementation(() => {
        throw new Error('Too many background processes (max 10)');
      });

      const result = await tool.execute({ action: 'start', command: 'npm start' });
      expect(result).toContain('Error');
      expect(result).toContain('Too many');
    });
  });

  describe('poll', () => {
    it('should return new output', async () => {
      manager.poll.mockReturnValue({
        info: mockInfo,
        stdout: 'Server listening on port 3000',
        stderr: '',
      });

      const result = await tool.execute({ action: 'poll', id: 'abc12345' });
      expect(result).toContain('abc12345');
      expect(result).toContain('running');
      expect(result).toContain('Server listening on port 3000');
    });

    it('should show no new output message', async () => {
      manager.poll.mockReturnValue({
        info: mockInfo,
        stdout: '',
        stderr: '',
      });

      const result = await tool.execute({ action: 'poll', id: 'abc12345' });
      expect(result).toContain('no new output');
    });

    it('should require id', async () => {
      const result = await tool.execute({ action: 'poll' });
      expect(result).toContain('Error');
      expect(result).toContain('id');
    });

    it('should show exit code for exited process', async () => {
      manager.poll.mockReturnValue({
        info: { ...mockInfo, status: 'exited', exitCode: 0 },
        stdout: 'Build complete',
        stderr: '',
      });

      const result = await tool.execute({ action: 'poll', id: 'abc12345' });
      expect(result).toContain('exited');
      expect(result).toContain('exit code: 0');
    });
  });

  describe('send', () => {
    it('should send input to stdin', async () => {
      const result = await tool.execute({
        action: 'send',
        id: 'abc12345',
        input: 'print("hello")',
      });

      expect(result).toContain('Sent to process abc12345');
      expect(result).toContain('print("hello")');
      expect(manager.send).toHaveBeenCalledWith('abc12345', 'print("hello")');
    });

    it('should require id', async () => {
      const result = await tool.execute({ action: 'send', input: 'test' });
      expect(result).toContain('Error');
      expect(result).toContain('id');
    });

    it('should require input', async () => {
      const result = await tool.execute({ action: 'send', id: 'abc12345' });
      expect(result).toContain('Error');
      expect(result).toContain('input');
    });

    it('should handle send to exited process', async () => {
      manager.send.mockImplementation(() => {
        throw new Error('Process abc12345 is not running (status=exited)');
      });

      const result = await tool.execute({
        action: 'send',
        id: 'abc12345',
        input: 'test',
      });
      expect(result).toContain('Error');
      expect(result).toContain('not running');
    });
  });

  describe('kill', () => {
    it('should kill a process', async () => {
      manager.kill.mockReturnValue(mockInfo);

      const result = await tool.execute({ action: 'kill', id: 'abc12345' });
      expect(result).toContain('SIGTERM');
      expect(result).toContain('abc12345');
      expect(manager.kill).toHaveBeenCalledWith('abc12345', 'SIGTERM');
    });

    it('should support SIGKILL', async () => {
      manager.kill.mockReturnValue(mockInfo);

      await tool.execute({ action: 'kill', id: 'abc12345', signal: 'SIGKILL' });
      expect(manager.kill).toHaveBeenCalledWith('abc12345', 'SIGKILL');
    });

    it('should require id', async () => {
      const result = await tool.execute({ action: 'kill' });
      expect(result).toContain('Error');
      expect(result).toContain('id');
    });
  });

  describe('list', () => {
    it('should list processes', async () => {
      manager.list.mockReturnValue([
        mockInfo,
        { ...mockInfo, id: 'def67890', command: 'python server.py', status: 'exited', exitCode: 0 },
      ]);

      const result = await tool.execute({ action: 'list' });
      expect(result).toContain('2 managed process');
      expect(result).toContain('abc12345');
      expect(result).toContain('def67890');
      expect(result).toContain('npm run dev');
      expect(result).toContain('python server.py');
    });

    it('should handle empty list', async () => {
      manager.list.mockReturnValue([]);

      const result = await tool.execute({ action: 'list' });
      expect(result).toContain('No background processes');
    });
  });

  describe('error handling', () => {
    it('should handle unknown action', async () => {
      const result = await tool.execute({ action: 'bogus' });
      expect(result).toContain('Unknown action');
    });

    it('should handle process not found', async () => {
      manager.poll.mockImplementation(() => {
        throw new Error('Process "xyz" not found');
      });

      const result = await tool.execute({ action: 'poll', id: 'xyz' });
      expect(result).toContain('Error');
      expect(result).toContain('not found');
    });
  });
});
