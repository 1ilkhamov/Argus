import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { DEFAULT_AGENT_USER_PROFILE } from '../../src/agent/profile/user-profile.types';
import { ConversationExecutionStateService } from '../../src/chat/runtime/conversation-execution-state.service';
import { CronJobRunRepository } from '../../src/cron/cron-run.repository';
import { CronSchedulerService } from '../../src/cron/cron-scheduler.service';
import { LOG_DIR } from '../../src/common/logger/file-logger.service';
import { LlmService } from '../../src/llm/llm.service';
import { MemoryService } from '../../src/memory/memory.service';
import { MonitorRepository } from '../../src/monitors/monitor.repository';
import { TurnResolutionDiagnosticsService } from '../../src/chat/runtime/turn-resolution-diagnostics.service';
import { TelegramClientMonitorRuntimeService } from '../../src/telegram-client/telegram-client-monitor-runtime.service';
import { TelegramClientRepository } from '../../src/telegram-client/telegram-client.repository';
import { TelegramOutboundAuditRepository } from '../../src/telegram-runtime/telegram-outbound-audit.repository';
import { PendingNotifyService } from '../../src/tools/core/pending-notify.service';

const EMPTY_EXTRACTION_JSON = JSON.stringify({
  facts: [],
  episodes: [],
  invalidatedFactKeys: [],
  invalidatedEpisodeKinds: [],
});

describe('Ops admin surfaces (e2e)', () => {
  let app: INestApplication;
  let tempDir: string;
  let cronRunRepository: CronJobRunRepository;
  let cronScheduler: CronSchedulerService;
  let monitorRepository: MonitorRepository;
  let monitoredChatRepository: TelegramClientRepository;
  let telegramClientMonitorRuntimeService: TelegramClientMonitorRuntimeService;
  let outboundAuditRepository: TelegramOutboundAuditRepository;
  let pendingNotifyService: PendingNotifyService;
  let memoryService: MemoryService;
  let executionStateService: ConversationExecutionStateService;
  let turnResolutionDiagnosticsService: TurnResolutionDiagnosticsService;
  const logFile = 'app-2099-12-31.log';
  const logPath = join(LOG_DIR, logFile);

  const adminGet = (path: string, ip: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('x-api-key', 'test-admin-key')
      .set('x-forwarded-for', ip);

  const adminPost = (path: string, ip: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('x-api-key', 'test-admin-key')
      .set('x-forwarded-for', ip);

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'argus-ops-e2e-'));

    process.env.NODE_ENV = 'test';
    process.env.AUTH_ENABLED = 'true';
    process.env.AUTH_API_KEYS = 'test-key';
    process.env.AUTH_ADMIN_API_KEY = 'test-admin-key';
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_BACKEND = 'memory';
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.STORAGE_DB_FILE = join(tempDir, 'chat.db');
    process.env.STORAGE_MEMORY_DB_FILE = join(tempDir, 'memory.db');
    process.env.STORAGE_DATA_FILE = join(tempDir, 'chat-store.json');
    process.env.LLM_API_KEY = 'test-llm-key';
    process.env.LLM_API_BASE = 'http://localhost:8317/v1';
    process.env.CORS_ORIGIN = 'http://localhost:2101';
    process.env.MEMORY_QDRANT_URL = '';
    process.env.TELEGRAM_ENABLED = 'false';

    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    writeFileSync(
      logPath,
      '2099-12-31 09:00:00.000 LOG     [HTTP] {"event":"http_request_completed","statusCode":200,"path":"/api/health"}\n',
    );

    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LlmService)
      .useValue({
        complete: async () => ({
          content: EMPTY_EXTRACTION_JSON,
          model: 'test-model',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        }),
        async *stream() {
          yield { content: '', done: true };
        },
        checkHealth: async () => ({
          status: 'up',
          model: 'test-model',
          responseTimeMs: 1,
        }),
        getRuntimeProfile: () => ({
          provider: 'openai',
          model: 'test-model',
          maxCompletionTokens: 4096,
          contextWindowTokens: 128000,
          completionTimeoutMs: 120000,
          streamTimeoutMs: 120000,
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    cronRunRepository = app.get(CronJobRunRepository);
    cronScheduler = app.get(CronSchedulerService);
    monitorRepository = app.get(MonitorRepository);
    monitoredChatRepository = app.get(TelegramClientRepository);
    telegramClientMonitorRuntimeService = app.get(TelegramClientMonitorRuntimeService);
    outboundAuditRepository = app.get(TelegramOutboundAuditRepository);
    pendingNotifyService = app.get(PendingNotifyService);
    memoryService = app.get(MemoryService);
    executionStateService = app.get(ConversationExecutionStateService);
    turnResolutionDiagnosticsService = app.get(TurnResolutionDiagnosticsService);
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(logPath, { force: true });
  });

  it('rejects admin-only ops routes without an admin API key', async () => {
    await request(app.getHttpServer())
      .get('/api/logs/search')
      .set('x-api-key', 'test-key')
      .set('x-forwarded-for', '10.0.1.1')
      .expect(401);
  });

  it('returns log search results through the admin API', async () => {
    const response = await adminGet('/api/logs/search?event=http_request_completed&date=2099-12-31&fileKind=app', '10.0.1.2')
      .expect(200);

    expect(response.body.filesScanned).toContain(logFile);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0]).toEqual(expect.objectContaining({
      file: logFile,
      level: 'log',
      context: 'HTTP',
      event: 'http_request_completed',
    }));
  });

  it('creates and lists monitor rules and runtime state through the admin API', async () => {
    const monitoredChat = await monitoredChatRepository.create({
      chatId: '-100500',
      chatTitle: 'Ops Admin Test',
      chatType: 'group',
      mode: 'manual',
      cooldownSeconds: 30,
    });

    const createResponse = await adminPost('/api/monitors/rules', '10.0.1.3')
      .send({
        monitoredChatId: monitoredChat.id,
        thresholdSeconds: 120,
      })
      .expect(201);

    expect(createResponse.body).toEqual(expect.objectContaining({
      monitoredChatId: monitoredChat.id,
      thresholdSeconds: 120,
      enabled: true,
      ruleType: 'telegram_unanswered_message_monitor',
    }));

    const listRulesResponse = await adminGet('/api/monitors/rules', '10.0.1.4').expect(200);
    expect(listRulesResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createResponse.body.id,
          monitoredChatId: monitoredChat.id,
        }),
      ]),
    );

    const listStatesResponse = await adminGet('/api/monitors/states', '10.0.1.5').expect(200);
    expect(listStatesResponse.body).toEqual([]);
  });

  it('returns cron jobs and recent cron runs through the admin API', async () => {
    const job = await cronScheduler.createJob({
      name: 'Ops cron visibility',
      task: 'Produce an ops status snapshot.',
      scheduleType: 'interval',
      schedule: '60000',
      maxRuns: 0,
    });

    const run = await cronRunRepository.create({
      jobId: job.id,
      jobName: job.name,
      scheduleType: job.scheduleType,
      schedule: job.schedule,
      attempt: 1,
      scheduledFor: new Date('2099-12-31T09:05:00.000Z').toISOString(),
      startedAt: new Date('2099-12-31T09:05:05.000Z').toISOString(),
    });
    await cronRunRepository.update(run.id, {
      finishedAt: new Date('2099-12-31T09:05:07.000Z').toISOString(),
      status: 'notified',
      resultStatus: 'success',
      notificationStatus: 'sent',
      outputPreview: 'Status snapshot sent.',
      toolRoundsUsed: 1,
      toolNames: ['notify'],
    });

    const jobsResponse = await adminGet('/api/cron/jobs', '10.0.1.6').expect(200);
    expect(jobsResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: job.id,
          name: 'Ops cron visibility',
          scheduleType: 'interval',
        }),
      ]),
    );

    const runsResponse = await adminGet(`/api/cron/runs?jobId=${encodeURIComponent(job.id)}`, '10.0.1.7').expect(200);
    expect(runsResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: run.id,
          jobId: job.id,
          status: 'notified',
          resultStatus: 'success',
          notificationStatus: 'sent',
          outputPreview: 'Status snapshot sent.',
        }),
      ]),
    );
  });

  it('returns outbound audit visibility through the admin API', async () => {
    const event = await outboundAuditRepository.create({
      channel: 'telegram_bot',
      action: 'notify',
      actor: 'watchdog',
      origin: 'telegram_watchdog',
      targetChatId: '999',
      targetChatTitle: 'Ops On-Call',
      monitoredChatId: 'mon-chat-1',
      monitoredMode: 'manual',
      policyDecision: 'allow',
      policyReasonCode: 'ALLOW_BOT_CHANNEL',
      result: 'sent',
      payloadPreview: 'Watchdog alert delivered',
    });

    const response = await adminGet('/api/telegram-outbound-audit?actor=watchdog&result=sent&chatId=999', '10.0.1.8')
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: event.id,
          actor: 'watchdog',
          origin: 'telegram_watchdog',
          result: 'sent',
          targetChatId: '999',
        }),
      ]),
    );
  });

  it('returns notify routing visibility through the admin API', async () => {
    pendingNotifyService.setPending(901, {
      chatId: '-100901',
      chatTitle: 'Pending Notify Chat',
      question: 'Please review this alert',
      createdAt: Date.now(),
      sourceBotMessageId: 901,
    });
    pendingNotifyService.setPending(902, {
      chatId: '-100902',
      chatTitle: 'Awaiting Reply Chat',
      question: 'Need your answer',
      createdAt: Date.now() + 1,
      sourceBotMessageId: 902,
    });
    pendingNotifyService.setAwaitingReply(7002, {
      chatId: '-100902',
      chatTitle: 'Awaiting Reply Chat',
      question: 'Need your answer',
      createdAt: Date.now() + 1,
      sourceBotMessageId: 902,
    });
    pendingNotifyService.setPending(903, {
      chatId: '-100903',
      chatTitle: 'Completed Reply Chat',
      question: 'Reply back to me',
      createdAt: Date.now() + 2,
      sourceBotMessageId: 903,
    });
    pendingNotifyService.setAwaitingReply(7003, {
      chatId: '-100903',
      chatTitle: 'Completed Reply Chat',
      question: 'Reply back to me',
      createdAt: Date.now() + 2,
      sourceBotMessageId: 903,
    });
    pendingNotifyService.completeAwaitingReply(7003, 'Done.', 'notify-reply:e2e');

    const response = await adminGet('/api/notify-routing?limit=10', '10.0.1.9').expect(200);

    expect(response.body.pendingMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botMessageId: 901,
          chatId: '-100901',
        }),
        expect.objectContaining({
          botMessageId: 902,
          chatId: '-100902',
        }),
      ]),
    );
    expect(response.body.awaitingReplies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botChatId: 7002,
          sourceBotMessageId: 902,
          chatId: '-100902',
        }),
      ]),
    );
    expect(response.body.recentRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botChatId: 7003,
          sourceBotMessageId: 903,
          chatId: '-100903',
          routeStatus: 'sent',
          replyText: 'Done.',
          correlationId: 'notify-reply:e2e',
        }),
      ]),
    );
  });

  it('returns unified diagnostics through the admin API', async () => {
    const scopeKey = 'ops:e2e';
    const conversationId = 'conv-ops-1';
    const userMessageId = 'msg-ops-1';
    const observedAt = new Date('2099-12-31T10:30:00.000Z').toISOString();
    const monitoredChat = await monitoredChatRepository.create({
      chatId: '-100777',
      chatTitle: 'Unified Diagnostics Chat',
      chatType: 'group',
      mode: 'auto',
      cooldownSeconds: 45,
      systemNote: 'Unified runtime source test',
    });
    await telegramClientMonitorRuntimeService.recordProcessing({
      monitoredChat,
      queueLength: 1,
      conversationId,
      observedAt,
    });

    await memoryService.saveManagedMemoryState({
      scopeKey,
      interactionPreferences: DEFAULT_AGENT_USER_PROFILE,
      userFacts: [
        {
          key: 'project',
          value: 'Argus 0.2.3',
          source: 'explicit_user_statement',
          confidence: 0.98,
          pinned: true,
          updatedAt: observedAt,
        },
      ],
      episodicMemories: [
        {
          id: 'episode-ops-1',
          kind: 'goal',
          summary: 'Ship unified ops diagnostics',
          source: 'explicit_user_statement',
          salience: 0.91,
          pinned: true,
          updatedAt: observedAt,
        },
      ],
      expectedVersion: 0,
      lastProcessedUserMessage: {
        conversationId,
        messageId: userMessageId,
        createdAt: observedAt,
      },
    });

    turnResolutionDiagnosticsService.record({
      timestamp: observedAt,
      conversationId,
      scopeKey,
      mode: 'assistant',
      modeSource: 'explicit',
      executionMode: 'staged',
      executionReasons: ['long_turn', 'budget_pressure_high'],
      counts: {
        userFacts: 1,
        episodicMemories: 1,
        recalledMemories: 0,
        archiveEvidence: 0,
        identityTraits: 3,
      },
      soulSource: 'data/soul.yml',
      prompt: {
        provider: 'openai',
        model: 'test-model',
        maxContextTokens: 128000,
        reservedCompletionTokens: 4096,
        reservedRetryTokens: 1024,
        reservedToolRoundTokens: 768,
        reservedStructuredFinishTokens: 256,
        availablePromptTokens: 121856,
        estimatedInputTokens: 1200,
        finalInputTokens: 1400,
        trimmedSectionIds: ['archive'],
        trimmedHistoryCount: 2,
        compressedSectionIds: ['recalled_memory'],
        budgetPressure: 'high',
        systemSectionCount: 6,
        historyMessageCount: 14,
      },
      checkpoint: {
        active: true,
        resumed: false,
        phase: 'plan',
      },
      memoryGrounding: {
        isMemoryQuestion: false,
        evidenceStrength: 'structured',
        uncertaintyFirst: true,
      },
    });

    await executionStateService.saveCheckpoint({
      conversationId,
      scopeKey,
      userMessageId,
      mode: 'staged',
      phase: 'plan',
      workingSummary: 'Assembling diagnostics response',
      remainingSteps: ['summarize runtime state', 'emit response'],
      budget: {
        provider: 'openai',
        model: 'test-model',
        maxContextTokens: 128000,
        reservedCompletionTokens: 4096,
        reservedRetryTokens: 1024,
        reservedToolRoundTokens: 768,
        reservedStructuredFinishTokens: 256,
        availablePromptTokens: 121856,
        estimatedInputTokens: 1200,
        finalInputTokens: 1400,
        trimmedSectionIds: ['archive'],
        trimmedHistoryCount: 2,
        compressedSectionIds: ['recalled_memory'],
        budgetPressure: 'high',
      },
      expiresAt: new Date('2099-12-31T22:30:00.000Z').toISOString(),
    });

    const response = await adminGet(`/api/ops/diagnostics?scopeKey=${encodeURIComponent(scopeKey)}`, '10.0.1.10').expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        timestamp: expect.any(String),
        llm: expect.objectContaining({
          provider: 'openai',
          model: 'test-model',
        }),
        startup: expect.objectContaining({
          telegram: expect.objectContaining({
            enabled: false,
            tokenConfigured: false,
            tokenSource: 'none',
            running: false,
          }),
          applescript: expect.objectContaining({
            platform: expect.any(String),
            supported: expect.any(Boolean),
            enabled: expect.any(Boolean),
            registered: expect.any(Boolean),
            status: expect.any(String),
          }),
        }),
        memory: expect.objectContaining({
          scopeKey,
          interactionPreferencesConfigured: true,
          processingState: expect.objectContaining({
            lastProcessedUserMessageId: userMessageId,
          }),
          userFacts: {
            total: 1,
            pinned: 1,
          },
          episodicMemories: {
            total: 1,
            pinned: 1,
          },
        }),
        telegramClient: expect.objectContaining({
          monitoredChats: expect.arrayContaining([
            expect.objectContaining({
              id: monitoredChat.id,
              chatId: monitoredChat.chatId,
              mode: 'auto',
            }),
          ]),
          runtimeStates: expect.arrayContaining([
            expect.objectContaining({
              monitoredChatId: monitoredChat.id,
              chatId: monitoredChat.chatId,
              status: 'processing',
              queueLength: 1,
            }),
          ]),
        }),
        continuation: expect.objectContaining({
          activeCount: 1,
        }),
        qdrant: expect.objectContaining({
          configured: false,
          ready: false,
          circuitOpen: false,
          consecutiveFailures: 0,
        }),
      }),
    );
    expect(response.body.memory.processingState.version).toBeGreaterThan(0);
    expect(response.body.prompt.latest).toEqual(
      expect.objectContaining({
        conversationId,
        scopeKey,
        executionMode: 'staged',
        executionReasons: ['long_turn', 'budget_pressure_high'],
        checkpoint: expect.objectContaining({
          active: true,
          phase: 'plan',
        }),
        prompt: expect.objectContaining({
          budgetPressure: 'high',
          reservedToolRoundTokens: 768,
          reservedStructuredFinishTokens: 256,
          availablePromptTokens: 121856,
          trimmedHistoryCount: 2,
          trimmedSectionIds: ['archive'],
          compressedSectionIds: ['recalled_memory'],
        }),
      }),
    );
    expect(response.body.continuation.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId,
          scopeKey,
          userMessageId,
          phase: 'plan',
          status: 'active',
          budgetPressure: 'high',
        }),
      ]),
    );
    expect(response.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prompt_budget_high',
          subject: 'prompt',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'prompt_trimming_active',
          subject: 'prompt',
          severity: 'info',
        }),
        expect.objectContaining({
          code: 'active_continuations_present',
          subject: 'continuation',
          severity: 'info',
        }),
      ]),
    );
  });

  it('returns structured operational events through the admin API', async () => {
    const job = await cronScheduler.createJob({
      name: 'Ops events cron',
      task: 'Collect structured ops signals.',
      scheduleType: 'interval',
      schedule: '60000',
      notificationPolicy: 'never',
    });
    const monitorRule = await monitorRepository.createRule({
      monitoredChatId: 'monitored-ops-events',
      name: 'Ops events rule',
      thresholdSeconds: 300,
    });
    const run = await cronRunRepository.create({
      jobId: job.id,
      jobName: job.name,
      scheduleType: job.scheduleType,
      schedule: job.schedule,
      attempt: 1,
      scheduledFor: new Date('2099-12-31T10:00:00.000Z').toISOString(),
      startedAt: new Date('2099-12-31T10:00:05.000Z').toISOString(),
    });
    await cronRunRepository.update(run.id, {
      finishedAt: new Date('2099-12-31T10:00:07.000Z').toISOString(),
      status: 'success',
      resultStatus: 'success',
      notificationStatus: 'skipped',
      outputPreview: 'Structured ops collected.',
    });

    await monitorRepository.createEvaluation({
      ruleId: monitorRule.id,
      ruleType: 'telegram_unanswered_message_monitor',
      monitoredChatId: monitorRule.monitoredChatId,
      chatId: '999',
      chatTitle: 'Ops Events Chat',
      stateStatus: 'alerted',
      evaluationStatus: 'alerted',
      lastInboundMessageId: 501,
      lastOwnerReplyMessageId: null,
      dedupeKey: 'dedupe-ops-events',
      correlationId: 'ops-monitor-correlation',
      alertTriggered: true,
      message: 'Owner reply overdue.',
      evaluatedAt: new Date('2099-12-31T10:01:00.000Z').toISOString(),
    });

    await outboundAuditRepository.create({
      channel: 'telegram_bot',
      action: 'notify',
      actor: 'cron',
      origin: 'cron_executor',
      targetChatId: '999',
      targetChatTitle: 'Ops Events Chat',
      policyDecision: 'allow',
      policyReasonCode: 'ALLOW_BOT_CHANNEL',
      result: 'sent',
      correlationId: 'ops-outbound-correlation',
      payloadPreview: 'Outbound audit for structured ops.',
    });

    pendingNotifyService.setPending(904, {
      chatId: '-100904',
      chatTitle: 'Ops Events Reply Chat',
      question: 'Reply for structured ops',
      createdAt: Date.now() + 3,
      sourceBotMessageId: 904,
    });
    pendingNotifyService.setAwaitingReply(7004, {
      chatId: '-100904',
      chatTitle: 'Ops Events Reply Chat',
      question: 'Reply for structured ops',
      createdAt: Date.now() + 3,
      sourceBotMessageId: 904,
    });
    pendingNotifyService.completeAwaitingReply(7004, 'Structured reply sent.', 'ops-notify-correlation');

    const response = await adminGet('/api/ops/events?limit=20', '10.0.1.10').expect(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'cron_run',
          jobId: job.id,
          status: 'success',
        }),
        expect.objectContaining({
          kind: 'monitor_evaluation',
          ruleId: monitorRule.id,
          correlationId: 'ops-monitor-correlation',
          chatId: '999',
        }),
        expect.objectContaining({
          kind: 'monitor_alert',
          ruleId: monitorRule.id,
          correlationId: 'ops-monitor-correlation',
          chatId: '999',
        }),
        expect.objectContaining({
          kind: 'telegram_outbound',
          correlationId: 'ops-outbound-correlation',
          chatId: '999',
        }),
        expect.objectContaining({
          kind: 'notify_route',
          correlationId: 'ops-notify-correlation',
          chatId: '-100904',
        }),
      ]),
    );

    const filteredResponse = await adminGet('/api/ops/events?kind=telegram_outbound&chatId=999&limit=20', '10.0.1.11').expect(200);
    expect(filteredResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'telegram_outbound',
          chatId: '999',
          correlationId: 'ops-outbound-correlation',
        }),
      ]),
    );
    expect(filteredResponse.body.every((event: { kind: string; chatId: string | null }) => event.kind === 'telegram_outbound' && event.chatId === '999')).toBe(true);
  });
});
