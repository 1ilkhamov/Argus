import { Injectable, Optional } from '@nestjs/common';

import { ARGUS_CORE_CONTRACT } from '../core-contract';
import { SoulConfigService, type SoulConfigRuntimeState } from '../identity/config/soul-config.service';
import type { SoulConfig } from '../identity/config/soul-config.types';
import type { StructuredSystemPrompt, SystemPromptSection } from './prompt-section.types';
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
  private readonly toolCapabilitiesInstruction = 'IMPORTANT: You have REAL tool capabilities. You CAN set reminders and scheduled tasks via the "cron" tool. You CAN send desktop and Telegram notifications via the "notify" tool. You CAN search/manage your long-term memory via "memory_manage". You CAN run shell commands via "system_run". You CAN search the web and fetch pages. You CAN query SQLite and PostgreSQL databases via "sql_query". You CAN automate macOS via "applescript" (AppleScript/JXA). You CAN generate PDF/HTML documents from markdown via "document_gen". You CAN create webhook endpoints for event-driven automation via the "webhook" tool. You CAN read, search, and send emails via the "email" tool (Gmail, Outlook, Yandex, Mail.ru, iCloud, custom IMAP/SMTP). You CAN manage long-running background processes via the "process" tool (start, poll output, send stdin, kill). You CAN spawn parallel sub-agents via the "sub_agent" tool to handle multiple independent tasks simultaneously. You CAN read and send messages in Telegram chats as the connected user account via the "telegram_client" tool (list dialogs, read messages, send messages, manage monitored chats for auto-reply). NEVER say "I cannot" for these capabilities — USE THE TOOLS.';

  constructor(@Optional() private readonly soulConfigService?: SoulConfigService) {}

  getRuntimeState(): SoulConfigRuntimeState {
    return this.soulConfigService?.getRuntimeState() ?? {
      source: 'core_contract_fallback',
      sourceKind: 'core_contract_fallback',
      watching: false,
    };
  }

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
    return this.buildStructured(mode, userProfile, options).content;
  }

  buildStructured(
    mode: AgentModeId = DEFAULT_AGENT_MODE,
    userProfile: AgentUserProfile = DEFAULT_AGENT_USER_PROFILE,
    options: SystemPromptBuildOptions = {},
  ): StructuredSystemPrompt {
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

    const sections: SystemPromptSection[] = [];

    this.pushSection(
      sections,
      'core_identity',
      'Core Identity',
      'critical',
      'never',
      'soul',
      buildCoreIdentitySection(identity, soul.defaultBehavior, context.availableModes),
    );
    this.pushSection(sections, 'tool_capabilities', 'Tool Capabilities', 'critical', 'never', 'tooling', [this.toolCapabilitiesInstruction]);
    this.pushSection(sections, 'personality', 'Personality', 'high', 'compress', 'soul', buildPersonalitySection(soul));
    this.pushSection(sections, 'identity_traits', 'Identity Traits', 'medium', 'compress', 'identity', buildIdentitySection(options.identityTraits ?? []));
    this.pushSection(sections, 'self_model', 'Self Model', 'medium', 'compress', 'identity', buildSelfModelSection(options.selfModelRaw ?? ''));
    this.pushSection(sections, 'mode', 'Mode', 'critical', 'never', 'mode', buildModeSection(context));
    this.pushSection(sections, 'user_profile', 'User Profile', 'high', 'compress', 'profile', buildUserProfileSection(context));
    this.pushSection(sections, 'turn_directives', 'Turn Directives', 'critical', 'never', 'directive', buildTurnDirectiveSection(context));
    this.pushSection(sections, 'user_facts', 'User Facts', 'high', 'compress', 'memory', buildUserFactsSection(context.userFacts));
    this.pushSection(sections, 'episodic_memory', 'Episodic Memory', 'medium', 'compress', 'memory', buildEpisodicMemorySection(context.episodicMemories));
    this.pushSection(sections, 'recalled_memory', 'Recalled Memory', 'medium', 'drop', 'memory', buildRecalledMemorySection(context.recalledMemories));
    this.pushSection(
      sections,
      'archive_evidence',
      'Archive Evidence',
      'low',
      'drop',
      'archive',
      buildArchiveEvidenceSection(context.archiveEvidence, this.archiveEvidenceMaxItems, this.archiveEvidenceMaxTotalChars),
    );
    this.pushSection(sections, 'memory_grounding', 'Memory Grounding', 'critical', 'never', 'grounding', buildMemoryGroundingSection(context.memoryGrounding));
    this.pushSection(sections, 'truthfulness', 'Truthfulness', 'critical', 'never', 'grounding', buildTruthfulnessSection(context.userProfileSource));
    this.pushSection(sections, 'invariants', 'Invariants', 'critical', 'never', 'soul', soul.invariants);
    this.pushSection(sections, 'anti_goals', 'Anti Goals', 'critical', 'never', 'soul', soul.antiGoals.length > 0 ? [`Avoid the following: ${soul.antiGoals.join(', ')}.`] : []);
    this.pushSection(sections, 'interaction_contract', 'Interaction Contract', 'critical', 'never', 'soul', soul.interactionContract);
    this.pushSection(sections, 'mode_instructions', 'Mode Instructions', 'critical', 'never', 'mode', context.activeMode.instructions);

    return {
      sections,
      content: sections.map((section) => section.content).join(' '),
    };
  }

  private pushSection(
    sections: SystemPromptSection[],
    id: string,
    title: string,
    priority: SystemPromptSection['priority'],
    trimPolicy: SystemPromptSection['trimPolicy'],
    source: SystemPromptSection['source'],
    lines: string[],
  ): void {
    const content = lines.filter((line) => line.trim().length > 0).join(' ').trim();
    if (!content) {
      return;
    }

    sections.push({ id, title, priority, trimPolicy, source, content });
  }
}
