import type { AgentVerbosity } from '../core-contract';

export type AgentPreferredLanguage = 'auto' | 'ru' | 'en';
export type AgentTone = 'direct' | 'warm' | 'formal';
export type AgentStructurePreference = 'adaptive' | 'structured';

export interface AgentUserProfile {
  communication: {
    preferredLanguage: AgentPreferredLanguage;
    tone: AgentTone;
    detail: AgentVerbosity;
    structure: AgentStructurePreference;
  };
  interaction: {
    allowPushback: boolean;
    allowProactiveSuggestions: boolean;
  };
}

export interface AgentUserProfilePatch {
  communication?: Partial<AgentUserProfile['communication']>;
  interaction?: Partial<AgentUserProfile['interaction']>;
}

export type AgentUserProfileSource = 'recent_context' | 'persisted_profile_and_recent_context';

export const DEFAULT_AGENT_USER_PROFILE: AgentUserProfile = {
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

export const mergeAgentUserProfile = (
  baseProfile: AgentUserProfile,
  patch: AgentUserProfilePatch = {},
): AgentUserProfile => ({
  communication: {
    ...baseProfile.communication,
    ...patch.communication,
  },
  interaction: {
    ...baseProfile.interaction,
    ...patch.interaction,
  },
});
