// ─── Configuration ────────────────────────────────────────────────────────────

export interface TelegramClientConfig {
  enabled: boolean;
  apiId: number;
  apiHash: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface TgClientAuthState {
  step: 'idle' | 'awaiting_code' | 'awaiting_2fa' | 'awaiting_qr' | 'authorized';
  phone?: string;
  phoneCodeHash?: string;
}

export interface TgQrTokenResult {
  /** tg://login?token=... URL for QR code */
  qrUrl: string;
  /** Seconds until this token expires */
  expiresIn: number;
}

export interface TgQrCheckResult {
  status: 'waiting' | 'requires_2fa' | 'authorized' | 'expired';
  user?: TgClientUser;
}

export interface TgClientSendCodeResult {
  phoneCodeHash: string;
}

export interface TgClientSignInResult {
  success: boolean;
  requires2FA?: boolean;
  user?: TgClientUser;
}

export interface TgClientUser {
  id: string;
  firstName: string;
  username?: string;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface TgClientStatus {
  connected: boolean;
  authorized: boolean;
  user: TgClientUser | null;
  monitoredChats: number;
  authStep: TgClientAuthState['step'];
}

// ─── Monitored chat ───────────────────────────────────────────────────────────

export type TgChatMode = 'auto' | 'read_only' | 'manual' | 'disabled';

export type TgChatType = 'user' | 'group' | 'supergroup' | 'channel' | 'unknown';

export interface TgMonitoredChat {
  id: string;
  chatId: string;
  chatTitle: string;
  chatType: TgChatType;
  mode: TgChatMode;
  /** Minimum seconds between auto-replies in this chat */
  cooldownSeconds: number;
  /** Extra context injected into LLM system prompt for this chat */
  systemNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMonitoredChatParams {
  chatId: string;
  chatTitle: string;
  chatType?: TgChatType;
  mode?: TgChatMode;
  cooldownSeconds?: number;
  systemNote?: string;
}

export interface UpdateMonitoredChatParams {
  chatTitle?: string;
  chatType?: TgChatType;
  mode?: TgChatMode;
  cooldownSeconds?: number;
  systemNote?: string;
}

// ─── Dialog (from TG API) ─────────────────────────────────────────────────────

export interface TgDialogInfo {
  chatId: string;
  title: string;
  type: 'user' | 'group' | 'supergroup' | 'channel' | 'unknown';
  unreadCount: number;
  lastMessageDate: string | null;
}

export interface TgClientMessageInfo {
  id: number;
  senderId: string;
  senderName: string;
  text: string;
  date: string;
  isOutgoing: boolean;
}

// ─── Incoming message (internal) ──────────────────────────────────────────────

export interface TgIncomingMessage {
  messageId: number;
  chatId: string;
  chatTitle: string;
  senderId: string;
  senderName: string;
  text: string;
  date: number;
  isOutgoing: boolean;
  replyToMsgId?: number;
}

// ─── Stored message (local DB) ───────────────────────────────────────────────

export interface TgStoredMessage {
  id: string;
  chatId: string;
  tgMessageId: number;
  senderId: string;
  senderName: string;
  text: string;
  isOutgoing: boolean;
  replyToId: number | null;
  timestamp: string;
}

export interface CreateStoredMessageParams {
  chatId: string;
  tgMessageId: number;
  senderId: string;
  senderName: string;
  text: string;
  isOutgoing: boolean;
  replyToId?: number;
  timestamp: string;
}

// ─── Chat profile (persistent, built by profiler) ───────────────────────────

export interface TgChatProfile {
  chatId: string;
  chatType: TgChatType;
  language: string;
  ownerStyleSummary: string;
  ownerStyleExamples: string[];
  chatTopicSummary: string;
  participantSummary: string;
  lastProfiledAt: string;
  totalMessages: number;
}

// ─── Settings keys ────────────────────────────────────────────────────────────

export const TG_CLIENT_SETTINGS = {
  API_ID: 'telegram_client.api_id',
  API_HASH: 'telegram_client.api_hash',
  PHONE: 'telegram_client.phone',
  SESSION: 'telegram_client.session',
} as const;

export const TG_CHAT_MODES = ['auto', 'read_only', 'manual', 'disabled'] as const;

export const TG_CHAT_TYPES = ['user', 'group', 'supergroup', 'channel', 'unknown'] as const;

export function isTgChatMode(value: unknown): value is TgChatMode {
  return typeof value === 'string' && TG_CHAT_MODES.includes(value as TgChatMode);
}

export function isTgChatType(value: unknown): value is TgChatType {
  return typeof value === 'string' && TG_CHAT_TYPES.includes(value as TgChatType);
}
