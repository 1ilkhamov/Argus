// ─── Provider presets ────────────────────────────────────────────────────────

export type EmailProvider = 'gmail' | 'outlook' | 'yandex' | 'mailru' | 'icloud' | 'custom';

export interface EmailProviderPreset {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

export const EMAIL_PROVIDER_PRESETS: Record<Exclude<EmailProvider, 'custom'>, EmailProviderPreset> = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
  },
  outlook: {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  yandex: {
    imap: { host: 'imap.yandex.ru', port: 993, secure: true },
    smtp: { host: 'smtp.yandex.ru', port: 465, secure: true },
  },
  mailru: {
    imap: { host: 'imap.mail.ru', port: 993, secure: true },
    smtp: { host: 'smtp.mail.ru', port: 465, secure: true },
  },
  icloud: {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  },
};

// ─── Account config ─────────────────────────────────────────────────────────

export interface EmailAccountConfig {
  /** Provider shorthand or 'custom' for manual IMAP/SMTP host */
  provider: EmailProvider;
  /** Email address (used as IMAP/SMTP login) */
  email: string;
  /** Password or app-specific password */
  password: string;
  /** Custom IMAP host (only for provider=custom) */
  imapHost?: string;
  /** Custom IMAP port (only for provider=custom) */
  imapPort?: number;
  /** Custom SMTP host (only for provider=custom) */
  smtpHost?: string;
  /** Custom SMTP port (only for provider=custom) */
  smtpPort?: number;
}

// ─── Email message ──────────────────────────────────────────────────────────

export interface EmailAddress {
  name: string;
  address: string;
}

export interface EmailMessage {
  uid: number;
  messageId: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string;
  flags: string[];
  folder: string;
  /** Text body (plain text preferred, HTML stripped as fallback) */
  body: string;
  /** True if message has attachments */
  hasAttachments: boolean;
  /** Attachment names (without content — too large for LLM context) */
  attachmentNames: string[];
  /** Byte size of the raw message */
  size: number;
}

export interface EmailMessageSummary {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  date: string;
  flags: string[];
  hasAttachments: boolean;
  size: number;
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface EmailSearchParams {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string;
  before?: string;
  unseen?: boolean;
  flagged?: boolean;
  limit?: number;
}

// ─── Send ───────────────────────────────────────────────────────────────────

export interface EmailSendParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** 'text' or 'html' — defaults to 'text' */
  contentType?: 'text' | 'html';
  /** Reply to this message ID (sets In-Reply-To + References headers) */
  inReplyTo?: string;
}

export interface EmailSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

// ─── Folder ─────────────────────────────────────────────────────────────────

export interface EmailFolder {
  name: string;
  path: string;
  delimiter: string;
  totalMessages: number;
  unseenMessages: number;
}
