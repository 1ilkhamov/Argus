import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { EmailService, EmailNotConfiguredError } from '../../../email/email.service';

@Injectable()
export class EmailTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(EmailTool.name);
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'email',
    description:
      'Read, search, and send emails via IMAP/SMTP. Works with Gmail, Outlook, Yandex, Mail.ru, iCloud, or any custom IMAP/SMTP server.\n\n' +
      'Actions:\n' +
      '- search: Find emails by sender, subject, date range, or flags\n' +
      '- read: Read a specific email by UID\n' +
      '- send: Send a new email or reply to an existing one\n' +
      '- count: Get total and unread count for a folder\n' +
      '- list_folders: List all mailbox folders\n\n' +
      'Email credentials are stored securely in Settings (tools.email.provider, tools.email.email, tools.email.password).\n' +
      'Supported providers: gmail, outlook, yandex, mailru, icloud, custom.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: ['search', 'read', 'send', 'count', 'list_folders'],
        },
        // ─── Search params ───────────────────────────────────────────────
        folder: {
          type: 'string',
          description: 'Mailbox folder (default: "INBOX"). Used by search, read, count.',
        },
        from: {
          type: 'string',
          description: 'Filter by sender email/name (for "search").',
        },
        to: {
          type: 'string',
          description: 'Filter by recipient (for "search").',
        },
        subject: {
          type: 'string',
          description: 'Filter by subject (for "search").',
        },
        since: {
          type: 'string',
          description: 'Messages since date, ISO 8601 (for "search"). E.g. "2026-03-01".',
        },
        before: {
          type: 'string',
          description: 'Messages before date, ISO 8601 (for "search").',
        },
        unseen: {
          type: 'boolean',
          description: 'Only unread messages (for "search").',
        },
        flagged: {
          type: 'boolean',
          description: 'Only flagged/starred messages (for "search").',
        },
        limit: {
          type: 'number',
          description: 'Max results (for "search"). Default: 20, max: 50.',
        },
        // ─── Read params ─────────────────────────────────────────────────
        uid: {
          type: 'number',
          description: 'Email UID to read (for "read"). Get UIDs from search results.',
        },
        // ─── Send params ─────────────────────────────────────────────────
        send_to: {
          type: 'string',
          description: 'Comma-separated recipient email addresses (for "send").',
        },
        cc: {
          type: 'string',
          description: 'Comma-separated CC addresses (for "send").',
        },
        bcc: {
          type: 'string',
          description: 'Comma-separated BCC addresses (for "send").',
        },
        send_subject: {
          type: 'string',
          description: 'Email subject (for "send").',
        },
        body: {
          type: 'string',
          description: 'Email body text (for "send").',
        },
        content_type: {
          type: 'string',
          description: 'Body content type: "text" or "html" (for "send"). Default: "text".',
          enum: ['text', 'html'],
        },
        in_reply_to: {
          type: 'string',
          description: 'Message-ID to reply to (for "send"). Sets In-Reply-To header.',
        },
      },
      required: ['action'],
    },
    safety: 'moderate',
    timeoutMs: 60_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('tools.email.enabled', true);
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.registry.register(this);
      this.logger.log('email tool registered');
    }
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!this.enabled) {
      return 'Error: Email tool is disabled. Set TOOLS_EMAIL_ENABLED=true to enable.';
    }

    const action = String(args.action ?? '');

    try {
      switch (action) {
        case 'search':
          return await this.handleSearch(args);
        case 'read':
          return await this.handleRead(args);
        case 'send':
          return await this.handleSend(args);
        case 'count':
          return await this.handleCount(args);
        case 'list_folders':
          return await this.handleListFolders();
        default:
          return `Unknown action: "${action}". Use "search", "read", "send", "count", or "list_folders".`;
      }
    } catch (error) {
      if (error instanceof EmailNotConfiguredError) {
        return `Error: ${error.message}`;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`email ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private async handleSearch(args: Record<string, unknown>): Promise<string> {
    const results = await this.emailService.search({
      folder: args.folder ? String(args.folder) : undefined,
      from: args.from ? String(args.from) : undefined,
      to: args.to ? String(args.to) : undefined,
      subject: args.subject ? String(args.subject) : undefined,
      since: args.since ? String(args.since) : undefined,
      before: args.before ? String(args.before) : undefined,
      unseen: args.unseen === true ? true : undefined,
      flagged: args.flagged === true ? true : undefined,
      limit: args.limit ? Number(args.limit) : undefined,
    });

    if (!results.length) {
      return 'No emails found matching the search criteria.';
    }

    const lines = results.map((m, i) => {
      const flags = m.flags.length ? ` [${m.flags.join(', ')}]` : '';
      const attach = m.hasAttachments ? ' 📎' : '';
      return `${i + 1}. UID:${m.uid} | ${m.date.slice(0, 16)} | ${m.from}\n   Subject: ${m.subject}${flags}${attach}`;
    });

    return `Found ${results.length} email(s):\n\n${lines.join('\n\n')}`;
  }

  private async handleRead(args: Record<string, unknown>): Promise<string> {
    const uid = Number(args.uid);
    if (!uid || uid <= 0) {
      return 'Error: "uid" is required (positive number). Get UIDs from search results.';
    }

    const folder = args.folder ? String(args.folder) : 'INBOX';
    const msg = await this.emailService.readMessage(uid, folder);

    if (!msg) {
      return `Error: Email UID ${uid} not found in "${folder}".`;
    }

    const from = msg.from.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
    const to = msg.to.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
    const cc = msg.cc.length
      ? `\nCC: ${msg.cc.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ')}`
      : '';
    const attachments = msg.attachmentNames.length
      ? `\nAttachments: ${msg.attachmentNames.join(', ')}`
      : '';
    const flags = msg.flags.length ? `\nFlags: ${msg.flags.join(', ')}` : '';

    return [
      `Subject: ${msg.subject}`,
      `From: ${from}`,
      `To: ${to}`,
      cc,
      `Date: ${msg.date}`,
      `Message-ID: ${msg.messageId}`,
      flags,
      attachments,
      `\n---\n\n${msg.body}`,
    ].filter(Boolean).join('\n');
  }

  private async handleSend(args: Record<string, unknown>): Promise<string> {
    const to = String(args.send_to ?? '').trim();
    const subject = String(args.send_subject ?? '').trim();
    const body = String(args.body ?? '').trim();

    if (!to) return 'Error: "send_to" is required (comma-separated email addresses).';
    if (!subject) return 'Error: "send_subject" is required.';
    if (!body) return 'Error: "body" is required.';

    const toList = to.split(',').map((s) => s.trim()).filter(Boolean);
    const ccList = args.cc ? String(args.cc).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const bccList = args.bcc ? String(args.bcc).split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    const result = await this.emailService.sendMessage({
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject,
      body,
      contentType: args.content_type === 'html' ? 'html' : 'text',
      inReplyTo: args.in_reply_to ? String(args.in_reply_to) : undefined,
    });

    const accepted = result.accepted.length ? `Delivered to: ${result.accepted.join(', ')}` : '';
    const rejected = result.rejected.length ? `\nRejected: ${result.rejected.join(', ')}` : '';

    return `Email sent successfully.\nMessage-ID: ${result.messageId}\n${accepted}${rejected}`;
  }

  private async handleCount(args: Record<string, unknown>): Promise<string> {
    const folder = args.folder ? String(args.folder) : 'INBOX';
    const { total, unseen } = await this.emailService.countMessages(folder);
    return `Folder "${folder}": ${total} total, ${unseen} unread.`;
  }

  private async handleListFolders(): Promise<string> {
    const folders = await this.emailService.listFolders();

    if (!folders.length) return 'No folders found.';

    const lines = folders.map((f) => {
      const stats = f.totalMessages > 0
        ? ` (${f.totalMessages} messages, ${f.unseenMessages} unread)`
        : '';
      return `- ${f.path}${stats}`;
    });

    return `Mailbox folders:\n${lines.join('\n')}`;
  }
}
