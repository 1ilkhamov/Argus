import { ResponseComplianceService } from './compliance.service';
import type { ResponseDirectives } from '../response-directives/response-directives.types';

describe('ResponseComplianceService', () => {
  const service = new ResponseComplianceService();

  it('flags a foreign-language lead when Russian prose was explicitly requested', () => {
    const directives: ResponseDirectives = {
      language: 'ru',
      verbosity: 'concise',
      shape: 'definition_only',
      hardLimits: {
        singleSentence: true,
        noExamples: true,
        noAdjacentFacts: true,
        noOptionalExpansion: true,
      },
    };

    const validation = service.validate(
      'Eventual consistency — это модель согласованности, при которой реплики со временем сходятся к одному состоянию.',
      directives,
    );

    expect(validation.compliant).toBe(false);
    expect(validation.violations).toEqual([
      {
        code: 'language',
        message: 'The response should primarily be in Russian prose.',
      },
    ]);
  });

  it('accepts a concise Russian definition-only answer when all hard rules are met', () => {
    const directives: ResponseDirectives = {
      language: 'ru',
      verbosity: 'concise',
      shape: 'definition_only',
      hardLimits: {
        singleSentence: true,
        noExamples: true,
        noAdjacentFacts: true,
        noOptionalExpansion: true,
      },
    };

    const validation = service.validate(
      'Это модель согласованности, при которой реплики могут временно различаться, но затем сходятся к одному состоянию.',
      directives,
    );

    expect(validation).toEqual({ compliant: true, violations: [] });
  });

  it('flags responses that violate an exact numbered structure', () => {
    const directives: ResponseDirectives = {
      shape: 'strict_sections',
      structure: 'structured',
      hardLimits: {
        maxTopLevelItems: 4,
        exactSections: [
          { index: 1, label: 'определение' },
          { index: 2, label: 'когда подходит' },
          { index: 3, label: 'когда опасно' },
          { index: 4, label: 'короткий вывод' },
        ],
      },
    };

    const validation = service.validate(
      '1) Определение\nOptimistic UI — это ...\n2) Когда подходит\n...\n4) Короткий вывод\n...',
      directives,
    );

    expect(validation.compliant).toBe(false);
    expect(validation.violations).toEqual([
      {
        code: 'exact_sections',
        message: 'The response does not follow the requested numbered section structure.',
      },
    ]);
  });

  it('flags prose wrappers when the response should contain only steps', () => {
    const directives: ResponseDirectives = {
      shape: 'steps_only',
      structure: 'structured',
      hardLimits: {
        noOptionalExpansion: true,
      },
    };

    const validation = service.validate(
      'Вот шаги:\n1. Проверить auth\n2. Проверить БД\n3. Проверить логи',
      directives,
    );

    expect(validation.compliant).toBe(false);
    expect(validation.violations).toEqual([
      {
        code: 'steps_only',
        message: 'The response must contain only steps without explanatory prose between them.',
      },
    ]);
  });

  it('requires uncertainty-first responses to start by naming missing information', () => {
    const directives: ResponseDirectives = {
      shape: 'adaptive',
      hardLimits: {
        uncertaintyFirst: true,
        noOptionalExpansion: true,
      },
    };

    const invalid = service.validate('Лучшей моделью, скорее всего, будет multilingual-e5-base.', directives);
    const valid = service.validate(
      'Мне не хватает данных о типе корпуса, языке запросов и latency budget, чтобы уверенно назвать лучшую модель.',
      directives,
    );

    expect(invalid.compliant).toBe(false);
    expect(invalid.violations).toEqual([
      {
        code: 'uncertainty_first',
        message: 'The response must start by naming the missing information or uncertainty before giving guidance.',
      },
    ]);
    expect(valid).toEqual({ compliant: true, violations: [] });
  });
});
