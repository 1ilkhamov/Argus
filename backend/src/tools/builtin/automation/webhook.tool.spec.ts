import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { WebhookTool } from './webhook.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import { HooksService } from '../../../hooks/hooks.service';
import type { WebhookHook } from '../../../hooks/hook.types';

describe('WebhookTool', () => {
  let tool: WebhookTool;
  let hooksService: jest.Mocked<HooksService>;
  let registry: jest.Mocked<ToolRegistryService>;

  const mockHook: WebhookHook = {
    id: 'hook-1',
    name: 'github-push',
    description: 'Handle GitHub push events',
    promptTemplate: 'New push to {{payload.repository.full_name}}: {{payload}}',
    secret: 'supersecret12345678',
    methods: ['POST'],
    status: 'active',
    notifyOnFire: true,
    maxPayloadBytes: 102400,
    fireCount: 5,
    lastFiredAt: '2026-03-26T10:00:00.000Z',
    createdAt: '2026-03-25T10:00:00.000Z',
    updatedAt: '2026-03-26T10:00:00.000Z',
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WebhookTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
        {
          provide: HooksService,
          useValue: {
            createHook: jest.fn(),
            listHooks: jest.fn(),
            deleteHook: jest.fn(),
            pauseHook: jest.fn(),
            resumeHook: jest.fn(),
            updateHook: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'hooks.enabled') return true;
              if (key === 'port') return 2901;
              return fallback;
            }),
          },
        },
      ],
    }).compile();

    tool = module.get(WebhookTool);
    hooksService = module.get(HooksService) as jest.Mocked<HooksService>;
    registry = module.get(ToolRegistryService) as jest.Mocked<ToolRegistryService>;
  });

  describe('definition', () => {
    it('should have correct name and parameters', () => {
      expect(tool.definition.name).toBe('webhook');
      expect(tool.definition.parameters.properties).toHaveProperty('action');
      expect(tool.definition.parameters.properties).toHaveProperty('name');
      expect(tool.definition.parameters.properties).toHaveProperty('prompt_template');
      expect(tool.definition.parameters.properties).toHaveProperty('secret');
      expect(tool.definition.parameters.required).toEqual(['action']);
    });
  });

  describe('onModuleInit', () => {
    it('should register with the tool registry', () => {
      tool.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(tool);
    });
  });

  describe('create', () => {
    it('should create a hook with valid params', async () => {
      hooksService.createHook.mockResolvedValue(mockHook);

      const result = await tool.execute({
        action: 'create',
        name: 'github-push',
        description: 'Handle GitHub push events',
        prompt_template: 'New push to {{payload.repository.full_name}}: {{payload}}',
        secret: 'supersecret12345678',
        methods: 'POST',
      });

      expect(result).toContain('Webhook created successfully');
      expect(result).toContain('github-push');
      expect(result).toContain('/api/hooks/github-push');
      expect(hooksService.createHook).toHaveBeenCalledWith({
        name: 'github-push',
        description: 'Handle GitHub push events',
        promptTemplate: 'New push to {{payload.repository.full_name}}: {{payload}}',
        secret: 'supersecret12345678',
        methods: ['POST'],
        notifyOnFire: true,
      });
    });

    it('should require name', async () => {
      const result = await tool.execute({ action: 'create', prompt_template: 'test', secret: 'secret123' });
      expect(result).toContain('Error');
      expect(result).toContain('name');
    });

    it('should require prompt_template', async () => {
      const result = await tool.execute({ action: 'create', name: 'test', secret: 'secret123' });
      expect(result).toContain('Error');
      expect(result).toContain('prompt_template');
    });

    it('should require secret', async () => {
      const result = await tool.execute({ action: 'create', name: 'test', prompt_template: 'test' });
      expect(result).toContain('Error');
      expect(result).toContain('secret');
    });

    it('should handle creation errors', async () => {
      hooksService.createHook.mockImplementationOnce(() => {
        return Promise.reject(new Error('Hook "test" already exists'));
      });

      const result = await tool.execute({
        action: 'create',
        name: 'test-hook',
        prompt_template: 'test prompt',
        secret: 'secret12345678',
      });
      expect(result).toContain('Error');
      expect(result).toContain('already exists');
    });
  });

  describe('list', () => {
    it('should list all hooks', async () => {
      hooksService.listHooks.mockResolvedValue([mockHook]);

      const result = await tool.execute({ action: 'list' });
      expect(result).toContain('1 webhook(s)');
      expect(result).toContain('github-push');
      expect(result).toContain('active');
      expect(result).toContain('5 time(s)');
    });

    it('should handle empty list', async () => {
      hooksService.listHooks.mockResolvedValue([]);

      const result = await tool.execute({ action: 'list' });
      expect(result).toContain('No webhooks configured');
    });
  });

  describe('delete', () => {
    it('should delete an existing hook', async () => {
      hooksService.deleteHook.mockResolvedValue(true);

      const result = await tool.execute({ action: 'delete', id: 'hook-1' });
      expect(result).toContain('deleted');
    });

    it('should report not found', async () => {
      hooksService.deleteHook.mockResolvedValue(false);

      const result = await tool.execute({ action: 'delete', id: 'nonexistent' });
      expect(result).toContain('not found');
    });

    it('should require id', async () => {
      const result = await tool.execute({ action: 'delete' });
      expect(result).toContain('Error');
      expect(result).toContain('id');
    });
  });

  describe('pause / resume', () => {
    it('should pause a hook', async () => {
      hooksService.pauseHook.mockResolvedValue({ ...mockHook, status: 'paused' });

      const result = await tool.execute({ action: 'pause', id: 'hook-1' });
      expect(result).toContain('paused');
    });

    it('should resume a hook', async () => {
      hooksService.resumeHook.mockResolvedValue({ ...mockHook, status: 'active' });

      const result = await tool.execute({ action: 'resume', id: 'hook-1' });
      expect(result).toContain('resumed');
    });
  });

  describe('update', () => {
    it('should update hook fields', async () => {
      hooksService.updateHook.mockResolvedValue({ ...mockHook, description: 'Updated desc' });

      const result = await tool.execute({
        action: 'update',
        id: 'hook-1',
        description: 'Updated desc',
      });
      expect(result).toContain('updated');
    });

    it('should require id for update', async () => {
      const result = await tool.execute({ action: 'update', description: 'test' });
      expect(result).toContain('Error');
      expect(result).toContain('id');
    });

    it('should require at least one field to update', async () => {
      const result = await tool.execute({ action: 'update', id: 'hook-1' });
      expect(result).toContain('Error');
      expect(result).toContain('No fields');
    });
  });

  describe('generate_secret', () => {
    it('should return a hex string', async () => {
      const result = await tool.execute({ action: 'generate_secret' });
      expect(result).toContain('Generated secret');
      // Hex string should be 64 chars (32 bytes * 2)
      const lines = result.split('\n');
      const secretLine = lines[1]!.trim();
      expect(secretLine).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const result = await tool.execute({ action: 'unknown' });
      expect(result).toContain('Unknown action');
    });
  });
});
