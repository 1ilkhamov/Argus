import { Injectable, Optional } from '@nestjs/common';

import { ARGUS_CORE_CONTRACT } from '../core-contract';
import { SoulConfigService } from '../identity/config/soul-config.service';
import type { SoulConfig } from '../identity/config/soul-config.types';
import {
  AGENT_MODE_REGISTRY,
  DEFAULT_AGENT_MODE,
  getAgentModeDefinition,
} from '../modes/mode-registry';
import type { AgentModeId } from '../modes/mode.types';
import {
  DEFAULT_AGENT_USER_PROFILE,
  type AgentUserProfile,
  type AgentUserProfileSource,
} from '../profile/user-profile.types';
import {
  buildArchiveEvidenceSection,
  buildCoreIdentitySection,
  buildEpisodicMemorySection,
  buildIdentitySection,
  buildMemoryGroundingSection,
  buildModeSection,
  buildPersonalitySection,
  buildRecalledMemorySection,
  buildSelfModelSection,
  buildTruthfulnessSection,
  buildTurnDirectiveSection,
  buildUserFactsSection,
  buildUserProfileSection,
  resolveEffectiveVerbosity,
  type SystemPromptContext,
} from './sections';
import { EMPTY_RESPONSE_DIRECTIVES, type ResponseDirectives } from '../response-directives/response-directives.types';
import type { EpisodicMemoryEntry } from '../../memory/episodic-memory.types';
import type { RecalledMemory } from '../../memory/core/memory-entry.types';
import type { RecalledIdentityTrait } from '../identity/recall/identity-recall.service';
import type { ArchivedChatEvidenceItem } from '../../memory/archive/archive-chat-retrieval.types';
import { EMPTY_MEMORY_GROUNDING_CONTEXT, type MemoryGroundingContext } from '../../memory/grounding/grounding-policy';
import type { UserProfileFact } from '../../memory/user-profile-facts.types';

export interface SystemPromptBuildOptions {
  userProfileSource?: AgentUserProfileSource;
  userFacts?: UserProfileFact[];
  episodicMemories?: EpisodicMemoryEntry[];
  recalledMemories?: RecalledMemory[];
  identityTraits?: RecalledIdentityTrait[];
  selfModelRaw?: string;
  archiveEvidence?: ArchivedChatEvidenceItem[];
  memoryGrounding?: MemoryGroundingContext;
  responseDirectives?: ResponseDirectives;
}

@Injectable()
export class SystemPromptBuilder {
  private readonly archiveEvidenceMaxItems = 6;
  private readonly archiveEvidenceMaxTotalChars = 900;

  constructor(@Optional() private readonly soulConfigService?: SoulConfigService) {}

  private getSoulConfig(): SoulConfig {
    if (this.soulConfigService) {
      return this.soulConfigService.getSoulConfig();
    }
    // Fallback for tests or when SoulConfigService is not injected
    const cc = ARGUS_CORE_CONTRACT;
    return {
      name: cc.identity.name,
      role: cc.identity.role,
      mission: cc.identity.mission,
      personality: [],
      invariants: cc.invariants,
      never: [],
      values: [],
      defaultBehavior: cc.defaultBehavior,
      interactionContract: cc.interactionContract,
      antiGoals: cc.antiGoals,
    };
  }

  build(
    mode: AgentModeId = DEFAULT_AGENT_MODE,
    userProfile: AgentUserProfile = DEFAULT_AGENT_USER_PROFILE,
    options: SystemPromptBuildOptions = {},
  ): string {
    const soul = this.getSoulConfig();
    const identity = { name: soul.name, role: soul.role, mission: soul.mission };
    const activeMode = getAgentModeDefinition(mode);
    const responseDirectives = options.responseDirectives ?? EMPTY_RESPONSE_DIRECTIVES;
    const effectiveVerbosity = resolveEffectiveVerbosity(mode, userProfile, responseDirectives);
    const userProfileSource = options.userProfileSource ?? 'recent_context';
    const archiveEvidence = options.archiveEvidence ?? [];
    const memoryGrounding = options.memoryGrounding ?? EMPTY_MEMORY_GROUNDING_CONTEXT;
    const availableModes = Object.values(AGENT_MODE_REGISTRY)
      .map((definition) => `${definition.id} (${definition.label})`)
      .join(', ');
    const context: SystemPromptContext = {
      activeMode,
      availableModes,
      effectiveVerbosity,
      userProfile,
      userProfileSource,
      userFacts: options.userFacts ?? [],
      episodicMemories: options.episodicMemories ?? [],
      recalledMemories: options.recalledMemories ?? [],
      archiveEvidence,
      memoryGrounding,
      responseDirectives,
    };

    return [
      ...buildCoreIdentitySection(identity, soul.defaultBehavior, context.availableModes),
      // Tool capabilities — placed early so the LLM knows what it CAN do before it reflexively refuses
      'IMPORTANT: You have REAL tool capabilities. You CAN set reminders and scheduled tasks via the "cron" tool. You CAN send desktop and Telegram notifications via the "notify" tool. You CAN search/manage your long-term memory via "memory_manage". You CAN run shell commands via "system_run". You CAN search the web and fetch pages. You CAN query SQLite and PostgreSQL databases via "sql_query". You CAN automate macOS via "applescript" (AppleScript/JXA). You CAN generate PDF/HTML documents from markdown via "document_gen". You CAN create webhook endpoints for event-driven automation via the "webhook" tool. You CAN read, search, and send emails via the "email" tool (Gmail, Outlook, Yandex, Mail.ru, iCloud, custom IMAP/SMTP). You CAN manage long-running background processes via the "process" tool (start, poll output, send stdin, kill). You CAN spawn parallel sub-agents via the "sub_agent" tool to handle multiple independent tasks simultaneously. You CAN read and send messages in Telegram chats as the connected user account via the "telegram_client" tool (list dialogs, read messages, send messages, manage monitored chats for auto-reply). NEVER say "I cannot" for these capabilities — USE THE TOOLS.',
      ...buildPersonalitySection(soul),
      ...buildIdentitySection(options.identityTraits ?? []),
      ...buildSelfModelSection(options.selfModelRaw ?? ''),
      ...buildModeSection(context),
      ...buildUserProfileSection(context),
      ...buildTurnDirectiveSection(context),
      ...buildUserFactsSection(context.userFacts),
      ...buildEpisodicMemorySection(context.episodicMemories),
      ...buildRecalledMemorySection(context.recalledMemories),
      ...buildArchiveEvidenceSection(context.archiveEvidence, this.archiveEvidenceMaxItems, this.archiveEvidenceMaxTotalChars),
      ...buildMemoryGroundingSection(context.memoryGrounding),
      ...buildTruthfulnessSection(context.userProfileSource),
      ...soul.invariants,
      `Avoid the following: ${soul.antiGoals.join(', ')}.`,
      ...soul.interactionContract,
      ...context.activeMode.instructions,
    ].join(' ');
  }
}
