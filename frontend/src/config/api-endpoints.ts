export const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '');

export const API_ENDPOINTS = {
  chat: {
    conversations: '/chat/conversations',
    conversation: (id: string) => `/chat/conversations/${id}`,
    sendMessage: '/chat/messages',
    streamMessage: '/chat/messages/stream',
    voiceStream: '/chat/voice/stream',
  },
  memory: {
    entries: '/memory/v2/entries',
    entry: (id: string) => `/memory/v2/entries/${id}`,
    pin: (id: string) => `/memory/v2/entries/${id}/pin`,
    stats: '/memory/v2/stats',
  },
  settings: {
    list: '/settings',
    entry: (key: string) => `/settings/${encodeURIComponent(key)}`,
  },
  telegram: {
    status: '/telegram/status',
    restart: '/telegram/restart',
    stop: '/telegram/stop',
  },
  telegramClient: {
    status: '/telegram-client/status',
    start: '/telegram-client/start',
    stop: '/telegram-client/stop',
    restart: '/telegram-client/restart',
    sendCode: '/telegram-client/auth/send-code',
    resendCode: '/telegram-client/auth/resend-code',
    qrToken: '/telegram-client/auth/qr-token',
    qrCheck: '/telegram-client/auth/qr-check',
    signIn: '/telegram-client/auth/sign-in',
    submit2fa: '/telegram-client/auth/2fa',
    dialogs: '/telegram-client/dialogs',
    chats: '/telegram-client/chats',
    chat: (id: string) => `/telegram-client/chats/${id}`,
  },
  tools: {
    list: '/tools',
  },
  health: '/health',
} as const;
