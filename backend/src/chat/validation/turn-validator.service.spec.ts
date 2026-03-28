import type { ResponseComplianceResult, ResponseComplianceViolation } from '../../agent/response-compliance/compliance.service';
import { ResponseComplianceService } from '../../agent/response-compliance/compliance.service';
import type { ResponseDirectives } from '../../agent/response-directives/response-directives.types';
import { EMPTY_RESPONSE_DIRECTIVES } from '../../agent/response-directives/response-directives.types';
import type { LlmCompletionResult } from '../../llm/interfaces/llm.interface';
import { LlmService } from '../../llm/llm.service';
import {
  EMPTY_MEMORY_GROUNDING_CONTEXT,
  type MemoryGroundingContext,
} from '../../memory/grounding/grounding-policy';
import { TurnResponseValidatorService } from './turn-validator.service';

const compliantResult: ResponseComplianceResult = { compliant: true, violations: [] };

const createComplianceService = (overrides?: {
  validate?: ResponseComplianceResult | ResponseComplianceResult[];
  shouldUseBufferedCompletion?: boolean;
}) => {
  const validationQueue = Array.isArray(overrides?.validate) ? [...overrides.validate] : undefined;

  return {
    validate: jest.fn().mockImplementation(() => {
      if (validationQueue && validationQueue.length > 0) {
        return validationQueue.shift()!;
      }
      return overrides?.validate ?? compliantResult;
    }),
    shouldUseBufferedCompletion: jest.fn().mockReturnValue(overrides?.shouldUseBufferedCompletion ?? false),
    buildRetryInstruction: jest.fn().mockReturnValue('Rewrite the answer to fix compliance violations.'),
  } as unknown as ResponseComplianceService;
};

const createLlmService = (contents: string[] = ['assistant reply']) => {
  const queue = [...contents];
  return {
    complete: jest.fn().mockImplementation(async () => ({
      content: queue.shift() ?? 'fallback',
      model: 'test-model',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    } satisfies LlmCompletionResult)),
    stream: jest.fn(),
  } as unknown as LlmService;
};

const memoryQuestionGrounding: MemoryGroundingContext = {
  isMemoryQuestion: true,
  intent: 'name',
  evidenceStrength: 'none',
  archiveEvidenceCount: 0,
  recalledMemoryCount: 0,
  shouldUseUncertaintyFirst: true,
};

describe('TurnResponseValidatorService', () => {
  describe('validate', () => {
    it('returns compliant when both compliance and grounding pass', () => {
      const service = new TurnResponseValidatorService(
        createComplianceService(),
        createLlmService(),
      );

      const result = service.validate('Hello', EMPTY_RESPONSE_DIRECTIVES);

      expect(result.compliant).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('returns compliance violations when compliance fails', () => {
      const violation: ResponseComplianceViolation = {
        code: 'language',
        message: 'Response should be in Russian.',
      };
      const service = new TurnResponseValidatorService(
        createComplianceService({
          validate: { compliant: false, violations: [violation] },
        }),
        createLlmService(),
      );

      const result = service.validate('Hello', EMPTY_RESPONSE_DIRECTIVES);

      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toEqual({
        source: 'compliance',
        code: 'language',
        message: 'Response should be in Russian.',
      });
    });

    it('returns grounding violations for unsupported memory claims with no evidence', () => {
      const service = new TurnResponseValidatorService(
        createComplianceService(),
        createLlmService(),
      );

      const result = service.validate(
        'Тебя зовут Алекс.',
        EMPTY_RESPONSE_DIRECTIVES,
        memoryQuestionGrounding,
      );

      expect(result.compliant).toBe(false);
      expect(result.violations.some((v) => v.source === 'grounding' && v.code === 'missing_uncertainty_lead')).toBe(true);
      expect(result.violations.some((v) => v.source === 'grounding' && v.code === 'unsupported_memory_claim')).toBe(true);
    });

    it('merges compliance and grounding violations together', () => {
      const complianceViolation: ResponseComplianceViolation = {
        code: 'single_sentence',
        message: 'Must be a single sentence.',
      };
      const service = new TurnResponseValidatorService(
        createComplianceService({
          validate: { compliant: false, violations: [complianceViolation] },
        }),
        createLlmService(),
      );

      const result = service.validate(
        'Тебя зовут Алекс. Ты работаешь в Google.',
        EMPTY_RESPONSE_DIRECTIVES,
        memoryQuestionGrounding,
      );

      expect(result.compliant).toBe(false);
      const sources = result.violations.map((v) => v.source);
      expect(sources).toContain('compliance');
      expect(sources).toContain('grounding');
    });

    it('passes with grounding when response starts with uncertainty lead', () => {
      const service = new TurnResponseValidatorService(
        createComplianceService(),
        createLlmService(),
      );

      const result = service.validate(
        'Я не знаю точно — у меня недостаточно подтверждённой памяти.',
        EMPTY_RESPONSE_DIRECTIVES,
        memoryQuestionGrounding,
      );

      expect(result.compliant).toBe(true);
    });
  });

  describe('shouldUseBufferedCompletion', () => {
    it('returns true for memory questions', () => {
      const service = new TurnResponseValidatorService(
        createComplianceService(),
        createLlmService(),
      );

      expect(service.shouldUseBufferedCompletion(EMPTY_RESPONSE_DIRECTIVES, memoryQuestionGrounding)).toBe(true);
    });

    it('delegates to compliance service for non-memory questions', () => {
      const complianceService = createComplianceService({ shouldUseBufferedCompletion: true });
      const service = new TurnResponseValidatorService(complianceService, createLlmService());

      expect(service.shouldUseBufferedCompletion(EMPTY_RESPONSE_DIRECTIVES, EMPTY_MEMORY_GROUNDING_CONTEXT)).toBe(true);
      expect(complianceService.shouldUseBufferedCompletion).toHaveBeenCalledWith(EMPTY_RESPONSE_DIRECTIVES);
    });

    it('returns false when neither memory question nor strict directives', () => {
      const service = new TurnResponseValidatorService(
        createComplianceService({ shouldUseBufferedCompletion: false }),
        createLlmService(),
      );

      expect(service.shouldUseBufferedCompletion(EMPTY_RESPONSE_DIRECTIVES, EMPTY_MEMORY_GROUNDING_CONTEXT)).toBe(false);
    });
  });

  describe('completeWithValidation', () => {
    it('returns initial content when validation passes on first attempt', async () => {
      const service = new TurnResponseValidatorService(
        createComplianceService(),
        createLlmService(['Good response']),
      );

      const result = await service.completeWithValidation(
        [{ role: 'user', content: 'Hello' }],
        EMPTY_RESPONSE_DIRECTIVES,
      );

      expect(result).toBe('Good response');
    });

    it('retries with corrective instruction when initial validation fails', async () => {
      const violation: ResponseComplianceViolation = {
        code: 'language',
        message: 'Response should be in Russian.',
      };
      const llmService = createLlmService([
        'Bad English response',
        'Хороший русский ответ',
      ]);
      const complianceService = createComplianceService({
        validate: [
          { compliant: false, violations: [violation] },
          compliantResult,
        ],
      });
      const service = new TurnResponseValidatorService(complianceService, llmService);

      const result = await service.completeWithValidation(
        [{ role: 'user', content: 'Привет' }],
        { language: 'ru', hardLimits: {} } as ResponseDirectives,
      );

      expect(result).toBe('Хороший русский ответ');
      expect(llmService.complete).toHaveBeenCalledTimes(2);
      expect(complianceService.buildRetryInstruction).toHaveBeenCalledTimes(1);
    });

    it('returns retry content even when retry validation still fails', async () => {
      const violation: ResponseComplianceViolation = {
        code: 'language',
        message: 'Response should be in Russian.',
      };
      const llmService = createLlmService([
        'Bad English response',
        'Still bad English response',
      ]);
      const complianceService = createComplianceService({
        validate: [
          { compliant: false, violations: [violation] },
          { compliant: false, violations: [violation] },
        ],
      });
      const service = new TurnResponseValidatorService(complianceService, llmService);

      const result = await service.completeWithValidation(
        [{ role: 'user', content: 'Привет' }],
        { language: 'ru', hardLimits: {} } as ResponseDirectives,
      );

      expect(result).toBe('Still bad English response');
      expect(llmService.complete).toHaveBeenCalledTimes(2);
    });

    it('retries with grounding instruction for memory grounding violations', async () => {
      const llmService = createLlmService([
        'Тебя зовут Алекс.',
        'Я не знаю точно: у меня недостаточно подтверждённой памяти.',
      ]);
      const complianceService = createComplianceService({
        validate: [compliantResult, compliantResult],
      });
      const service = new TurnResponseValidatorService(complianceService, llmService);

      const result = await service.completeWithValidation(
        [{ role: 'user', content: 'Как меня зовут?' }],
        EMPTY_RESPONSE_DIRECTIVES,
        memoryQuestionGrounding,
      );

      expect(result).toBe('Я не знаю точно: у меня недостаточно подтверждённой памяти.');
      expect(llmService.complete).toHaveBeenCalledTimes(2);
      const retryMessages = (llmService.complete as jest.Mock).mock.calls[1][0];
      expect(retryMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'Тебя зовут Алекс.' }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('grounded memory evidence'),
          }),
        ]),
      );
    });

    it('includes both compliance and grounding retry instructions when both fail', async () => {
      const violation: ResponseComplianceViolation = {
        code: 'language',
        message: 'Response should be in Russian.',
      };
      const llmService = createLlmService([
        'Your name is Alex.',
        'Я не знаю точно.',
      ]);
      const complianceService = createComplianceService({
        validate: [
          { compliant: false, violations: [violation] },
          compliantResult,
        ],
      });
      const service = new TurnResponseValidatorService(complianceService, llmService);

      await service.completeWithValidation(
        [{ role: 'user', content: 'Как меня зовут?' }],
        { language: 'ru', hardLimits: {} } as ResponseDirectives,
        memoryQuestionGrounding,
      );

      expect(complianceService.buildRetryInstruction).toHaveBeenCalledTimes(1);
      const retryMessages = (llmService.complete as jest.Mock).mock.calls[1][0];
      const systemRetry = retryMessages.find((m: { role: string }) => m.role === 'system' && retryMessages.indexOf(m) > 0);
      expect(systemRetry.content).toContain('compliance violations');
      expect(systemRetry.content).toContain('grounded memory evidence');
    });
  });
});
