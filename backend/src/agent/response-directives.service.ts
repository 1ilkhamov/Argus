import { Injectable } from '@nestjs/common';

import type { AgentVerbosity } from './core-contract';
import type { AgentStructurePreference, AgentTone } from './profile/user-profile.types';
import {
  EMPTY_RESPONSE_DIRECTIVES,
  type ResponseDirectives,
  type ResponseSectionDirective,
} from './response-directives.types';

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

@Injectable()
export class ResponseDirectivesService {
  resolve(content: string): ResponseDirectives {
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return {
        ...EMPTY_RESPONSE_DIRECTIVES,
        hardLimits: { ...EMPTY_RESPONSE_DIRECTIVES.hardLimits },
      };
    }

    const directives: ResponseDirectives = {
      ...EMPTY_RESPONSE_DIRECTIVES,
      hardLimits: { ...EMPTY_RESPONSE_DIRECTIVES.hardLimits },
    };

    const language = this.detectLanguage(trimmedContent);
    if (language) {
      directives.language = language;
    }

    const tone = this.detectTone(trimmedContent);
    if (tone) {
      directives.tone = tone;
    }

    const verbosity = this.detectVerbosity(trimmedContent);
    if (verbosity) {
      directives.verbosity = verbosity;
    }

    const shape = this.detectShape(trimmedContent);
    if (shape) {
      directives.shape = shape;
    }

    const structure = this.detectStructure(trimmedContent, directives.shape);
    if (structure) {
      directives.structure = structure;
    }

    directives.hardLimits.singleSentence = this.matchesAny(trimmedContent, SINGLE_SENTENCE_PATTERNS);
    directives.hardLimits.noExamples = this.matchesAny(trimmedContent, NO_EXAMPLES_PATTERNS);
    directives.hardLimits.noAdjacentFacts = this.matchesAny(trimmedContent, NO_ADJACENT_FACTS_PATTERNS);
    directives.hardLimits.uncertaintyFirst = this.matchesAny(trimmedContent, UNCERTAINTY_FIRST_PATTERNS);

    const maxTopLevelItems = this.detectMaxTopLevelItems(trimmedContent);
    if (maxTopLevelItems !== undefined) {
      directives.hardLimits.maxTopLevelItems = maxTopLevelItems;
    }

    const exactSections = this.extractExactSections(trimmedContent);
    if (exactSections && exactSections.length > 0) {
      directives.shape = 'strict_sections';
      directives.structure = 'structured';
      directives.hardLimits.exactSections = exactSections;
      directives.hardLimits.maxTopLevelItems ??= exactSections.length;
    }

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

    if (directives.hardLimits.singleSentence || directives.hardLimits.maxTopLevelItems !== undefined) {
      directives.verbosity = directives.verbosity ?? 'concise';
      directives.hardLimits.noOptionalExpansion = true;
    }

    if (directives.hardLimits.uncertaintyFirst) {
      directives.hardLimits.noOptionalExpansion = true;
    }

    if (this.matchesAny(trimmedContent, CONCISE_PATTERNS)) {
      directives.hardLimits.noOptionalExpansion = true;
      directives.hardLimits.noAdjacentFacts ??= true;
    }

    return directives;
  }

  private detectLanguage(content: string): 'ru' | 'en' | undefined {
    if (this.matchesAny(content, RUSSIAN_LANGUAGE_PATTERNS)) {
      return 'ru';
    }

    if (this.matchesAny(content, ENGLISH_LANGUAGE_PATTERNS)) {
      return 'en';
    }

    return undefined;
  }

  private detectVerbosity(content: string): AgentVerbosity | undefined {
    if (this.matchesAny(content, CONCISE_PATTERNS) || this.matchesAny(content, SINGLE_SENTENCE_PATTERNS)) {
      return 'concise';
    }

    if (this.matchesAny(content, DETAILED_PATTERNS)) {
      return 'detailed';
    }

    return undefined;
  }

  private detectTone(content: string): AgentTone | undefined {
    if (this.matchesAny(content, FORMAL_TONE_PATTERNS)) {
      return 'formal';
    }

    if (this.matchesAny(content, WARM_TONE_PATTERNS)) {
      return 'warm';
    }

    return undefined;
  }

  private detectStructure(content: string, shape: ResponseDirectives['shape']): AgentStructurePreference | undefined {
    if (shape === 'steps_only' || shape === 'strict_sections') {
      return 'structured';
    }

    if (this.matchesAny(content, STRUCTURED_PATTERNS)) {
      return 'structured';
    }

    return undefined;
  }

  private detectShape(content: string): ResponseDirectives['shape'] | undefined {
    if (this.matchesAny(content, DEFINITION_ONLY_PATTERNS)) {
      return 'definition_only';
    }

    if (this.matchesAny(content, STEPS_ONLY_PATTERNS)) {
      return 'steps_only';
    }

    return undefined;
  }

  private detectMaxTopLevelItems(content: string): number | undefined {
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

  private extractExactSections(content: string): ResponseSectionDirective[] | undefined {
    if (!this.matchesAny(content, STRICT_FORMAT_PATTERNS)) {
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

  private matchesAny(content: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(content));
  }
}
