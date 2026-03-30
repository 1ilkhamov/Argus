import { ResponseDirectivesService } from './response-directives.service';

describe('ResponseDirectivesService', () => {
  const service = new ResponseDirectivesService();

  it('extracts explicit language, concise definition-only shape, and hard no-expansion limits', () => {
    const directives = service.resolve(
      'Please answer in Russian: what is eventual consistency? Keep it concise. Only definition, without examples.',
    );

    expect(directives).toEqual({
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

  it('extracts exact numbered sections from a strict format request', () => {
    const directives = service.resolve(
      'Объясни, когда использовать optimistic UI. Формат строго такой: 1) определение 2) когда подходит 3) когда опасно 4) короткий вывод.',
    );

    expect(directives.shape).toBe('strict_sections');
    expect(directives.structure).toBe('structured');
    expect(directives.hardLimits.maxTopLevelItems).toBe(4);
    expect(directives.hardLimits.exactSections).toEqual([
      { index: 1, label: 'определение' },
      { index: 2, label: 'когда подходит' },
      { index: 3, label: 'когда опасно' },
      { index: 4, label: 'короткий вывод' },
    ]);
  });

  it('extracts steps-only shape and max top-level items from an execution-focused request', () => {
    const directives = service.resolve('Мне нужен конкретный план: только шаги, 4 пункта максимум, без воды.');

    expect(directives.verbosity).toBe('concise');
    expect(directives.shape).toBe('steps_only');
    expect(directives.structure).toBe('structured');
    expect(directives.hardLimits.maxTopLevelItems).toBe(4);
    expect(directives.hardLimits.noOptionalExpansion).toBe(true);
  });

  it('extracts uncertainty-first handling when the user asks to name missing information before answering', () => {
    const directives = service.resolve(
      'Какой лучший embedding model для моего проекта? Не выдумывай: если данных мало, сначала перечисли, чего тебе не хватает для уверенного ответа.',
    );

    expect(directives.hardLimits.uncertaintyFirst).toBe(true);
    expect(directives.hardLimits.noOptionalExpansion).toBe(true);
  });
});
