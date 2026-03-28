import type { AgentBehaviorLevel, AgentVerbosity } from '../core-contract';

export const AGENT_MODE_IDS = ['assistant', 'operator', 'strategist', 'researcher', 'reflective'] as const;

export type AgentModeId = (typeof AGENT_MODE_IDS)[number];

export interface AgentModeDefinition {
  id: AgentModeId;
  label: string;
  purpose: string;
  behavior: {
    initiative: AgentBehaviorLevel;
    assertiveness: AgentBehaviorLevel;
    warmth: AgentBehaviorLevel;
    verbosity: AgentVerbosity;
  };
  instructions: string[];
}
