import { Inject, Injectable, Logger } from '@nestjs/common';

import { AgentMetricsService } from '../agent/metrics/metrics.service';
import type { AgentModeId } from '../agent/modes/mode.types';
import { ModeSelector } from '../agent/modes/mode-selector';
import {
  type AgentUserProfile,
  type AgentUserProfileSource,
} from '../agent/profile/user-profile.types';
import { UserProfileService } from '../agent/profile/user-profile.service';
import { ResponseDirectivesService } from '../agent/response-directives/response-directives.service';
import {
  hasExplicitResponseDirectives,
  type ResponseDirectives,
} from '../agent/response-directives/response-directives.types';
import { SystemPromptBuilder } from '../agent/prompt/prompt.builder';
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  DEFAULT_CONVERSATION_TITLE,
} from '../common/constants';
import { LlmService } from '../llm/llm.service';
import type { LlmMessage, LlmStreamChunk } from '../llm/interfaces/llm.interface';
import { ToolOrchestratorService } from '../tools/core/tool-orchestrator.service';
import type { ToolExecutionContext } from '../tools/core/tool.types';
import { ArchiveChatRetrieverService } from '../memory/archive/archive-chat-retriever.service';
import { ConversationalMemoryCommandService } from '../memory/conversational-memory-command.service';
import type { EpisodicMemoryEntry } from '../memory/episodic-memory.types';
import {
  resolveMemoryGroundingContext,
  type MemoryGroundingContext,
} from '../memory/grounding/grounding-policy';
import type { RecalledMemory } from '../memory/core/memory-entry.types';
import { MemoryResolverService } from '../memory/memory-resolver.service';
import type { ResolvedUserMemoryContext } from '../memory/memory.types';
import { AutoRecallService } from '../memory/recall/auto-recall.service';
import { AutoCaptureService } from '../memory/capture/pipeline/auto-capture.service';
import type { UserProfileFact } from '../memory/user-profile-facts.types';
import { IdentityCaptureService } from '../agent/identity/capture/identity-capture.service';
import { IdentityRecallService, type RecalledIdentityTrait } from '../agent/identity/recall/identity-recall.service';
import { SelfModelService } from '../agent/identity/reflection/self-model.service';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { CHAT_REPOSITORY, ChatRepository } from './repositories/chat.repository';
import { ContextTrimService } from './context-trim.service';
import { TurnResponseValidatorService } from './validation/turn-validator.service';
import { SessionReflectionService } from '../memory/action-log/session-reflection.service';

interface ChatProfileContext {
  mode?: AgentModeId;
  scopeKey?: string;
  signal?: AbortSignal;
  /** Extra instruction appended to the system prompt (e.g. for Telegram chat context) */
  extraSystemInstruction?: string;
  /** Tool names to exclude from this conversation (e.g. telegram_client for tg-client scope) */
  excludeTools?: string[];
  /** Metadata passed to tools via ToolExecutionContext.meta */
  toolMeta?: Record<string, string>;
}

type ResolvedModeContext = {
  mode: AgentModeId;
  source: 'explicit' | 'inferred';
};

type TurnContext = {
  conversation: Conversation;
  mode: ResolvedModeContext;
  userProfile: AgentUserProfile;
  userProfileSource: AgentUserProfileSource;
  messages: LlmMessage[];
  responseDirectives: ResponseDirectives;
  memoryGrounding: MemoryGroundingContext;
  needsBufferedCompletion: boolean;
  recalledMemories: RecalledMemory[];
  resolvedUserMemory?: ResolvedUserMemoryContext;
  userMessageContent: string;
};

type TurnPreparationResult =
  | { commandHandled: true; conversation: Conversation; operationNote: string }
  | { commandHandled: false; turnContext: TurnContext };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  private async finalizeAssistantDraft(
    messages: LlmMessage[],
    draft: string,
    turnContext: TurnContext,
  ): Promise<string> {
    if (!turnContext.needsBufferedCompletion) {
      return draft;
    }

    return this.turnResponseValidator.validateDraftWithRetry(
      messages,
      draft,
      turnContext.responseDirectives,
      turnContext.memoryGrounding,
    );
  }

  constructor(
    private readonly modeSelector: ModeSelector,
    private readonly userProfileService: UserProfileService,
    private readonly memoryResolverService: MemoryResolverService,
    private readonly conversationalMemoryCommandService: ConversationalMemoryCommandService,
    private readonly responseDirectivesService: ResponseDirectivesService,
    private readonly turnResponseValidator: TurnResponseValidatorService,
    private readonly systemPromptBuilder: SystemPromptBuilder,
    private readonly archiveChatRetrieverService: ArchiveChatRetrieverService,
    private readonly agentMetricsService: AgentMetricsService,
    private readonly llmService: LlmService,
    private readonly autoRecallService: AutoRecallService,
    private readonly autoCaptureService: AutoCaptureService,
    private readonly identityCaptureService: IdentityCaptureService,
    private readonly identityRecallService: IdentityRecallService,
    private readonly selfModelService: SelfModelService,
    private readonly contextTrimService: ContextTrimService,
    private readonly toolOrchestrator: ToolOrchestratorService,
    @Inject(CHAT_REPOSITORY) private readonly chatRepository: ChatRepository,
    private readonly sessionReflectionService: SessionReflectionService,
  ) {
    // Session inactivity reflection: check every 60s
    this.sessionReflectionTimer = setInterval(() => {
      this.checkSessionInactivity().catch((err) => {
        this.logger.warn(`Session inactivity check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 60_000);
    this.sessionReflectionTimer.unref();
  }

  /** Track last activity per conversation for session boundary detection */
  private readonly lastActivityMap = new Map<string, { at: number; messageCount: number; scopeKey?: string }>();
  private readonly sessionReflectionTimer: ReturnType<typeof setInterval>;
  private static readonly SESSION_INACTIVITY_MS = 30 * 60_000; // 30 minutes
  private readonly reflectedSessions = new Set<string>();

  async getOrCreateConversation(conversationId?: string, scopeKey?: string): Promise<Conversation> {
    if (conversationId) {
      const existing = await this.chatRepository.getConversation(conversationId, scopeKey);
      if (existing) return existing;
    }

    const conversation = await this.chatRepository.createConversation(scopeKey);
    this.logger.debug(`Created conversation ${conversation.id} scope=${conversation.scopeKey}`);
    return conversation;
  }

  async getConversation(conversationId: string, scopeKey?: string): Promise<Conversation | undefined> {
    return this.chatRepository.getConversation(conversationId, scopeKey);
  }

  async getAllConversations(scopeKey?: string): Promise<Conversation[]> {
    return this.chatRepository.getAllConversations(scopeKey);
  }

  async deleteConversation(conversationId: string, scopeKey?: string): Promise<boolean> {
    return this.chatRepository.deleteConversation(conversationId, scopeKey);
  }

  async sendMessage(
    conversationId: string | undefined,
    content: string,
    profileContext: ChatProfileContext = {},
  ): Promise<{ conversation: Conversation; assistantMessage: Message }> {
    const preparation = await this.prepareTurn(conversationId, content, profileContext);

    if (preparation.commandHandled) {
      const assistantMessage = new Message({
        conversationId: preparation.conversation.id,
        role: 'assistant',
        content: preparation.operationNote,
      });
      preparation.conversation.addMessage(assistantMessage);
      await this.chatRepository.saveConversation(preparation.conversation);
      return { conversation: preparation.conversation, assistantMessage };
    }

    const { turnContext } = preparation;

    let resultContent: string;
    if (this.toolOrchestrator.isEnabled) {
      const toolExecCtx: ToolExecutionContext = {
        scopeKey: profileContext.scopeKey,
        conversationId: turnContext.conversation.id,
        excludeTools: profileContext.excludeTools,
        meta: profileContext.toolMeta,
      };
      const toolResult = await this.toolOrchestrator.completeWithTools(turnContext.messages, undefined, toolExecCtx);
      if (toolResult.toolRoundsUsed > 0) {
        this.logger.debug(`Tool loop: ${toolResult.toolRoundsUsed} rounds, calls=${toolResult.toolCallLog.map((c) => c.name).join(',')}`);
      }
      resultContent = await this.finalizeAssistantDraft(turnContext.messages, toolResult.content, turnContext);
    } else {
      resultContent = await this.turnResponseValidator.completeWithValidation(
        turnContext.messages,
        turnContext.responseDirectives,
        turnContext.memoryGrounding,
      );
    }

    const assistantMessage = new Message({
      conversationId: turnContext.conversation.id,
      role: 'assistant',
      content: resultContent,
    });
    turnContext.conversation.addMessage(assistantMessage);
    await this.chatRepository.saveConversation(turnContext.conversation);
    await this.commitManagedMemory(turnContext.resolvedUserMemory);

    // Memory v2: fire-and-forget auto-capture
    this.fireAndForgetCapture(turnContext.userMessageContent, resultContent, turnContext.conversation.id, assistantMessage.id, profileContext.scopeKey);

    // Track activity for session reflection
    this.trackActivity(turnContext.conversation.id, turnContext.conversation.getMessageHistory().length, profileContext.scopeKey);

    return { conversation: turnContext.conversation, assistantMessage };
  }

  private trackActivity(conversationId: string, messageCount: number, scopeKey?: string): void {
    this.lastActivityMap.set(conversationId, { at: Date.now(), messageCount, scopeKey });
    this.reflectedSessions.delete(conversationId); // reset if user returns
  }

  private async checkSessionInactivity(): Promise<void> {
    const now = Date.now();
    for (const [conversationId, { at, messageCount, scopeKey }] of this.lastActivityMap) {
      if (this.reflectedSessions.has(conversationId)) continue;
      if (messageCount < 4) continue; // too short to reflect
      if (now - at < ChatService.SESSION_INACTIVITY_MS) continue;

      this.reflectedSessions.add(conversationId);
      this.lastActivityMap.delete(conversationId);

      const conversation = await this.chatRepository.getConversation(conversationId);
      if (!conversation) continue;

      const history = conversation.getMessageHistory();
      const contextSummary = history
        .slice(-20)
        .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '(complex)'}`)
        .join('\n');

      this.sessionReflectionService.reflect(contextSummary, conversationId, scopeKey).catch((err) => {
        this.logger.warn(`Session reflection failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
      });

      this.logger.debug(`Triggered session reflection for ${conversationId} (inactive ${Math.round((now - at) / 60_000)}min)`);
    }
  }

  async *streamMessage(
    conversationId: string | undefined,
    content: string,
    profileContext: ChatProfileContext = {},
  ): AsyncGenerator<{ chunk: LlmStreamChunk; conversationId: string; messageId: string }> {
    const preparation = await this.prepareTurn(conversationId, content, profileContext);

    if (preparation.commandHandled) {
      const messageId = crypto.randomUUID();
      const assistantMessage = new Message({
        id: messageId,
        conversationId: preparation.conversation.id,
        role: 'assistant',
        content: preparation.operationNote,
      });
      preparation.conversation.addMessage(assistantMessage);
      await this.chatRepository.saveConversation(preparation.conversation);
      yield { chunk: { content: preparation.operationNote, done: false }, conversationId: preparation.conversation.id, messageId };
      yield { chunk: { content: '', done: true }, conversationId: preparation.conversation.id, messageId };
      return;
    }

    const { turnContext } = preparation;

    if (turnContext.needsBufferedCompletion) {
      const bufferedContent = await this.turnResponseValidator.completeWithValidation(
        turnContext.messages,
        turnContext.responseDirectives,
        turnContext.memoryGrounding,
      );
      const messageId = crypto.randomUUID();
      yield { chunk: { content: bufferedContent, done: false }, conversationId: turnContext.conversation.id, messageId };
      yield { chunk: { content: '', done: true }, conversationId: turnContext.conversation.id, messageId };

      const assistantMessage = new Message({
        id: messageId,
        conversationId: turnContext.conversation.id,
        role: 'assistant',
        content: bufferedContent,
      });
      turnContext.conversation.addMessage(assistantMessage);
      await this.chatRepository.saveConversation(turnContext.conversation);
      await this.commitManagedMemory(turnContext.resolvedUserMemory);

      // Memory v2: fire-and-forget auto-capture
      this.fireAndForgetCapture(turnContext.userMessageContent, bufferedContent, turnContext.conversation.id, messageId, profileContext.scopeKey);
      return;
    }

    // Persist conversation with user message before streaming,
    // so the user's input is never lost on LLM timeout/abort.
    await this.chatRepository.saveConversation(turnContext.conversation);

    let fullContent = '';
    const messageId = crypto.randomUUID();

    const toolExecCtx: ToolExecutionContext = {
      scopeKey: profileContext.scopeKey,
      conversationId: turnContext.conversation.id,
      messageId,
      excludeTools: profileContext.excludeTools,
      meta: profileContext.toolMeta,
    };

    const streamSource = this.toolOrchestrator.isEnabled
      ? this.toolOrchestrator.streamWithTools(turnContext.messages, { signal: profileContext.signal }, toolExecCtx)
      : this.llmService.stream(turnContext.messages, { signal: profileContext.signal });

    for await (const chunk of streamSource) {
      fullContent += chunk.content;
      yield { chunk, conversationId: turnContext.conversation.id, messageId };
    }

    const assistantMessage = new Message({
      id: messageId,
      conversationId: turnContext.conversation.id,
      role: 'assistant',
      content: fullContent,
    });
    turnContext.conversation.addMessage(assistantMessage);
    await this.chatRepository.saveConversation(turnContext.conversation);
    await this.commitManagedMemory(turnContext.resolvedUserMemory);

    // Memory v2: fire-and-forget auto-capture
    // Skip if memory_manage tool was used — it already handled memory explicitly,
    // running auto-capture would create duplicates.
    const usedTools = this.toolOrchestrator.isEnabled
      ? this.toolOrchestrator.lastUsedToolNames
      : new Set<string>();

    if (usedTools.has('memory_manage')) {
      this.logger.debug('Skipping auto-capture: memory_manage tool was used in this turn');
    } else {
      this.fireAndForgetCapture(turnContext.userMessageContent, fullContent, turnContext.conversation.id, messageId, profileContext.scopeKey);
    }

    // Track activity for session reflection
    this.trackActivity(turnContext.conversation.id, turnContext.conversation.getMessageHistory().length, profileContext.scopeKey);
  }

  private fireAndForgetCapture(
    userMessage: string,
    assistantResponse: string,
    conversationId: string,
    messageId: string,
    scopeKey?: string,
  ): void {
    // General memory capture + identity capture run in parallel (both fire-and-forget)
    this.autoCaptureService
      .captureFromTurn(userMessage, assistantResponse, conversationId, messageId, scopeKey)
      .catch((err) => {
        this.logger.warn(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
      });

    this.identityCaptureService
      .captureFromTurn(userMessage, assistantResponse, conversationId, messageId, scopeKey)
      .catch((err) => {
        this.logger.warn(`Identity capture failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private async commitManagedMemory(resolvedUserMemory?: ResolvedUserMemoryContext): Promise<void> {
    if (!resolvedUserMemory) {
      return;
    }

    try {
      await this.memoryResolverService.commitResolvedUserMemory(resolvedUserMemory);
    } catch (err) {
      this.logger.warn(`Managed memory commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildMessages(
    conversation: Conversation,
    mode: AgentModeId,
    userProfile: AgentUserProfile,
    userProfileSource: AgentUserProfileSource,
    userFacts: UserProfileFact[],
    episodicMemories: EpisodicMemoryEntry[],
    recalledMemories: RecalledMemory[],
    identityTraits: RecalledIdentityTrait[],
    selfModelRaw: string,
    archiveEvidence: Awaited<ReturnType<ArchiveChatRetrieverService['retrieveEvidence']>>,
    memoryGrounding: MemoryGroundingContext,
    responseDirectives: ResponseDirectives,
    extraSystemInstruction?: string,
  ): LlmMessage[] {
    const history = conversation.getMessageHistory();
    const buildOptions = {
      userProfileSource,
      userFacts,
      episodicMemories,
      recalledMemories,
      identityTraits,
      selfModelRaw,
      archiveEvidence,
      ...(memoryGrounding.isMemoryQuestion ? { memoryGrounding } : {}),
      ...(hasExplicitResponseDirectives(responseDirectives) ? { responseDirectives } : {}),
    };

    const systemContent = this.systemPromptBuilder.build(mode, userProfile, buildOptions);

    return [
      {
        role: 'system',
        content: extraSystemInstruction
          ? `${systemContent}\n\n${extraSystemInstruction}`
          : systemContent,
      },
      ...history,
    ];
  }

  private async prepareTurn(
    conversationId: string | undefined,
    content: string,
    profileContext: ChatProfileContext,
  ): Promise<TurnPreparationResult> {
    const conversation = await this.getOrCreateConversation(conversationId, profileContext.scopeKey);

    const userMessage = new Message({
      conversationId: conversation.id,
      role: 'user',
      content,
    });
    conversation.addMessage(userMessage);
    this.autoGenerateTitle(conversation, content);

    const commandResult = await this.conversationalMemoryCommandService.handle(content, conversation);
    if (commandResult.handled) {
      return { commandHandled: true, conversation, operationNote: commandResult.response ?? '' };
    }

    const turnContext = await this.prepareTurnContext(conversation, content, profileContext);
    return { commandHandled: false, turnContext };
  }

  private async prepareTurnContext(
    conversation: Conversation,
    content: string,
    profileContext: ChatProfileContext,
  ): Promise<TurnContext> {
    // Smart Extraction Sweep: trim old messages if conversation is too long
    let activeConversation = conversation;
    try {
      const trimResult = await this.contextTrimService.trimIfNeeded(conversation);
      if (trimResult.result.trimmed) {
        activeConversation = trimResult.conversation;
        await this.chatRepository.saveConversation(activeConversation);
        this.logger.debug(
          `Context trim: removed=${trimResult.result.messagesRemoved}, extracted=${trimResult.result.memoriesExtracted}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Context trim failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    const resolvedMode = this.resolveMode(activeConversation, profileContext);
    const requestedResponseDirectives = this.responseDirectivesService.resolve(content);

    // Memory v2: auto-recall + identity recall + self-model + archive evidence (all in parallel)
    // Strip metadata prefixes like "[From: Name]\n" so recall searches on clean text
    const recallQuery = content.replace(/^\[From:\s*[^\]]*\]\s*\n?/i, '').trim() || content;

    const [resolvedUserMemory, archiveEvidence, recalledMemories, identityRecallResult, selfModelSummary] = await Promise.all([
      this.memoryResolverService.resolveUserMemory(activeConversation).catch((err) => {
        this.logger.warn(`Managed memory resolution failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }),
      this.archiveChatRetrieverService.retrieveEvidence(activeConversation, { limit: 6 }),
      this.autoRecallService.recall(recallQuery, { limit: 10 }).catch((err) => {
        this.logger.warn(`Auto-recall failed: ${err instanceof Error ? err.message : String(err)}`);
        return [] as RecalledMemory[];
      }),
      this.identityRecallService.recall().catch((err) => {
        this.logger.warn(`Identity recall failed: ${err instanceof Error ? err.message : String(err)}`);
        return { traits: [] as RecalledIdentityTrait[] };
      }),
      this.selfModelService.buildSelfModelSummary().catch((err) => {
        this.logger.warn(`Self-model build failed: ${err instanceof Error ? err.message : String(err)}`);
        return { strengths: [], improving: [], boundaries: [], style: [], values: [], raw: '' };
      }),
    ]);
    const identityTraits = identityRecallResult.traits;
    const selfModelRaw = selfModelSummary.raw;

    const userProfile = resolvedUserMemory?.interactionPreferences.userProfile ?? this.userProfileService.resolveProfile(activeConversation);
    const userProfileSource: AgentUserProfileSource =
      resolvedUserMemory?.interactionPreferences.source ?? 'recent_context';
    const userFacts = resolvedUserMemory?.userFacts.facts ?? [];
    const episodicMemories = resolvedUserMemory?.episodicMemory.relevantEntries ?? [];
    const memoryGrounding = resolveMemoryGroundingContext(content, recalledMemories, archiveEvidence, {
      structuredMemoryCount: userFacts.length + episodicMemories.length,
    });
    const responseDirectives = this.applyMemoryGroundingDirectives(requestedResponseDirectives, memoryGrounding);
    const messages = this.buildMessages(
      activeConversation,
      resolvedMode.mode,
      userProfile,
      userProfileSource,
      userFacts,
      episodicMemories,
      recalledMemories,
      identityTraits,
      selfModelRaw,
      archiveEvidence,
      memoryGrounding,
      responseDirectives,
      profileContext.extraSystemInstruction,
    );
    const needsBufferedCompletion = this.turnResponseValidator.shouldUseBufferedCompletion(responseDirectives, memoryGrounding);

    this.agentMetricsService.recordResolution({
      mode: resolvedMode.mode,
      modeSource: resolvedMode.source,
      profileSource: userProfileSource,
      profileKeyKind: 'local_default',
      userProfile,
    });

    this.logger.debug(
      `Turn context: mode=${resolvedMode.mode} (${resolvedMode.source}), managedFacts=${userFacts.length}, managedEpisodes=${episodicMemories.length}, recalled=${recalledMemories.length}, identity=${identityTraits.length}, selfModel=${selfModelRaw.length > 0 ? 'yes' : 'no'}, archive=${archiveEvidence.length}, grounding=${memoryGrounding.evidenceStrength}`,
    );

    return {
      conversation: activeConversation,
      mode: resolvedMode,
      userProfile,
      userProfileSource,
      messages,
      responseDirectives,
      memoryGrounding,
      needsBufferedCompletion,
      recalledMemories,
      resolvedUserMemory,
      userMessageContent: content,
    };
  }

  private applyMemoryGroundingDirectives(
    responseDirectives: ResponseDirectives,
    memoryGrounding: MemoryGroundingContext,
  ): ResponseDirectives {
    if (!memoryGrounding.shouldUseUncertaintyFirst || responseDirectives.hardLimits.uncertaintyFirst) {
      return responseDirectives;
    }

    return {
      ...responseDirectives,
      hardLimits: {
        ...responseDirectives.hardLimits,
        uncertaintyFirst: true,
      },
    };
  }

  private resolveMode(conversation: Conversation, profileContext: ChatProfileContext): ResolvedModeContext {
    const explicitMode = profileContext.mode;
    if (explicitMode) {
      return {
        mode: explicitMode,
        source: 'explicit',
      };
    }

    return {
      mode: this.modeSelector.selectMode(conversation),
      source: 'inferred',
    };
  }

  private autoGenerateTitle(conversation: Conversation, firstUserContent: string): void {
    if (conversation.title !== DEFAULT_CONVERSATION_TITLE) return;

    const trimmed = firstUserContent.trim();
    if (trimmed.length <= CONVERSATION_TITLE_MAX_LENGTH) {
      conversation.title = trimmed;
    } else {
      conversation.title = trimmed.slice(0, CONVERSATION_TITLE_MAX_LENGTH - 1) + '…';
    }
  }
}
