import { TelegramAuthService } from './telegram.auth.service';

function buildService(allowedUsers: number[] = []): TelegramAuthService {
  const configService = {
    get: jest.fn().mockReturnValue({
      enabled: true,
      botToken: 'test-token',
      allowedUsers,
      webhookUrl: '',
      webhookSecret: '',
      progressiveEdit: false,
      editIntervalMs: 1500,
    }),
  } as any;

  return new TelegramAuthService(configService);
}

describe('TelegramAuthService', () => {
  describe('isAllowed', () => {
    it('rejects all users when allowedUsers is empty', () => {
      const service = buildService([]);
      expect(service.isAllowed(123456)).toBe(false);
    });

    it('allows a user in the whitelist', () => {
      const service = buildService([111, 222, 333]);
      expect(service.isAllowed(222)).toBe(true);
    });

    it('rejects a user not in the whitelist', () => {
      const service = buildService([111, 222, 333]);
      expect(service.isAllowed(999)).toBe(false);
    });
  });

  describe('buildUserContext', () => {
    it('builds context with telegram-prefixed scopeKey', () => {
      const service = buildService([100]);
      const ctx = service.buildUserContext(100, 200, 'Alice', 'alice_bot');

      expect(ctx.userId).toBe(100);
      expect(ctx.chatId).toBe(200);
      expect(ctx.firstName).toBe('Alice');
      expect(ctx.username).toBe('alice_bot');
      expect(ctx.scopeKey).toMatch(/^telegram:[a-f0-9]{16}$/);
    });

    it('produces deterministic scopeKey for the same userId', () => {
      const service = buildService([100]);
      const ctx1 = service.buildUserContext(100, 200);
      const ctx2 = service.buildUserContext(100, 300);

      expect(ctx1.scopeKey).toBe(ctx2.scopeKey);
    });

    it('produces different scopeKey for different userIds', () => {
      const service = buildService([100, 200]);
      const ctx1 = service.buildUserContext(100, 100);
      const ctx2 = service.buildUserContext(200, 200);

      expect(ctx1.scopeKey).not.toBe(ctx2.scopeKey);
    });
  });
});
