import type { RecalledIdentityTrait } from '../../agent/identity/recall/identity-recall.service';
import type { AgentModeId } from '../../agent/modes/mode.types';
import type { AgentUserProfile, AgentUserProfileSource } from '../../agent/profile/user-profile.types';
import type { SystemPromptSection } from '../../agent/prompt/prompt-section.types';
import type { ResponseDirectives } from '../../agent/response-directives/response-directives.types';
import type { Conversation } from '../entities/conversation.entity';
import type { LlmCompletionOptions, LlmMessage } from '../../llm/interfaces/llm.interface';
import type { LlmRuntimeProfile } from '../../llm/llm-runtime.types';
import type { ArchivedChatEvidenceItem } from '../../memory/archive/archive-chat-retrieval.types';
import type { RecalledMemory } from '../../memory/core/memory-entry.types';
import type { EpisodicMemoryEntry } from '../../memory/episodic-memory.types';
import type { MemoryGroundingContext } from '../../memory/grounding/grounding-policy';
import type { UserProfileFact } from '../../memory/user-profile-facts.types';
import type { TurnExecutionBudgetSnapshot, TurnExecutionMode, TurnExecutionState } from './turn-execution-state.types';

export interface PromptAssemblyInput {
  conversation: Conversation;
  mode: AgentModeId;
  userProfile: AgentUserProfile;
  userProfileSource: AgentUserProfileSource;
  userFacts: UserProfileFact[];
  episodicMemories: EpisodicMemoryEntry[];
  recalledMemories: RecalledMemory[];
  identityTraits: RecalledIdentityTrait[];
  selfModelRaw: string;
  archiveEvidence: ArchivedChatEvidenceItem[];
  memoryGrounding: MemoryGroundingContext;
  responseDirectives: ResponseDirectives;
  extraSystemInstruction?: string;
}

export interface PromptAssemblyHistoryMessage {
  message: LlmMessage;
  estimatedTokens: number;
  locked: boolean;
}

export interface PromptAssembly {
  systemSections: SystemPromptSection[];
  historyMessages: PromptAssemblyHistoryMessage[];
  estimatedSystemTokens: number;
  estimatedHistoryTokens: number;
  estimatedTotalTokens: number;
}

export interface BudgetPromptInput {
  assembly: PromptAssembly;
  runtimeProfile: LlmRuntimeProfile;
  needsBufferedCompletion: boolean;
  toolsEnabled: boolean;
}

export interface BudgetedPrompt {
  messages: LlmMessage[];
  systemSections: SystemPromptSection[];
  historyMessages: PromptAssemblyHistoryMessage[];
  completionOptions: LlmCompletionOptions;
  budget: TurnExecutionBudgetSnapshot;
}

export interface TurnExecutionPlan {
  mode: TurnExecutionMode;
  reasonCodes: string[];
  shouldResumeFromCheckpoint: boolean;
  workingSummary?: string;
  remainingSteps?: string[];
  executionInstruction?: string;
  checkpoint?: TurnExecutionState;
}
