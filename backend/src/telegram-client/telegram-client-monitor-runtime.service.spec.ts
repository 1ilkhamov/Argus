import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TelegramClientMonitorRuntimeRepository } from './telegram-client-monitor-runtime.repository';
import { TelegramClientMonitorRuntimeService } from './telegram-client-monitor-runtime.service';
import type { TgMonitoredChat } from './telegram-client.types';

const createConfigService = (dbPath: string): ConfigService => ({
  get: jest.fn((key: string, defaultValue?: unknown) => {
    if (key === 'storage.memoryDbFilePath') {
      return dbPath;
    }
    return defaultValue;
  }),
}) as unknown as ConfigService;

const monitoredChat: TgMonitoredChat = {
  id: 'chat-record-1',
  chatId: '-100200',
  chatTitle: 'Runtime Ops',
  chatType: 'group',
  mode: 'auto',
  cooldownSeconds: 30,
  systemNote: '',
  createdAt: new Date('2026-03-31T00:00:00.000Z').toISOString(),
  updatedAt: new Date('2026-03-31T00:00:00.000Z').toISOString(),
};

describe('TelegramClientMonitorRuntimeService', () => {
  it('persists runtime state transitions across service instances', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-monitor-runtime-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);

    try {
      const repositoryA = new TelegramClientMonitorRuntimeRepository(configService);
      repositoryA.onModuleInit();
      const serviceA = new TelegramClientMonitorRuntimeService(repositoryA);
      await serviceA.observeInbound({
        monitoredChat,
        messageId: 101,
        senderName: 'Alice',
        observedAt: '2026-03-31T10:00:00.000Z',
      });
      await serviceA.recordQueued({
        monitoredChat,
        queueLength: 1,
        queueActive: false,
        messageId: 101,
        senderName: 'Alice',
        observedAt: '2026-03-31T10:00:01.000Z',
      });
      await serviceA.recordProcessing({
        monitoredChat,
        queueLength: 0,
        queueActive: true,
        messageId: 101,
        senderName: 'Alice',
        observedAt: '2026-03-31T10:00:02.000Z',
      });
      await serviceA.recordReplySent({
        monitoredChat,
        queueLength: 0,
        conversationId: 'conv-1',
        replyMessageId: 202,
        observedAt: '2026-03-31T10:00:03.000Z',
      });

      const repositoryB = new TelegramClientMonitorRuntimeRepository(configService);
      repositoryB.onModuleInit();
      const serviceB = new TelegramClientMonitorRuntimeService(repositoryB);
      const states = await serviceB.listStates();

      expect(states).toHaveLength(1);
      expect(states[0]).toEqual(expect.objectContaining({
        chatId: monitoredChat.chatId,
        monitoredChatId: monitoredChat.id,
        chatTitle: monitoredChat.chatTitle,
        mode: monitoredChat.mode,
        status: 'idle',
        queueLength: 0,
        queueActive: false,
        lastInboundMessageId: 101,
        lastInboundSenderName: 'Alice',
        lastReplyMessageId: 202,
        lastReplyAt: '2026-03-31T10:00:03.000Z',
        lastConversationId: 'conv-1',
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records error state with the last error message', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-monitor-runtime-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);

    try {
      const repository = new TelegramClientMonitorRuntimeRepository(configService);
      repository.onModuleInit();
      const service = new TelegramClientMonitorRuntimeService(repository);
      await service.recordError({
        monitoredChat,
        queueLength: 2,
        queueActive: true,
        errorMessage: 'Policy denied send',
        observedAt: '2026-03-31T10:05:00.000Z',
      });

      const states = await service.listStates();
      expect(states).toHaveLength(1);
      expect(states[0]).toEqual(expect.objectContaining({
        status: 'error',
        queueLength: 2,
        queueActive: true,
        lastErrorMessage: 'Policy denied send',
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
