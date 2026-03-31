import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PendingNotifyRepository } from './pending-notify.repository';
import { PendingNotifyService } from './pending-notify.service';
import { PENDING_TTL_MS, type PendingNotify } from './pending-notify.types';

const createConfigService = (dbPath: string): ConfigService => ({
  get: jest.fn((key: string, defaultValue?: unknown) => {
    if (key === 'storage.memoryDbFilePath') {
      return dbPath;
    }
    return defaultValue;
  }),
}) as unknown as ConfigService;

describe('PendingNotifyService', () => {
  it('persists pending routes and awaiting replies across service instances', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-pending-notify-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);
    const info: PendingNotify = {
      chatId: '-100123',
      chatTitle: 'Ops Chat',
      question: 'Ping me later',
      createdAt: Date.now(),
      sourceBotMessageId: null,
    };

    try {
      const repositoryA = new PendingNotifyRepository(configService);
      repositoryA.onModuleInit();
      const serviceA = new PendingNotifyService(repositoryA);
      serviceA.setPending(42, info);
      serviceA.setAwaitingReply(7, info);

      const repositoryB = new PendingNotifyRepository(configService);
      repositoryB.onModuleInit();
      const serviceB = new PendingNotifyService(repositoryB);

      expect(serviceB.getPending(42)).toEqual(info);
      expect(serviceB.consumeAwaitingReply(7)).toEqual(info);
      expect(serviceB.consumeAwaitingReply(7)).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('expires stale pending entries', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-pending-notify-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);
    const staleInfo: PendingNotify = {
      chatId: '-100999',
      chatTitle: 'Expired Chat',
      question: 'Old question',
      createdAt: Date.now() - PENDING_TTL_MS - 1_000,
    };

    try {
      const repository = new PendingNotifyRepository(configService);
      repository.onModuleInit();
      const service = new PendingNotifyService(repository);
      service.setPending(99, staleInfo);
      service.setAwaitingReply(11, staleInfo);

      expect(service.getPending(99)).toBeUndefined();
      expect(service.consumeAwaitingReply(11)).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns notify routing snapshot with active and completed flows', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-pending-notify-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);
    const completedInfo: PendingNotify = {
      chatId: '-100111',
      chatTitle: 'Completed Chat',
      question: 'Need a reply',
      createdAt: Date.now(),
      sourceBotMessageId: 42,
    };
    const activeInfo: PendingNotify = {
      chatId: '-100222',
      chatTitle: 'Active Chat',
      question: 'Still waiting',
      createdAt: Date.now() + 1,
      sourceBotMessageId: 43,
    };

    try {
      const repositoryA = new PendingNotifyRepository(configService);
      repositoryA.onModuleInit();
      const serviceA = new PendingNotifyService(repositoryA);
      serviceA.setPending(42, completedInfo);
      serviceA.setAwaitingReply(7, completedInfo);
      serviceA.completeAwaitingReply(7, 'Handled.', 'notify-reply:test-1');
      serviceA.setPending(43, activeInfo);
      serviceA.setAwaitingReply(8, activeInfo);

      const repositoryB = new PendingNotifyRepository(configService);
      repositoryB.onModuleInit();
      const serviceB = new PendingNotifyService(repositoryB);
      const snapshot = serviceB.getSnapshot(10);

      expect(snapshot.pendingMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            botMessageId: 43,
            chatId: '-100222',
          }),
        ]),
      );
      expect(snapshot.pendingMessages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ botMessageId: 42 }),
        ]),
      );
      expect(snapshot.awaitingReplies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            botChatId: 8,
            sourceBotMessageId: 43,
            chatId: '-100222',
          }),
        ]),
      );
      expect(snapshot.recentRoutes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            botChatId: 7,
            sourceBotMessageId: 42,
            chatId: '-100111',
            routeStatus: 'sent',
            replyText: 'Handled.',
            correlationId: 'notify-reply:test-1',
          }),
        ]),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
