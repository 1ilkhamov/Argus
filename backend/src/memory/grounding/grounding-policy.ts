import type { ArchivedChatEvidenceItem } from '../archive/archive-chat-retrieval.types';
import type { RecalledMemory } from '../core/memory-entry.types';

export type MemoryQuestionIntent = 'name' | 'role' | 'project' | 'goal' | 'profile' | 'summary' | 'general';

export type MemoryGroundingEvidenceStrength = 'none' | 'structured' | 'archive_only' | 'structured_and_archive';

export interface MemoryGroundingContext {
  isMemoryQuestion: boolean;
  intent?: MemoryQuestionIntent;
  evidenceStrength: MemoryGroundingEvidenceStrength;
  recalledMemoryCount: number;
  archiveEvidenceCount: number;
  shouldUseUncertaintyFirst: boolean;
}

export type MemoryGroundingViolationCode =
  | 'missing_uncertainty_lead'
  | 'unsupported_memory_claim'
  | 'missing_archive_qualification';

export interface MemoryGroundingViolation {
  code: MemoryGroundingViolationCode;
  message: string;
}

export interface MemoryGroundingValidationResult {
  compliant: boolean;
  violations: MemoryGroundingViolation[];
}

export const EMPTY_MEMORY_GROUNDING_CONTEXT: MemoryGroundingContext = {
  isMemoryQuestion: false,
  evidenceStrength: 'none',
  recalledMemoryCount: 0,
  archiveEvidenceCount: 0,
  shouldUseUncertaintyFirst: false,
};

const UNCERTAINTY_LEAD_PATTERNS = [
  /^(?:i do not know|i don't know|i am not sure|i can't confirm|i do not have enough grounded memory evidence|i don't have enough grounded memory evidence|i do not have enough evidence|i don't have enough evidence)/i,
  /^(?:я не знаю|я не уверен|я не могу подтвердить|у меня недостаточно подтвержд[её]нной памяти|у меня недостаточно данных|я не могу над[её]жно подтвердить)/i,
];

const ARCHIVE_QUALIFIER_PATTERNS = [
  /(?:based on|according to|from) (?:earlier|prior|previous) chat/i,
  /(?:based on|according to) prior chat evidence/i,
  /(?:судя по|по) прошл(?:им|ым) (?:сообщениям|чатам|обсуждениям)/i,
  /насколько я могу судить по прошлым чатам/i,
];

const ASSERTIVE_MEMORY_CLAIM_PATTERNS = [
  /\byour name is\b/i,
  /\byou are working on\b/i,
  /\byour project is\b/i,
  /\byour goal is\b/i,
  /тебя зовут/i,
  /вас зовут/i,
  /твой проект/i,
  /ваш проект/i,
  /твоя цель/i,
  /ваша цель/i,
];

const PROFILE_PATTERNS = [
  /\bwhat do you know about me\b/i,
  /\bwhat do you remember about me\b/i,
  /что ты (?:знаешь|помнишь) обо мне/i,
];

const SUMMARY_PATTERNS = [
  /\bwhat did we discuss\b/i,
  /\bwhat were we discussing\b/i,
  /\bwhat did i say earlier\b/i,
  /что мы обсуждали/i,
  /о ч[её]м мы говорили/i,
  /что я говорил(?: раньше| ранее)?/i,
];

const NAME_PATTERNS = [/\bwhat(?:'s| is)? my name\b/i, /как меня зовут/i];
const ROLE_PATTERNS = [
  /\bwhat(?:'s| is)? my role\b/i,
  /\bwhat do i do\b/i,
  /кем я работаю/i,
  /какая у меня роль/i,
];
const PROJECT_PATTERNS = [
  /\bwhat(?:'s| is)? my project\b/i,
  /\bwhat did i call my project\b/i,
  /\bwhich project am i working on\b/i,
  /какой у меня проект/i,
  /как я называл(?: свой)? проект/i,
];
const GOAL_PATTERNS = [
  /\bwhat(?:'s| is)? my goal\b/i,
  /\bwhat was my goal\b/i,
  /какая у меня цель/i,
  /какой была моя цель/i,
];
const GENERAL_MEMORY_PATTERNS = [
  /\bdo you remember\b/i,
  /\bremember\b/i,
  /\brecall\b/i,
  /\bremind me\b/i,
  /\bearlier\b/i,
  /\bprevious(?:ly)?\b/i,
  /\bbefore\b/i,
  /\bpast chats?\b/i,
  /помнишь/i,
  /напомни/i,
  /в прошл(?:ом|ых)/i,
  /раньше/i,
  /ранее/i,
  /до этого/i,
];

/**
 * Patterns that look like memory recall keywords but are actually
 * scheduling / reminder requests (e.g. "напомни через 2 минуты",
 * "remind me in 5 minutes"). These should NOT be treated as memory
 * questions because they need the tool pipeline (cron tool).
 */
const SCHEDULING_EXCLUSION_PATTERNS = [
  /напомни.{0,10}(?:через|в |каждые|завтра|сегодня|утром|вечером|днём|ночью|\d)/i,
  /remind me.{0,10}(?:in \d|at \d|every|tomorrow|tonight|to(?:day)?)/i,
  /\bremind me\b.{0,15}(?:to |about )/i,
  /напомни\s+(?:мне\s+)?(?:о |про |что(?:бы)?)/i,
];

export function resolveMemoryGroundingContext(
  content: string,
  recalledMemories: RecalledMemory[],
  archiveEvidence: ArchivedChatEvidenceItem[],
): MemoryGroundingContext {
  const normalized = content.trim();

  // Scheduling requests look like memory questions ("напомни", "remind me")
  // but are actually tool-requiring actions — exclude them early.
  if (SCHEDULING_EXCLUSION_PATTERNS.some((p) => p.test(normalized))) {
    return EMPTY_MEMORY_GROUNDING_CONTEXT;
  }

  const intent = detectMemoryQuestionIntent(normalized);
  if (!intent) {
    return EMPTY_MEMORY_GROUNDING_CONTEXT;
  }

  const hasStructuredEvidence = recalledMemories.length > 0;
  const hasArchiveEvidence = archiveEvidence.length > 0;

  return {
    isMemoryQuestion: true,
    intent,
    evidenceStrength: resolveEvidenceStrength(hasStructuredEvidence, hasArchiveEvidence),
    recalledMemoryCount: recalledMemories.length,
    archiveEvidenceCount: archiveEvidence.length,
    shouldUseUncertaintyFirst: !hasStructuredEvidence && !hasArchiveEvidence,
  };
}

export function validateMemoryGroundingResponse(
  content: string,
  context: MemoryGroundingContext,
): MemoryGroundingValidationResult {
  if (!context.isMemoryQuestion) {
    return { compliant: true, violations: [] };
  }

  const violations: MemoryGroundingViolation[] = [];

  if (context.evidenceStrength === 'none') {
    if (!startsWithUncertainty(content)) {
      violations.push({
        code: 'missing_uncertainty_lead',
        message: 'The answer must start by saying there is not enough grounded memory evidence to answer confidently.',
      });
    }

    if (containsAssertiveMemoryClaim(content)) {
      violations.push({
        code: 'unsupported_memory_claim',
        message: 'The answer makes a memory claim without grounded supporting evidence.',
      });
    }
  }

  if (context.evidenceStrength === 'archive_only' && !containsArchiveQualifier(content)) {
    violations.push({
      code: 'missing_archive_qualification',
      message: 'When only archive evidence exists, the answer must label it as prior-chat evidence instead of stating it as certain current fact.',
    });
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}

export function buildMemoryGroundingRetryInstruction(
  context: MemoryGroundingContext,
  violations: MemoryGroundingViolation[],
): string {
  if (!context.isMemoryQuestion) {
    return '';
  }

  const rules: string[] = [
    'Rewrite the assistant answer so it follows the memory-grounding policy for this turn.',
    'Do not guess, invent, or imply remembered facts that are not grounded in the current evidence.',
    'Separate confirmed memory from inference explicitly.',
    'Output only the corrected final answer with no meta commentary.',
  ];

  switch (context.evidenceStrength) {
    case 'none':
      rules.push(
        'There is no grounded memory evidence for this memory question. Start by saying you do not know or do not have enough grounded memory evidence, then ask the user to remind you or provide the missing fact.',
      );
      break;
    case 'archive_only':
      rules.push(
        'Only archive chat evidence supports this answer. Explicitly label the answer as based on prior chat evidence, and do not present it as certain current fact.',
      );
      break;
    case 'structured':
    case 'structured_and_archive':
      rules.push(
        'Answer only from the grounded structured memory and archive evidence that are already provided. Do not add extra remembered details beyond that support.',
      );
      break;
  }

  if (violations.length > 0) {
    rules.push(`Correct these memory-grounding violations: ${violations.map((violation) => violation.message).join(' ')}`);
  }

  return rules.join(' ');
}

function detectMemoryQuestionIntent(content: string): MemoryQuestionIntent | undefined {
  if (PROFILE_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'profile';
  }
  if (SUMMARY_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'summary';
  }
  if (NAME_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'name';
  }
  if (ROLE_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'role';
  }
  if (PROJECT_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'project';
  }
  if (GOAL_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'goal';
  }
  if (GENERAL_MEMORY_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'general';
  }
  return undefined;
}

function resolveEvidenceStrength(
  hasStructuredEvidence: boolean,
  hasArchiveEvidence: boolean,
): MemoryGroundingEvidenceStrength {
  if (hasStructuredEvidence && hasArchiveEvidence) {
    return 'structured_and_archive';
  }
  if (hasStructuredEvidence) {
    return 'structured';
  }
  if (hasArchiveEvidence) {
    return 'archive_only';
  }
  return 'none';
}

function startsWithUncertainty(content: string): boolean {
  return UNCERTAINTY_LEAD_PATTERNS.some((pattern) => pattern.test(content.trim()));
}

function containsArchiveQualifier(content: string): boolean {
  return ARCHIVE_QUALIFIER_PATTERNS.some((pattern) => pattern.test(content));
}

function containsAssertiveMemoryClaim(content: string): boolean {
  return ASSERTIVE_MEMORY_CLAIM_PATTERNS.some((pattern) => pattern.test(content));
}
