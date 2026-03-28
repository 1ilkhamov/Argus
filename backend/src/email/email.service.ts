import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import * as nodemailer from 'nodemailer';

import { SettingsService } from '../settings/settings.service';
import {
  EMAIL_PROVIDER_PRESETS,
  type EmailAccountConfig,
  type EmailAddress,
  type EmailFolder,
  type EmailMessage,
  type EmailMessageSummary,
  type EmailProvider,
  type EmailSearchParams,
  type EmailSendParams,
  type EmailSendResult,
} from './email.types';

// ─── Settings keys ──────────────────────────────────────────────────────────

const SETTINGS_PREFIX = 'tools.email';
const KEY_PROVIDER = `${SETTINGS_PREFIX}.provider`;
const KEY_EMAIL = `${SETTINGS_PREFIX}.email`;
const KEY_PASSWORD = `${SETTINGS_PREFIX}.password`;
const KEY_IMAP_HOST = `${SETTINGS_PREFIX}.imap_host`;
const KEY_IMAP_PORT = `${SETTINGS_PREFIX}.imap_port`;
const KEY_SMTP_HOST = `${SETTINGS_PREFIX}.smtp_host`;
const KEY_SMTP_PORT = `${SETTINGS_PREFIX}.smtp_port`;

const MAX_BODY_LENGTH = 8_000;
const DEFAULT_SEARCH_LIMIT = 20;
const IMAP_TIMEOUT_MS = 30_000;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly settingsService: SettingsService) {}

  // ─── Account resolution ───────────────────────────────────────────────────

  async getAccountConfig(): Promise<EmailAccountConfig | null> {
    const email = await this.settingsService.getValue(KEY_EMAIL);
    const password = await this.settingsService.getValue(KEY_PASSWORD);
    if (!email || !password) return null;

    const provider = ((await this.settingsService.getValue(KEY_PROVIDER)) || 'custom') as EmailProvider;

    return {
      provider,
      email,
      password,
      imapHost: (await this.settingsService.getValue(KEY_IMAP_HOST)) || undefined,
      imapPort: Number(await this.settingsService.getValue(KEY_IMAP_PORT)) || undefined,
      smtpHost: (await this.settingsService.getValue(KEY_SMTP_HOST)) || undefined,
      smtpPort: Number(await this.settingsService.getValue(KEY_SMTP_PORT)) || undefined,
    };
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getAccountConfig()) !== null;
  }

  // ─── IMAP: list folders ───────────────────────────────────────────────────

  async listFolders(): Promise<EmailFolder[]> {
    const config = await this.requireConfig();
    const client = this.createImapClient(config);

    try {
      await client.connect();
      const tree = await client.listTree();
      const folders: EmailFolder[] = [];

      const walk = (nodes: typeof tree.folders) => {
        if (!nodes) return;
        for (const node of nodes) {
          folders.push({
            name: node.name ?? '',
            path: node.path ?? '',
            delimiter: node.delimiter ?? '/',
            totalMessages: node.status?.messages ?? 0,
            unseenMessages: node.status?.unseen ?? 0,
          });
          if (node.folders?.length) walk(node.folders);
        }
      };
      walk(tree.folders);
      return folders;
    } finally {
      await this.safeLogout(client);
    }
  }

  // ─── IMAP: search ────────────────────────────────────────────────────────

  async search(params: EmailSearchParams): Promise<EmailMessageSummary[]> {
    const config = await this.requireConfig();
    const client = this.createImapClient(config);
    const folder = params.folder || 'INBOX';
    const limit = Math.min(params.limit ?? DEFAULT_SEARCH_LIMIT, 50);

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        const query = this.buildSearchQuery(params);
        const searchResult = await client.search(query, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];

        if (!uids.length) return [];

        // Take the latest N UIDs
        const targetUids = uids.slice(-limit).reverse();
        const summaries: EmailMessageSummary[] = [];

        for await (const msg of client.fetch(targetUids, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          size: true,
        }, { uid: true })) {
          summaries.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId || '',
            subject: msg.envelope?.subject || '(no subject)',
            from: this.formatAddress(msg.envelope?.from),
            date: msg.envelope?.date?.toISOString() || '',
            flags: [...(msg.flags || [])],
            hasAttachments: this.hasAttachments(msg.bodyStructure),
            size: msg.size || 0,
          });
        }

        return summaries;
      } finally {
        lock.release();
      }
    } finally {
      await this.safeLogout(client);
    }
  }

  // ─── IMAP: read single message ───────────────────────────────────────────

  async readMessage(uid: number, folder = 'INBOX'): Promise<EmailMessage | null> {
    const config = await this.requireConfig();
    const client = this.createImapClient(config);

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        let result: EmailMessage | null = null;

        for await (const msg of client.fetch([uid], {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          size: true,
          source: true,
        }, { uid: true })) {
          const rawSource = msg.source?.toString('utf-8') || '';
          const body = this.extractTextBody(rawSource);
          const attachmentNames = this.extractAttachmentNames(msg.bodyStructure);

          result = {
            uid: msg.uid,
            messageId: msg.envelope?.messageId || '',
            subject: msg.envelope?.subject || '(no subject)',
            from: this.parseAddressList(msg.envelope?.from),
            to: this.parseAddressList(msg.envelope?.to),
            cc: this.parseAddressList(msg.envelope?.cc),
            date: msg.envelope?.date?.toISOString() || '',
            flags: [...(msg.flags || [])],
            folder,
            body: body.length > MAX_BODY_LENGTH
              ? body.slice(0, MAX_BODY_LENGTH) + '\n… (truncated)'
              : body,
            hasAttachments: attachmentNames.length > 0,
            attachmentNames,
            size: msg.size || 0,
          };
        }

        // Mark as \Seen
        if (result) {
          await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        }

        return result;
      } finally {
        lock.release();
      }
    } finally {
      await this.safeLogout(client);
    }
  }

  // ─── IMAP: count ─────────────────────────────────────────────────────────

  async countMessages(folder = 'INBOX'): Promise<{ total: number; unseen: number }> {
    const config = await this.requireConfig();
    const client = this.createImapClient(config);

    try {
      await client.connect();
      const status = await client.status(folder, { messages: true, unseen: true });
      return {
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
      };
    } finally {
      await this.safeLogout(client);
    }
  }

  // ─── SMTP: send ──────────────────────────────────────────────────────────

  async sendMessage(params: EmailSendParams): Promise<EmailSendResult> {
    const config = await this.requireConfig();
    const { host, port, secure } = this.resolveSmtp(config);

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: config.email, pass: config.password },
      tls: { rejectUnauthorized: false },
    });

    try {
      const mailOptions: nodemailer.SendMailOptions = {
        from: config.email,
        to: params.to.join(', '),
        subject: params.subject,
        ...(params.cc?.length && { cc: params.cc.join(', ') }),
        ...(params.bcc?.length && { bcc: params.bcc.join(', ') }),
        ...(params.inReplyTo && {
          inReplyTo: params.inReplyTo,
          references: params.inReplyTo,
        }),
      };

      if (params.contentType === 'html') {
        mailOptions.html = params.body;
      } else {
        mailOptions.text = params.body;
      }

      const info = await transporter.sendMail(mailOptions);

      return {
        messageId: info.messageId || '',
        accepted: (info.accepted || []).map(String),
        rejected: (info.rejected || []).map(String),
      };
    } finally {
      transporter.close();
    }
  }

  // ─── Private: IMAP client factory ─────────────────────────────────────────

  private createImapClient(config: EmailAccountConfig): ImapFlow {
    const { host, port, secure } = this.resolveImap(config);

    return new ImapFlow({
      host,
      port,
      secure,
      auth: { user: config.email, pass: config.password },
      logger: false as never,
      emitLogs: false,
      tls: { rejectUnauthorized: false },
      greetingTimeout: IMAP_TIMEOUT_MS,
      socketTimeout: IMAP_TIMEOUT_MS,
    });
  }

  private resolveImap(config: EmailAccountConfig): { host: string; port: number; secure: boolean } {
    if (config.provider !== 'custom') {
      return EMAIL_PROVIDER_PRESETS[config.provider].imap;
    }
    return {
      host: config.imapHost || '',
      port: config.imapPort || 993,
      secure: true,
    };
  }

  private resolveSmtp(config: EmailAccountConfig): { host: string; port: number; secure: boolean } {
    if (config.provider !== 'custom') {
      return EMAIL_PROVIDER_PRESETS[config.provider].smtp;
    }
    return {
      host: config.smtpHost || '',
      port: config.smtpPort || 587,
      secure: false,
    };
  }

  // ─── Private: search query builder ────────────────────────────────────────

  private buildSearchQuery(params: EmailSearchParams): Record<string, unknown> {
    const query: Record<string, unknown> = {};

    if (params.from) query.from = params.from;
    if (params.to) query.to = params.to;
    if (params.subject) query.subject = params.subject;
    if (params.body) query.body = params.body;
    if (params.since) query.since = new Date(params.since);
    if (params.before) query.before = new Date(params.before);
    if (params.unseen === true) query.seen = false;
    if (params.flagged === true) query.flagged = true;

    // Default: all messages if no criteria
    if (Object.keys(query).length === 0) query.all = true;

    return query;
  }

  // ─── Private: body extraction ─────────────────────────────────────────────

  private extractTextBody(rawSource: string): string {
    // Try to extract plain text part from raw email source
    // Simple approach: find text/plain content or strip HTML

    // Check for multipart boundary
    const boundaryMatch = rawSource.match(/boundary="?([^";\r\n]+)"?/i);

    if (boundaryMatch) {
      const boundary = boundaryMatch[1]!;
      const parts = rawSource.split(`--${boundary}`);

      // Look for text/plain part first
      for (const part of parts) {
        if (/content-type:\s*text\/plain/i.test(part)) {
          return this.decodeBodyPart(part);
        }
      }

      // Fallback to text/html, strip tags
      for (const part of parts) {
        if (/content-type:\s*text\/html/i.test(part)) {
          return this.stripHtml(this.decodeBodyPart(part));
        }
      }
    }

    // Non-multipart: extract body after double newline
    const headerEnd = rawSource.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const body = rawSource.slice(headerEnd + 4);
      if (/content-type:\s*text\/html/i.test(rawSource.slice(0, headerEnd))) {
        return this.stripHtml(this.decodeTransferEncoding(body, rawSource.slice(0, headerEnd)));
      }
      return this.decodeTransferEncoding(body, rawSource.slice(0, headerEnd));
    }

    return rawSource.slice(0, MAX_BODY_LENGTH);
  }

  private decodeBodyPart(part: string): string {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) return part.trim();
    const headers = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4);
    return this.decodeTransferEncoding(body, headers);
  }

  private decodeTransferEncoding(body: string, headers: string): string {
    if (/content-transfer-encoding:\s*base64/i.test(headers)) {
      try {
        return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
      } catch {
        return body;
      }
    }

    if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
      return body
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    return body;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ─── Private: attachments ─────────────────────────────────────────────────

  private hasAttachments(bodyStructure: unknown): boolean {
    return this.extractAttachmentNames(bodyStructure).length > 0;
  }

  private extractAttachmentNames(bodyStructure: unknown): string[] {
    const names: string[] = [];
    this.walkBodyStructure(bodyStructure, (part: Record<string, unknown>) => {
      const disposition = part.disposition as string | undefined;
      if (disposition === 'attachment' || disposition === 'inline') {
        const params = part.dispositionParameters as Record<string, string> | undefined;
        const filename = params?.filename || (part.parameters as Record<string, string>)?.name;
        if (filename) names.push(String(filename));
      }
    });
    return names;
  }

  private walkBodyStructure(node: unknown, visitor: (part: Record<string, unknown>) => void): void {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    visitor(obj);
    if (Array.isArray(obj.childNodes)) {
      for (const child of obj.childNodes) {
        this.walkBodyStructure(child, visitor);
      }
    }
  }

  // ─── Private: address helpers ─────────────────────────────────────────────

  private parseAddressList(list: unknown): EmailAddress[] {
    if (!Array.isArray(list)) return [];
    return list.map((addr) => ({
      name: String(addr?.name || ''),
      address: String(addr?.address || ''),
    }));
  }

  private formatAddress(list: unknown): string {
    const parsed = this.parseAddressList(list);
    if (!parsed.length) return '(unknown)';
    const first = parsed[0]!;
    return first.name ? `${first.name} <${first.address}>` : first.address;
  }

  // ─── Private: config helpers ──────────────────────────────────────────────

  private async requireConfig(): Promise<EmailAccountConfig> {
    const config = await this.getAccountConfig();
    if (!config) {
      throw new EmailNotConfiguredError();
    }
    return config;
  }

  private async safeLogout(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch {
      // ignore — connection may already be closed
    }
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      'Email is not configured. Ask the user to provide email credentials via Settings:\n' +
      '- tools.email.provider (gmail, outlook, yandex, mailru, icloud, or custom)\n' +
      '- tools.email.email (email address)\n' +
      '- tools.email.password (password or app password)\n' +
      'For custom provider, also set: tools.email.imap_host, tools.email.smtp_host',
    );
    this.name = 'EmailNotConfiguredError';
  }
}
