import type { AgentModeId } from '../../agent/modes/mode.types';
import type { MemoryGroundingContext } from '../../memory/grounding/grounding-policy';
import type { TurnExecutionBudgetSnapshot, TurnExecutionMode, TurnExecutionPhase } from './turn-execution-state.types';

export interface TurnResolutionDiagnostics {
  timestamp: string;
  conversationId: string;
  scopeKey: string;
  mode: AgentModeId;
  modeSource: 'explicit' | 'inferred';
  executionMode: TurnExecutionMode;
  executionReasons: string[];
  counts: {
    userFacts: number;
    episodicMemories: number;
    recalledMemories: number;
    archiveEvidence: number;
    identityTraits: number;
  };
  soulSource: string;
  prompt: TurnExecutionBudgetSnapshot & {
    systemSectionCount: number;
    historyMessageCount: number;
  };
  checkpoint: {
    active: boolean;
    resumed: boolean;
    phase?: TurnExecutionPhase;
  };
  memoryGrounding: {
    isMemoryQuestion: boolean;
    intent?: MemoryGroundingContext['intent'];
    evidenceStrength: MemoryGroundingContext['evidenceStrength'];
    uncertaintyFirst: boolean;
  };
}
