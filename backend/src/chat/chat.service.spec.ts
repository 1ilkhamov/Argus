import { AgentMetricsService } from '../agent/metrics/metrics.service';
import { ModeSelector } from '../agent/modes/mode-selector';
import type { AgentUserProfile } from '../agent/profile/user-profile.types';
import { UserProfileService } from '../agent/profile/user-profile.service';
import { ResponseDirectivesService } from '../agent/response-directives/response-directives.service';
import {
  EMPTY_RESPONSE_DIRECTIVES,
  type ResponseDirectives,
} from '../agent/response-directives/response-directives.types';
import { SystemPromptBuilder } from '../agent/prompt/prompt.builder';
import type { LlmMessage, LlmStreamChunk } from '../llm/interfaces/llm.interface';
import { LlmService } from '../llm/llm.service';
import {
  ConversationalMemoryCommandService,
  type ConversationalMemoryCommandResult,
} from '../memory/conversational-memory-command.service';
import type { ArchivedChatEvidenceItem } from '../memory/archive/archive-chat-retrieval.types';
import { ArchiveChatRetrieverService } from '../memory/archive/archive-chat-retriever.service';
import { MemoryResolverService } from '../memory/memory-resolver.service';
import type { ResolvedUserMemoryContext } from '../memory/memory.types';
import { AutoRecallService } from '../memory/recall/auto-recall.service';
import { AutoCaptureService } from '../memory/capture/pipeline/auto-capture.service';
import { IdentityCaptureService } from '../agent/identity/capture/identity-capture.service';
import { IdentityRecallService } from '../agent/identity/recall/identity-recall.service';
import { SelfModelService } from '../agent/identity/reflection/self-model.service';
import { ToolOrchestratorService } from '../tools/core/tool-orchestrator.service';
import { ChatService } from './chat.service';
import { ContextTrimService } from './context-trim.service';
import { TurnResponseValidatorService } from './validation/turn-validator.service';
import { Conversation } from './entities/conversation.entity';
import { ChatRepository } from './repositories/chat.repository';

const defaultUserProfile: AgentUserProfile = {
  communication: {
    preferredLanguage: 'auto',
    tone: 'direct',
    detail: 'adaptive',
    structure: 'adaptive',
  },
  interaction: {
    allowPushback: true,
    allowProactiveSuggestions: true,
  },
};

const createUserProfileService = (profile: AgentUserProfile = defaultUserProfile) => ({
  resolveProfile: jest.fn().mockReturnValue(profile),
});

const defaultResolvedUserMemory: ResolvedUserMemoryContext = {
  interactionPreferences: {
    keyKind: 'local_default',
    source: 'recent_context',
    userProfile: defaultUserProfile,
  },
  userFacts: {
    scopeKey: 'local:default',
    source: 'recent_context',
    facts: [],
    storedFacts: [],
  },
  episodicMemory: {
    scopeKey: 'local:default',
    source: 'recent_context',
    entries: [],
    relevantEntries: [],
  },
};

const createMemoryResolverService = (resolvedUserMemory: ResolvedUserMemoryContext = defaultResolvedUserMemory) => ({
  resolveUserMemory: jest.fn().mockResolvedValue(resolvedUserMemory),
  commitResolvedUserMemory: jest.fn().mockResolvedValue(undefined),
});

const createArchiveChatRetrieverService = (evidence: ArchivedChatEvidenceItem[] = []) => ({
  retrieveEvidence: jest.fn().mockResolvedValue(evidence),
});

const createAutoRecallService = () => ({
  recall: jest.fn().mockResolvedValue([]),
});

const createAutoCaptureService = () => ({
  captureFromTurn: jest.fn().mockResolvedValue({ created: [], superseded: [], invalidated: [] }),
});

const createIdentityCaptureService = () => ({
  captureFromTurn: jest.fn().mockResolvedValue({ created: [], superseded: [], skipped: 0 }),
});

const createIdentityRecallService = () => ({
  recall: jest.fn().mockResolvedValue({ traits: [] }),
});

const createSelfModelService = () => ({
  buildSelfModelSummary: jest.fn().mockResolvedValue({ strengths: [], improving: [], boundaries: [], style: [], values: [], raw: '' }),
});

const createAgentMetricsService = () => ({
  recordResolution: jest.fn(),
  getSnapshot: jest.fn(),
});

const createConversationalMemoryCommandService = (
  result: ConversationalMemoryCommandResult = { handled: false },
) => ({
  handle: jest.fn().mockResolvedValue(result),
});

const createResponseDirectivesService = (directives: ResponseDirectives = EMPTY_RESPONSE_DIRECTIVES) => ({
  resolve: jest.fn().mockReturnValue(directives),
});

const createTurnResponseValidator = (options?: {
  shouldUseBufferedCompletion?: boolean;
  completionContent?: string;
}) => ({
  shouldUseBufferedCompletion: jest.fn().mockReturnValue(options?.shouldUseBufferedCompletion ?? false),
  validate: jest.fn().mockReturnValue({ compliant: true, violations: [] }),
  validateDraftWithRetry: jest.fn().mockResolvedValue(options?.completionContent ?? 'assistant reply'),
  completeWithValidation: jest.fn().mockResolvedValue(options?.completionContent ?? 'assistant reply'),
});

const createRepository = () => {
  const conversation = new Conversation();
  const repository = {
    createConversation: jest.fn().mockResolvedValue(conversation),
    getConversation: jest.fn().mockResolvedValue(undefined),
    getAllConversations: jest.fn().mockResolvedValue([]),
    saveConversation: jest.fn().mockResolvedValue(undefined),
    deleteConversation: jest.fn().mockResolvedValue(true),
    checkHealth: jest.fn(),
  };

  return { conversation, repository };
};

const createToolOrchestrator = () => ({
  isEnabled: false,
  completeWithTools: jest.fn().mockResolvedValue({ content: 'tool response', messages: [], toolRoundsUsed: 0, toolCallLog: [] }),
  streamWithTools: jest.fn(),
});

const buildService = (overrides: {
  modeSelector?: unknown;
  userProfileService?: unknown;
  memoryResolverService?: unknown;
  conversationalMemoryCommandService?: unknown;
  responseDirectivesService?: unknown;
  turnResponseValidator?: unknown;
  systemPromptBuilder?: unknown;
  archiveChatRetrieverService?: unknown;
  agentMetricsService?: unknown;
  llmService?: unknown;
  autoRecallService?: unknown;
  autoCaptureService?: unknown;
  identityCaptureService?: unknown;
  identityRecallService?: unknown;
  selfModelService?: unknown;
  contextTrimService?: unknown;
  toolOrchestrator?: unknown;
  repository?: unknown;
  sessionReflectionService?: unknown;
}) =>
  new ChatService(
    (overrides.modeSelector ?? { selectMode: jest.fn().mockReturnValue('assistant') }) as ModeSelector,
    (overrides.userProfileService ?? createUserProfileService()) as UserProfileService,
    (overrides.memoryResolverService ?? createMemoryResolverService()) as MemoryResolverService,
    (overrides.conversationalMemoryCommandService ?? createConversationalMemoryCommandService()) as ConversationalMemoryCommandService,
    (overrides.responseDirectivesService ?? createResponseDirectivesService()) as ResponseDirectivesService,
    (overrides.turnResponseValidator ?? createTurnResponseValidator()) as TurnResponseValidatorService,
    (overrides.systemPromptBuilder ?? { build: jest.fn().mockReturnValue('system prompt') }) as SystemPromptBuilder,
    (overrides.archiveChatRetrieverService ?? createArchiveChatRetrieverService()) as ArchiveChatRetrieverService,
    (overrides.agentMetricsService ?? createAgentMetricsService()) as AgentMetricsService,
    (overrides.llmService ?? { complete: jest.fn(), stream: jest.fn() }) as LlmService,
    (overrides.autoRecallService ?? createAutoRecallService()) as AutoRecallService,
    (overrides.autoCaptureService ?? createAutoCaptureService()) as AutoCaptureService,
    (overrides.identityCaptureService ?? createIdentityCaptureService()) as IdentityCaptureService,
    (overrides.identityRecallService ?? createIdentityRecallService()) as IdentityRecallService,
    (overrides.selfModelService ?? createSelfModelService()) as SelfModelService,
    (overrides.contextTrimService ?? { trimIfNeeded: jest.fn().mockImplementation((conv: Conversation) => Promise.resolve({ conversation: conv, result: { trimmed: false, messagesRemoved: 0, memoriesExtracted: 0, summaryInjected: false } })) }) as ContextTrimService,
    (overrides.toolOrchestrator ?? createToolOrchestrator()) as ToolOrchestratorService,
    overrides.repository as ChatRepository,
    (overrides.sessionReflectionService ?? { reflect: jest.fn().mockResolvedValue(undefined), isAvailable: jest.fn().mockReturnValue(false) }) as any,
  );

describe('ChatService', () => {
  it('prepends the selected mode and resolved profile system prompt when sending a non-streaming message', async () => {
    const { conversation, repository } = createRepository();
    const selectModeMock = jest.fn().mockReturnValue('assistant');
    const userProfileService = createUserProfileService();
    const memoryResolverService = createMemoryResolverService();
    const buildMock = jest.fn().mockReturnValue('system prompt');
    const agentMetricsService = createAgentMetricsService();
    const turnResponseValidator = createTurnResponseValidator();
    const archiveChatRetrieverService = createArchiveChatRetrieverService();

    const service = buildService({
      modeSelector: { selectMode: selectModeMock },
      userProfileService,
      memoryResolverService,
      systemPromptBuilder: { build: buildMock },
      agentMetricsService,
      turnResponseValidator,
      archiveChatRetrieverService,
      repository,
    });

    const result = await service.sendMessage(undefined, 'Hello');

    expect(selectModeMock).toHaveBeenCalledTimes(1);
    expect(selectModeMock).toHaveBeenCalledWith(conversation);
    expect(memoryResolverService.resolveUserMemory).toHaveBeenCalledTimes(1);
    expect(memoryResolverService.resolveUserMemory).toHaveBeenCalledWith(conversation);
    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(buildMock).toHaveBeenCalledWith('assistant', defaultUserProfile, expect.objectContaining({
      userProfileSource: 'recent_context',
      userFacts: [],
      episodicMemories: [],
      recalledMemories: [],
      archiveEvidence: [],
    }));
    expect((archiveChatRetrieverService.retrieveEvidence as jest.Mock)).toHaveBeenCalledWith(conversation, { limit: 6 });
    expect(turnResponseValidator.completeWithValidation).toHaveBeenCalledTimes(1);
    expect(turnResponseValidator.completeWithValidation.mock.calls[0]?.[0]).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(result.conversation.id).toBe(conversation.id);
    expect(result.assistantMessage.content).toBe('assistant reply');
    expect(conversation.messages).toHaveLength(2);
    expect(repository.saveConversation).toHaveBeenCalledTimes(1);
    expect(memoryResolverService.commitResolvedUserMemory).toHaveBeenCalledWith(defaultResolvedUserMemory);
    expect(agentMetricsService.recordResolution).toHaveBeenCalledWith({
      mode: 'assistant',
      modeSource: 'inferred',
      profileSource: 'recent_context',
      profileKeyKind: 'local_default',
      userProfile: defaultUserProfile,
    });
  });

  it('prepends the selected mode and resolved profile system prompt when streaming a message', async () => {
    const { conversation, repository } = createRepository();
    const selectModeMock = jest.fn().mockReturnValue('assistant');
    const userProfileService = createUserProfileService();
    const memoryResolverService = createMemoryResolverService();
    const buildMock = jest.fn().mockReturnValue('system prompt');
    const agentMetricsService = createAgentMetricsService();
    const llmChunks: LlmStreamChunk[] = [
      { content: 'Hello', done: false },
      { content: ' world', done: false },
      { content: '', done: true },
    ];
    const streamMock = jest.fn(async function* (messages: LlmMessage[]) {
      void messages;
      for (const chunk of llmChunks) {
        yield chunk;
      }
    });
    const archiveChatRetrieverService = createArchiveChatRetrieverService();

    const service = buildService({
      modeSelector: { selectMode: selectModeMock },
      userProfileService,
      memoryResolverService,
      systemPromptBuilder: { build: buildMock },
      agentMetricsService,
      llmService: { complete: jest.fn(), stream: streamMock },
      archiveChatRetrieverService,
      repository,
    });

    const emitted = [] as Array<{ chunk: LlmStreamChunk; conversationId: string; messageId: string }>;
    for await (const item of service.streamMessage(undefined, 'Hello')) {
      emitted.push(item);
    }

    expect(selectModeMock).toHaveBeenCalledTimes(1);
    expect(selectModeMock).toHaveBeenCalledWith(conversation);
    expect(memoryResolverService.resolveUserMemory).toHaveBeenCalledWith(conversation);
    expect(buildMock).toHaveBeenCalledWith('assistant', defaultUserProfile, expect.objectContaining({
      userProfileSource: 'recent_context',
      userFacts: [],
      episodicMemories: [],
      recalledMemories: [],
      archiveEvidence: [],
    }));
    expect(streamMock.mock.calls[0]?.[0]).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(emitted).toHaveLength(3);
    expect(new Set(emitted.map((item) => item.messageId)).size).toBe(1);
    expect(new Set(emitted.map((item) => item.conversationId))).toEqual(new Set([conversation.id]));
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]?.content).toBe('Hello world');
    // Called twice: once before stream (persist user message), once after (persist assistant reply)
    expect(repository.saveConversation).toHaveBeenCalledTimes(2);
    expect(memoryResolverService.commitResolvedUserMemory).toHaveBeenCalledWith(defaultResolvedUserMemory);
    expect(agentMetricsService.recordResolution).toHaveBeenCalledWith({
      mode: 'assistant',
      modeSource: 'inferred',
      profileSource: 'recent_context',
      profileKeyKind: 'local_default',
      userProfile: defaultUserProfile,
    });
  });

  it('uses an explicit mode override instead of inferred selection', async () => {
    const { repository } = createRepository();
    const selectModeMock = jest.fn().mockReturnValue('assistant');
    const buildMock = jest.fn().mockReturnValue('system prompt');
    const agentMetricsService = createAgentMetricsService();

    const service = buildService({
      modeSelector: { selectMode: selectModeMock },
      systemPromptBuilder: { build: buildMock },
      agentMetricsService,
      repository,
    });

    await service.sendMessage(undefined, 'Hello', { mode: 'strategist' });

    expect(selectModeMock).not.toHaveBeenCalled();
    expect(buildMock).toHaveBeenCalledWith('strategist', defaultUserProfile, expect.objectContaining({
      userProfileSource: 'recent_context',
      userFacts: [],
      episodicMemories: [],
      recalledMemories: [],
      archiveEvidence: [],
    }));
    expect(agentMetricsService.recordResolution).toHaveBeenCalledWith({
      mode: 'strategist',
      modeSource: 'explicit',
      profileSource: 'recent_context',
      profileKeyKind: 'local_default',
      userProfile: defaultUserProfile,
    });
  });

  it('returns memory command operationNote directly without calling the LLM for non-streaming chat', async () => {
    const { repository } = createRepository();
    const completeMock = jest.fn();
    const operationNote = 'Memory snapshot: 3 entries stored.';
    const conversationalMemoryCommandService = createConversationalMemoryCommandService({
      handled: true,
      response: operationNote,
    });

    const service = buildService({
      conversationalMemoryCommandService,
      llmService: { complete: completeMock, stream: jest.fn() },
      repository,
    });

    const result = await service.sendMessage(undefined, 'Show memory snapshot');

    expect(conversationalMemoryCommandService.handle).toHaveBeenCalledWith('Show memory snapshot', expect.any(Conversation));
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.assistantMessage.content).toBe(operationNote);
  });

  it('returns memory command operationNote directly without calling the LLM for streaming chat', async () => {
    const { repository } = createRepository();
    const streamMock = jest.fn();
    const operationNote = 'I forgot your stored project fact.';
    const conversationalMemoryCommandService = createConversationalMemoryCommandService({
      handled: true,
      response: operationNote,
    });

    const service = buildService({
      conversationalMemoryCommandService,
      llmService: { complete: jest.fn(), stream: streamMock },
      repository,
    });

    const emitted = [] as Array<{ chunk: LlmStreamChunk; conversationId: string; messageId: string }>;
    for await (const item of service.streamMessage(undefined, 'Forget my project')) {
      emitted.push(item);
    }

    expect(conversationalMemoryCommandService.handle).toHaveBeenCalledWith('Forget my project', expect.any(Conversation));
    expect(streamMock).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.chunk.content).toBe(operationNote);
    expect(emitted[1]?.chunk.done).toBe(true);
  });

  it('delegates response generation with directives to TurnResponseValidator completeWithValidation', async () => {
    const { conversation, repository } = createRepository();
    const directives: ResponseDirectives = {
      language: 'ru',
      verbosity: 'concise',
      shape: 'definition_only',
      hardLimits: {
        singleSentence: true,
        noExamples: true,
        noAdjacentFacts: true,
        noOptionalExpansion: true,
      },
    };
    const responseDirectivesService = createResponseDirectivesService(directives);
    const turnResponseValidator = createTurnResponseValidator({
      completionContent: 'Это модель согласованности.',
    });
    const buildMock = jest.fn().mockReturnValue('system prompt');

    const service = buildService({
      responseDirectivesService,
      turnResponseValidator,
      systemPromptBuilder: { build: buildMock },
      repository,
    });

    const result = await service.sendMessage(undefined, 'что такое eventual consistency?');

    expect(responseDirectivesService.resolve).toHaveBeenCalledWith('что такое eventual consistency?');
    expect(buildMock).toHaveBeenCalledWith('assistant', defaultUserProfile, expect.objectContaining({
      userProfileSource: 'recent_context',
      userFacts: [],
      episodicMemories: [],
      recalledMemories: [],
      archiveEvidence: [],
      responseDirectives: directives,
    }));
    expect(turnResponseValidator.completeWithValidation).toHaveBeenCalledTimes(1);
    expect(turnResponseValidator.completeWithValidation.mock.calls[0]?.[0]).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'что такое eventual consistency?' },
    ]);
    expect(turnResponseValidator.completeWithValidation.mock.calls[0]?.[1]).toEqual(directives);
    expect(result.assistantMessage.content).toBe('Это модель согласованности.');
    expect(conversation.messages).toHaveLength(2);
  });

  it('passes memory grounding context to TurnResponseValidator for memory questions', async () => {
    const { repository } = createRepository();
    const turnResponseValidator = createTurnResponseValidator({
      shouldUseBufferedCompletion: true,
      completionContent: 'Я не знаю точно.',
    });
    const toolOrchestrator = createToolOrchestrator();
    toolOrchestrator.isEnabled = true;
    const buildMock = jest.fn().mockReturnValue('system prompt');

    const service = buildService({
      turnResponseValidator,
      systemPromptBuilder: { build: buildMock },
      toolOrchestrator,
      repository,
    });

    const result = await service.sendMessage(undefined, 'Как меня зовут?');

    expect(buildMock).toHaveBeenCalledWith(
      'assistant',
      defaultUserProfile,
      expect.objectContaining({
        userProfileSource: 'recent_context',
        archiveEvidence: [],
        memoryGrounding: expect.objectContaining({
          isMemoryQuestion: true,
          intent: 'name',
          evidenceStrength: 'none',
          shouldUseUncertaintyFirst: true,
        }),
        responseDirectives: expect.objectContaining({
          hardLimits: expect.objectContaining({ uncertaintyFirst: true }),
        }),
      }),
    );
    expect(toolOrchestrator.completeWithTools).toHaveBeenCalledTimes(1);
    expect(turnResponseValidator.validateDraftWithRetry).toHaveBeenCalledWith(
      expect.any(Array),
      'tool response',
      expect.objectContaining({
        hardLimits: expect.objectContaining({ uncertaintyFirst: true }),
      }),
      expect.objectContaining({
        isMemoryQuestion: true,
        intent: 'name',
        evidenceStrength: 'none',
      }),
    );
    expect(turnResponseValidator.completeWithValidation).not.toHaveBeenCalled();
    expect(result.assistantMessage.content).toBe('Я не знаю точно.');
  });

  it('uses buffered completion for streaming when strict turn-level directives require compliance validation', async () => {
    const { conversation, repository } = createRepository();
    const directives: ResponseDirectives = {
      shape: 'steps_only',
      structure: 'structured',
      hardLimits: { noOptionalExpansion: true },
    };
    const responseDirectivesService = createResponseDirectivesService(directives);
    const turnResponseValidator = createTurnResponseValidator({
      shouldUseBufferedCompletion: true,
      completionContent: '1. Check auth.\n2. Check DB.\n3. Check logs.',
    });
    const streamMock = jest.fn();

    const service = buildService({
      responseDirectivesService,
      turnResponseValidator,
      llmService: { complete: jest.fn(), stream: streamMock },
      repository,
    });

    const emitted = [] as Array<{ chunk: LlmStreamChunk; conversationId: string; messageId: string }>;
    for await (const item of service.streamMessage(undefined, 'только шаги')) {
      emitted.push(item);
    }

    expect(streamMock).not.toHaveBeenCalled();
    expect(turnResponseValidator.completeWithValidation).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.chunk).toEqual({ content: '1. Check auth.\n2. Check DB.\n3. Check logs.', done: false });
    expect(emitted[1]?.chunk).toEqual({ content: '', done: true });
    expect(conversation.messages).toHaveLength(2);
    expect(repository.saveConversation).toHaveBeenCalledTimes(1);
  });
});
