import { Injectable } from '@nestjs/common';

import { Conversation } from '../../chat/entities/conversation.entity';
import { inferDurableProfilePatch, inferProfilePatch } from './user-profile.detectors';
import {
  DEFAULT_AGENT_USER_PROFILE,
  mergeAgentUserProfile,
  type AgentUserProfile,
  type AgentUserProfilePatch,
} from './user-profile.types';

@Injectable()
export class UserProfileService {
  resolveProfile(
    conversation: Conversation,
    baseProfile: AgentUserProfile = DEFAULT_AGENT_USER_PROFILE,
  ): AgentUserProfile {
    return mergeAgentUserProfile(baseProfile, this.inferProfilePatch(conversation));
  }

  resolveProfileForPersistence(
    conversation: Conversation,
    baseProfile: AgentUserProfile = DEFAULT_AGENT_USER_PROFILE,
  ): AgentUserProfile {
    return mergeAgentUserProfile(baseProfile, this.inferDurableProfilePatch(conversation));
  }

  inferProfilePatch(conversation: Conversation): AgentUserProfilePatch {
    return inferProfilePatch(conversation);
  }

  inferDurableProfilePatch(conversation: Conversation): AgentUserProfilePatch {
    return inferDurableProfilePatch(conversation);
  }
}
