import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/resources/ops.api', async () => {
  const actual = await vi.importActual<typeof import('@/api/resources/ops.api')>('@/api/resources/ops.api');

  return {
    ...actual,
    opsApi: {
      listLogFiles: vi.fn(),
      searchLogs: vi.fn(),
      listMonitorRules: vi.fn(),
      createMonitorRule: vi.fn(),
      updateMonitorRule: vi.fn(),
      deleteMonitorRule: vi.fn(),
      runMonitorRule: vi.fn(),
      listMonitorStates: vi.fn(),
      listMonitorEvaluations: vi.fn(),
      listMonitorAlerts: vi.fn(),
      listTelegramClientRuntime: vi.fn(),
      listMonitoredChats: vi.fn(),
      getDiagnostics: vi.fn(),
      updateMonitoredChat: vi.fn(),
      listCronJobs: vi.fn(),
      createCronJob: vi.fn(),
      updateCronJob: vi.fn(),
      deleteCronJob: vi.fn(),
      pauseCronJob: vi.fn(),
      resumeCronJob: vi.fn(),
      listCronRuns: vi.fn(),
      listOutboundAudit: vi.fn(),
      listNotifyRouting: vi.fn(),
      listStructuredOperationalEvents: vi.fn(),
    },
  };
});

import {
  opsApi,
  type CronJob,
  type CronJobRun,
  type OpsDiagnosticsPayload,
  type OpsMonitoredChat,
  type PendingNotifySnapshot,
  type StructuredOperationalEvent,
  type TelegramClientMonitorRuntimeState,
  type TelegramWatchAlertRecord,
  type TelegramWatchEvaluationResult,
  type TelegramWatchRule,
  type TelegramWatchState,
} from '@/api/resources/ops.api';
import { useOpsStore } from './ops.store';

const runtimeState: TelegramClientMonitorRuntimeState = {
  chatId: 'chat-1',
  monitoredChatId: 'monitored-1',
  chatTitle: 'Ops Chat',
  mode: 'auto',
  status: 'idle',
  queueLength: 0,
  queueActive: false,
  lastInboundMessageId: null,
  lastInboundSenderName: null,
  lastInboundAt: null,
  lastReplyMessageId: null,
  lastReplyAt: null,
  lastConversationId: null,
  cooldownUntil: null,
  lastProcessedAt: null,
  lastErrorMessage: null,
  updatedAt: '2026-03-31T10:00:00.000Z',
};

const monitoredChat: OpsMonitoredChat = {
  id: 'monitored-1',
  chatId: 'chat-1',
  chatTitle: 'Ops Chat',
  chatType: 'group',
  mode: 'auto',
  cooldownSeconds: 60,
  systemNote: 'Primary monitored chat',
  createdAt: '2026-03-31T09:00:00.000Z',
  updatedAt: '2026-03-31T10:00:00.000Z',
};

const cronJob: CronJob = {
  id: 'job-1',
  name: 'Nightly sync',
  task: 'sync_data',
  scheduleType: 'cron',
  schedule: '0 * * * *',
  enabled: true,
  lastRunAt: '2026-03-31T09:55:00.000Z',
  nextRunAt: '2026-03-31T10:55:00.000Z',
  runCount: 1,
  maxRuns: 0,
  notificationPolicy: 'always',
  createdAt: '2026-03-31T09:00:00.000Z',
  updatedAt: '2026-03-31T10:00:00.000Z',
};

const cronRun: CronJobRun = {
  id: 'run-1',
  jobId: 'job-1',
  jobName: 'Nightly sync',
  scheduleType: 'cron',
  schedule: '0 * * * *',
  attempt: 1,
  scheduledFor: '2026-03-31T10:00:00.000Z',
  startedAt: '2026-03-31T10:00:00.000Z',
  finishedAt: '2026-03-31T10:00:05.000Z',
  status: 'success',
  resultStatus: 'success',
  notificationStatus: 'sent',
  outputPreview: 'OK',
  errorMessage: null,
  notificationErrorMessage: null,
  toolRoundsUsed: 1,
  toolNames: ['sync'],
  createdAt: '2026-03-31T10:00:00.000Z',
  updatedAt: '2026-03-31T10:00:05.000Z',
};

const monitorRule: TelegramWatchRule = {
  id: 'rule-1',
  ruleType: 'telegram_unanswered_message_monitor',
  monitoredChatId: 'monitored-1',
  name: 'Primary rule',
  thresholdSeconds: 900,
  enabled: true,
  createdAt: '2026-03-31T09:00:00.000Z',
  updatedAt: '2026-03-31T10:00:00.000Z',
};

const monitorState: TelegramWatchState = {
  ruleId: 'rule-1',
  ruleType: 'telegram_unanswered_message_monitor',
  monitoredChatId: 'monitored-1',
  chatId: 'chat-1',
  chatTitle: 'Ops Chat',
  status: 'idle',
  lastInboundMessageId: null,
  lastInboundSenderName: null,
  lastInboundAt: null,
  lastOwnerReplyMessageId: null,
  lastOwnerReplyAt: null,
  unansweredSince: null,
  lastEvaluatedAt: '2026-03-31T10:00:00.000Z',
  lastAlertedAt: null,
  dedupeKey: null,
  lastEvaluationStatus: 'observed',
  lastEvaluationMessage: 'No alert',
  updatedAt: '2026-03-31T10:00:00.000Z',
};

const monitorEvaluation: TelegramWatchEvaluationResult = {
  id: 'eval-1',
  ruleId: 'rule-1',
  ruleType: 'telegram_unanswered_message_monitor',
  monitoredChatId: 'monitored-1',
  chatId: 'chat-1',
  chatTitle: 'Ops Chat',
  stateStatus: 'idle',
  evaluationStatus: 'observed',
  lastInboundMessageId: null,
  lastOwnerReplyMessageId: null,
  dedupeKey: null,
  correlationId: 'corr-1',
  alertTriggered: false,
  message: 'Evaluated successfully',
  evaluatedAt: '2026-03-31T10:00:00.000Z',
};

const monitorAlert: TelegramWatchAlertRecord = {
  evaluationId: 'eval-1',
  ruleId: 'rule-1',
  monitoredChatId: 'monitored-1',
  chatId: 'chat-1',
  chatTitle: 'Ops Chat',
  correlationId: 'corr-1',
  lastInboundMessageId: null,
  dedupeKey: 'dedupe-1',
  message: 'Alert routed',
  evaluatedAt: '2026-03-31T10:00:00.000Z',
};

const notifySnapshot: PendingNotifySnapshot = {
  pendingMessages: [
    {
      botMessageId: 10,
      chatId: 'chat-1',
      chatTitle: 'Ops Chat',
      question: 'Need response?',
      createdAt: 1711879200000,
      expiresAt: 1711879260000,
    },
  ],
  awaitingReplies: [
    {
      botChatId: 20,
      sourceBotMessageId: 10,
      chatId: 'chat-1',
      chatTitle: 'Ops Chat',
      question: 'Need response?',
      createdAt: 1711879200000,
      expiresAt: 1711879260000,
    },
  ],
  recentRoutes: [
    {
      id: 'route-1',
      botChatId: 20,
      sourceBotMessageId: 10,
      chatId: 'chat-1',
      chatTitle: 'Ops Chat',
      question: 'Need response?',
      replyText: 'Handled',
      routeStatus: 'sent',
      correlationId: 'corr-1',
      createdAt: 1711879200000,
      completedAt: 1711879230000,
    },
  ],
};

const operationalEvent: StructuredOperationalEvent = {
  id: 'event-1',
  kind: 'notify_route',
  timestamp: '2026-03-31T10:00:00.000Z',
  severity: 'info',
  status: 'sent',
  source: 'notify-routing',
  title: 'Reply route delivered',
  summary: 'Reply was routed to the chat owner',
  correlationId: 'corr-1',
  chatId: 'chat-1',
  chatTitle: 'Ops Chat',
  jobId: null,
  jobName: null,
  ruleId: null,
  monitoredChatId: 'monitored-1',
  payload: { routeId: 'route-1' },
};

const diagnostics: OpsDiagnosticsPayload = {
  timestamp: '2026-03-31T10:05:00.000Z',
  health: {
    status: 'ok',
    timestamp: '2026-03-31T10:05:00.000Z',
    uptime: 120,
    checks: {
      storage: {
        status: 'up',
        driver: 'sqlite',
        target: 'data/argus.db',
        conversationCount: 3,
      },
      llm: {
        status: 'up',
        model: 'gpt-4.1-mini',
        responseTimeMs: 220,
      },
      embedding: {
        status: 'up',
      },
      qdrant: {
        status: 'down',
      },
    },
    metrics: {
      agent: {},
      memory: {
        totalEntries: 7,
      },
    },
  },
  llm: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    maxCompletionTokens: 4096,
    contextWindowTokens: 128000,
    completionTimeoutMs: 120000,
    streamTimeoutMs: 120000,
  },
  soul: {
    source: 'data/soul.yml',
    sourceKind: 'data_override',
    watching: true,
    configuredPath: '/app/data/soul.yml',
  },
  startup: {
    storage: {
      driver: 'sqlite',
      dataFilePath: 'data',
      dbFilePath: 'data/argus.db',
      memoryDbFilePath: 'data/memory.db',
      postgresConfigured: false,
    },
    telegram: {
      enabled: true,
      tokenConfigured: true,
      tokenSource: 'env',
      running: true,
      username: 'argus_bot',
      mode: 'polling',
      allowlistConfigured: true,
      allowedUsersCount: 1,
    },
    applescript: {
      platform: 'darwin',
      supported: true,
      enabled: true,
      registered: true,
      status: 'available',
    },
  },
  memory: {
    scopeKey: 'local:default',
    interactionPreferencesConfigured: true,
    processingState: {
      version: 2,
      lastProcessedUserMessageId: 'msg-1',
    },
    userFacts: {
      total: 2,
      pinned: 1,
    },
    episodicMemories: {
      total: 1,
      pinned: 0,
    },
  },
  prompt: {
    latest: {
      timestamp: '2026-03-31T10:05:00.000Z',
      conversationId: 'conv-1',
      scopeKey: 'local:default',
      mode: 'assistant',
      modeSource: 'explicit',
      executionMode: 'staged',
      executionReasons: ['long_turn', 'budget_pressure_high'],
      counts: {
        userFacts: 2,
        episodicMemories: 1,
        recalledMemories: 0,
        archiveEvidence: 0,
        identityTraits: 3,
      },
      soulSource: 'data/soul.yml',
      prompt: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        maxContextTokens: 128000,
        reservedCompletionTokens: 4096,
        reservedRetryTokens: 1024,
        reservedToolRoundTokens: 768,
        reservedStructuredFinishTokens: 256,
        availablePromptTokens: 121856,
        estimatedInputTokens: 900,
        finalInputTokens: 980,
        trimmedSectionIds: ['archive'],
        trimmedHistoryCount: 2,
        compressedSectionIds: [],
        budgetPressure: 'medium',
        systemSectionCount: 5,
        historyMessageCount: 12,
      },
      checkpoint: {
        active: true,
        resumed: false,
        phase: 'plan',
      },
      memoryGrounding: {
        isMemoryQuestion: false,
        evidenceStrength: 'strong',
        uncertaintyFirst: true,
      },
    },
    recent: [],
  },
  telegramClient: {
    monitoredChats: [monitoredChat],
    runtimeStates: [runtimeState],
  },
  continuation: {
    activeCount: 1,
    active: [
      {
        conversationId: 'conv-1',
        scopeKey: 'local:default',
        userMessageId: 'msg-1',
        phase: 'plan',
        status: 'active',
        updatedAt: '2026-03-31T10:05:00.000Z',
        expiresAt: '2026-03-31T22:05:00.000Z',
        budgetPressure: 'medium',
      },
    ],
  },
  qdrant: {
    configured: true,
    ready: false,
    circuitOpen: false,
    url: 'http://localhost:6333',
    collectionName: 'argus_memory',
    vectorSize: 1536,
    consecutiveFailures: 1,
  },
  warnings: [
    {
      code: 'qdrant_not_ready',
      severity: 'warning',
      subject: 'qdrant',
      message: 'Qdrant is configured but not ready for vector operations.',
      action: 'Verify Qdrant availability.',
    },
  ],
};

function resetOpsStore() {
  useOpsStore.setState({
    logs: [],
    logFiles: [],
    logFilesScanned: [],
    monitoredChats: [],
    monitorRules: [],
    monitorStates: [],
    monitorEvaluations: [],
    monitorAlerts: [],
    runtimeStates: [],
    diagnostics: null,
    cronJobs: [],
    cronRuns: [],
    outboundAuditEvents: [],
    notifyRouting: {
      pendingMessages: [],
      awaitingReplies: [],
      recentRoutes: [],
    },
    operationalEvents: [],
    isLoading: false,
    error: null,
    lastUpdatedAt: null,
  });
}

describe('useOpsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpsStore();
  });

  it('loads runtime states together with monitored chats', async () => {
    vi.mocked(opsApi.getDiagnostics).mockResolvedValue(diagnostics);

    await useOpsStore.getState().loadRuntimeStates();

    const state = useOpsStore.getState();
    expect(opsApi.listTelegramClientRuntime).not.toHaveBeenCalled();
    expect(opsApi.listMonitoredChats).not.toHaveBeenCalled();
    expect(opsApi.getDiagnostics).toHaveBeenCalledTimes(1);
    expect(state.runtimeStates).toEqual([runtimeState]);
    expect(state.monitoredChats).toEqual([monitoredChat]);
    expect(state.diagnostics).toEqual(diagnostics);
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.lastUpdatedAt).toEqual(expect.any(String));
  });

  it('reloads runtime state after updating a monitored chat', async () => {
    const updatedChat: OpsMonitoredChat = {
      ...monitoredChat,
      mode: 'manual',
      cooldownSeconds: 120,
      systemNote: 'Updated note',
      updatedAt: '2026-03-31T11:00:00.000Z',
    };
    const updatedRuntimeState: TelegramClientMonitorRuntimeState = {
      ...runtimeState,
      mode: 'manual',
      updatedAt: '2026-03-31T11:00:00.000Z',
    };

    vi.mocked(opsApi.updateMonitoredChat).mockResolvedValue(updatedChat);
    vi.mocked(opsApi.getDiagnostics).mockResolvedValue({
      ...diagnostics,
      telegramClient: {
        monitoredChats: [updatedChat],
        runtimeStates: [updatedRuntimeState],
      },
    });

    await expect(
      useOpsStore.getState().updateMonitoredChat('monitored-1', {
        mode: 'manual',
        cooldownSeconds: 120,
        systemNote: 'Updated note',
      }),
    ).resolves.toEqual(updatedChat);

    const state = useOpsStore.getState();
    expect(opsApi.updateMonitoredChat).toHaveBeenCalledWith('monitored-1', {
      mode: 'manual',
      cooldownSeconds: 120,
      systemNote: 'Updated note',
    });
    expect(opsApi.listTelegramClientRuntime).not.toHaveBeenCalled();
    expect(opsApi.listMonitoredChats).not.toHaveBeenCalled();
    expect(opsApi.getDiagnostics).toHaveBeenCalledTimes(1);
    expect(state.runtimeStates).toEqual([updatedRuntimeState]);
    expect(state.monitoredChats).toEqual([updatedChat]);
    expect(state.diagnostics).toEqual(expect.objectContaining({
      telegramClient: {
        monitoredChats: [updatedChat],
        runtimeStates: [updatedRuntimeState],
      },
    }));
    expect(state.error).toBeNull();
  });

  it('loads notify routing snapshot into the dedicated slice', async () => {
    vi.mocked(opsApi.listNotifyRouting).mockResolvedValue(notifySnapshot);

    await useOpsStore.getState().loadNotifyRouting(50);

    const state = useOpsStore.getState();
    expect(opsApi.listNotifyRouting).toHaveBeenCalledWith(50);
    expect(state.notifyRouting).toEqual(notifySnapshot);
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it('loads structured operational events with the default limit', async () => {
    vi.mocked(opsApi.listStructuredOperationalEvents).mockResolvedValue([operationalEvent]);

    await useOpsStore.getState().loadOperationalEvents({ kind: 'notify_route', chatId: 'chat-1' });

    const state = useOpsStore.getState();
    expect(opsApi.listStructuredOperationalEvents).toHaveBeenCalledWith({
      kind: 'notify_route',
      chatId: 'chat-1',
      limit: 50,
    });
    expect(state.operationalEvents).toEqual([operationalEvent]);
    expect(state.error).toBeNull();
  });

  it('reloads the cron snapshot after creating a cron job', async () => {
    vi.mocked(opsApi.createCronJob).mockResolvedValue(cronJob);
    vi.mocked(opsApi.listCronJobs).mockResolvedValue([cronJob]);
    vi.mocked(opsApi.listCronRuns).mockResolvedValue([cronRun]);

    await expect(
      useOpsStore.getState().createCronJob({
        name: 'Nightly sync',
        task: 'sync_data',
        scheduleType: 'cron',
        schedule: '0 * * * *',
        notificationPolicy: 'always',
      }),
    ).resolves.toEqual(cronJob);

    const state = useOpsStore.getState();
    expect(opsApi.createCronJob).toHaveBeenCalledWith({
      name: 'Nightly sync',
      task: 'sync_data',
      scheduleType: 'cron',
      schedule: '0 * * * *',
      notificationPolicy: 'always',
    });
    expect(opsApi.listCronJobs).toHaveBeenCalledTimes(1);
    expect(opsApi.listCronRuns).toHaveBeenCalledWith(undefined, 25);
    expect(state.cronJobs).toEqual([cronJob]);
    expect(state.cronRuns).toEqual([cronRun]);
    expect(state.error).toBeNull();
  });

  it('reloads the monitor snapshot after running a monitor rule', async () => {
    vi.mocked(opsApi.runMonitorRule).mockResolvedValue(monitorEvaluation);
    vi.mocked(opsApi.listMonitorRules).mockResolvedValue([monitorRule]);
    vi.mocked(opsApi.listMonitorStates).mockResolvedValue([monitorState]);
    vi.mocked(opsApi.listMonitorEvaluations).mockResolvedValue([monitorEvaluation]);
    vi.mocked(opsApi.listMonitorAlerts).mockResolvedValue([monitorAlert]);

    await expect(useOpsStore.getState().runMonitorRule('rule-1')).resolves.toEqual(monitorEvaluation);

    const state = useOpsStore.getState();
    expect(opsApi.runMonitorRule).toHaveBeenCalledWith('rule-1');
    expect(opsApi.listMonitorRules).toHaveBeenCalledTimes(1);
    expect(opsApi.listMonitorStates).toHaveBeenCalledTimes(1);
    expect(opsApi.listMonitorEvaluations).toHaveBeenCalledWith(undefined, 25);
    expect(opsApi.listMonitorAlerts).toHaveBeenCalledWith(undefined, 25);
    expect(state.monitorRules).toEqual([monitorRule]);
    expect(state.monitorStates).toEqual([monitorState]);
    expect(state.monitorEvaluations).toEqual([monitorEvaluation]);
    expect(state.monitorAlerts).toEqual([monitorAlert]);
    expect(state.error).toBeNull();
  });

  it('stores a readable error when notify routing load fails', async () => {
    vi.mocked(opsApi.listNotifyRouting).mockRejectedValue(new Error('notify routing unavailable'));

    await useOpsStore.getState().loadNotifyRouting();

    const state = useOpsStore.getState();
    expect(state.error).toBe('notify routing unavailable');
    expect(state.isLoading).toBe(false);
  });
});
