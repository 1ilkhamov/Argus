export interface PendingNotify {
  chatId: string;
  chatTitle: string;
  question: string;
  createdAt: number;
  sourceBotMessageId?: number | null;
}

export interface PendingNotifyMessageRecord {
  botMessageId: number;
  chatId: string;
  chatTitle: string;
  question: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingNotifyAwaitingReplyRecord {
  botChatId: number;
  sourceBotMessageId: number | null;
  chatId: string;
  chatTitle: string;
  question: string;
  createdAt: number;
  expiresAt: number;
}

export const PENDING_NOTIFY_ROUTE_STATUSES = ['sent', 'expired'] as const;
export type PendingNotifyRouteStatus = (typeof PENDING_NOTIFY_ROUTE_STATUSES)[number];

export interface PendingNotifyRouteRecord {
  id: string;
  botChatId: number;
  sourceBotMessageId: number | null;
  chatId: string;
  chatTitle: string;
  question: string;
  replyText: string | null;
  routeStatus: PendingNotifyRouteStatus;
  correlationId: string | null;
  createdAt: number;
  completedAt: number;
}

export interface PendingNotifySnapshot {
  pendingMessages: PendingNotifyMessageRecord[];
  awaitingReplies: PendingNotifyAwaitingReplyRecord[];
  recentRoutes: PendingNotifyRouteRecord[];
}

export const PENDING_TTL_MS = 10 * 60 * 1000;
