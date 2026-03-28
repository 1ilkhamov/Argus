export const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '');

export const API_ENDPOINTS = {
  chat: {
    conversations: '/chat/conversations',
    conversation: (id: string) => `/chat/conversations/${id}`,
    sendMessage: '/chat/messages',
    streamMessage: '/chat/messages/stream',
  },
  health: '/health',
} as const;

export const APP_CONFIG = {
  name: 'Argus',
  version: '0.1.0',
  maxTextareaHeight: 200,
  sidebarWidth: 304,
} as const;

export const STORAGE_KEYS = {
  theme: 'argus-theme',
  lang: 'argus-lang',
} as const;
