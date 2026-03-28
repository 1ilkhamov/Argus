/**
 * Characterization tests for ResponseDirectivesService.
 *
 * Purpose: freeze the current behavior of every pattern family, derived-rule
 * cascade, precedence interaction and edge case BEFORE any refactoring begins.
 *
 * These tests document what the code does today — not what it ideally should do.
 * If a refactor changes any of these outputs, the diff is immediately visible.
 */
import { ResponseDirectivesService } from './response-directives.service';
import {
  hasExplicitResponseDirectives,
  hasStrictResponseDirectives,
  type ResponseDirectives,
} from './response-directives.types';

const service = new ResponseDirectivesService();

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Shorthand: resolve and return the full directives object. */
const r = (content: string): ResponseDirectives => service.resolve(content);

/* ------------------------------------------------------------------ */
/*  1. Empty / no-match baseline                                      */
/* ------------------------------------------------------------------ */

describe('ResponseDirectivesService – characterization', () => {
  describe('empty and no-match inputs', () => {
    it('returns empty directives for an empty string', () => {
      expect(r('')).toEqual({
        shape: 'adaptive',
        hardLimits: {},
      });
    });

    it('returns empty directives for whitespace-only input', () => {
      expect(r('   \n\t  ')).toEqual({
        shape: 'adaptive',
        hardLimits: {},
      });
    });

    it('returns baseline directives for plain conversational text', () => {
      const d = r('Tell me about the weather today');
      expect(d.language).toBeUndefined();
      expect(d.tone).toBeUndefined();
      expect(d.verbosity).toBeUndefined();
      expect(d.structure).toBeUndefined();
      expect(d.shape).toBe('adaptive');
      expect(d.hardLimits.singleSentence).toBe(false);
      expect(d.hardLimits.noExamples).toBe(false);
      expect(d.hardLimits.noAdjacentFacts).toBe(false);
      expect(d.hardLimits.noOptionalExpansion).toBeUndefined();
      expect(d.hardLimits.uncertaintyFirst).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Language detection                                              */
  /* ------------------------------------------------------------------ */

  describe('language detection', () => {
    it.each([
      ['answer in russian', 'ru'],
      ['respond in russian', 'ru'],
      ['please in russian', 'ru'],
      ['на русском объясни', 'ru'],
      ['по-русски ответь', 'ru'],
      ['ответь на русском', 'ru'],
      ['отвечай по-русски', 'ru'],
      ['пиши на русском', 'ru'],
    ] as const)('detects russian for: "%s"', (input, expected) => {
      expect(r(input).language).toBe(expected);
    });

    it.each([
      ['answer in english', 'en'],
      ['respond in english', 'en'],
      ['please in english', 'en'],
      ['на английском', 'en'],
      ['по-английски', 'en'],
      ['ответь на английском', 'en'],
      ['отвечай по-английски', 'en'],
      ['пиши по-английски', 'en'],
    ] as const)('detects english for: "%s"', (input, expected) => {
      expect(r(input).language).toBe(expected);
    });

    it('does not detect language from unrelated text', () => {
      expect(r('What is polymorphism?').language).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Verbosity detection                                             */
  /* ------------------------------------------------------------------ */

  describe('verbosity detection', () => {
    it.each([
      'keep it concise',
      'be concise',
      'briefly explain',
      'short answer please',
      'very short',
      'maximally short',
      'short explanation',
      'очень кратко',
      'максимально коротко',
      'максимально кратко',
      'кратко ответь',
      'коротко скажи',
      'без воды объясни',
    ])('detects concise for: "%s"', (input) => {
      expect(r(input).verbosity).toBe('concise');
    });

    it.each([
      'give me a detailed answer',
      'thorough analysis please',
      'explain in depth',
      'be thorough',
      'подробно опиши',
      'развернуто объясни',
      'развёрнуто объясни',
      'детально разбери',
    ])('detects detailed for: "%s"', (input) => {
      expect(r(input).verbosity).toBe('detailed');
    });

    it('does not detect verbosity from neutral text', () => {
      expect(r('Explain the CAP theorem').verbosity).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. Tone detection                                                  */
  /* ------------------------------------------------------------------ */

  describe('tone detection', () => {
    it.each([
      'use a formal style',
      'formal tone please',
      'answer formally',
      'в формальном стиле ответь',
      'формально объясни',
      'без разговорных оборотов',
    ])('detects formal for: "%s"', (input) => {
      expect(r(input).tone).toBe('formal');
    });

    it.each([
      'warm tone please',
      'explain gently',
      'softly describe it',
      'мягко объясни',
      'по-человечески скажи',
      'бережно',
      'без перегруза',
    ])('detects warm for: "%s"', (input) => {
      expect(r(input).tone).toBe('warm');
    });

    it('does not detect tone from neutral text', () => {
      expect(r('What is CQRS?').tone).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Shape detection                                                 */
  /* ------------------------------------------------------------------ */

  describe('shape detection', () => {
    it.each([
      'only definition',
      'definition only',
      'just the definition',
      'только определение',
      'только определением',
      'ответь только определением',
    ])('detects definition_only for: "%s"', (input) => {
      expect(r(input).shape).toBe('definition_only');
    });

    it.each([
      'only steps',
      'just steps',
      'steps only',
      'только шаги',
      'только шагами',
    ])('detects steps_only for: "%s"', (input) => {
      expect(r(input).shape).toBe('steps_only');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. Structure detection                                             */
  /* ------------------------------------------------------------------ */

  describe('structure detection', () => {
    it.each([
      'structured answer please',
      'structure it clearly',
      'with sections please',
      'with bullets',
      'структурно ответь',
      'по разделам объясни',
      'с разделами',
      'списком',
    ])('detects structured for: "%s"', (input) => {
      expect(r(input).structure).toBe('structured');
    });

    it('does not detect structure from neutral text', () => {
      expect(r('What is DDD?').structure).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  7. Hard limits – individual flags                                  */
  /* ------------------------------------------------------------------ */

  describe('hard limits – individual', () => {
    it.each([
      'one sentence please',
      'single sentence',
      'одним предложением',
    ])('sets singleSentence for: "%s"', (input) => {
      expect(r(input).hardLimits.singleSentence).toBe(true);
    });

    it.each([
      'without examples',
      'no examples',
      'do not give examples',
      'без примеров',
      'не приводи примеры',
    ])('sets noExamples for: "%s"', (input) => {
      expect(r(input).hardLimits.noExamples).toBe(true);
    });

    it.each([
      'no adjacent facts',
      'without adjacent facts',
      'do not add nearby facts',
      'без соседних фактов',
      'не добавляй соседние факты',
    ])('sets noAdjacentFacts for: "%s"', (input) => {
      expect(r(input).hardLimits.noAdjacentFacts).toBe(true);
    });

    it('sets uncertaintyFirst from russian phrasing', () => {
      expect(
        r('если данных мало, сначала перечисли, чего не хватает').hardLimits.uncertaintyFirst,
      ).toBe(true);
    });

    it('sets uncertaintyFirst from english phrasing', () => {
      expect(
        r('if the data is insufficient, first list what is missing before answering').hardLimits.uncertaintyFirst,
      ).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  8. Max top-level items                                             */
  /* ------------------------------------------------------------------ */

  describe('max top-level items', () => {
    it.each([
      ['3 points max', 3],
      ['maximum 5 bullets', 5],
      ['at most 4 items', 4],
      ['3 пункта максимум', 3],
      ['максимум 5 пунктов', 5],
    ] as const)('extracts count from: "%s"', (input, expected) => {
      expect(r(input).hardLimits.maxTopLevelItems).toBe(expected);
    });

    it('does not extract max items from unrelated numbers', () => {
      expect(r('HTTP status 404 means not found').hardLimits.maxTopLevelItems).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  9. Exact sections extraction                                       */
  /* ------------------------------------------------------------------ */

  describe('exact sections', () => {
    it('extracts numbered sections with strict format trigger', () => {
      const d = r('Формат строго такой: 1) проблема 2) причина 3) решение');
      expect(d.shape).toBe('strict_sections');
      expect(d.structure).toBe('structured');
      expect(d.hardLimits.exactSections).toEqual([
        { index: 1, label: 'проблема' },
        { index: 2, label: 'причина' },
        { index: 3, label: 'решение' },
      ]);
      expect(d.hardLimits.maxTopLevelItems).toBe(3);
    });

    it('extracts english strict format sections', () => {
      const d = r('strict format: 1) definition 2) use cases 3) pitfalls');
      expect(d.shape).toBe('strict_sections');
      expect(d.hardLimits.exactSections).toEqual([
        { index: 1, label: 'definition' },
        { index: 2, label: 'use cases' },
        { index: 3, label: 'pitfalls' },
      ]);
    });

    it('ignores numbered patterns without the strict format trigger', () => {
      const d = r('Give me: 1) definition 2) use cases 3) pitfalls');
      expect(d.hardLimits.exactSections).toBeUndefined();
      expect(d.shape).toBe('adaptive');
    });

    it('ignores strict format trigger when fewer than 2 sections are parsed', () => {
      const d = r('Формат строго: один абзац');
      expect(d.hardLimits.exactSections).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  10. Derived rules – definition_only cascade                        */
  /* ------------------------------------------------------------------ */

  describe('derived rules – definition_only', () => {
    it('cascades definition_only into singleSentence, noExamples, noAdjacentFacts, noOptionalExpansion, and defaults verbosity to concise', () => {
      const d = r('Only definition please');
      expect(d.shape).toBe('definition_only');
      expect(d.verbosity).toBe('concise');
      expect(d.hardLimits.singleSentence).toBe(true);
      expect(d.hardLimits.noExamples).toBe(true);
      expect(d.hardLimits.noAdjacentFacts).toBe(true);
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });

    it('preserves explicit detailed verbosity even with definition_only shape', () => {
      const d = r('Definition only but be detailed');
      expect(d.shape).toBe('definition_only');
      expect(d.verbosity).toBe('detailed');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  11. Derived rules – steps_only cascade                             */
  /* ------------------------------------------------------------------ */

  describe('derived rules – steps_only', () => {
    it('cascades steps_only into structured and noOptionalExpansion, defaults verbosity to concise', () => {
      const d = r('Only steps');
      expect(d.shape).toBe('steps_only');
      expect(d.structure).toBe('structured');
      expect(d.verbosity).toBe('concise');
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  12. Derived rules – singleSentence cascade                         */
  /* ------------------------------------------------------------------ */

  describe('derived rules – singleSentence', () => {
    it('singleSentence defaults verbosity to concise and sets noOptionalExpansion', () => {
      const d = r('One sentence');
      expect(d.verbosity).toBe('concise');
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  13. Derived rules – maxTopLevelItems cascade                       */
  /* ------------------------------------------------------------------ */

  describe('derived rules – maxTopLevelItems', () => {
    it('maxTopLevelItems defaults verbosity to concise and sets noOptionalExpansion', () => {
      const d = r('3 points max');
      expect(d.verbosity).toBe('concise');
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  14. Derived rules – concise pattern cascade                        */
  /* ------------------------------------------------------------------ */

  describe('derived rules – concise', () => {
    it('concise sets noOptionalExpansion but noAdjacentFacts stays false (??= does not override false)', () => {
      const d = r('be concise');
      expect(d.verbosity).toBe('concise');
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
      // NOTE: noAdjacentFacts is explicitly set to false earlier, and ??= only overrides nullish
      expect(d.hardLimits.noAdjacentFacts).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  15. Derived rules – uncertaintyFirst cascade                       */
  /* ------------------------------------------------------------------ */

  describe('derived rules – uncertaintyFirst', () => {
    it('uncertaintyFirst sets noOptionalExpansion', () => {
      const d = r('если данных мало, сначала перечисли, чего не хватает');
      expect(d.hardLimits.uncertaintyFirst).toBe(true);
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  16. Combined / multi-signal inputs                                 */
  /* ------------------------------------------------------------------ */

  describe('combined multi-signal inputs', () => {
    it('detects language + verbosity + tone together', () => {
      const d = r('Answer in Russian, be concise, formal tone please');
      expect(d.language).toBe('ru');
      expect(d.verbosity).toBe('concise');
      expect(d.tone).toBe('formal');
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
      // noAdjacentFacts is false because explicit assignment precedes ??=
      expect(d.hardLimits.noAdjacentFacts).toBe(false);
    });

    it('detects steps + max items + concise in Russian', () => {
      const d = r('Только шаги, 4 пункта максимум, без воды');
      expect(d.shape).toBe('steps_only');
      expect(d.structure).toBe('structured');
      expect(d.verbosity).toBe('concise');
      expect(d.hardLimits.maxTopLevelItems).toBe(4);
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });

    it('detects definition_only + language + no examples', () => {
      const d = r('Please answer in Russian: only definition, without examples');
      expect(d.language).toBe('ru');
      expect(d.shape).toBe('definition_only');
      expect(d.hardLimits.noExamples).toBe(true);
      expect(d.hardLimits.singleSentence).toBe(true);
      expect(d.hardLimits.noOptionalExpansion).toBe(true);
    });

    it('detects warm tone + detailed verbosity + structured', () => {
      const d = r('Explain gently, in depth, with sections');
      expect(d.tone).toBe('warm');
      expect(d.verbosity).toBe('detailed');
      expect(d.structure).toBe('structured');
    });

    it('detects strict sections with warm tone in Russian', () => {
      const d = r('Мягко объясни. Формат строго такой: 1) суть 2) примеры 3) итог');
      expect(d.tone).toBe('warm');
      expect(d.shape).toBe('strict_sections');
      expect(d.hardLimits.exactSections).toEqual([
        { index: 1, label: 'суть' },
        { index: 2, label: 'примеры' },
        { index: 3, label: 'итог' },
      ]);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  17. Precedence: strict_sections overrides prior shape              */
  /* ------------------------------------------------------------------ */

  describe('precedence', () => {
    it('strict_sections overrides an earlier definition_only shape', () => {
      const d = r('Only definition. Формат строго такой: 1) определение 2) контекст');
      expect(d.shape).toBe('strict_sections');
      expect(d.hardLimits.exactSections).toBeDefined();
    });

    it('concise pattern still sets noAdjacentFacts even when detailed is also present', () => {
      // concise matches first → verbosity=concise; detailed is ignored because concise already set
      const d = r('be concise but also detailed');
      expect(d.verbosity).toBe('concise');
      // noAdjacentFacts stays false (??= does not override false)
      expect(d.hardLimits.noAdjacentFacts).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  18. Conflict precedence – same-dimension conflicts                  */
  /* ------------------------------------------------------------------ */

  describe('conflict precedence – same dimension', () => {
    it('russian wins over english when both patterns match (ru checked first)', () => {
      const d = r('answer in russian and also in english');
      expect(d.language).toBe('ru');
    });

    it('formal wins over warm when both patterns match (formal checked first)', () => {
      const d = r('formal style, explain gently');
      expect(d.tone).toBe('formal');
    });

    it('definition_only wins over steps_only when both patterns match (definition checked first)', () => {
      const d = r('only definition, only steps');
      expect(d.shape).toBe('definition_only');
    });

    it('concise wins over detailed when both patterns match (concise checked first in detectVerbosity)', () => {
      const d = r('be concise and also give a detailed answer');
      expect(d.verbosity).toBe('concise');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  19. exactSections – sorting and maxTopLevelItems interaction        */
  /* ------------------------------------------------------------------ */

  describe('exactSections – sorting and interactions', () => {
    it('sorts sections by index when provided out of order', () => {
      const d = r('Формат строго такой: 3) итог 1) вход 2) процесс');
      expect(d.hardLimits.exactSections).toEqual([
        { index: 1, label: 'вход' },
        { index: 2, label: 'процесс' },
        { index: 3, label: 'итог' },
      ]);
    });

    it('explicit maxTopLevelItems is NOT overridden by exactSections count (??= only sets if undefined)', () => {
      const d = r('maximum 5 items. Формат строго такой: 1) определение 2) пример 3) итог');
      // maxTopLevelItems was already set to 5 before exactSections sets ??= 3
      expect(d.hardLimits.maxTopLevelItems).toBe(5);
    });

    it('maxTopLevelItems defaults to section count when not explicitly set', () => {
      const d = r('Формат строго такой: 1) проблема 2) причина 3) решение 4) итог');
      expect(d.hardLimits.maxTopLevelItems).toBe(4);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  20. Full toEqual snapshot – freeze exact output for complex input   */
  /* ------------------------------------------------------------------ */

  describe('full object snapshot', () => {
    it('freezes the complete output for a rich multi-signal input', () => {
      const d = r('Answer in Russian, be concise, formal tone, with sections, no examples, 3 points max');
      expect(d).toEqual({
        language: 'ru',
        tone: 'formal',
        verbosity: 'concise',
        structure: 'structured',
        shape: 'adaptive',
        hardLimits: {
          singleSentence: false,
          noExamples: true,
          noAdjacentFacts: false,
          noOptionalExpansion: true,
          maxTopLevelItems: 3,
          uncertaintyFirst: false,
        },
      });
    });

    it('freezes the complete output for a definition-only Russian input', () => {
      const d = r('Только определение, на русском, без примеров');
      expect(d).toEqual({
        language: 'ru',
        verbosity: 'concise',
        shape: 'definition_only',
        hardLimits: {
          singleSentence: true,
          noExamples: true,
          noAdjacentFacts: true,
          noOptionalExpansion: true,
          uncertaintyFirst: false,
        },
      });
    });

    it('freezes the complete output for strict sections with warm tone', () => {
      const d = r('Мягко объясни. Формат строго такой: 1) суть 2) примеры 3) итог');
      expect(d).toEqual({
        tone: 'warm',
        verbosity: 'concise',
        structure: 'structured',
        shape: 'strict_sections',
        hardLimits: {
          singleSentence: false,
          noExamples: false,
          noAdjacentFacts: false,
          noOptionalExpansion: true,
          maxTopLevelItems: 3,
          exactSections: [
            { index: 1, label: 'суть' },
            { index: 2, label: 'примеры' },
            { index: 3, label: 'итог' },
          ],
          uncertaintyFirst: false,
        },
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /*  21. Utility functions: hasExplicitResponseDirectives /              */
  /*      hasStrictResponseDirectives                                     */
  /* ------------------------------------------------------------------ */

  describe('hasExplicitResponseDirectives', () => {
    it('returns false for empty/adaptive directives', () => {
      expect(hasExplicitResponseDirectives(r(''))).toBe(false);
    });

    it('returns false for plain text (no signals)', () => {
      expect(hasExplicitResponseDirectives(r('What is DDD?'))).toBe(false);
    });

    it('returns true when language is set', () => {
      expect(hasExplicitResponseDirectives(r('answer in russian'))).toBe(true);
    });

    it('returns true when tone is set', () => {
      expect(hasExplicitResponseDirectives(r('formal tone please'))).toBe(true);
    });

    it('returns true when verbosity is set', () => {
      expect(hasExplicitResponseDirectives(r('be concise'))).toBe(true);
    });

    it('returns true when structure is set', () => {
      expect(hasExplicitResponseDirectives(r('with sections'))).toBe(true);
    });

    it('returns true when shape is non-adaptive', () => {
      expect(hasExplicitResponseDirectives(r('only definition'))).toBe(true);
    });

    it('returns true when singleSentence is set', () => {
      expect(hasExplicitResponseDirectives(r('one sentence'))).toBe(true);
    });

    it('returns true when noExamples is set', () => {
      expect(hasExplicitResponseDirectives(r('no examples'))).toBe(true);
    });

    it('returns true when maxTopLevelItems is set', () => {
      expect(hasExplicitResponseDirectives(r('3 points max'))).toBe(true);
    });

    it('returns true when exactSections is set', () => {
      expect(hasExplicitResponseDirectives(r('strict format: 1) a 2) b'))).toBe(true);
    });

    it('returns true when uncertaintyFirst is set', () => {
      expect(hasExplicitResponseDirectives(r('если данных мало, сначала перечисли, чего не хватает'))).toBe(true);
    });
  });

  describe('hasStrictResponseDirectives', () => {
    it('returns false for empty directives', () => {
      expect(hasStrictResponseDirectives(r(''))).toBe(false);
    });

    it('returns false for tone-only directive (tone is NOT strict)', () => {
      expect(hasStrictResponseDirectives(r('formal tone please'))).toBe(false);
    });

    it('returns true for verbosity=concise because derived rule sets noOptionalExpansion (a strict field)', () => {
      expect(hasStrictResponseDirectives(r('be concise'))).toBe(true);
    });

    it('returns false for verbosity=detailed (no strict fields triggered)', () => {
      expect(hasStrictResponseDirectives(r('give me a detailed answer'))).toBe(false);
    });

    it('returns false for structure-only directive (structure is NOT strict)', () => {
      expect(hasStrictResponseDirectives(r('with sections'))).toBe(false);
    });

    it('returns true when language is set', () => {
      expect(hasStrictResponseDirectives(r('answer in russian'))).toBe(true);
    });

    it('returns true when shape is non-adaptive', () => {
      expect(hasStrictResponseDirectives(r('only definition'))).toBe(true);
    });

    it('returns true when singleSentence is set', () => {
      expect(hasStrictResponseDirectives(r('one sentence'))).toBe(true);
    });

    it('returns true when noExamples is set', () => {
      expect(hasStrictResponseDirectives(r('no examples'))).toBe(true);
    });

    it('returns true when maxTopLevelItems is set', () => {
      expect(hasStrictResponseDirectives(r('3 points max'))).toBe(true);
    });

    it('returns true when exactSections is set', () => {
      expect(hasStrictResponseDirectives(r('strict format: 1) a 2) b'))).toBe(true);
    });

    it('returns true when uncertaintyFirst is set', () => {
      expect(hasStrictResponseDirectives(r('если данных мало, сначала перечисли, чего не хватает'))).toBe(true);
    });
  });
});
