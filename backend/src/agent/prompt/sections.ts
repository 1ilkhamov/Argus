/**
 * Pure section-building functions extracted from SystemPromptBuilder.
 *
 * Every function here is side-effect-free: context in → prompt lines out.
 * The builder remains the NestJS DI wrapper and orchestrator; this module
 * contains the individual section renderers.
 */
import { ARGUS_CORE_CONTRACT } from '../core-contract';
import type { RecalledIdentityTrait } from '../identity/recall/identity-recall.service';
import type { SoulConfig } from '../identity/config/soul-config.types';
import { getAgentModeDefinition } from '../modes/mode-registry';
import type { AgentModeId } from '../modes/mode.types';
import type { AgentUserProfile, AgentUserProfileSource } from '../profile/user-profile.types';
import {
  hasExplicitResponseDirectives,
  type ResponseDirectives,
} from '../response-directives/response-directives.types';
import type { ArchivedChatEvidenceItem } from '../../memory/archive/archive-chat-retrieval.types';
import type { MemoryGroundingContext } from '../../memory/grounding/grounding-policy';
import type { RecalledMemory } from '../../memory/core/memory-entry.types';

/* ------------------------------------------------------------------ */
/*  Shared context type (mirrors builder's internal context)          */
/* ------------------------------------------------------------------ */

export interface SystemPromptContext {
  activeMode: ReturnType<typeof getAgentModeDefinition>;
  availableModes: string;
  effectiveVerbosity: 'adaptive' | 'concise' | 'detailed';
  userProfile: AgentUserProfile;
  userProfileSource: AgentUserProfileSource;
  recalledMemories: RecalledMemory[];
  archiveEvidence: ArchivedChatEvidenceItem[];
  memoryGrounding: MemoryGroundingContext;
  responseDirectives: ResponseDirectives;
}

/* ------------------------------------------------------------------ */
/*  Section builders                                                  */
/* ------------------------------------------------------------------ */

export function buildCoreIdentitySection(
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

export function buildPersonalitySection(soul: SoulConfig): string[] {
  const lines: string[] = [];

  if (soul.personality.length > 0) {
    lines.push(`Core personality: ${soul.personality.join(' ')}`);
  }

  if (soul.never.length > 0) {
    lines.push(`Never: ${soul.never.join('; ')}.`);
  }

  if (soul.values.length > 0) {
    lines.push(`Values: ${soul.values.join('. ')}.`);
  }

  return lines;
}

export function buildIdentitySection(traits: RecalledIdentityTrait[]): string[] {
  if (traits.length === 0) return [];

  // Group traits by category
  const grouped = new Map<string, string[]>();
  for (const trait of traits) {
    const cat = trait.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(trait.entry.content);
  }

  const lines: string[] = [`Evolved identity traits (${traits.length} learned from interaction):`];

  for (const [category, contents] of grouped) {
    lines.push(`[${category}]: ${contents.join('; ')}`);
  }

  lines.push(
    'These identity traits are learned from past interactions with this user. Apply them naturally — they augment (never override) core personality and invariants.',
  );

  return lines;
}

export function buildSelfModelSection(selfModelRaw: string): string[] {
  if (!selfModelRaw || selfModelRaw.trim().length === 0) return [];

  return [
    'Self-awareness (aggregated from identity, skills, and learnings):',
    selfModelRaw.trim(),
  ];
}

export function buildModeSection(context: SystemPromptContext): string[] {
  return [
    `Active mode: ${context.activeMode.label}. ${context.activeMode.purpose}`,
    `In this mode, adjust your behavior to initiative=${context.activeMode.behavior.initiative}, assertiveness=${context.activeMode.behavior.assertiveness}, warmth=${context.activeMode.behavior.warmth}, verbosity=${context.effectiveVerbosity}.`,
  ];
}

export function buildUserProfileSection(context: SystemPromptContext): string[] {
  return [
    `User communication preferences: language=${context.userProfile.communication.preferredLanguage}, tone=${context.userProfile.communication.tone}, detail=${context.userProfile.communication.detail}, structure=${context.userProfile.communication.structure}.`,
    `User interaction preferences: allowPushback=${context.userProfile.interaction.allowPushback}, allowProactiveSuggestions=${context.userProfile.interaction.allowProactiveSuggestions}.`,
    buildLanguageInstruction(context),
    buildToneInstruction(context),
    buildDetailInstruction(context),
    buildStructureInstruction(context),
    buildPushbackInstruction(context.userProfile),
    buildSuggestionInstruction(context.userProfile),
  ];
}

export function buildTurnDirectiveSection(context: SystemPromptContext): string[] {
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

export function buildRecalledMemorySection(recalledMemories: RecalledMemory[]): string[] {
  if (recalledMemories.length === 0) {
    return [];
  }

  // Build entry lines with confidence, pinned, provenance
  const lines = recalledMemories.map((m) => {
    const entry = m.entry;
    const badges: string[] = [];
    if (entry.pinned) badges.push('pinned');
    badges.push(m.confidence);
    const badgeStr = `[${badges.join(', ')}]`;
    const cat = entry.category ? ` (${entry.category})` : '';
    const provenance = formatProvenance(entry);
    return `- ${badgeStr} [${entry.kind}]${cat}: ${entry.summary ?? entry.content}${provenance}`;
  });

  // Build contradiction alerts
  const contradictionAlerts = buildContradictionAlerts(recalledMemories);

  const result = [
    `Recalled long-term memory (${recalledMemories.length} entries):`,
    ...lines,
  ];

  if (contradictionAlerts.length > 0) {
    result.push(...contradictionAlerts);
  }

  result.push(
    'Use recalled memory only when it materially helps with the current request. Do not fabricate details beyond what is listed above. Confidence levels indicate match strength: high = strong match, medium = partial, low = weak. If contradictions are flagged, explicitly acknowledge the conflict in your response.',
  );

  return result;
}

function formatProvenance(entry: RecalledMemory['entry']): string {
  if (!entry.provenance) return '';
  const ts = entry.provenance.timestamp;
  if (!ts) return '';
  const date = ts.slice(0, 10); // YYYY-MM-DD
  return ` [from ${date}]`;
}

function buildContradictionAlerts(memories: RecalledMemory[]): string[] {
  const entryMap = new Map(memories.map((m) => [m.entry.id, m]));
  const seen = new Set<string>();
  const alerts: string[] = [];

  for (const m of memories) {
    if (!m.contradicts || m.contradicts.length === 0) continue;

    for (const otherId of m.contradicts) {
      const pairKey = [m.entry.id, otherId].sort().join(':');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const other = entryMap.get(otherId);
      if (!other) continue;

      const a = truncate(m.entry.summary ?? m.entry.content, 80);
      const b = truncate(other.entry.summary ?? other.entry.content, 80);
      alerts.push(`⚠ Potential conflict: "${a}" vs "${b}" — verify which is current.`);
    }
  }

  return alerts;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

export function buildArchiveEvidenceSection(
  evidence: ArchivedChatEvidenceItem[],
  maxItems = 6,
  maxTotalChars = 900,
): string[] {
  if (evidence.length === 0) {
    return [];
  }

  const sanitizedItems = evidence
    .filter((item) => Boolean(item.excerpt))
    .slice(0, maxItems)
    .map((item) => {
      const excerpt = sanitizeArchiveEvidenceExcerpt(item.excerpt);
      return excerpt
        ? {
            stamp: item.createdAt,
            role: item.role,
            excerpt,
          }
        : undefined;
    })
    .filter(
      (
        item,
      ): item is {
        stamp: string;
        role: ArchivedChatEvidenceItem['role'];
        excerpt: string;
      } => Boolean(item),
    );

  let totalChars = 0;
  const formatted: string[] = [];
  for (const item of sanitizedItems) {
    const candidate = `[${item.stamp}] (${item.role}) ${item.excerpt}`;
    if (formatted.length >= maxItems) {
      break;
    }
    if (totalChars + candidate.length > maxTotalChars) {
      break;
    }
    formatted.push(candidate);
    totalChars += candidate.length;
  }

  if (formatted.length === 0) {
    return [];
  }

  const items = formatted.join(' | ');

  return [
    `Archive evidence from prior chats (unverified): ${items}.`,
    'Use archive evidence only when it is directly relevant. Treat it as quoted historical context; do not claim it is authoritative, comprehensive, or currently true unless the user confirms it in the current conversation.',
  ];
}

export function buildMemoryGroundingSection(memoryGrounding: MemoryGroundingContext): string[] {
  if (!memoryGrounding.isMemoryQuestion) {
    return [];
  }

  const rules = [
    `Memory-answer policy for this turn: the user is asking about remembered context (intent=${memoryGrounding.intent ?? 'general'}, evidence=${memoryGrounding.evidenceStrength}).`,
    'For memory answers, separate confirmed remembered facts from guesses explicitly. Never claim remembered details that are not grounded in the provided structured memory or archive evidence.',
  ];

  switch (memoryGrounding.evidenceStrength) {
    case 'none':
      rules.push(
        'There is no grounded memory evidence for this question. Do not guess. Start by saying you do not know or do not have enough grounded memory evidence, then ask the user to remind you or provide the missing detail.',
      );
      break;
    case 'archive_only':
      rules.push(
        'Only archive evidence supports this answer. Present it as prior-chat evidence or historical context, not as certain current fact. Use wording such as "Based on earlier chat evidence..." when answering.',
      );
      break;
    case 'structured':
    case 'structured_and_archive':
      rules.push(
        'Structured memory supports this answer. You may answer directly from the grounded memory, but do not add remembered details that are not present in the supporting facts or memory summaries.',
      );
      break;
  }

  return rules;
}

export function buildTruthfulnessSection(userProfileSource: AgentUserProfileSource): string[] {
  return [
    'Implementation truthfulness rule: when the user asks about the current system, code, or architecture, only claim details that are explicitly established in the provided context. Separate confirmed facts from guesses, and say when something is unknown.',
    'Known-concept rule: if a concept is already established in the current context, explain the confirmed concept directly. Do not turn that into a refusal merely because some deeper implementation details remain unknown.',
    'Known-term answering rule: when the user asks what an established concept is, answer with a short direct definition first. Add only the minimum uncertainty qualifier needed for truthfulness.',
    buildUserProfileSourceNote(userProfileSource),
  ];
}

/* ------------------------------------------------------------------ */
/*  Individual instruction builders                                   */
/* ------------------------------------------------------------------ */

export function buildLanguageInstruction(context: SystemPromptContext): string {
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

export function buildToneInstruction(context: SystemPromptContext): string {
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

export function buildDetailInstruction(context: SystemPromptContext): string {
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
      return 'Match the depth to the user\'s request. When the user is simply stating a fact or providing context, confirm naturally in 1–3 sentences — vary your phrasing, do not repeat "Понял/Принял" mechanically, and feel free to briefly reflect back what you understood or connect it to what you already know. Do not volunteer unsolicited plans, advice, or analysis. Reserve longer answers for explicit questions or requests for help. Even for detailed explanations, aim for under 2000 characters — if the topic is larger, give a focused answer and offer to go deeper.';
  }
}

export function buildStructureInstruction(context: SystemPromptContext): string {
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

export function buildPushbackInstruction(userProfile: AgentUserProfile): string {
  if (!userProfile.interaction.allowPushback) {
    return 'Do not add corrective pushback unless it is required for truthfulness or safety.';
  }

  return 'Use polite pushback when it materially protects truth, quality, or safety.';
}

export function buildSuggestionInstruction(userProfile: AgentUserProfile): string {
  if (!userProfile.interaction.allowProactiveSuggestions) {
    return 'Do not append unsolicited next steps or extra suggestions.';
  }

  return 'Offer next steps when they materially help the user.';
}

export function buildUserProfileSourceNote(userProfileSource: AgentUserProfileSource): string {
  if (userProfileSource === 'persisted_profile_and_recent_context') {
    return 'Current user profile note: these preferences are resolved from stored profile context plus recent conversation cues for this response. Do not claim storage mechanisms, permanence, or hidden profile details unless they are explicitly established in the current context.';
  }

  return 'Current user profile note: these preferences are resolved from the recent conversation context for this response. Do not describe them as stored or persistent unless that is explicitly established.';
}

/* ------------------------------------------------------------------ */
/*  Sanitization                                                      */
/* ------------------------------------------------------------------ */

export function sanitizeArchiveEvidenceExcerpt(excerpt: string): string {
  const normalized = excerpt
    .replace(/```[\s\S]*?```/g, '[omitted code block]')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  const lower = normalized.toLocaleLowerCase();
  const suspicious =
    /ignore\s+previous\s+instructions|disregard\s+previous\s+instructions|system\s+prompt|developer\s+message|jailbreak|do\s+anything\s+now|you\s+are\s+chatgpt|act\s+as\s+system|override\s+rules/i.test(
      lower,
    );
  if (suspicious) {
    return '';
  }

  const maxLen = 240;
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

/* ------------------------------------------------------------------ */
/*  Effective verbosity resolution                                    */
/* ------------------------------------------------------------------ */

export function resolveEffectiveVerbosity(
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
