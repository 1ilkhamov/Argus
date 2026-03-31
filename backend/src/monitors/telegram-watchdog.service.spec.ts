import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MonitorRepository } from './monitor.repository';
import { TelegramWatchdogService } from './telegram-watchdog.service';
import { SettingsService } from '../settings/settings.service';
import { TelegramClientMessagesRepository } from '../telegram-client/telegram-client-messages.repository';
import { TelegramClientRepository } from '../telegram-client/telegram-client.repository';
import type { TgMonitoredChat } from '../telegram-client/telegram-client.types';
import { PendingNotifyService } from '../tools/core/pending-notify.service';
import { TelegramOutboundService } from '../telegram-runtime/telegram-outbound.service';

const createConfigService = (dbPath: string): ConfigService => ({
  get: jest.fn((key: string, defaultValue?: unknown) => {
    if (key === 'storage.memoryDbFilePath') {
      return dbPath;
    }
    if (key === 'monitors.telegramWatchdog.intervalSeconds') {
      return 30;
    }
    if (key === 'tools.notify.telegramBotToken') {
      return 'bot-token';
    }
    if (key === 'tools.notify.telegramChatId') {
      return '999';
    }
    if (key === 'telegram.allowedUsers') {
      return '999';
    }
    return defaultValue;
  }),
}) as unknown as ConfigService;

describe('TelegramWatchdogService', () => {
  it('alerts once for an unanswered message, dedupes repeats, and resolves after owner reply', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-watchdog-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);

    try {
      const monitorRepository = new MonitorRepository(configService);
      monitorRepository.onModuleInit();
      const monitoredChatRepository = new TelegramClientRepository(configService);
      monitoredChatRepository.onModuleInit();
      const messagesRepository = new TelegramClientMessagesRepository(configService);
      messagesRepository.onModuleInit();

      const settingsService = {
        getValue: jest.fn(async (key: string) => {
          if (key === 'telegram.bot_token') {
            return 'bot-token';
          }
          if (key === 'tools.notify.telegram_chat_id') {
            return '999';
          }
          if (key === 'telegram.allowed_users') {
            return '999';
          }
          return '';
        }),
      } as unknown as SettingsService;

      const pendingNotify = {
        setPending: jest.fn(),
      } as unknown as PendingNotifyService;

      const outboundService = {
        executeSend: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramOutboundService;

      const service = new TelegramWatchdogService(
        configService,
        settingsService,
        monitorRepository,
        monitoredChatRepository,
        messagesRepository,
        pendingNotify,
        outboundService,
      );

      const monitoredChat: TgMonitoredChat = await monitoredChatRepository.create({
        chatId: '-100400',
        chatTitle: 'Ops Inbox',
        chatType: 'group',
        mode: 'manual',
        cooldownSeconds: 30,
      });

      const inboundAt = new Date(Date.now() - 5 * 60_000).toISOString();
      await messagesRepository.save({
        chatId: monitoredChat.chatId,
        tgMessageId: 1001,
        senderId: 'user-1',
        senderName: 'Alice',
        text: 'Need your approval on the deployment.',
        isOutgoing: false,
        timestamp: inboundAt,
      });

      const rule = await service.createRule({
        monitoredChatId: monitoredChat.id,
        thresholdSeconds: 60,
      });

      const first = await service.runRule(rule.id);
      expect(first.evaluationStatus).toBe('alerted');
      expect(first.alertTriggered).toBe(true);
      expect((outboundService.executeSend as jest.Mock).mock.calls).toHaveLength(1);

      const second = await service.runRule(rule.id);
      expect(second.evaluationStatus).toBe('deduped');
      expect(second.alertTriggered).toBe(false);
      expect((outboundService.executeSend as jest.Mock).mock.calls).toHaveLength(1);

      await messagesRepository.save({
        chatId: monitoredChat.chatId,
        tgMessageId: 1002,
        senderId: 'owner',
        senderName: 'Owner',
        text: 'Approved, shipping it now.',
        isOutgoing: true,
        replyToId: 1001,
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const third = await service.runRule(rule.id);
      expect(third.evaluationStatus).toBe('resolved');
      expect(third.alertTriggered).toBe(false);

      const states = await service.listStates();
      expect(states).toHaveLength(1);
      expect(states[0]).toEqual(expect.objectContaining({
        ruleId: rule.id,
        status: 'idle',
        lastInboundMessageId: 1001,
        lastOwnerReplyMessageId: 1002,
        lastEvaluationStatus: 'resolved',
      }));

      const alerts = await service.listAlertHistory(rule.id, 10);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual(expect.objectContaining({
        ruleId: rule.id,
        monitoredChatId: monitoredChat.id,
        lastInboundMessageId: 1001,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('observes unanswered state without alert before the threshold is reached', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'argus-watchdog-'));
    const dbPath = join(tempDir, 'memory.db');
    const configService = createConfigService(dbPath);

    try {
      const monitorRepository = new MonitorRepository(configService);
      monitorRepository.onModuleInit();
      const monitoredChatRepository = new TelegramClientRepository(configService);
      monitoredChatRepository.onModuleInit();
      const messagesRepository = new TelegramClientMessagesRepository(configService);
      messagesRepository.onModuleInit();

      const service = new TelegramWatchdogService(
        configService,
        { getValue: jest.fn(async () => '') } as unknown as SettingsService,
        monitorRepository,
        monitoredChatRepository,
        messagesRepository,
        { setPending: jest.fn() } as unknown as PendingNotifyService,
        { executeSend: jest.fn().mockResolvedValue(undefined) } as unknown as TelegramOutboundService,
      );

      const monitoredChat = await monitoredChatRepository.create({
        chatId: '-100401',
        chatTitle: 'Recent Ping',
        chatType: 'group',
        mode: 'manual',
        cooldownSeconds: 30,
      });

      await messagesRepository.save({
        chatId: monitoredChat.chatId,
        tgMessageId: 2001,
        senderId: 'user-2',
        senderName: 'Bob',
        text: 'Ping?',
        isOutgoing: false,
        timestamp: new Date(Date.now() - 15_000).toISOString(),
      });

      const rule = await service.createRule({
        monitoredChatId: monitoredChat.id,
        thresholdSeconds: 120,
      });

      const evaluation = await service.runRule(rule.id);
      expect(evaluation.evaluationStatus).toBe('observed');
      expect(evaluation.alertTriggered).toBe(false);

      const states = await service.listStates();
      expect(states[0]).toEqual(expect.objectContaining({
        ruleId: rule.id,
        status: 'unanswered',
        lastEvaluationStatus: 'observed',
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
