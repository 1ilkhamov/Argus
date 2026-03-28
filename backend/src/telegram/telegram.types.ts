export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUsers: number[];
  webhookUrl: string;
  webhookSecret: string;
  progressiveEdit: boolean;
  editIntervalMs: number;
}

export interface TelegramUserContext {
  userId: number;
  chatId: number;
  scopeKey: string;
  firstName?: string;
  username?: string;
}

/**
 * Tracks per-chat conversation state for Telegram users.
 * Maps Telegram chatId → active Argus conversationId.
 */
export type ConversationMap = Map<number, string>;
