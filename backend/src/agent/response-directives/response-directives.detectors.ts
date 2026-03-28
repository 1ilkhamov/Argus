/**
 * Pure detection, resolution and derived-rule functions for ResponseDirectives.
 *
 * Pipeline: text → DirectiveSignal[] → resolveFromSignals() → ResponseDirectives
 *
 * The service remains the NestJS DI wrapper; this module is the computation layer.
 */
import type { AgentVerbosity } from '../core-contract';
import { matchesAny } from '../pattern-utils';
import type { AgentStructurePreference, AgentTone } from '../profile/user-profile.types';
import type { DirectiveSignal } from './response-directives.signals';
import { firstSignalByDimension, hasSignal } from './response-directives.signals';
import {
  EMPTY_RESPONSE_DIRECTIVES,
  type ResponseDirectives,
  type ResponseSectionDirective,
} from './response-directives.types';

/* ------------------------------------------------------------------ */
/*  Pattern registries                                                */
/* ------------------------------------------------------------------ */

const RUSSIAN_LANGUAGE_PATTERNS = [
  /\b(?:answer|respond)(?:[^.!?\n]{0,80})\bin russian\b/i,
  /\b(?:please\s+)?in russian\b/i,
  /(?:ответь|отвечай|пиши)(?:[^.!?\n]{0,80})(?:по-русски|на русском)/i,
  /на русском/i,
  /по-русски/i,
];

const ENGLISH_LANGUAGE_PATTERNS = [
  /\b(?:answer|respond)(?:[^.!?\n]{0,80})\bin english\b/i,
  /\b(?:please\s+)?in english\b/i,
  /(?:answer|respond)(?:[^.!?\n]{0,80})\benglish\b/i,
  /(?:ответь|отвечай|пиши)(?:[^.!?\n]{0,80})(?:по-английски|на английском)/i,
  /на английском/i,
  /по-английски/i,
];

const CONCISE_PATTERNS = [
  /\b(?:keep it concise|be concise|briefly|short answer|very short|maximally short)\b/i,
  /(?:очень\s+кратко|максимально\s+коротко|максимально\s+кратко|кратко|коротко|без\s+воды)/i,
  /\b(?:short explanation)\b/i,
];

const DETAILED_PATTERNS = [
  /\b(?:detailed|thorough|in depth|be thorough)\b/i,
  /(?:подробно|разв[её]рнуто|детально)/i,
];

const FORMAL_TONE_PATTERNS = [
  /\b(?:formal style|formal tone|formally)\b/i,
  /(?:в формальном стиле|формально|без разговорных оборотов)/i,
];

const WARM_TONE_PATTERNS = [
  /\b(?:warm tone|gently|softly|humanly)\b/i,
  /(?:мягко|по-человечески|бережно|без перегруза)/i,
];

const STRUCTURED_PATTERNS = [
  /\b(?:structured|structure it|with sections|with bullets|with 3 sections)\b/i,
  /(?:структурно|по разделам|с разделами|с 3 разделами|списком)/i,
];

const SINGLE_SENTENCE_PATTERNS = [
  /\b(?:one sentence|single sentence)\b/i,
  /одним предложением/i,
];

const DEFINITION_ONLY_PATTERNS = [
  /\b(?:only definition|definition only|just the definition)\b/i,
  /(?:только определени(?:ем|е)|ответь только определением)/i,
];

const STEPS_ONLY_PATTERNS = [
  /\b(?:only steps|just steps|steps only)\b/i,
  /(?:только шаги|только шагами)/i,
];

const NO_EXAMPLES_PATTERNS = [
  /\b(?:without examples|no examples|do not give examples)\b/i,
  /(?:без примеров|не приводи примеры)/i,
];

const NO_ADJACENT_FACTS_PATTERNS = [
  /\b(?:no adjacent facts|without adjacent facts|do not add nearby facts)\b/i,
  /(?:без соседних фактов|не добавляй соседние факты)/i,
];

const STRICT_FORMAT_PATTERNS = [
  /\b(?:strict format|format strictly|strictly this format)\b/i,
  /формат\s+строго(?:\s+такой)?/i,
];

const UNCERTAINTY_FIRST_PATTERNS = [
  /\b(?:if (?:the )?(?:data|information) (?:is|are) (?:insufficient|missing)|if there is not enough data)(?:[^.!?\n]{0,120})\b(?:first|before answering)\b/i,
  /(?:сначала|сперва)(?:[^.!?\n]{0,120})(?:чего не хватает|каких данных не хватает|что неизвестно)/i,
  /(?:если данных мало|если данных недостаточно|если информации недостаточно)(?:[^.!?\n]{0,120})(?:сначала|сперва)/i,
];

/* ------------------------------------------------------------------ */
/*  Main entry point (preserves original API)                         */
/* ------------------------------------------------------------------ */

export function resolveResponseDirectives(content: string): ResponseDirectives {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return {
      ...EMPTY_RESPONSE_DIRECTIVES,
      hardLimits: { ...EMPTY_RESPONSE_DIRECTIVES.hardLimits },
    };
  }

  const signals = detectAllSignals(trimmedContent);
  return resolveFromSignals(signals);
}

/* ------------------------------------------------------------------ */
/*  Signal detection layer                                            */
/* ------------------------------------------------------------------ */

export function detectAllSignals(content: string): DirectiveSignal[] {
  const signals: DirectiveSignal[] = [];

  const language = detectLanguage(content);
  if (language) {
    signals.push({ dimension: 'language', value: language });
  }

  const tone = detectTone(content);
  if (tone) {
    signals.push({ dimension: 'tone', value: tone });
  }

  const verbosity = detectVerbosity(content);
  if (verbosity) {
    signals.push({ dimension: 'verbosity', value: verbosity });
  }

  const shape = detectShape(content);
  if (shape && shape !== 'adaptive' && shape !== 'strict_sections') {
    signals.push({ dimension: 'shape', value: shape });
  }

  if (matchesAny(content, STRUCTURED_PATTERNS)) {
    signals.push({ dimension: 'structure', value: 'structured' });
  }

  if (matchesAny(content, SINGLE_SENTENCE_PATTERNS)) {
    signals.push({ dimension: 'single_sentence', value: true });
  }

  if (matchesAny(content, NO_EXAMPLES_PATTERNS)) {
    signals.push({ dimension: 'no_examples', value: true });
  }

  if (matchesAny(content, NO_ADJACENT_FACTS_PATTERNS)) {
    signals.push({ dimension: 'no_adjacent_facts', value: true });
  }

  if (matchesAny(content, UNCERTAINTY_FIRST_PATTERNS)) {
    signals.push({ dimension: 'uncertainty_first', value: true });
  }

  const maxTopLevelItems = detectMaxTopLevelItems(content);
  if (maxTopLevelItems !== undefined) {
    signals.push({ dimension: 'max_top_level_items', value: maxTopLevelItems });
  }

  const exactSections = extractExactSections(content);
  if (exactSections && exactSections.length > 0) {
    signals.push({ dimension: 'exact_sections', value: exactSections });
  }

  return signals;
}

/* ------------------------------------------------------------------ */
/*  Resolution layer (signals → ResponseDirectives + derived rules)   */
/* ------------------------------------------------------------------ */

export function resolveFromSignals(signals: readonly DirectiveSignal[]): ResponseDirectives {
  const directives: ResponseDirectives = {
    ...EMPTY_RESPONSE_DIRECTIVES,
    hardLimits: { ...EMPTY_RESPONSE_DIRECTIVES.hardLimits },
  };

  const languageSignal = firstSignalByDimension(signals, 'language');
  if (languageSignal) {
    directives.language = languageSignal.value;
  }

  const toneSignal = firstSignalByDimension(signals, 'tone');
  if (toneSignal) {
    directives.tone = toneSignal.value;
  }

  const verbositySignal = firstSignalByDimension(signals, 'verbosity');
  if (verbositySignal) {
    directives.verbosity = verbositySignal.value;
  }

  const shapeSignal = firstSignalByDimension(signals, 'shape');
  if (shapeSignal) {
    directives.shape = shapeSignal.value;
  }

  // Structure depends on resolved shape (steps_only/strict_sections imply structured)
  if (directives.shape === 'steps_only' || directives.shape === 'strict_sections') {
    directives.structure = 'structured';
  } else if (hasSignal(signals, 'structure')) {
    directives.structure = 'structured';
  }

  directives.hardLimits.singleSentence = hasSignal(signals, 'single_sentence');
  directives.hardLimits.noExamples = hasSignal(signals, 'no_examples');
  directives.hardLimits.noAdjacentFacts = hasSignal(signals, 'no_adjacent_facts');
  directives.hardLimits.uncertaintyFirst = hasSignal(signals, 'uncertainty_first');

  const maxTopLevelItemsSignal = firstSignalByDimension(signals, 'max_top_level_items');
  if (maxTopLevelItemsSignal) {
    directives.hardLimits.maxTopLevelItems = maxTopLevelItemsSignal.value;
  }

  const exactSectionsSignal = firstSignalByDimension(signals, 'exact_sections');
  if (exactSectionsSignal) {
    directives.shape = 'strict_sections';
    directives.structure = 'structured';
    directives.hardLimits.exactSections = exactSectionsSignal.value;
    directives.hardLimits.maxTopLevelItems ??= exactSectionsSignal.value.length;
  }

  // Derived rules — shape cascades
  if (directives.shape === 'definition_only') {
    directives.verbosity = directives.verbosity ?? 'concise';
    directives.hardLimits.singleSentence = true;
    directives.hardLimits.noExamples = true;
    directives.hardLimits.noAdjacentFacts = true;
    directives.hardLimits.noOptionalExpansion = true;
  }

  if (directives.shape === 'steps_only') {
    directives.verbosity = directives.verbosity ?? 'concise';
    directives.structure = 'structured';
    directives.hardLimits.noOptionalExpansion = true;
  }

  // Derived rules — hard limit cascades
  if (directives.hardLimits.singleSentence || directives.hardLimits.maxTopLevelItems !== undefined) {
    directives.verbosity = directives.verbosity ?? 'concise';
    directives.hardLimits.noOptionalExpansion = true;
  }

  if (directives.hardLimits.uncertaintyFirst) {
    directives.hardLimits.noOptionalExpansion = true;
  }

  // Derived rules — concise signal cascade
  if (verbositySignal?.value === 'concise') {
    directives.hardLimits.noOptionalExpansion = true;
    directives.hardLimits.noAdjacentFacts ??= true;
  }

  return directives;
}

/* ------------------------------------------------------------------ */
/*  Individual detectors (still exported for direct use)              */
/* ------------------------------------------------------------------ */

export function detectLanguage(content: string): 'ru' | 'en' | undefined {
  if (matchesAny(content, RUSSIAN_LANGUAGE_PATTERNS)) {
    return 'ru';
  }

  if (matchesAny(content, ENGLISH_LANGUAGE_PATTERNS)) {
    return 'en';
  }

  return undefined;
}

export function detectVerbosity(content: string): AgentVerbosity | undefined {
  if (matchesAny(content, CONCISE_PATTERNS) || matchesAny(content, SINGLE_SENTENCE_PATTERNS)) {
    return 'concise';
  }

  if (matchesAny(content, DETAILED_PATTERNS)) {
    return 'detailed';
  }

  return undefined;
}

export function detectTone(content: string): AgentTone | undefined {
  if (matchesAny(content, FORMAL_TONE_PATTERNS)) {
    return 'formal';
  }

  if (matchesAny(content, WARM_TONE_PATTERNS)) {
    return 'warm';
  }

  return undefined;
}

export function detectStructure(
  content: string,
  shape: ResponseDirectives['shape'],
): AgentStructurePreference | undefined {
  if (shape === 'steps_only' || shape === 'strict_sections') {
    return 'structured';
  }

  if (matchesAny(content, STRUCTURED_PATTERNS)) {
    return 'structured';
  }

  return undefined;
}

export function detectShape(content: string): ResponseDirectives['shape'] | undefined {
  if (matchesAny(content, DEFINITION_ONLY_PATTERNS)) {
    return 'definition_only';
  }

  if (matchesAny(content, STEPS_ONLY_PATTERNS)) {
    return 'steps_only';
  }

  return undefined;
}

export function detectMaxTopLevelItems(content: string): number | undefined {
  const patterns = [
    /\b(\d+)\s+(?:points?|bullets?|items?)\s+(?:max(?:imum)?|or less)\b/i,
    /\b(?:max(?:imum)?|at most)\s+(\d+)\s+(?:points?|bullets?|items?)\b/i,
    /(\d+)\s+(?:пункта|пунктов|пункты)\s+максимум/i,
    /максимум\s+(\d+)\s+(?:пункта|пунктов|пункты)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function extractExactSections(content: string): ResponseSectionDirective[] | undefined {
  if (!matchesAny(content, STRICT_FORMAT_PATTERNS)) {
    return undefined;
  }

  const sections: ResponseSectionDirective[] = [];
  const pattern = /(\d+)\)\s*([^\d][^\n]*?)(?=(?:\s+\d+\)|$))/g;

  let match: RegExpExecArray | null = pattern.exec(content);
  while (match) {
    const index = Number(match[1]);
    const label = match[2]?.trim().replace(/[.;:,]+$/u, '');
    if (Number.isFinite(index) && label) {
      sections.push({ index, label });
    }
    match = pattern.exec(content);
  }

  if (sections.length < 2) {
    return undefined;
  }

  return sections.sort((left, right) => left.index - right.index);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

// Re-export for backward compatibility
export { matchesAny } from '../pattern-utils';
