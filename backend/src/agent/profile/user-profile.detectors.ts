/**
 * Pure detection and inference functions for UserProfileService.
 *
 * Pipeline: messages[] → ProfileSignal[] → resolveProfileFromSignals() → AgentUserProfilePatch
 *
 * The service remains the NestJS DI wrapper; this module is the computation layer.
 */
import type { Conversation } from '../../chat/entities/conversation.entity';
import { matchesAny } from '../pattern-utils';
import type {
  AgentPreferredLanguage,
  AgentTone,
  AgentUserProfile,
  AgentUserProfilePatch,
} from './user-profile.types';
import type { ProfileSignal } from './user-profile.signals';
import { firstSignalByDimension } from './user-profile.signals';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const RECENT_USER_PROFILE_WINDOW = 6;

/* ------------------------------------------------------------------ */
/*  Pattern registries                                                */
/* ------------------------------------------------------------------ */

const ENGLISH_LANGUAGE_PATTERNS = [
  /\b(in english|answer in english|respond in english|english please)\b/i,
  /(на английском|по-английски|ответь на английском|отвечай на английском|ответь по-английски|отвечай по-английски)/i,
];

const RUSSIAN_LANGUAGE_PATTERNS = [
  /\b(in russian|answer in russian|respond in russian|russian please)\b/i,
  /(на русском|по-русски|ответь на русском|отвечай на русском|ответь по-русски|отвечай по-русски)/i,
];

const DIRECT_TONE_PATTERNS = [
  /\b(direct|to the point|straight to the point)\b/i,
  /(по делу|прямо)/i,
];

const WARM_TONE_PATTERNS = [
  /\b(warm|friendly|gentle|supportive|kind)\b/i,
  /(тепл|дружелюб|дружеск|мягк|бережн|поддерживающ|доброжелател)/i,
];

const FORMAL_TONE_PATTERNS = [
  /\b(formal|professional|professionally|businesslike)\b/i,
  /(формальн|официальн|делов)/i,
];

const CONCISE_DETAIL_PATTERNS = [
  /\b(short|brief|briefly|concise|compact|compactly|no fluff)\b/i,
  /\b(simple|simply)\s+(explain|answer|respond|say|tell|show)\b/i,
  /\b(explain|answer|respond|say|tell|show)\s+(simply|simple)\b/i,
  /\b(no long essay|no essay|no wall of text)\b/i,
  /(кратко|коротко|в двух словах|в двух предложениях|простыми словами|без лишнего|без лишней воды|максимально коротко|ответь просто|объясни просто|скажи просто|просто объясни|просто скажи|просто ответь|компактно|без длинного эссе|без простыни|коротк(?:их|ие)\s+пункт)/i,
];

const DETAILED_DETAIL_PATTERNS = [
  /\b(detailed|deep dive|in depth|thorough|more detail|more detailed|elaborate|verbose)\b/i,
  /(подробно|подробнее|детально|детальнее|глубоко|развернуто|развёрнуто)/i,
];

const STRUCTURED_PATTERNS = [
  /\b(step[- ]by[- ]step|bullet points|bullet list|numbered list|structured|outline)\b/i,
  /\b(?:first|start)\b[^.!?\n]{0,120}\b(?:then|after that|afterwards|next)\b/i,
  /(?:сначала|вначале)[^.!?\n]{0,120}(?:потом|затем|далее)/i,
  /(по пунктам|структур|пошагово|по шагам|поэтапно|списком|нумерованным списком)/i,
];

const DISABLE_PUSHBACK_PATTERNS = [
  /\b(don't push back|do not push back)\b/i,
  /(не спорь|не возражай|без критики)/i,
];

const ENABLE_PUSHBACK_PATTERNS = [
  /\b(push back|challenge me|be critical if needed)\b/i,
  /(можешь спорить|можешь возражать|критикуй если нужно|возражай если нужно)/i,
];

const DISABLE_SUGGESTION_PATTERNS = [
  /\b(no suggestions|don't suggest|do not suggest)\b/i,
  /(без предложений|не предлагай)/i,
];

const ENABLE_SUGGESTION_PATTERNS = [
  /\b(suggest|give suggestions|propose next steps|you can suggest|you may suggest|feel free to suggest)\b/i,
  /(можешь предлагать|можно предлагать|предлагай|предложи следующие шаги|дай следующие шаги|предлагать следующие шаги|в конце можешь предлагать|в конце можно предлагать)/i,
];

const DURABLE_PREFERENCE_CUE_PATTERNS = [
  /\b(?:by\s+default|from\s+now\s+on|going\s+forward|always|usually|in\s+general|generally|remember\s+that\s+i\s+prefer|i\s+prefer(?:\s+you)?(?:\s+to)?|my\s+default\s+preference\s+is)\b/i,
  /\b(?:this\s+is\s+my\s+default\s+(?:format|style|response\s+format|answer\s+format))\b/i,
  /\b(?:remember|save|keep)\s+(?:this\s+)?(?:as\s+)?(?:my\s+)?default(?:\s+(?:response|answer|format|style))?\b/i,
  /\b(?:now|from now)\b[^.!?\n]{0,120}\b(?:change|switch|update)\b[^.!?\n]{0,80}\b(?:style|format|response|answer)\b/i,
  /(?:по\s+умолчанию|с\s+этого\s+момента|дальше|в\s+дальнейшем|всегда|обычно|в\s+целом|как\s+правило|запомни(?:,?\s+что)?\s+я\s+предпочитаю|считай(?:,?\s+что)?\s+я\s+предпочитаю|я\s+предпочитаю|мой\s+предпочтительный\s+стиль|это\s+мой\s+дефолт(?:ный)?\s+(?:формат|стиль|формат\s+ответа)|это\s+мой\s+формат\s+по\s+умолчанию|(?:запомни|сохрани|зафиксируй)(?:\s+это)?\s+(?:как\s+)?(?:дефолт|по\s+умолчанию)(?:\s+(?:ответа|ответ|формат(?:а)?\s+ответа|стиль\s+ответа))?)/iu,
  /(?:теперь|с\s+этого\s+момента)[^.!?\n]{0,120}(?:поменяй|смени|измени|обнови)[^.!?\n]{0,80}(?:стиль|формат|ответ|ответы|формат\s+ответа|стиль\s+ответа)/iu,
];

/* ------------------------------------------------------------------ */
/*  Main entry point (preserves original API)                         */
/* ------------------------------------------------------------------ */

export function inferProfilePatch(conversation: Conversation): AgentUserProfilePatch {
  const recentUserMessages = getRecentUserMessages(conversation);
  if (recentUserMessages.length === 0) {
    return {};
  }

  const signals = detectAllProfileSignals(recentUserMessages);
  return resolveProfileFromSignals(signals);
}

export function inferDurableProfilePatch(conversation: Conversation): AgentUserProfilePatch {
  const durableMessages = getRecentUserMessages(conversation).filter((content) => hasDurablePreferenceCue(content));
  if (durableMessages.length === 0) {
    return {};
  }

  const communication: AgentUserProfilePatch['communication'] = {};
  const interaction: AgentUserProfilePatch['interaction'] = {};
  const normalizedContents = durableMessages.map((content) => content.toLowerCase());

  const explicitLanguage = detectExplicitLanguage(durableMessages);
  if (explicitLanguage) {
    communication.preferredLanguage = explicitLanguage;
  }

  const tone = detectTonePreference(normalizedContents);
  if (tone) {
    communication.tone = tone;
  }

  const detail = detectDetailPreference(normalizedContents);
  if (detail) {
    communication.detail = detail;
  }

  const structure = detectStructurePreference(normalizedContents);
  if (structure) {
    communication.structure = structure;
  }

  const allowPushback = detectBooleanPreference(
    normalizedContents,
    DISABLE_PUSHBACK_PATTERNS,
    ENABLE_PUSHBACK_PATTERNS,
  );
  if (allowPushback !== undefined) {
    interaction.allowPushback = allowPushback;
  }

  const allowProactiveSuggestions = detectBooleanPreference(
    normalizedContents,
    DISABLE_SUGGESTION_PATTERNS,
    ENABLE_SUGGESTION_PATTERNS,
  );
  if (allowProactiveSuggestions !== undefined) {
    interaction.allowProactiveSuggestions = allowProactiveSuggestions;
  }

  return {
    ...(Object.keys(communication).length > 0 ? { communication } : {}),
    ...(Object.keys(interaction).length > 0 ? { interaction } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Signal detection layer                                            */
/* ------------------------------------------------------------------ */

export function detectAllProfileSignals(recentUserMessages: string[]): ProfileSignal[] {
  const signals: ProfileSignal[] = [];
  const normalizedContents = recentUserMessages.map((content) => content.toLowerCase());

  // Language: explicit request wins over character voting
  const explicitLanguage = detectExplicitLanguage(recentUserMessages);
  if (explicitLanguage) {
    signals.push({ dimension: 'language', value: explicitLanguage, source: 'explicit_request' });
  } else {
    const votedLanguage = detectLanguageByVoting(recentUserMessages);
    if (votedLanguage) {
      signals.push({ dimension: 'language', value: votedLanguage, source: 'character_vote' });
    }
  }

  const tone = detectTonePreference(normalizedContents);
  if (tone) {
    signals.push({ dimension: 'tone', value: tone });
  }

  const detail = detectDetailPreference(normalizedContents);
  if (detail) {
    signals.push({ dimension: 'detail', value: detail });
  }

  const structure = detectStructurePreference(normalizedContents);
  if (structure) {
    signals.push({ dimension: 'structure', value: structure });
  }

  const allowPushback = detectBooleanPreference(
    normalizedContents,
    DISABLE_PUSHBACK_PATTERNS,
    ENABLE_PUSHBACK_PATTERNS,
  );
  if (allowPushback !== undefined) {
    signals.push({ dimension: 'allow_pushback', value: allowPushback });
  }

  const allowProactiveSuggestions = detectBooleanPreference(
    normalizedContents,
    DISABLE_SUGGESTION_PATTERNS,
    ENABLE_SUGGESTION_PATTERNS,
  );
  if (allowProactiveSuggestions !== undefined) {
    signals.push({ dimension: 'allow_proactive_suggestions', value: allowProactiveSuggestions });
  }

  return signals;
}

/* ------------------------------------------------------------------ */
/*  Resolution layer (signals → AgentUserProfilePatch)                */
/* ------------------------------------------------------------------ */

export function resolveProfileFromSignals(signals: readonly ProfileSignal[]): AgentUserProfilePatch {
  const communication: AgentUserProfilePatch['communication'] = {};
  const interaction: AgentUserProfilePatch['interaction'] = {};

  const languageSignal = firstSignalByDimension(signals, 'language');
  if (languageSignal) {
    communication.preferredLanguage = languageSignal.value;
  }

  const toneSignal = firstSignalByDimension(signals, 'tone');
  if (toneSignal) {
    communication.tone = toneSignal.value;
  }

  const detailSignal = firstSignalByDimension(signals, 'detail');
  if (detailSignal) {
    communication.detail = detailSignal.value;
  }

  const structureSignal = firstSignalByDimension(signals, 'structure');
  if (structureSignal) {
    communication.structure = structureSignal.value;
  }

  const pushbackSignal = firstSignalByDimension(signals, 'allow_pushback');
  if (pushbackSignal) {
    interaction.allowPushback = pushbackSignal.value;
  }

  const suggestionsSignal = firstSignalByDimension(signals, 'allow_proactive_suggestions');
  if (suggestionsSignal) {
    interaction.allowProactiveSuggestions = suggestionsSignal.value;
  }

  return {
    ...(Object.keys(communication).length > 0 ? { communication } : {}),
    ...(Object.keys(interaction).length > 0 ? { interaction } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Message window                                                    */
/* ------------------------------------------------------------------ */

export function getRecentUserMessages(conversation: Conversation): string[] {
  return [...conversation.messages]
    .reverse()
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .slice(0, RECENT_USER_PROFILE_WINDOW);
}

export function hasDurablePreferenceCue(content: string): boolean {
  return matchesAny(content, DURABLE_PREFERENCE_CUE_PATTERNS);
}

/* ------------------------------------------------------------------ */
/*  Language detection                                                */
/* ------------------------------------------------------------------ */

export function detectPreferredLanguage(contents: string[]): AgentPreferredLanguage | undefined {
  const explicitLanguage = detectExplicitLanguage(contents);

  if (explicitLanguage) {
    return explicitLanguage;
  }

  return detectLanguageByVoting(contents);
}

export function detectLanguageByVoting(contents: string[]): AgentPreferredLanguage | undefined {
  const languageVotes = contents.reduce(
    (votes, content) => {
      const cyrillicMatches = content.match(/[А-Яа-яЁё]/g)?.length ?? 0;
      const latinMatches = content.match(/[A-Za-z]/g)?.length ?? 0;

      if (cyrillicMatches > latinMatches * 1.2) {
        votes.ru += 1;
      } else if (latinMatches > cyrillicMatches * 1.2) {
        votes.en += 1;
      }

      return votes;
    },
    { ru: 0, en: 0 },
  );

  if (languageVotes.ru > languageVotes.en) {
    return 'ru';
  }

  if (languageVotes.en > languageVotes.ru) {
    return 'en';
  }

  return undefined;
}

export function detectExplicitLanguage(contents: string[]): AgentPreferredLanguage | null {
  for (const content of contents) {
    if (matchesAny(content, RUSSIAN_LANGUAGE_PATTERNS)) {
      return 'ru';
    }

    if (matchesAny(content, ENGLISH_LANGUAGE_PATTERNS)) {
      return 'en';
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Pattern-based preference detection                                */
/* ------------------------------------------------------------------ */

export function detectTonePreference(contents: string[]): AgentTone | undefined {
  return detectPatternPreference<AgentTone>(
    contents,
    [
      { patterns: FORMAL_TONE_PATTERNS, value: 'formal' },
      { patterns: WARM_TONE_PATTERNS, value: 'warm' },
      { patterns: DIRECT_TONE_PATTERNS, value: 'direct' },
    ],
  );
}

export function detectDetailPreference(contents: string[]): AgentUserProfile['communication']['detail'] | undefined {
  return detectPatternPreference<AgentUserProfile['communication']['detail']>(
    contents,
    [
      { patterns: CONCISE_DETAIL_PATTERNS, value: 'concise' },
      { patterns: DETAILED_DETAIL_PATTERNS, value: 'detailed' },
    ],
  );
}

export function detectStructurePreference(contents: string[]): AgentUserProfile['communication']['structure'] | undefined {
  return detectPatternPreference<AgentUserProfile['communication']['structure']>(
    contents,
    [{ patterns: STRUCTURED_PATTERNS, value: 'structured' }],
  );
}

export function detectBooleanPreference(
  contents: string[],
  disablePatterns: RegExp[],
  enablePatterns: RegExp[],
): boolean | undefined {
  for (const content of contents) {
    if (matchesAny(content, disablePatterns)) {
      return false;
    }

    if (matchesAny(content, enablePatterns)) {
      return true;
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Generic pattern preference                                        */
/* ------------------------------------------------------------------ */

export function detectPatternPreference<T>(
  contents: string[],
  options: Array<{ patterns: RegExp[]; value: T }>,
): T | undefined {
  for (const content of contents) {
    for (const option of options) {
      if (matchesAny(content, option.patterns)) {
        return option.value;
      }
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

// Re-export for backward compatibility
export { matchesAny } from '../pattern-utils';
