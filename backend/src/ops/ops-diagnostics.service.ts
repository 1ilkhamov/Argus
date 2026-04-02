import { Injectable } from '@nestjs/common';

import { SystemPromptBuilder } from '../agent/prompt/prompt.builder';
import { ConversationExecutionStateService } from '../chat/runtime/conversation-execution-state.service';
import { TurnResolutionDiagnosticsService } from '../chat/runtime/turn-resolution-diagnostics.service';
import { LlmService } from '../llm/llm.service';
import { HealthService } from '../health/health.service';
import { MemoryManagementService } from '../memory/memory-management.service';
import { DEFAULT_LOCAL_MEMORY_SCOPE } from '../memory/memory.types';
import { QdrantVectorService } from '../memory/qdrant/qdrant-vector.service';
import { TelegramClientMonitorRuntimeService } from '../telegram-client/telegram-client-monitor-runtime.service';
import { TelegramClientRepository } from '../telegram-client/telegram-client.repository';
import {
  BootstrapDiagnosticsService,
  type BootstrapDiagnosticsSummary,
  type RuntimeDiagnosticWarning,
} from './bootstrap-diagnostics.service';

export interface OpsDiagnosticsPayload {
  timestamp: string;
  health: Awaited<ReturnType<HealthService['checkRuntime']>>;
  llm: ReturnType<LlmService['getRuntimeProfile']>;
  soul: ReturnType<SystemPromptBuilder['getRuntimeState']>;
  startup: {
    storage: BootstrapDiagnosticsSummary['storage'];
    telegram: BootstrapDiagnosticsSummary['telegram'];
    applescript: BootstrapDiagnosticsSummary['applescript'];
  };
  memory: {
    scopeKey: string;
    interactionPreferencesConfigured: boolean;
    processingState: {
      version: number;
      lastProcessedUserMessageId?: string;
    };
    userFacts: {
      total: number;
      pinned: number;
    };
    episodicMemories: {
      total: number;
      pinned: number;
    };
  };
  prompt: {
    latest?: ReturnType<TurnResolutionDiagnosticsService['getLatest']>;
    recent: ReturnType<TurnResolutionDiagnosticsService['listRecent']>;
  };
  telegramClient: {
    monitoredChats: Awaited<ReturnType<TelegramClientRepository['findAll']>>;
    runtimeStates: Awaited<ReturnType<TelegramClientMonitorRuntimeService['listStates']>>;
  };
  continuation: {
    activeCount: number;
    active: Array<{
      conversationId: string;
      scopeKey: string;
      userMessageId: string;
      phase: string;
      status: string;
      updatedAt: string;
      expiresAt: string;
      budgetPressure: string;
      lastErrorCode?: string;
    }>;
  };
  qdrant: ReturnType<QdrantVectorService['getRuntimeState']>;
  warnings: RuntimeDiagnosticWarning[];
}

@Injectable()
export class OpsDiagnosticsService {
  constructor(
    private readonly healthService: HealthService,
    private readonly llmService: LlmService,
    private readonly systemPromptBuilder: SystemPromptBuilder,
    private readonly memoryManagementService: MemoryManagementService,
    private readonly executionStateService: ConversationExecutionStateService,
    private readonly turnResolutionDiagnosticsService: TurnResolutionDiagnosticsService,
    private readonly qdrantVectorService: QdrantVectorService,
    private readonly telegramClientRepository: TelegramClientRepository,
    private readonly telegramClientMonitorRuntimeService: TelegramClientMonitorRuntimeService,
    private readonly bootstrapDiagnosticsService: BootstrapDiagnosticsService,
  ) {}

  async getDiagnostics(scopeKey = DEFAULT_LOCAL_MEMORY_SCOPE): Promise<OpsDiagnosticsPayload> {
    const latestPrompt = this.turnResolutionDiagnosticsService.getLatest();
    const recentPrompt = this.turnResolutionDiagnosticsService.listRecent(5);
    const [health, snapshot, activeCheckpoints, monitoredChats, runtimeStates] = await Promise.all([
      this.healthService.checkRuntime(),
      this.memoryManagementService.getSnapshot(scopeKey),
      this.executionStateService.listActiveCheckpoints(10),
      this.telegramClientRepository.findAll(),
      this.telegramClientMonitorRuntimeService.listStates(),
    ]);
    const bootstrap = this.bootstrapDiagnosticsService.getSummary();
    const qdrant = this.qdrantVectorService.getRuntimeState();
    const warnings = [
      ...bootstrap.warnings,
      ...this.buildRuntimeWarnings(latestPrompt, activeCheckpoints, qdrant),
    ];

    return {
      timestamp: new Date().toISOString(),
      health,
      llm: this.llmService.getRuntimeProfile(),
      soul: this.systemPromptBuilder.getRuntimeState(),
      startup: {
        storage: bootstrap.storage,
        telegram: bootstrap.telegram,
        applescript: bootstrap.applescript,
      },
      memory: {
        scopeKey,
        interactionPreferencesConfigured: Boolean(snapshot.interactionPreferences),
        processingState: {
          version: snapshot.processingState?.expectedVersion ?? 0,
          ...(snapshot.processingState?.lastProcessedUserMessage?.messageId
            ? { lastProcessedUserMessageId: snapshot.processingState.lastProcessedUserMessage.messageId }
            : {}),
        },
        userFacts: {
          total: snapshot.userFacts.length,
          pinned: snapshot.userFacts.filter((fact) => Boolean(fact.pinned)).length,
        },
        episodicMemories: {
          total: snapshot.episodicMemories.length,
          pinned: snapshot.episodicMemories.filter((entry) => Boolean(entry.pinned)).length,
        },
      },
      prompt: {
        latest: latestPrompt,
        recent: recentPrompt,
      },
      telegramClient: {
        monitoredChats,
        runtimeStates,
      },
      continuation: {
        activeCount: activeCheckpoints.length,
        active: activeCheckpoints.map((checkpoint) => ({
          conversationId: checkpoint.conversationId,
          scopeKey: checkpoint.scopeKey,
          userMessageId: checkpoint.userMessageId,
          phase: checkpoint.phase,
          status: checkpoint.status,
          updatedAt: checkpoint.updatedAt,
          expiresAt: checkpoint.expiresAt,
          budgetPressure: checkpoint.budget.budgetPressure,
          ...(checkpoint.lastErrorCode ? { lastErrorCode: checkpoint.lastErrorCode } : {}),
        })),
      },
      qdrant,
      warnings,
    };
  }

  private buildRuntimeWarnings(
    latestPrompt: ReturnType<TurnResolutionDiagnosticsService['getLatest']>,
    activeCheckpoints: Awaited<ReturnType<ConversationExecutionStateService['listActiveCheckpoints']>>,
    qdrant: ReturnType<QdrantVectorService['getRuntimeState']>,
  ): RuntimeDiagnosticWarning[] {
    const warnings: RuntimeDiagnosticWarning[] = [];
    const budgetExhaustedContinuations = activeCheckpoints.filter((checkpoint) => checkpoint.lastErrorCode === 'budget_exhausted');

    if (qdrant.configured && (!qdrant.ready || qdrant.circuitOpen)) {
      warnings.push({
        code: 'qdrant_not_ready',
        severity: 'warning',
        subject: 'qdrant',
        message: 'Qdrant is configured but not ready for vector operations.',
        action: 'Verify Qdrant availability, collection health, and embedding/vector-size compatibility.',
      });
    }

    if (latestPrompt?.prompt.budgetPressure === 'high') {
      warnings.push({
        code: 'prompt_budget_high',
        severity: 'warning',
        subject: 'prompt',
        message: 'Latest turn ran under high prompt budget pressure.',
        action: 'Inspect trimmed sections, recalled memory volume, and staged execution behavior.',
      });
    }

    if (
      latestPrompt &&
      (latestPrompt.prompt.trimmedHistoryCount > 0 ||
        latestPrompt.prompt.trimmedSectionIds.length > 0 ||
        latestPrompt.prompt.compressedSectionIds.length > 0)
    ) {
      warnings.push({
        code: 'prompt_trimming_active',
        severity: 'info',
        subject: 'prompt',
        message: 'Latest turn required prompt trimming or compression.',
        action: 'Review trimmed history and compressed sections if response quality regressed.',
      });
    }

    if (activeCheckpoints.length > 0) {
      warnings.push({
        code: 'active_continuations_present',
        severity: 'info',
        subject: 'continuation',
        message: `There are ${activeCheckpoints.length} active continuation checkpoints awaiting completion or resume.`,
        action: 'Inspect resumable conversations and any checkpoint error codes.',
      });
    }

    if (budgetExhaustedContinuations.length > 0) {
      warnings.push({
        code: 'continuation_budget_exhausted',
        severity: 'warning',
        subject: 'continuation',
        message: `There are ${budgetExhaustedContinuations.length} active continuation checkpoints that were created after prompt budget exhaustion.`,
        action: 'Inspect available prompt tokens, tool-round reserves, and staged-execution step sizing before resuming.',
      });
    }

    return warnings;
  }
}
