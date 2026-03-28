import { apiFetch } from '../http/client';
import { API_ENDPOINTS } from '@/config';

export interface TgQrTokenResult {
  qrUrl: string;
  expiresIn: number;
}

export interface TgQrCheckResult {
  status: 'waiting' | 'requires_2fa' | 'authorized' | 'expired';
  user?: { id: string; firstName: string; username?: string };
}

export interface TgClientStatus {
  connected: boolean;
  authorized: boolean;
  user: { id: string; firstName: string; username?: string } | null;
  monitoredChats: number;
  authStep: 'idle' | 'awaiting_code' | 'awaiting_2fa' | 'awaiting_qr' | 'authorized';
}

export interface TgMonitoredChat {
  id: string;
  chatId: string;
  chatTitle: string;
  chatType: 'user' | 'group' | 'supergroup' | 'channel' | 'unknown';
  mode: 'auto' | 'read_only' | 'manual' | 'disabled';
  cooldownSeconds: number;
  systemNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface TgDialogInfo {
  chatId: string;
  title: string;
  type: 'user' | 'group' | 'supergroup' | 'channel' | 'unknown';
  unreadCount: number;
  lastMessageDate: string | null;
}

export const telegramClientApi = {
  getStatus(): Promise<TgClientStatus> {
    return apiFetch<TgClientStatus>(API_ENDPOINTS.telegramClient.status);
  },

  start(): Promise<TgClientStatus> {
    return apiFetch<TgClientStatus>(API_ENDPOINTS.telegramClient.start, { method: 'POST' });
  },

  stop(): Promise<TgClientStatus> {
    return apiFetch<TgClientStatus>(API_ENDPOINTS.telegramClient.stop, { method: 'POST' });
  },

  restart(): Promise<TgClientStatus> {
    return apiFetch<TgClientStatus>(API_ENDPOINTS.telegramClient.restart, { method: 'POST' });
  },

  sendCode(phone: string): Promise<{ phoneCodeHash: string }> {
    return apiFetch<{ phoneCodeHash: string }>(API_ENDPOINTS.telegramClient.sendCode, {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  },

  resendCode(): Promise<{ phoneCodeHash: string }> {
    return apiFetch<{ phoneCodeHash: string }>(API_ENDPOINTS.telegramClient.resendCode, {
      method: 'POST',
    });
  },

  getQrToken(): Promise<TgQrTokenResult> {
    return apiFetch<TgQrTokenResult>(API_ENDPOINTS.telegramClient.qrToken, {
      method: 'POST',
    });
  },

  checkQrLogin(): Promise<TgQrCheckResult> {
    return apiFetch<TgQrCheckResult>(API_ENDPOINTS.telegramClient.qrCheck);
  },

  signIn(phone: string, code: string, phoneCodeHash: string): Promise<{ success: boolean; requires2FA?: boolean; user?: { id: string; firstName: string; username?: string } }> {
    return apiFetch(API_ENDPOINTS.telegramClient.signIn, {
      method: 'POST',
      body: JSON.stringify({ phone, code, phoneCodeHash }),
    });
  },

  submit2fa(password: string): Promise<{ success: boolean; user?: { id: string; firstName: string; username?: string } }> {
    return apiFetch(API_ENDPOINTS.telegramClient.submit2fa, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  getDialogs(): Promise<TgDialogInfo[]> {
    return apiFetch<TgDialogInfo[]>(API_ENDPOINTS.telegramClient.dialogs);
  },

  getChats(): Promise<TgMonitoredChat[]> {
    return apiFetch<TgMonitoredChat[]>(API_ENDPOINTS.telegramClient.chats);
  },

  addChat(params: { chatId: string; chatTitle: string; chatType?: string; mode?: string; cooldownSeconds?: number; systemNote?: string }): Promise<TgMonitoredChat> {
    return apiFetch<TgMonitoredChat>(API_ENDPOINTS.telegramClient.chats, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  updateChat(id: string, params: { mode?: string; cooldownSeconds?: number; systemNote?: string; chatTitle?: string }): Promise<TgMonitoredChat> {
    return apiFetch<TgMonitoredChat>(API_ENDPOINTS.telegramClient.chat(id), {
      method: 'PATCH',
      body: JSON.stringify(params),
    });
  },

  removeChat(id: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(API_ENDPOINTS.telegramClient.chat(id), {
      method: 'DELETE',
    });
  },
};
