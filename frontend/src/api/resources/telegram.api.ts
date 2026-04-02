import { apiFetch } from '../http/client';
import { API_ENDPOINTS } from '@/config';

export interface TelegramStatus {
  enabled: boolean;
  tokenConfigured: boolean;
  tokenSource: 'settings' | 'env' | 'none';
  running: boolean;
  username: string | null;
  mode: 'polling' | 'webhook' | null;
}

export const telegramApi = {
  getStatus(): Promise<TelegramStatus> {
    return apiFetch<TelegramStatus>(API_ENDPOINTS.telegram.status);
  },

  restart(): Promise<TelegramStatus> {
    return apiFetch<TelegramStatus>(API_ENDPOINTS.telegram.restart, {
      method: 'POST',
    });
  },

  stop(): Promise<TelegramStatus> {
    return apiFetch<TelegramStatus>(API_ENDPOINTS.telegram.stop, {
      method: 'POST',
    });
  },
};
