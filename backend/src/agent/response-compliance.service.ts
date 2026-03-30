import { Injectable } from '@nestjs/common';

import {
  hasStrictResponseDirectives,
  type ResponseDirectives,
  type ResponseSectionDirective,
} from './response-directives.types';

export type ResponseComplianceViolationCode =
  | 'language'
  | 'single_sentence'
  | 'definition_only'
  | 'steps_only'
  | 'no_examples'
  | 'max_top_level_items'
  | 'exact_sections'
  | 'uncertainty_first';

export interface ResponseComplianceViolation {
  code: ResponseComplianceViolationCode;
  message: string;
}

export interface ResponseComplianceResult {
  compliant: boolean;
  violations: ResponseComplianceViolation[];
}

const EXAMPLE_PATTERNS = [/(?:^|\b)(?:for example|example:|e\.g\.|например|к примеру)(?:\b|:)/i];
const UNCERTAINTY_LEAD_PATTERNS = [
  /^(?:i do not know|i don't know|there is not enough data|not enough data|i need more information)/i,
  /^(?:я этого не знаю|я не знаю|мне не хватает данных|не хватает данных|недостаточно данных|нужно больше данных)/i,
];

@Injectable()
export class ResponseComplianceService {
  validate(content: string, directives: ResponseDirectives): ResponseComplianceResult {
    if (!hasStrictResponseDirectives(directives)) {
      return { compliant: true, violations: [] };
    }

    const violations: ResponseComplianceViolation[] = [];

    if (directives.language && !this.isLanguageCompliant(content, directives.language)) {
      violations.push({
        code: 'language',
        message: `The response should primarily be in ${directives.language === 'ru' ? 'Russian' : 'English'} prose.`,
      });
    }

    if (directives.hardLimits.singleSentence && !this.isSingleSentence(content)) {
      violations.push({
        code: 'single_sentence',
        message: 'The response must be a single sentence.',
      });
    }

    if (directives.shape === 'definition_only' && !this.isDefinitionOnly(content)) {
      violations.push({
        code: 'definition_only',
        message: 'The response must stay as a direct definition only, without extra sections or expansions.',
      });
    }

    if (directives.shape === 'steps_only' && !this.isStepsOnly(content)) {
      violations.push({
        code: 'steps_only',
        message: 'The response must contain only steps without explanatory prose between them.',
      });
    }

    if (directives.hardLimits.noExamples && this.containsExamples(content)) {
      violations.push({
        code: 'no_examples',
        message: 'The response must not include examples.',
      });
    }

    if (
      directives.hardLimits.maxTopLevelItems !== undefined &&
      this.countTopLevelItems(content) > directives.hardLimits.maxTopLevelItems
    ) {
      violations.push({
        code: 'max_top_level_items',
        message: `The response exceeds the maximum of ${directives.hardLimits.maxTopLevelItems} top-level items.`,
      });
    }

    if (
      directives.hardLimits.exactSections &&
      directives.hardLimits.exactSections.length > 0 &&
      !this.hasExactSections(content, directives.hardLimits.exactSections)
    ) {
      violations.push({
        code: 'exact_sections',
        message: 'The response does not follow the requested numbered section structure.',
      });
    }

    if (directives.hardLimits.uncertaintyFirst && !this.startsWithUncertainty(content)) {
      violations.push({
        code: 'uncertainty_first',
        message: 'The response must start by naming the missing information or uncertainty before giving guidance.',
      });
    }

    return {
      compliant: violations.length === 0,
      violations,
    };
  }

  shouldUseBufferedCompletion(directives: ResponseDirectives): boolean {
    return hasStrictResponseDirectives(directives);
  }

  buildRetryInstruction(directives: ResponseDirectives, violations: ResponseComplianceViolation[]): string {
    const rules: string[] = [
      'Rewrite the assistant answer so it fully complies with the hard response directives for this turn.',
      'Preserve truthfulness, groundedness, and the requested meaning.',
      'Output only the corrected final answer with no meta commentary.',
    ];

    if (directives.language === 'ru') {
      rules.push('Respond in Russian prose unless a technical token must remain unchanged.');
    } else if (directives.language === 'en') {
      rules.push('Respond in English prose unless a technical token must remain unchanged.');
    }

    if (directives.hardLimits.singleSentence) {
      rules.push('Use exactly one sentence.');
    }

    if (directives.shape === 'definition_only') {
      rules.push('Give only a direct definition. Do not add examples, comparisons, adjacent facts, or follow-up guidance.');
    }

    if (directives.shape === 'steps_only') {
      rules.push('Return only the steps as a list. Do not wrap them in explanatory introduction or conclusion.');
    }

    if (directives.hardLimits.noExamples) {
      rules.push('Do not include examples.');
    }

    if (directives.hardLimits.noAdjacentFacts || directives.hardLimits.noOptionalExpansion) {
      rules.push('Do not append optional expansions or nearby but unasked-for facts.');
    }

    if (directives.hardLimits.maxTopLevelItems !== undefined) {
      rules.push(`Use no more than ${directives.hardLimits.maxTopLevelItems} top-level items.`);
    }

    if (directives.hardLimits.exactSections && directives.hardLimits.exactSections.length > 0) {
      rules.push(
        `Follow this exact numbered structure: ${directives.hardLimits.exactSections
          .map((section) => `${section.index}) ${section.label}`)
          .join(' ')}`,
      );
    }

    if (directives.hardLimits.uncertaintyFirst) {
      rules.push('Start by stating the missing information or uncertainty before giving any recommendation.');
    }

    if (violations.length > 0) {
      rules.push(`Correct these violations: ${violations.map((violation) => violation.message).join(' ')}`);
    }

    return rules.join(' ');
  }

  private isLanguageCompliant(content: string, targetLanguage: 'ru' | 'en'): boolean {
    const prose = this.toComparableProse(content);
    if (!prose) {
      return true;
    }

    if (this.startsWithForeignLead(prose, targetLanguage)) {
      return false;
    }

    const cyrillicLetters = prose.match(/[А-Яа-яЁё]/g)?.length ?? 0;
    const latinLetters = prose.match(/[A-Za-z]/g)?.length ?? 0;

    if (targetLanguage === 'ru') {
      if (cyrillicLetters === 0 && latinLetters > 0) {
        return false;
      }

      if (cyrillicLetters > 0 && latinLetters > cyrillicLetters * 1.5) {
        return false;
      }

      return true;
    }

    if (latinLetters === 0 && cyrillicLetters > 0) {
      return false;
    }

    if (latinLetters > 0 && cyrillicLetters > latinLetters * 1.5) {
      return false;
    }

    return true;
  }

  private startsWithForeignLead(prose: string, targetLanguage: 'ru' | 'en'): boolean {
    const tokens = prose.match(/[A-Za-z]+|[А-Яа-яЁё]+/g)?.slice(0, 4) ?? [];
    if (tokens.length < 2) {
      return false;
    }

    if (targetLanguage === 'ru') {
      return tokens.slice(0, 2).every((token) => /[A-Za-z]/.test(token) && token !== token.toUpperCase());
    }

    return tokens.slice(0, 2).every((token) => /[А-Яа-яЁё]/.test(token));
  }

  private isSingleSentence(content: string): boolean {
    const prose = this.toComparableProse(content);
    if (!prose) {
      return true;
    }

    const sentenceCount = prose.match(/[.!?](?=\s|$)/g)?.length ?? 0;
    return sentenceCount <= 1 && !/\n\s*\n/u.test(prose);
  }

  private isDefinitionOnly(content: string): boolean {
    const prose = this.toComparableProse(content);
    if (!prose) {
      return true;
    }

    if (!this.isSingleSentence(prose)) {
      return false;
    }

    return !this.containsListMarkers(prose) && !/\n/u.test(prose);
  }

  private isStepsOnly(content: string): boolean {
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return true;
    }

    return lines.every((line) => /^[-*]|^\d+[.)]/u.test(line));
  }

  private containsExamples(content: string): boolean {
    return EXAMPLE_PATTERNS.some((pattern) => pattern.test(content));
  }

  private countTopLevelItems(content: string): number {
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const explicitItems = lines.filter((line) => /^[-*]|^\d+[.)]/u.test(line)).length;
    return explicitItems;
  }

  private hasExactSections(content: string, sections: ResponseSectionDirective[]): boolean {
    let lastIndex = -1;

    for (const section of sections) {
      const pattern = new RegExp(
        `${section.index}[.)]\\s*(?:\\*\\*)?${this.escapeRegex(section.label)}(?:\\*\\*)?`,
        'iu',
      );
      const matchIndex = content.search(pattern);
      if (matchIndex === -1 || matchIndex <= lastIndex) {
        return false;
      }
      lastIndex = matchIndex;
    }

    return true;
  }

  private startsWithUncertainty(content: string): boolean {
    const prose = this.toComparableProse(content);
    if (!prose) {
      return false;
    }

    return UNCERTAINTY_LEAD_PATTERNS.some((pattern) => pattern.test(prose));
  }

  private containsListMarkers(content: string): boolean {
    return /(^|\n)\s*(?:[-*]|\d+[.)])/u.test(content);
  }

  private toComparableProse(content: string): string {
    return content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
