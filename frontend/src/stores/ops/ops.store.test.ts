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
    vi.mocked(opsApi.listTelegramClientRuntime).mockResolvedValue([runtimeState]);
    vi.mocked(opsApi.listMonitoredChats).mockResolvedValue([monitoredChat]);

    await useOpsStore.getState().loadRuntimeStates();

    const state = useOpsStore.getState();
    expect(opsApi.listTelegramClientRuntime).toHaveBeenCalledTimes(1);
    expect(opsApi.listMonitoredChats).toHaveBeenCalledTimes(1);
    expect(state.runtimeStates).toEqual([runtimeState]);
    expect(state.monitoredChats).toEqual([monitoredChat]);
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
    vi.mocked(opsApi.listTelegramClientRuntime).mockResolvedValue([updatedRuntimeState]);
    vi.mocked(opsApi.listMonitoredChats).mockResolvedValue([updatedChat]);

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
    expect(opsApi.listTelegramClientRuntime).toHaveBeenCalledTimes(1);
    expect(opsApi.listMonitoredChats).toHaveBeenCalledTimes(1);
    expect(state.runtimeStates).toEqual([updatedRuntimeState]);
    expect(state.monitoredChats).toEqual([updatedChat]);
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
