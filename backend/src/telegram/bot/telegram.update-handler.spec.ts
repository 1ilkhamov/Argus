import { TelegramUpdateHandler } from './telegram.update-handler';

function createMockChatService(overrides: Record<string, any> = {}): any {
  return {
    sendMessage: jest.fn().mockResolvedValue({
      conversation: { id: 'conv-1' },
      assistantMessage: { id: 'msg-1', content: 'Hello from assistant', role: 'assistant' },
    }),
    streamMessage: jest.fn(async function* () {
      yield { chunk: { content: 'Hello', done: false }, conversationId: 'conv-1', messageId: 'msg-1' };
      yield { chunk: { content: ' world', done: false }, conversationId: 'conv-1', messageId: 'msg-1' };
      yield { chunk: { content: '', done: true }, conversationId: 'conv-1', messageId: 'msg-1' };
    }),
    ...overrides,
  };
}

function createMockAuthService(allowed = true): any {
  return {
    isAllowed: jest.fn().mockReturnValue(allowed),
    buildUserContext: jest.fn().mockReturnValue({
      userId: 100,
      chatId: 200,
      scopeKey: 'telegram:abc123',
      firstName: 'Test',
    }),
  };
}

function createMockMessageSender(): any {
  return {
    sendTypingAction: jest.fn().mockResolvedValue(undefined),
    sendText: jest.fn().mockResolvedValue(42),
    sendHtml: jest.fn().mockResolvedValue(42),
    sendPlaceholder: jest.fn().mockResolvedValue(42),
    editMessage: jest.fn().mockResolvedValue(true),
    sendError: jest.fn().mockResolvedValue(undefined),
    escapeHtml: jest.fn((text: string) => text),
    escapeMarkdownV2: jest.fn((text: string) => text),
    markdownToHtml: jest.fn((text: string) => text),
  };
}

function createMockVoiceHandler(transcription: string | null = 'transcribed text'): any {
  return {
    transcribe: jest.fn().mockResolvedValue(transcription),
  };
}

function createMockMemoryStore(): any {
  return {
    count: jest.fn().mockResolvedValue(42),
  };
}

function createMockToolRegistry(): any {
  return {
    getDefinitions: jest.fn().mockReturnValue([
      { name: 'web_search', safety: 'safe' },
      { name: 'file_ops', safety: 'moderate' },
    ]),
  };
}

function createMockConfigService(progressive = false): any {
  return {
    get: jest.fn((key: string, fallback?: any) => {
      if (key === 'telegram') {
        return {
          enabled: true,
          botToken: 'test-token',
          allowedUsers: [100],
          webhookUrl: '',
          webhookSecret: '',
          progressiveEdit: progressive,
          editIntervalMs: 1500,
        };
      }
      if (key === 'llm.model') return 'gpt-test';
      if (key === 'llm.provider') return 'local';
      return fallback;
    }),
  };
}

function createMockClientRepository(): any {
  return {
    findActive: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue([]),
    findByChatId: jest.fn().mockResolvedValue(null),
  };
}

function createMockClientMessagesRepository(): any {
  return {
    getRecent: jest.fn().mockResolvedValue([]),
  };
}

function createMockPendingNotifyService(): any {
  return {
    setPending: jest.fn(),
    getPending: jest.fn().mockReturnValue(undefined),
    getAwaitingReply: jest.fn().mockReturnValue(undefined),
    setAwaitingReply: jest.fn(),
    consumeAwaitingReply: jest.fn().mockReturnValue(undefined),
  };
}

function createMockClientService(): any {
  return {
    sendMessage: jest.fn().mockResolvedValue(1),
    isConnected: jest.fn().mockReturnValue(true),
  };
}

function buildHandler(options: {
  chatService?: any;
  memoryStore?: any;
  toolRegistry?: any;
  authService?: any;
  messageSender?: any;
  voiceHandler?: any;
  progressive?: boolean;
} = {}): TelegramUpdateHandler {
  return new TelegramUpdateHandler(
    createMockConfigService(options.progressive ?? false),
    options.chatService ?? createMockChatService(),
    options.memoryStore ?? createMockMemoryStore(),
    options.toolRegistry ?? createMockToolRegistry(),
    options.authService ?? createMockAuthService(),
    options.messageSender ?? createMockMessageSender(),
    options.voiceHandler ?? createMockVoiceHandler(),
    createMockClientRepository(),
    createMockClientMessagesRepository(),
    createMockPendingNotifyService(),
    createMockClientService(),
  );
}

function createMockBot(): any {
  return {
    command: jest.fn(),
    on: jest.fn(),
    telegram: {
      sendChatAction: jest.fn().mockResolvedValue(true),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 42 }),
      setMyCommands: jest.fn().mockResolvedValue(true),
      answerCbQuery: jest.fn().mockResolvedValue(true),
    },
  };
}

describe('TelegramUpdateHandler', () => {
  describe('registerHandlers', () => {
    it('registers command and message handlers on the bot', () => {
      const handler = buildHandler();
      const bot = createMockBot();

      handler.registerHandlers(bot);

      expect(bot.command).toHaveBeenCalledWith('start', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('menu', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('new', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('status', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('memory', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('tools', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('help', expect.any(Function));
      expect(bot.on).toHaveBeenCalledWith('callback_query', expect.any(Function));
      expect(bot.on).toHaveBeenCalledWith('voice', expect.any(Function));
      expect(bot.on).toHaveBeenCalledWith('audio', expect.any(Function));
      expect(bot.on).toHaveBeenCalledWith('text', expect.any(Function));
      expect(bot.telegram.setMyCommands).toHaveBeenCalled();
    });
  });

  describe('text message handling (simple mode)', () => {
    it('sends text to ChatService and delivers response', async () => {
      const chatService = createMockChatService();
      const messageSender = createMockMessageSender();
      const handler = buildHandler({ chatService, messageSender });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      // Get the text handler callback
      const textHandler = bot.on.mock.calls.find((c: any[]) => c[0] === 'text')[1];
      const ctx = {
        message: { text: 'Hello agent' },
        chat: { id: 200 },
        from: { id: 100, first_name: 'Test', username: 'testuser' },
      };

      await textHandler(ctx);

      expect(chatService.sendMessage).toHaveBeenCalledWith(
        undefined,
        'Hello agent',
        expect.objectContaining({ scopeKey: 'telegram:abc123' }),
      );
      expect(messageSender.sendText).toHaveBeenCalledWith(
        bot,
        200,
        'Hello from assistant',
        expect.objectContaining({ actor: 'agent', origin: 'telegram_update_handler' }),
      );
    });

    it('rejects unauthorized users', async () => {
      const authService = createMockAuthService(false);
      const messageSender = createMockMessageSender();
      const handler = buildHandler({ authService, messageSender });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const textHandler = bot.on.mock.calls.find((c: any[]) => c[0] === 'text')[1];
      const ctx = {
        message: { text: 'Hello' },
        chat: { id: 200 },
        from: { id: 999 },
      };

      await textHandler(ctx);

      expect(messageSender.sendError).toHaveBeenCalledWith(
        bot,
        200,
        'Access denied.',
        expect.objectContaining({ actor: 'system', correlationId: 'bot:200:text:access-denied' }),
      );
    });

    it('ignores empty text messages', async () => {
      const chatService = createMockChatService();
      const handler = buildHandler({ chatService });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const textHandler = bot.on.mock.calls.find((c: any[]) => c[0] === 'text')[1];
      const ctx = {
        message: { text: '   ' },
        chat: { id: 200 },
        from: { id: 100 },
      };

      await textHandler(ctx);
      expect(chatService.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('voice message handling', () => {
    it('transcribes voice and sends to ChatService', async () => {
      const chatService = createMockChatService();
      const voiceHandler = createMockVoiceHandler('Hello from voice');
      const messageSender = createMockMessageSender();
      const handler = buildHandler({ chatService, voiceHandler, messageSender });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const voiceCallback = bot.on.mock.calls.find((c: any[]) => c[0] === 'voice')[1];
      const ctx = {
        message: { voice: { file_id: 'voice-file-123' } },
        chat: { id: 200 },
        from: { id: 100, first_name: 'Test' },
      };

      await voiceCallback(ctx);

      expect(voiceHandler.transcribe).toHaveBeenCalledWith(bot, 'voice-file-123');
      expect(chatService.sendMessage).toHaveBeenCalledWith(
        undefined,
        'Hello from voice',
        expect.objectContaining({ scopeKey: 'telegram:abc123' }),
      );
    });

    it('sends error when transcription fails', async () => {
      const voiceHandler = createMockVoiceHandler(null);
      const messageSender = createMockMessageSender();
      const chatService = createMockChatService();
      const handler = buildHandler({ chatService, voiceHandler, messageSender });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const voiceCallback = bot.on.mock.calls.find((c: any[]) => c[0] === 'voice')[1];
      const ctx = {
        message: { voice: { file_id: 'bad-file' } },
        chat: { id: 200 },
        from: { id: 100 },
      };

      await voiceCallback(ctx);

      expect(messageSender.sendError).toHaveBeenCalledWith(
        bot,
        200,
        'Could not transcribe the voice message. Please try again or send text.',
        expect.objectContaining({ actor: 'system', correlationId: 'bot:200:voice:transcribe-failed' }),
      );
      expect(chatService.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('/new command', () => {
    it('clears conversation for the chat', async () => {
      const messageSender = createMockMessageSender();
      const handler = buildHandler({ messageSender });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const newCallback = bot.command.mock.calls.find((c: any[]) => c[0] === 'new')[1];
      const ctx = {
        chat: { id: 200 },
        from: { id: 100 },
      };

      await newCallback(ctx);

      // Verify response was sent
      expect(messageSender.sendHtml).toHaveBeenCalledWith(
        bot,
        200,
        expect.stringContaining('Новый диалог'),
        expect.objectContaining({ actor: 'system', correlationId: 'bot:200:new' }),
      );
    });
  });

  describe('progressive edit mode', () => {
    it('sends placeholder then edits with streamed content', async () => {
      const chatService = createMockChatService();
      const messageSender = createMockMessageSender();
      const handler = buildHandler({ chatService, messageSender, progressive: true });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const textHandler = bot.on.mock.calls.find((c: any[]) => c[0] === 'text')[1];
      const ctx = {
        message: { text: 'Hello' },
        chat: { id: 200 },
        from: { id: 100 },
      };

      await textHandler(ctx);

      expect(messageSender.sendPlaceholder).toHaveBeenCalledWith(
        bot,
        200,
        '⏳',
        expect.objectContaining({ actor: 'agent', audit: false, correlationId: 'bot:200:stream:placeholder' }),
      );
      expect(chatService.streamMessage).toHaveBeenCalled();
      // Final edit with full content
      expect(messageSender.editMessage).toHaveBeenCalledWith(
        bot,
        200,
        42,
        'Hello world',
        expect.objectContaining({ actor: 'agent', correlationId: 'bot:200:conversation:conv-1' }),
      );
    });

    it('falls back to simple mode if placeholder fails', async () => {
      const chatService = createMockChatService();
      const messageSender = createMockMessageSender();
      messageSender.sendPlaceholder = jest.fn().mockResolvedValue(undefined);
      const handler = buildHandler({ chatService, messageSender, progressive: true });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const textHandler = bot.on.mock.calls.find((c: any[]) => c[0] === 'text')[1];
      const ctx = {
        message: { text: 'Hello' },
        chat: { id: 200 },
        from: { id: 100 },
      };

      await textHandler(ctx);

      // Should fall back to sendMessage (simple mode)
      expect(chatService.sendMessage).toHaveBeenCalled();
      expect(messageSender.sendText).toHaveBeenCalled();
    });
  });

  describe('conversation persistence', () => {
    it('reuses conversationId across messages in the same chat', async () => {
      const chatService = createMockChatService();
      const handler = buildHandler({ chatService });

      const bot = createMockBot();
      handler.registerHandlers(bot);

      const textHandler = bot.on.mock.calls.find((c: any[]) => c[0] === 'text')[1];
      const ctx = {
        message: { text: 'First message' },
        chat: { id: 200 },
        from: { id: 100 },
      };

      // First message — no conversationId
      await textHandler(ctx);
      expect(chatService.sendMessage).toHaveBeenCalledWith(undefined, 'First message', expect.any(Object));

      // Second message — should reuse conv-1
      ctx.message.text = 'Second message';
      await textHandler(ctx);
      expect(chatService.sendMessage).toHaveBeenCalledWith('conv-1', 'Second message', expect.any(Object));
    });
  });
});
