import { Injectable, Logger } from '@nestjs/common';

import { ResponseComplianceService } from '../../agent/response-compliance/compliance.service';
import type { ResponseComplianceViolation } from '../../agent/response-compliance/compliance.service';
import type { ResponseDirectives } from '../../agent/response-directives/response-directives.types';
import {
  buildMemoryGroundingRetryInstruction,
  EMPTY_MEMORY_GROUNDING_CONTEXT,
  type MemoryGroundingContext,
  type MemoryGroundingViolation,
  validateMemoryGroundingResponse,
} from '../../memory/grounding/grounding-policy';
import { LlmService } from '../../llm/llm.service';
import type { LlmCompletionOptions, LlmMessage } from '../../llm/interfaces/llm.interface';

export interface TurnValidationViolation {
  source: 'compliance' | 'grounding';
  code: string;
  message: string;
}

export interface TurnValidationResult {
  compliant: boolean;
  violations: TurnValidationViolation[];
}

/**
 * Unified turn-level response validator.
 *
 * Combines response compliance checks (language, format, structure) and
 * memory-grounding checks (uncertainty-first, unsupported claims) into a
 * single entry point with one retry cycle.
 */
@Injectable()
export class TurnResponseValidatorService {
  private readonly logger = new Logger(TurnResponseValidatorService.name);

  constructor(
    private readonly responseComplianceService: ResponseComplianceService,
    private readonly llmService: LlmService,
  ) {}

  validate(
    content: string,
    responseDirectives: ResponseDirectives,
    memoryGrounding: MemoryGroundingContext = EMPTY_MEMORY_GROUNDING_CONTEXT,
  ): TurnValidationResult {
    const complianceResult = this.responseComplianceService.validate(content, responseDirectives);
    const groundingResult = validateMemoryGroundingResponse(content, memoryGrounding);

    if (complianceResult.compliant && groundingResult.compliant) {
      return { compliant: true, violations: [] };
    }

    return {
      compliant: false,
      violations: [
        ...complianceResult.violations.map((v: ResponseComplianceViolation) => ({
          source: 'compliance' as const,
          code: v.code,
          message: v.message,
        })),
        ...groundingResult.violations.map((v: MemoryGroundingViolation) => ({
          source: 'grounding' as const,
          code: v.code,
          message: v.message,
        })),
      ],
    };
  }

  shouldUseBufferedCompletion(
    responseDirectives: ResponseDirectives,
    memoryGrounding: MemoryGroundingContext,
  ): boolean {
    return memoryGrounding.isMemoryQuestion || this.responseComplianceService.shouldUseBufferedCompletion(responseDirectives);
  }

  async completeWithValidation(
    messages: LlmMessage[],
    responseDirectives: ResponseDirectives,
    memoryGrounding: MemoryGroundingContext = EMPTY_MEMORY_GROUNDING_CONTEXT,
    completionOptions?: LlmCompletionOptions,
  ): Promise<string> {
    const initialResult = await this.llmService.complete(messages, completionOptions);
    return this.validateDraftWithRetry(messages, initialResult.content, responseDirectives, memoryGrounding, completionOptions);
  }

  async validateDraftWithRetry(
    messages: LlmMessage[],
    draft: string,
    responseDirectives: ResponseDirectives,
    memoryGrounding: MemoryGroundingContext = EMPTY_MEMORY_GROUNDING_CONTEXT,
    completionOptions?: LlmCompletionOptions,
  ): Promise<string> {
    const initialValidation = this.validate(draft, responseDirectives, memoryGrounding);

    if (initialValidation.compliant) {
      return draft;
    }

    this.logger.warn(
      `Response compliance retry triggered: violations=${initialValidation.violations.map((v) => v.code).join(',')}`,
    );

    const retryInstruction = this.buildRetryInstruction(responseDirectives, memoryGrounding, initialValidation.violations);
    const retryMessages: LlmMessage[] = [
      ...messages,
      { role: 'assistant', content: draft },
      { role: 'system', content: retryInstruction },
    ];

    const retryResult = await this.llmService.complete(retryMessages, completionOptions);
    const retryValidation = this.validate(retryResult.content, responseDirectives, memoryGrounding);

    if (!retryValidation.compliant) {
      this.logger.warn(
        `Response compliance retry still failed: violations=${retryValidation.violations.map((v) => v.code).join(',')}`,
      );
    }

    return retryResult.content;
  }

  private buildRetryInstruction(
    responseDirectives: ResponseDirectives,
    memoryGrounding: MemoryGroundingContext,
    violations: TurnValidationViolation[],
  ): string {
    const complianceViolations = violations
      .filter((v) => v.source === 'compliance')
      .map((v) => ({ code: v.code, message: v.message }) as ResponseComplianceViolation);
    const groundingViolations = violations
      .filter((v) => v.source === 'grounding')
      .map((v) => ({ code: v.code, message: v.message }) as MemoryGroundingViolation);

    const parts = [
      complianceViolations.length > 0
        ? this.responseComplianceService.buildRetryInstruction(responseDirectives, complianceViolations)
        : '',
      groundingViolations.length > 0
        ? buildMemoryGroundingRetryInstruction(memoryGrounding, groundingViolations)
        : '',
    ].filter((part) => part.length > 0);

    return parts.join(' ');
  }
}
