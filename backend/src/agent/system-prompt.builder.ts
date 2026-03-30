import { Injectable } from '@nestjs/common';

import { ARGUS_CORE_CONTRACT } from './core-contract';
import {
  AGENT_MODE_REGISTRY,
  DEFAULT_AGENT_MODE,
  getAgentModeDefinition,
} from './modes/mode-registry';
import type { AgentModeId } from './modes/mode.types';
import {
  DEFAULT_AGENT_USER_PROFILE,
  type AgentUserProfile,
  type AgentUserProfileSource,
} from './profile/user-profile.types';
import {
  EMPTY_RESPONSE_DIRECTIVES,
  hasExplicitResponseDirectives,
  type ResponseDirectives,
} from './response-directives.types';
import type { EpisodicMemoryEntry } from '../memory/episodic-memory.types';
import type { UserProfileFact } from '../memory/user-profile-facts.types';

export interface SystemPromptBuildOptions {
  userProfileSource?: AgentUserProfileSource;
  userFacts?: UserProfileFact[];
  episodicMemories?: EpisodicMemoryEntry[];
  responseDirectives?: ResponseDirectives;
}

interface SystemPromptContext {
  activeMode: ReturnType<typeof getAgentModeDefinition>;
  availableModes: string;
  effectiveVerbosity: 'adaptive' | 'concise' | 'detailed';
  userProfile: AgentUserProfile;
  userProfileSource: AgentUserProfileSource;
  userFacts: UserProfileFact[];
  episodicMemories: EpisodicMemoryEntry[];
  responseDirectives: ResponseDirectives;
}

@Injectable()
export class SystemPromptBuilder {
  build(
    mode: AgentModeId = DEFAULT_AGENT_MODE,
    userProfile: AgentUserProfile = DEFAULT_AGENT_USER_PROFILE,
    options: SystemPromptBuildOptions = {},
  ): string {
    const { identity, invariants, defaultBehavior, antiGoals, interactionContract } =
      ARGUS_CORE_CONTRACT;
    const activeMode = getAgentModeDefinition(mode);
    const responseDirectives = options.responseDirectives ?? EMPTY_RESPONSE_DIRECTIVES;
    const effectiveVerbosity = this.resolveEffectiveVerbosity(mode, userProfile, responseDirectives);
    const userProfileSource = options.userProfileSource ?? 'recent_context';
    const userFacts = options.userFacts ?? [];
    const episodicMemories = options.episodicMemories ?? [];
    const availableModes = Object.values(AGENT_MODE_REGISTRY)
      .map((definition) => `${definition.id} (${definition.label})`)
      .join(', ');
    const context: SystemPromptContext = {
      activeMode,
      availableModes,
      effectiveVerbosity,
      userProfile,
      userProfileSource,
      userFacts,
      episodicMemories,
      responseDirectives,
    };

    return [
      ...this.buildCoreIdentitySection(identity, defaultBehavior, context.availableModes),
      ...this.buildModeSection(context),
      ...this.buildUserProfileSection(context),
      ...this.buildTurnDirectiveSection(context),
      ...this.buildUserFactsSection(context.userFacts),
      ...this.buildEpisodicMemorySection(context.episodicMemories),
      ...this.buildTruthfulnessSection(context.userProfileSource),
      ...invariants,
      `Avoid the following: ${antiGoals.join(', ')}.`,
      ...interactionContract,
      ...context.activeMode.instructions,
    ].join(' ');
  }

  private buildCoreIdentitySection(
    identity: typeof ARGUS_CORE_CONTRACT.identity,
    defaultBehavior: typeof ARGUS_CORE_CONTRACT.defaultBehavior,
    availableModes: string,
  ): string[] {
    return [
      `You are ${identity.name} — ${identity.role}.`,
      ...identity.mission,
      `Baseline operating style: initiative=${defaultBehavior.initiative}, assertiveness=${defaultBehavior.assertiveness}, warmth=${defaultBehavior.warmth}, verbosity=${defaultBehavior.verbosity}.`,
      `Available runtime modes: ${availableModes}.`,
      'Do not invent, rename, or imply additional internal modes or architecture layers unless they are explicitly established in the current context.',
    ];
  }

  private buildModeSection(context: SystemPromptContext): string[] {
    return [
      `Active mode: ${context.activeMode.label}. ${context.activeMode.purpose}`,
      `In this mode, adjust your behavior to initiative=${context.activeMode.behavior.initiative}, assertiveness=${context.activeMode.behavior.assertiveness}, warmth=${context.activeMode.behavior.warmth}, verbosity=${context.effectiveVerbosity}.`,
    ];
  }

  private buildUserProfileSection(context: SystemPromptContext): string[] {
    return [
      `User communication preferences: language=${context.userProfile.communication.preferredLanguage}, tone=${context.userProfile.communication.tone}, detail=${context.userProfile.communication.detail}, structure=${context.userProfile.communication.structure}.`,
      `User interaction preferences: allowPushback=${context.userProfile.interaction.allowPushback}, allowProactiveSuggestions=${context.userProfile.interaction.allowProactiveSuggestions}.`,
      this.buildLanguageInstruction(context),
      this.buildToneInstruction(context),
      this.buildDetailInstruction(context),
      this.buildStructureInstruction(context),
      this.buildPushbackInstruction(context.userProfile),
      this.buildSuggestionInstruction(context.userProfile),
    ];
  }

  private buildTurnDirectiveSection(context: SystemPromptContext): string[] {
    if (!hasExplicitResponseDirectives(context.responseDirectives)) {
      return [];
    }

    const rules = [
      'Current-turn response directives override profile and mode defaults for this answer unless truthfulness or safety require a narrower answer.',
    ];

    if (context.responseDirectives.hardLimits.singleSentence) {
      rules.push('If the user asked for one sentence, produce exactly one sentence.');
    }

    if (context.responseDirectives.hardLimits.noExamples) {
      rules.push('If the user asked for no examples, do not include examples.');
    }

    if (context.responseDirectives.hardLimits.noAdjacentFacts || context.responseDirectives.hardLimits.noOptionalExpansion) {
      rules.push('Do not add optional expansion or nearby but unasked-for facts after the direct answer.');
    }

    if (context.responseDirectives.hardLimits.maxTopLevelItems !== undefined) {
      rules.push(`Use no more than ${context.responseDirectives.hardLimits.maxTopLevelItems} top-level items.`);
    }

    if (context.responseDirectives.hardLimits.uncertaintyFirst) {
      rules.push('If the request asks for uncertainty-first handling, start by naming the missing information or uncertainty before giving guidance.');
    }

    return rules;
  }

  private buildUserFactsSection(userFacts: UserProfileFact[]): string[] {
    if (userFacts.length === 0) {
      return [];
    }

    return [
      `Known user facts: ${userFacts.map((fact) => `${fact.key}=${fact.value}`).join('; ')}.`,
      'Use known user facts only when they are relevant to the current request. Do not infer additional biography, persistence scope, or hidden context beyond what is explicitly established.',
    ];
  }

  private buildEpisodicMemorySection(episodicMemories: EpisodicMemoryEntry[]): string[] {
    if (episodicMemories.length === 0) {
      return [];
    }

    return [
      `Relevant conversation memory: ${episodicMemories.map((entry) => `${entry.kind}=${entry.summary}`).join('; ')}.`,
      'Use relevant conversation memory only when it materially helps with the current request. Treat it as lightweight prior context, not as a license to invent hidden state or claim more certainty than the stored memory supports.',
    ];
  }

  private buildTruthfulnessSection(userProfileSource: AgentUserProfileSource): string[] {
    return [
      'Implementation truthfulness rule: when the user asks about the current system, code, or architecture, only claim details that are explicitly established in the provided context. Separate confirmed facts from guesses, and say when something is unknown.',
      'Known-concept rule: if a concept is already established in the current context, explain the confirmed concept directly. Do not turn that into a refusal merely because some deeper implementation details remain unknown.',
      'Known-term answering rule: when the user asks what an established concept is, answer with a short direct definition first. Add only the minimum uncertainty qualifier needed for truthfulness.',
      this.buildUserProfileSourceNote(userProfileSource),
    ];
  }

  private buildLanguageInstruction(context: SystemPromptContext): string {
    if (context.responseDirectives.language === 'ru') {
      return 'Current-turn hard rule: answer this response in Russian. Keep the main prose and response scaffolding in Russian unless a technical token or quoted identifier must remain unchanged.';
    }

    if (context.responseDirectives.language === 'en') {
      return 'Current-turn hard rule: answer this response in English. Keep the main prose and response scaffolding in English unless a technical token or quoted identifier must remain unchanged.';
    }

    switch (context.userProfile.communication.preferredLanguage) {
      case 'ru':
        return 'Respond primarily in Russian unless the user clearly asks for another language.';
      case 'en':
        return 'Respond primarily in English unless the user clearly asks for another language.';
      default:
        return 'Match the user\'s language in the current message unless they clearly ask otherwise.';
    }
  }

  private buildToneInstruction(context: SystemPromptContext): string {
    switch (context.responseDirectives.tone) {
      case 'warm':
        return 'Current-turn instruction: use a warm, human tone while staying precise and grounded.';
      case 'formal':
        return 'Current-turn instruction: use a formal tone and avoid casual phrasing.';
      case 'direct':
        return 'Current-turn instruction: be direct, clear, and not theatrical.';
      default:
        break;
    }

    switch (context.userProfile.communication.tone) {
      case 'warm':
        return 'Use a warm tone while staying precise and grounded.';
      case 'formal':
        return 'Use a formal tone while staying clear and practical.';
      default:
        return 'Use a direct tone; be clear, concrete, and not theatrical.';
    }
  }

  private buildDetailInstruction(context: SystemPromptContext): string {
    if (context.responseDirectives.shape === 'definition_only') {
      return 'Current-turn hard rule: give only a direct definition. Do not add examples, comparisons, adjacent facts, or optional follow-up guidance unless needed for truthfulness.';
    }

    if (context.responseDirectives.shape === 'steps_only') {
      return 'Current-turn hard rule: return only the requested steps. Do not wrap them in extra explanatory prose.';
    }

    switch (context.responseDirectives.verbosity) {
      case 'concise':
        return 'Current-turn hard rule: answer briefly, lead with the essentials, stop before optional expansions, and do not add adjacent facts the user did not ask for.';
      case 'detailed':
        return 'Current-turn instruction: be thorough, but stay anchored to confirmed facts and avoid speculative implementation claims.';
      default:
        break;
    }

    switch (context.userProfile.communication.detail) {
      case 'concise':
        return 'If the user asks for brevity or the profile prefers concise answers, answer briefly, lead with the essentials, stop before optional expansions, and do not add adjacent facts the user did not ask for.';
      case 'detailed':
        return 'When depth is requested, be thorough, but stay anchored to confirmed facts and avoid speculative implementation claims.';
      default:
        return 'Match the depth to the user\'s request and avoid unnecessary expansion.';
    }
  }

  private buildStructureInstruction(context: SystemPromptContext): string {
    if (context.responseDirectives.hardLimits.exactSections && context.responseDirectives.hardLimits.exactSections.length > 0) {
      return `Current-turn hard rule: follow this exact numbered structure: ${context.responseDirectives.hardLimits.exactSections
        .map((section) => `${section.index}) ${section.label}`)
        .join(' ')}.`;
    }

    if (context.responseDirectives.shape === 'steps_only') {
      return 'Current-turn hard rule: format the answer as steps only, with no extra introduction or conclusion.';
    }

    if (context.responseDirectives.structure === 'structured') {
      return 'Current-turn instruction: keep this answer explicitly structured with clear bullets or numbered sections.';
    }

    if (context.userProfile.communication.structure === 'structured') {
      return 'Prefer explicit structure such as bullets or numbered steps when it helps clarity.';
    }

    return 'Use structure when it materially improves clarity.';
  }

  private buildPushbackInstruction(userProfile: AgentUserProfile): string {
    if (!userProfile.interaction.allowPushback) {
      return 'Do not add corrective pushback unless it is required for truthfulness or safety.';
    }

    return 'Use polite pushback when it materially protects truth, quality, or safety.';
  }

  private buildSuggestionInstruction(userProfile: AgentUserProfile): string {
    if (!userProfile.interaction.allowProactiveSuggestions) {
      return 'Do not append unsolicited next steps or extra suggestions.';
    }

    return 'Offer next steps when they materially help the user.';
  }

  private buildUserProfileSourceNote(userProfileSource: AgentUserProfileSource): string {
    if (userProfileSource === 'persisted_profile_and_recent_context') {
      return 'Current user profile note: these preferences are resolved from stored profile context plus recent conversation cues for this response. Do not claim storage mechanisms, permanence, or hidden profile details unless they are explicitly established in the current context.';
    }

    return 'Current user profile note: these preferences are resolved from the recent conversation context for this response. Do not describe them as stored or persistent unless that is explicitly established.';
  }

  private resolveEffectiveVerbosity(
    mode: AgentModeId,
    userProfile: AgentUserProfile,
    responseDirectives: ResponseDirectives,
  ): 'adaptive' | 'concise' | 'detailed' {
    if (responseDirectives.verbosity === 'concise') {
      return 'concise';
    }

    if (responseDirectives.verbosity === 'detailed') {
      return 'detailed';
    }

    if (userProfile.communication.detail === 'concise') {
      return 'concise';
    }

    if (userProfile.communication.detail === 'detailed') {
      return 'detailed';
    }

    return getAgentModeDefinition(mode).behavior.verbosity;
  }
}
