import { Test } from '@nestjs/testing';

import { HookExecutorService } from './hook-executor.service';
import { HooksService } from './hooks.service';
import { ToolOrchestratorService } from '../tools/core/tool-orchestrator.service';
import { NotifyTool } from '../tools/builtin/system/notify.tool';
import type { WebhookHook, HookFireContext } from './hook.types';

describe('HookExecutorService', () => {
  let executor: HookExecutorService;
  let hooksService: jest.Mocked<HooksService>;
  let toolOrchestrator: jest.Mocked<ToolOrchestratorService>;
  let notifyTool: jest.Mocked<NotifyTool>;

  const mockHook: WebhookHook = {
    id: 'hook-1',
    name: 'github-push',
    description: 'Handle GitHub push events',
    promptTemplate: 'Push to {{payload.repository}} by {{payload.pusher}}: {{payload}}',
    secret: 'supersecret12345678',
    methods: ['POST'],
    status: 'active',
    notifyOnFire: true,
    maxPayloadBytes: 102400,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: '2026-03-26T10:00:00.000Z',
    updatedAt: '2026-03-26T10:00:00.000Z',
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        HookExecutorService,
        {
          provide: HooksService,
          useValue: { setFireHandler: jest.fn() },
        },
        {
          provide: ToolOrchestratorService,
          useValue: {
            completeWithTools: jest.fn().mockResolvedValue({
              content: 'Push analyzed: 3 files changed',
              toolRoundsUsed: 1,
              toolCallLog: [{ name: 'web_fetch' }],
            }),
          },
        },
        {
          provide: NotifyTool,
          useValue: {
            sendNotification: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    executor = module.get(HookExecutorService);
    hooksService = module.get(HooksService) as jest.Mocked<HooksService>;
    toolOrchestrator = module.get(ToolOrchestratorService) as jest.Mocked<ToolOrchestratorService>;
    notifyTool = module.get(NotifyTool) as jest.Mocked<NotifyTool>;
  });

  describe('onModuleInit', () => {
    it('should register fire handler with HooksService', () => {
      executor.onModuleInit();
      expect(hooksService.setFireHandler).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('executeHook (via handler)', () => {
    let handler: (ctx: HookFireContext) => Promise<unknown>;

    beforeEach(() => {
      executor.onModuleInit();
      handler = hooksService.setFireHandler.mock.calls[0]![0];
    });

    it('should interpolate template and call LLM', async () => {
      const ctx: HookFireContext = {
        hook: mockHook,
        payload: '{"repository":"myrepo","pusher":"alice"}',
        parsedPayload: { repository: 'myrepo', pusher: 'alice' },
        headers: { 'x-github-event': 'push' },
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      const result = await handler(ctx);

      expect(toolOrchestrator.completeWithTools).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('myrepo'),
          }),
        ]),
      );

      expect(result).toEqual(
        expect.objectContaining({
          hookName: 'github-push',
          success: true,
          content: 'Push analyzed: 3 files changed',
          toolRoundsUsed: 1,
        }),
      );
    });

    it('should send notification when notifyOnFire=true', async () => {
      const ctx: HookFireContext = {
        hook: mockHook,
        payload: '{}',
        parsedPayload: {},
        headers: {},
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      await handler(ctx);

      expect(notifyTool.sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('github-push'),
        expect.stringContaining('Push analyzed'),
        expect.objectContaining({ actor: 'system', origin: 'hook_executor', correlationId: 'hook-1' }),
      );
    });

    it('should NOT send notification when notifyOnFire=false', async () => {
      const ctx: HookFireContext = {
        hook: { ...mockHook, notifyOnFire: false },
        payload: '{}',
        parsedPayload: {},
        headers: {},
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      await handler(ctx);

      expect(notifyTool.sendNotification).not.toHaveBeenCalled();
    });

    it('should handle LLM errors gracefully', async () => {
      toolOrchestrator.completeWithTools.mockRejectedValue(new Error('LLM timeout'));

      const ctx: HookFireContext = {
        hook: mockHook,
        payload: '{}',
        parsedPayload: {},
        headers: {},
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      const result = await handler(ctx);
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: 'LLM timeout',
        }),
      );

      // Should still try to notify about failure
      expect(notifyTool.sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('github-push'),
        expect.stringContaining('failed'),
        expect.objectContaining({ actor: 'system', origin: 'hook_executor', correlationId: 'hook-1' }),
      );
    });

    it('should interpolate {{method}}, {{source_ip}}, {{hook_name}}', async () => {
      const hookWithMetaPlaceholders: WebhookHook = {
        ...mockHook,
        promptTemplate: 'Method: {{method}}, IP: {{source_ip}}, Hook: {{hook_name}}',
      };

      const ctx: HookFireContext = {
        hook: hookWithMetaPlaceholders,
        payload: '',
        parsedPayload: null,
        headers: {},
        query: {},
        method: 'POST',
        sourceIp: '10.0.0.1',
      };

      await handler(ctx);

      const callArgs = toolOrchestrator.completeWithTools.mock.calls[0]![0];
      const userMessage = callArgs.find((m: { role: string }) => m.role === 'user');
      expect(userMessage?.content).toContain('Method: POST');
      expect(userMessage?.content).toContain('IP: 10.0.0.1');
      expect(userMessage?.content).toContain('Hook: github-push');
    });

    it('should interpolate {{headers.key}}', async () => {
      const hookWithHeaders: WebhookHook = {
        ...mockHook,
        promptTemplate: 'Event: {{headers.x-github-event}}',
      };

      const ctx: HookFireContext = {
        hook: hookWithHeaders,
        payload: '',
        parsedPayload: null,
        headers: { 'x-github-event': 'push' },
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      await handler(ctx);

      const callArgs = toolOrchestrator.completeWithTools.mock.calls[0]![0];
      const userMessage = callArgs.find((m: { role: string }) => m.role === 'user');
      expect(userMessage?.content).toContain('Event: push');
    });

    it('should interpolate {{query.key}}', async () => {
      const hookWithQuery: WebhookHook = {
        ...mockHook,
        promptTemplate: 'Action: {{query.action}}',
      };

      const ctx: HookFireContext = {
        hook: hookWithQuery,
        payload: '',
        parsedPayload: null,
        headers: {},
        query: { action: 'deploy' },
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      await handler(ctx);

      const callArgs = toolOrchestrator.completeWithTools.mock.calls[0]![0];
      const userMessage = callArgs.find((m: { role: string }) => m.role === 'user');
      expect(userMessage?.content).toContain('Action: deploy');
    });

    it('should handle nested payload access', async () => {
      const hookNested: WebhookHook = {
        ...mockHook,
        promptTemplate: 'Repo: {{payload.repo.name}}',
      };

      const ctx: HookFireContext = {
        hook: hookNested,
        payload: '{"repo":{"name":"argus"}}',
        parsedPayload: { repo: { name: 'argus' } },
        headers: {},
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      await handler(ctx);

      const callArgs = toolOrchestrator.completeWithTools.mock.calls[0]![0];
      const userMessage = callArgs.find((m: { role: string }) => m.role === 'user');
      expect(userMessage?.content).toContain('Repo: argus');
    });

    it('should keep unknown placeholders as-is', async () => {
      const hookUnknown: WebhookHook = {
        ...mockHook,
        promptTemplate: 'Unknown: {{unknown_key}}',
      };

      const ctx: HookFireContext = {
        hook: hookUnknown,
        payload: '',
        parsedPayload: null,
        headers: {},
        query: {},
        method: 'POST',
        sourceIp: '1.2.3.4',
      };

      await handler(ctx);

      const callArgs = toolOrchestrator.completeWithTools.mock.calls[0]![0];
      const userMessage = callArgs.find((m: { role: string }) => m.role === 'user');
      expect(userMessage?.content).toContain('{{unknown_key}}');
    });
  });
});
