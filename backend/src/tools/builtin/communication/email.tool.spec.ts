import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { EmailTool } from './email.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import { EmailService, EmailNotConfiguredError } from '../../../email/email.service';
import type { EmailMessageSummary, EmailMessage, EmailFolder, EmailSendResult } from '../../../email/email.types';

describe('EmailTool', () => {
  let tool: EmailTool;
  let emailService: jest.Mocked<EmailService>;
  let registry: jest.Mocked<ToolRegistryService>;

  const mockSummary: EmailMessageSummary = {
    uid: 42,
    messageId: '<abc@mail.com>',
    subject: 'Hello from GitHub',
    from: 'noreply@github.com',
    date: '2026-03-26T10:00:00.000Z',
    flags: ['\\Seen'],
    hasAttachments: false,
    size: 1234,
  };

  const mockMessage: EmailMessage = {
    uid: 42,
    messageId: '<abc@mail.com>',
    subject: 'Hello from GitHub',
    from: [{ name: 'GitHub', address: 'noreply@github.com' }],
    to: [{ name: '', address: 'user@example.com' }],
    cc: [],
    date: '2026-03-26T10:00:00.000Z',
    flags: ['\\Seen'],
    folder: 'INBOX',
    body: 'You have a new notification on GitHub.',
    hasAttachments: false,
    attachmentNames: [],
    size: 1234,
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EmailTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
        {
          provide: EmailService,
          useValue: {
            search: jest.fn(),
            readMessage: jest.fn(),
            sendMessage: jest.fn(),
            countMessages: jest.fn(),
            listFolders: jest.fn(),
            isConfigured: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'tools.email.enabled') return true;
              return fallback;
            }),
          },
        },
      ],
    }).compile();

    tool = module.get(EmailTool);
    emailService = module.get(EmailService) as jest.Mocked<EmailService>;
    registry = module.get(ToolRegistryService) as jest.Mocked<ToolRegistryService>;
  });

  describe('definition', () => {
    it('should have correct name and parameters', () => {
      expect(tool.definition.name).toBe('email');
      expect(tool.definition.parameters.properties).toHaveProperty('action');
      expect(tool.definition.parameters.required).toEqual(['action']);
      expect(tool.definition.safety).toBe('moderate');
    });
  });

  describe('onModuleInit', () => {
    it('should register with the tool registry', () => {
      tool.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(tool);
    });
  });

  describe('search', () => {
    it('should search emails with params', async () => {
      emailService.search.mockResolvedValue([mockSummary]);

      const result = await tool.execute({
        action: 'search',
        from: 'github.com',
        unseen: true,
        limit: 10,
      });

      expect(result).toContain('Found 1 email(s)');
      expect(result).toContain('Hello from GitHub');
      expect(result).toContain('UID:42');
      expect(emailService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'github.com',
          unseen: true,
          limit: 10,
        }),
      );
    });

    it('should handle no results', async () => {
      emailService.search.mockResolvedValue([]);

      const result = await tool.execute({ action: 'search', subject: 'nonexistent' });
      expect(result).toContain('No emails found');
    });
  });

  describe('read', () => {
    it('should read a message by UID', async () => {
      emailService.readMessage.mockResolvedValue(mockMessage);

      const result = await tool.execute({ action: 'read', uid: 42 });

      expect(result).toContain('Hello from GitHub');
      expect(result).toContain('noreply@github.com');
      expect(result).toContain('new notification on GitHub');
      expect(result).toContain('<abc@mail.com>');
    });

    it('should handle missing UID', async () => {
      const result = await tool.execute({ action: 'read' });
      expect(result).toContain('Error');
      expect(result).toContain('uid');
    });

    it('should handle not found', async () => {
      emailService.readMessage.mockResolvedValue(null);

      const result = await tool.execute({ action: 'read', uid: 999 });
      expect(result).toContain('not found');
    });
  });

  describe('send', () => {
    it('should send an email', async () => {
      const sendResult: EmailSendResult = {
        messageId: '<sent@mail.com>',
        accepted: ['recipient@example.com'],
        rejected: [],
      };
      emailService.sendMessage.mockResolvedValue(sendResult);

      const result = await tool.execute({
        action: 'send',
        send_to: 'recipient@example.com',
        send_subject: 'Test subject',
        body: 'Hello world',
      });

      expect(result).toContain('sent successfully');
      expect(result).toContain('recipient@example.com');
      expect(emailService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['recipient@example.com'],
          subject: 'Test subject',
          body: 'Hello world',
          contentType: 'text',
        }),
      );
    });

    it('should require send_to', async () => {
      const result = await tool.execute({ action: 'send', send_subject: 'Test', body: 'Hello' });
      expect(result).toContain('Error');
      expect(result).toContain('send_to');
    });

    it('should require send_subject', async () => {
      const result = await tool.execute({ action: 'send', send_to: 'a@b.com', body: 'Hello' });
      expect(result).toContain('Error');
      expect(result).toContain('send_subject');
    });

    it('should require body', async () => {
      const result = await tool.execute({ action: 'send', send_to: 'a@b.com', send_subject: 'Test' });
      expect(result).toContain('Error');
      expect(result).toContain('body');
    });

    it('should support CC, BCC, reply', async () => {
      const sendResult: EmailSendResult = {
        messageId: '<reply@mail.com>',
        accepted: ['to@b.com', 'cc@b.com'],
        rejected: [],
      };
      emailService.sendMessage.mockResolvedValue(sendResult);

      await tool.execute({
        action: 'send',
        send_to: 'to@b.com',
        cc: 'cc@b.com',
        bcc: 'bcc@b.com',
        send_subject: 'Re: Test',
        body: 'Reply body',
        in_reply_to: '<original@mail.com>',
      });

      expect(emailService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['to@b.com'],
          cc: ['cc@b.com'],
          bcc: ['bcc@b.com'],
          inReplyTo: '<original@mail.com>',
        }),
      );
    });
  });

  describe('count', () => {
    it('should count messages in folder', async () => {
      emailService.countMessages.mockResolvedValue({ total: 150, unseen: 12 });

      const result = await tool.execute({ action: 'count', folder: 'INBOX' });
      expect(result).toContain('150 total');
      expect(result).toContain('12 unread');
    });
  });

  describe('list_folders', () => {
    it('should list folders', async () => {
      const folders: EmailFolder[] = [
        { name: 'INBOX', path: 'INBOX', delimiter: '/', totalMessages: 200, unseenMessages: 5 },
        { name: 'Sent', path: 'Sent', delimiter: '/', totalMessages: 100, unseenMessages: 0 },
      ];
      emailService.listFolders.mockResolvedValue(folders);

      const result = await tool.execute({ action: 'list_folders' });
      expect(result).toContain('INBOX');
      expect(result).toContain('Sent');
      expect(result).toContain('200 messages');
      expect(result).toContain('5 unread');
    });

    it('should handle empty folders', async () => {
      emailService.listFolders.mockResolvedValue([]);

      const result = await tool.execute({ action: 'list_folders' });
      expect(result).toContain('No folders');
    });
  });

  describe('error handling', () => {
    it('should handle EmailNotConfiguredError', async () => {
      emailService.search.mockRejectedValue(new EmailNotConfiguredError());

      const result = await tool.execute({ action: 'search' });
      expect(result).toContain('not configured');
      expect(result).toContain('tools.email.provider');
    });

    it('should handle generic errors', async () => {
      emailService.search.mockRejectedValue(new Error('Connection timeout'));

      const result = await tool.execute({ action: 'search' });
      expect(result).toContain('Error');
      expect(result).toContain('Connection timeout');
    });

    it('should handle unknown action', async () => {
      const result = await tool.execute({ action: 'bogus' });
      expect(result).toContain('Unknown action');
    });
  });
});
