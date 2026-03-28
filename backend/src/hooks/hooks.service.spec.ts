import { Test } from '@nestjs/testing';

import { HooksService, HookNotFoundError, HookPausedError, HookMethodNotAllowedError, HookAuthError, HookPayloadTooLargeError } from './hooks.service';
import { HookRepository } from './hook.repository';
import type { WebhookHook, HookFireContext, HookFireResult } from './hook.types';

describe('HooksService', () => {
  let service: HooksService;
  let repo: jest.Mocked<HookRepository>;

  const mockHook: WebhookHook = {
    id: 'hook-1',
    name: 'github-push',
    description: 'Handle GitHub push events',
    promptTemplate: 'Push event: {{payload}}',
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
        HooksService,
        {
          provide: HookRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            findByName: jest.fn(),
            findAll: jest.fn(),
            findActive: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            recordFire: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(HooksService);
    repo = module.get(HookRepository) as jest.Mocked<HookRepository>;
  });

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  describe('createHook', () => {
    it('should create a hook with valid params', async () => {
      repo.findByName.mockResolvedValue(undefined);
      repo.findAll.mockResolvedValue([]);
      repo.create.mockResolvedValue(mockHook);

      const result = await service.createHook({
        name: 'github-push',
        promptTemplate: 'Push event: {{payload}}',
        secret: 'supersecret12345678',
      });

      expect(result).toEqual(mockHook);
      expect(repo.create).toHaveBeenCalled();
    });

    it('should reject invalid hook name', async () => {
      await expect(
        service.createHook({ name: 'A B C', promptTemplate: 'test', secret: 'secret12345678' }),
      ).rejects.toThrow('Invalid hook name');
    });

    it('should reject too short name', async () => {
      await expect(
        service.createHook({ name: 'ab', promptTemplate: 'test', secret: 'secret12345678' }),
      ).rejects.toThrow('Invalid hook name');
    });

    it('should reject duplicate name', async () => {
      repo.findByName.mockResolvedValue(mockHook);

      await expect(
        service.createHook({ name: 'github-push', promptTemplate: 'test', secret: 'secret12345678' }),
      ).rejects.toThrow('already exists');
    });

    it('should reject too short secret', async () => {
      repo.findByName.mockResolvedValue(undefined);
      repo.findAll.mockResolvedValue([]);

      await expect(
        service.createHook({ name: 'test-hook', promptTemplate: 'test', secret: 'short' }),
      ).rejects.toThrow('at least 8 characters');
    });

    it('should reject empty prompt template', async () => {
      repo.findByName.mockResolvedValue(undefined);
      repo.findAll.mockResolvedValue([]);

      await expect(
        service.createHook({ name: 'test-hook', promptTemplate: '   ', secret: 'secret12345678' }),
      ).rejects.toThrow('cannot be empty');
    });

    it('should reject invalid methods', async () => {
      repo.findByName.mockResolvedValue(undefined);
      repo.findAll.mockResolvedValue([]);

      await expect(
        service.createHook({
          name: 'test-hook',
          promptTemplate: 'test',
          secret: 'secret12345678',
          methods: ['DELETE' as 'POST'],
        }),
      ).rejects.toThrow('Invalid method');
    });

    it('should enforce max hooks limit', async () => {
      repo.findByName.mockResolvedValue(undefined);
      repo.findAll.mockResolvedValue(Array(100).fill(mockHook));

      await expect(
        service.createHook({ name: 'test-hook', promptTemplate: 'test', secret: 'secret12345678' }),
      ).rejects.toThrow('Maximum number of hooks');
    });
  });

  describe('listHooks', () => {
    it('should return all hooks', async () => {
      repo.findAll.mockResolvedValue([mockHook]);
      const result = await service.listHooks();
      expect(result).toEqual([mockHook]);
    });
  });

  describe('deleteHook', () => {
    it('should delete existing hook', async () => {
      repo.delete.mockResolvedValue(true);
      expect(await service.deleteHook('hook-1')).toBe(true);
    });

    it('should return false for non-existent hook', async () => {
      repo.delete.mockResolvedValue(false);
      expect(await service.deleteHook('nope')).toBe(false);
    });
  });

  describe('pauseHook / resumeHook', () => {
    it('should pause a hook', async () => {
      repo.findById.mockResolvedValue(mockHook);
      repo.update.mockResolvedValue(undefined);

      const result = await service.pauseHook('hook-1');
      expect(result?.status).toBe('paused');
      expect(repo.update).toHaveBeenCalledWith('hook-1', { status: 'paused' });
    });

    it('should resume a hook', async () => {
      repo.findById.mockResolvedValue({ ...mockHook, status: 'paused' });
      repo.update.mockResolvedValue(undefined);

      const result = await service.resumeHook('hook-1');
      expect(result?.status).toBe('active');
      expect(repo.update).toHaveBeenCalledWith('hook-1', { status: 'active' });
    });

    it('should return undefined for non-existent hook', async () => {
      repo.findById.mockResolvedValue(undefined);
      expect(await service.pauseHook('nope')).toBeUndefined();
    });
  });

  describe('updateHook', () => {
    it('should update hook fields', async () => {
      const updated = { ...mockHook, description: 'New desc' };
      repo.findById.mockResolvedValueOnce(mockHook).mockResolvedValueOnce(updated);
      repo.update.mockResolvedValue(undefined);

      const result = await service.updateHook('hook-1', { description: 'New desc' });
      expect(result?.description).toBe('New desc');
    });

    it('should reject too short secret on update', async () => {
      repo.findById.mockResolvedValue(mockHook);

      await expect(
        service.updateHook('hook-1', { secret: 'short' }),
      ).rejects.toThrow('at least 8 characters');
    });
  });

  // ─── Fire ──────────────────────────────────────────────────────────────────

  describe('fireHook', () => {
    let fireHandler: jest.Mock<Promise<HookFireResult>, [HookFireContext]>;

    beforeEach(() => {
      fireHandler = jest.fn<Promise<HookFireResult>, [HookFireContext]>().mockResolvedValue({
        hookName: 'github-push',
        success: true,
        content: 'Processed',
        toolRoundsUsed: 0,
        durationMs: 100,
      });
      service.setFireHandler(fireHandler);
    });

    it('should fire a valid hook', async () => {
      repo.findByName.mockResolvedValue(mockHook);
      repo.recordFire.mockResolvedValue(undefined);

      const result = await service.fireHook(
        'github-push', 'POST', '{"ref":"main"}',
        { 'content-type': 'application/json' }, {}, '1.2.3.4',
        'supersecret12345678',
      );

      expect(result.success).toBe(true);
      expect(result.hookName).toBe('github-push');
      expect(repo.recordFire).toHaveBeenCalledWith('hook-1');
      expect(fireHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          hook: mockHook,
          payload: '{"ref":"main"}',
          method: 'POST',
          sourceIp: '1.2.3.4',
        }),
      );
    });

    it('should throw HookNotFoundError for missing hook', async () => {
      repo.findByName.mockResolvedValue(undefined);

      await expect(
        service.fireHook('nope', 'POST', '', {}, {}, '1.2.3.4', 'token'),
      ).rejects.toThrow(HookNotFoundError);
    });

    it('should throw HookPausedError for paused hook', async () => {
      repo.findByName.mockResolvedValue({ ...mockHook, status: 'paused' });

      await expect(
        service.fireHook('github-push', 'POST', '', {}, {}, '1.2.3.4', 'supersecret12345678'),
      ).rejects.toThrow(HookPausedError);
    });

    it('should throw HookMethodNotAllowedError for wrong method', async () => {
      repo.findByName.mockResolvedValue(mockHook); // only POST allowed

      await expect(
        service.fireHook('github-push', 'PUT', '', {}, {}, '1.2.3.4', 'supersecret12345678'),
      ).rejects.toThrow(HookMethodNotAllowedError);
    });

    it('should throw HookAuthError for wrong secret', async () => {
      repo.findByName.mockResolvedValue(mockHook);

      await expect(
        service.fireHook('github-push', 'POST', '', {}, {}, '1.2.3.4', 'wrongsecret1234567'),
      ).rejects.toThrow(HookAuthError);
    });

    it('should throw HookPayloadTooLargeError for oversized payload', async () => {
      const smallMaxHook = { ...mockHook, maxPayloadBytes: 10 };
      repo.findByName.mockResolvedValue(smallMaxHook);

      await expect(
        service.fireHook('github-push', 'POST', 'a'.repeat(100), {}, {}, '1.2.3.4', 'supersecret12345678'),
      ).rejects.toThrow(HookPayloadTooLargeError);
    });

    it('should parse JSON payload', async () => {
      repo.findByName.mockResolvedValue(mockHook);
      repo.recordFire.mockResolvedValue(undefined);

      await service.fireHook(
        'github-push', 'POST', '{"key":"value"}',
        {}, {}, '1.2.3.4', 'supersecret12345678',
      );

      expect(fireHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          parsedPayload: { key: 'value' },
        }),
      );
    });

    it('should handle non-JSON payload gracefully', async () => {
      repo.findByName.mockResolvedValue(mockHook);
      repo.recordFire.mockResolvedValue(undefined);

      await service.fireHook(
        'github-push', 'POST', 'not json',
        {}, {}, '1.2.3.4', 'supersecret12345678',
      );

      expect(fireHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          parsedPayload: null,
        }),
      );
    });
  });

  describe('generateSecret', () => {
    it('should generate a 64-char hex string', () => {
      const secret = HooksService.generateSecret();
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate unique secrets', () => {
      const s1 = HooksService.generateSecret();
      const s2 = HooksService.generateSecret();
      expect(s1).not.toBe(s2);
    });
  });
});
