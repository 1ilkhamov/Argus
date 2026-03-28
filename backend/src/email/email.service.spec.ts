import { Test } from '@nestjs/testing';

import { EmailService, EmailNotConfiguredError } from './email.service';
import { SettingsService } from '../settings/settings.service';

// Mock imapflow and nodemailer at module level
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    listTree: jest.fn().mockResolvedValue({
      folders: [
        {
          name: 'INBOX',
          path: 'INBOX',
          delimiter: '/',
          status: { messages: 42, unseen: 3 },
          folders: [],
        },
        {
          name: 'Sent',
          path: 'Sent',
          delimiter: '/',
          status: { messages: 100, unseen: 0 },
          folders: [],
        },
      ],
    }),
    status: jest.fn().mockResolvedValue({ messages: 42, unseen: 3 }),
    getMailboxLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    search: jest.fn().mockResolvedValue([1, 2, 3]),
    fetch: jest.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => {
        let done = false;
        return {
          next: () => {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({
              done: false,
              value: {
                uid: 1,
                envelope: {
                  messageId: '<test@mail.com>',
                  subject: 'Test Subject',
                  from: [{ name: 'Sender', address: 'sender@test.com' }],
                  to: [{ name: '', address: 'me@test.com' }],
                  cc: [],
                  date: new Date('2026-03-26T10:00:00Z'),
                },
                flags: new Set(['\\Seen']),
                bodyStructure: { type: 'text/plain' },
                size: 500,
                source: Buffer.from(
                  'From: sender@test.com\r\nTo: me@test.com\r\nSubject: Test\r\n\r\nHello world body text',
                ),
              },
            });
          },
        };
      },
    }),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue({
      messageId: '<sent-id@mail.com>',
      accepted: ['recipient@test.com'],
      rejected: [],
    }),
    close: jest.fn(),
  }),
}));

describe('EmailService', () => {
  let service: EmailService;
  let settingsService: jest.Mocked<SettingsService>;

  const mockSettings: Record<string, string> = {
    'tools.email.provider': 'gmail',
    'tools.email.email': 'user@gmail.com',
    'tools.email.password': 'app-password-123',
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: SettingsService,
          useValue: {
            getValue: jest.fn((key: string) => Promise.resolve(mockSettings[key] || '')),
          },
        },
      ],
    }).compile();

    service = module.get(EmailService);
    settingsService = module.get(SettingsService) as jest.Mocked<SettingsService>;
  });

  describe('getAccountConfig', () => {
    it('should return config from settings', async () => {
      const config = await service.getAccountConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('gmail');
      expect(config!.email).toBe('user@gmail.com');
      expect(config!.password).toBe('app-password-123');
    });

    it('should return null if email not set', async () => {
      settingsService.getValue.mockResolvedValue('');
      const config = await service.getAccountConfig();
      expect(config).toBeNull();
    });
  });

  describe('isConfigured', () => {
    it('should return true when configured', async () => {
      expect(await service.isConfigured()).toBe(true);
    });

    it('should return false when not configured', async () => {
      settingsService.getValue.mockResolvedValue('');
      expect(await service.isConfigured()).toBe(false);
    });
  });

  describe('listFolders', () => {
    it('should list mailbox folders', async () => {
      const folders = await service.listFolders();
      expect(folders).toHaveLength(2);
      expect(folders[0]!.name).toBe('INBOX');
      expect(folders[0]!.totalMessages).toBe(42);
      expect(folders[0]!.unseenMessages).toBe(3);
      expect(folders[1]!.name).toBe('Sent');
    });
  });

  describe('search', () => {
    it('should search and return summaries', async () => {
      const results = await service.search({ from: 'sender@test.com', limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.uid).toBe(1);
      expect(results[0]!.subject).toBe('Test Subject');
      expect(results[0]!.from).toContain('sender@test.com');
    });

    it('should throw EmailNotConfiguredError when not configured', async () => {
      settingsService.getValue.mockResolvedValue('');
      await expect(service.search({})).rejects.toThrow(EmailNotConfiguredError);
    });
  });

  describe('readMessage', () => {
    it('should read a message by UID', async () => {
      const msg = await service.readMessage(1);
      expect(msg).not.toBeNull();
      expect(msg!.uid).toBe(1);
      expect(msg!.subject).toBe('Test Subject');
      expect(msg!.body).toContain('Hello world body text');
      expect(msg!.from[0]!.address).toBe('sender@test.com');
    });
  });

  describe('countMessages', () => {
    it('should return message counts', async () => {
      const counts = await service.countMessages('INBOX');
      expect(counts.total).toBe(42);
      expect(counts.unseen).toBe(3);
    });
  });

  describe('sendMessage', () => {
    it('should send an email via SMTP', async () => {
      const result = await service.sendMessage({
        to: ['recipient@test.com'],
        subject: 'Test send',
        body: 'Hello from test',
      });

      expect(result.messageId).toBe('<sent-id@mail.com>');
      expect(result.accepted).toContain('recipient@test.com');
      expect(result.rejected).toHaveLength(0);
    });

    it('should throw EmailNotConfiguredError when not configured', async () => {
      settingsService.getValue.mockResolvedValue('');
      await expect(
        service.sendMessage({ to: ['a@b.com'], subject: 'Test', body: 'Body' }),
      ).rejects.toThrow(EmailNotConfiguredError);
    });
  });
});
