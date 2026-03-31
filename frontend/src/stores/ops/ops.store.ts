import { create } from 'zustand';

import {
  opsApi,
  type CreateCronJobInput,
  type CreateMonitorRuleInput,
  type CronJob,
  type CronJobRun,
  type LogSearchParams,
  type OpsMonitoredChat,
  type OutboundAuditSearchParams,
  type ParsedLogEntry,
  type PendingNotifySnapshot,
  type StructuredOperationalEvent,
  type StructuredOperationalEventSearchParams,
  type TelegramClientMonitorRuntimeState,
  type TelegramOutboundAuditEvent,
  type TelegramWatchAlertRecord,
  type TelegramWatchEvaluationResult,
  type TelegramWatchRule,
  type TelegramWatchState,
  type UpdateCronJobInput,
  type UpdateMonitoredChatInput,
  type UpdateMonitorRuleInput,
} from '@/api/resources/ops.api';

interface OpsState {
  logs: ParsedLogEntry[];
  logFiles: string[];
  logFilesScanned: string[];
  monitoredChats: OpsMonitoredChat[];
  monitorRules: TelegramWatchRule[];
  monitorStates: TelegramWatchState[];
  monitorEvaluations: TelegramWatchEvaluationResult[];
  monitorAlerts: TelegramWatchAlertRecord[];
  runtimeStates: TelegramClientMonitorRuntimeState[];
  cronJobs: CronJob[];
  cronRuns: CronJobRun[];
  outboundAuditEvents: TelegramOutboundAuditEvent[];
  notifyRouting: PendingNotifySnapshot;
  operationalEvents: StructuredOperationalEvent[];
  isLoading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  loadLogs: (params?: LogSearchParams) => Promise<void>;
  loadMonitorSnapshot: () => Promise<void>;
  loadRuntimeStates: () => Promise<void>;
  loadCronSnapshot: () => Promise<void>;
  loadOutboundAudit: (params?: OutboundAuditSearchParams) => Promise<void>;
  loadNotifyRouting: (limit?: number) => Promise<void>;
  loadOperationalEvents: (params?: StructuredOperationalEventSearchParams) => Promise<void>;
  updateMonitoredChat: (id: string, input: UpdateMonitoredChatInput) => Promise<OpsMonitoredChat>;
  createCronJob: (input: CreateCronJobInput) => Promise<CronJob>;
  updateCronJob: (id: string, input: UpdateCronJobInput) => Promise<CronJob>;
  deleteCronJob: (id: string) => Promise<void>;
  pauseCronJob: (id: string) => Promise<CronJob>;
  resumeCronJob: (id: string) => Promise<CronJob>;
  createMonitorRule: (input: CreateMonitorRuleInput) => Promise<TelegramWatchRule>;
  updateMonitorRule: (id: string, input: UpdateMonitorRuleInput) => Promise<TelegramWatchRule>;
  deleteMonitorRule: (id: string) => Promise<void>;
  runMonitorRule: (id: string) => Promise<TelegramWatchEvaluationResult>;
  clearError: () => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const EMPTY_NOTIFY_ROUTING: PendingNotifySnapshot = {
  pendingMessages: [],
  awaitingReplies: [],
  recentRoutes: [],
};

function touchedAt(): string {
  return new Date().toISOString();
}

export const useOpsStore = create<OpsState>((set, get) => ({
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
  notifyRouting: EMPTY_NOTIFY_ROUTING,
  operationalEvents: [],
  isLoading: false,
  error: null,
  lastUpdatedAt: null,
  loadLogs: async (params = {}) => {
    set({ isLoading: true, error: null });
    try {
      const [files, result] = await Promise.all([
        opsApi.listLogFiles(params.fileKind),
        opsApi.searchLogs(params),
      ]);
      set({
        logs: result.entries,
        logFiles: files.files,
        logFilesScanned: result.filesScanned,
        isLoading: false,
        lastUpdatedAt: touchedAt(),
      });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load logs'), isLoading: false });
    }
  },
  loadMonitorSnapshot: async () => {
    set({ isLoading: true, error: null });
    try {
      const [monitorRules, monitorStates, monitorEvaluations, monitorAlerts] = await Promise.all([
        opsApi.listMonitorRules(),
        opsApi.listMonitorStates(),
        opsApi.listMonitorEvaluations(undefined, 25),
        opsApi.listMonitorAlerts(undefined, 25),
      ]);
      set({
        monitorRules,
        monitorStates,
        monitorEvaluations,
        monitorAlerts,
        isLoading: false,
        lastUpdatedAt: touchedAt(),
      });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load monitor data'), isLoading: false });
    }
  },
  loadRuntimeStates: async () => {
    set({ isLoading: true, error: null });
    try {
      const [runtimeStates, monitoredChats] = await Promise.all([
        opsApi.listTelegramClientRuntime(),
        opsApi.listMonitoredChats(),
      ]);
      set({ runtimeStates, monitoredChats, isLoading: false, lastUpdatedAt: touchedAt() });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load Telegram runtime'), isLoading: false });
    }
  },
  loadCronSnapshot: async () => {
    set({ isLoading: true, error: null });
    try {
      const [cronJobs, cronRuns] = await Promise.all([
        opsApi.listCronJobs(),
        opsApi.listCronRuns(undefined, 25),
      ]);
      set({ cronJobs, cronRuns, isLoading: false, lastUpdatedAt: touchedAt() });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load cron data'), isLoading: false });
    }
  },
  loadOutboundAudit: async (params = {}) => {
    set({ isLoading: true, error: null });
    try {
      const outboundAuditEvents = await opsApi.listOutboundAudit({ ...params, limit: params.limit ?? 50 });
      set({ outboundAuditEvents, isLoading: false, lastUpdatedAt: touchedAt() });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load outbound audit'), isLoading: false });
    }
  },
  loadNotifyRouting: async (limit = 25) => {
    set({ isLoading: true, error: null });
    try {
      const notifyRouting = await opsApi.listNotifyRouting(limit);
      set({ notifyRouting, isLoading: false, lastUpdatedAt: touchedAt() });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load notify routing'), isLoading: false });
    }
  },
  loadOperationalEvents: async (params = {}) => {
    set({ isLoading: true, error: null });
    try {
      const operationalEvents = await opsApi.listStructuredOperationalEvents({ ...params, limit: params.limit ?? 50 });
      set({ operationalEvents, isLoading: false, lastUpdatedAt: touchedAt() });
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to load operational events'), isLoading: false });
    }
  },
  updateMonitoredChat: async (id, input) => {
    set({ isLoading: true, error: null });
    try {
      const chat = await opsApi.updateMonitoredChat(id, input);
      await get().loadRuntimeStates();
      return chat;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to update monitored chat'), isLoading: false });
      throw error;
    }
  },
  createCronJob: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const job = await opsApi.createCronJob(input);
      await get().loadCronSnapshot();
      return job;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to create cron job'), isLoading: false });
      throw error;
    }
  },
  updateCronJob: async (id, input) => {
    set({ isLoading: true, error: null });
    try {
      const job = await opsApi.updateCronJob(id, input);
      await get().loadCronSnapshot();
      return job;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to update cron job'), isLoading: false });
      throw error;
    }
  },
  deleteCronJob: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await opsApi.deleteCronJob(id);
      await get().loadCronSnapshot();
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to delete cron job'), isLoading: false });
      throw error;
    }
  },
  pauseCronJob: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const job = await opsApi.pauseCronJob(id);
      await get().loadCronSnapshot();
      return job;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to pause cron job'), isLoading: false });
      throw error;
    }
  },
  resumeCronJob: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const job = await opsApi.resumeCronJob(id);
      await get().loadCronSnapshot();
      return job;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to resume cron job'), isLoading: false });
      throw error;
    }
  },
  createMonitorRule: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const rule = await opsApi.createMonitorRule(input);
      await get().loadMonitorSnapshot();
      return rule;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to create monitor rule'), isLoading: false });
      throw error;
    }
  },
  updateMonitorRule: async (id, input) => {
    set({ isLoading: true, error: null });
    try {
      const rule = await opsApi.updateMonitorRule(id, input);
      await get().loadMonitorSnapshot();
      return rule;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to update monitor rule'), isLoading: false });
      throw error;
    }
  },
  deleteMonitorRule: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await opsApi.deleteMonitorRule(id);
      await get().loadMonitorSnapshot();
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to delete monitor rule'), isLoading: false });
      throw error;
    }
  },
  runMonitorRule: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const evaluation = await opsApi.runMonitorRule(id);
      await get().loadMonitorSnapshot();
      return evaluation;
    } catch (error) {
      set({ error: toErrorMessage(error, 'Failed to run monitor rule'), isLoading: false });
      throw error;
    }
  },
  clearError: () => set({ error: null }),
}));
