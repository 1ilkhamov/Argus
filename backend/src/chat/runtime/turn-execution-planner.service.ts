import { Injectable } from '@nestjs/common';

import type { LlmRuntimeProfile } from '../../llm/llm-runtime.types';
import { TokenEstimatorService } from './token-estimator.service';
import type { BudgetedPrompt, PromptAssembly, TurnExecutionPlan } from './prompt-assembly.types';
import type { TurnExecutionState } from './turn-execution-state.types';

interface PlanTurnInput {
  content: string;
  assembly: PromptAssembly;
  budgetedPrompt: BudgetedPrompt;
  runtimeProfile: LlmRuntimeProfile;
  activeCheckpoint?: TurnExecutionState;
}

@Injectable()
export class TurnExecutionPlannerService {
  constructor(private readonly tokenEstimator: TokenEstimatorService) {}

  planTurn(input: PlanTurnInput): TurnExecutionPlan {
    const trimmedContent = input.content.trim();
    const activeCheckpoint = this.shouldResumeFromCheckpoint(trimmedContent, input.activeCheckpoint)
      ? input.activeCheckpoint
      : undefined;

    if (activeCheckpoint) {
      return {
        mode: 'staged',
        reasonCodes: ['resume_checkpoint'],
        shouldResumeFromCheckpoint: true,
        workingSummary: activeCheckpoint.workingSummary,
        remainingSteps: activeCheckpoint.remainingSteps,
        executionInstruction: this.buildResumeInstruction(activeCheckpoint),
        checkpoint: activeCheckpoint,
      };
    }

    const contentTokens = this.tokenEstimator.estimateTextTokens(trimmedContent, input.runtimeProfile.provider);
    const reasonCodes: string[] = [];

    if (this.looksMultiStep(trimmedContent)) {
      reasonCodes.push('multi_step_request');
    }
    if (contentTokens >= 320) {
      reasonCodes.push('large_user_payload');
    }
    if (input.assembly.historyMessages.length >= 18) {
      reasonCodes.push('long_history');
    }
    if (input.budgetedPrompt.budget.budgetPressure === 'high') {
      reasonCodes.push('high_budget_pressure');
    }
    if (
      input.budgetedPrompt.budget.trimmedSectionIds.length > 0 ||
      input.budgetedPrompt.budget.trimmedHistoryCount > 0 ||
      input.budgetedPrompt.budget.compressedSectionIds.length > 1
    ) {
      reasonCodes.push('aggressive_budgeting');
    }

    const shouldStage =
      reasonCodes.includes('high_budget_pressure') ||
      reasonCodes.includes('aggressive_budgeting') ||
      (reasonCodes.includes('multi_step_request') && (contentTokens >= 180 || input.assembly.historyMessages.length >= 10)) ||
      (reasonCodes.includes('large_user_payload') && input.assembly.estimatedTotalTokens >= input.runtimeProfile.contextWindowTokens * 0.45);

    if (!shouldStage) {
      return {
        mode: 'standard',
        reasonCodes,
        shouldResumeFromCheckpoint: false,
      };
    }

    const remainingSteps = this.extractRemainingSteps(trimmedContent);
    const workingSummary = this.buildWorkingSummary(trimmedContent, remainingSteps);

    return {
      mode: 'staged',
      reasonCodes,
      shouldResumeFromCheckpoint: false,
      workingSummary,
      remainingSteps,
      executionInstruction: this.buildExecutionInstruction(workingSummary, remainingSteps),
    };
  }

  private shouldResumeFromCheckpoint(content: string, checkpoint?: TurnExecutionState): checkpoint is TurnExecutionState {
    if (!checkpoint || checkpoint.status !== 'active') {
      return false;
    }

    if (Date.parse(checkpoint.expiresAt) <= Date.now()) {
      return false;
    }

    return /^(continue|resume|продолж|дальше|go on|carry on)\b/i.test(content);
  }

  private looksMultiStep(content: string): boolean {
    return /\n\s*(?:[-*]|\d+[.)])\s+/.test(content) || /(сделай|реализуй|построй|design|implement|plan|refactor).*(и|then|and).*(и|then|and)/i.test(content);
  }

  private extractRemainingSteps(content: string): string[] {
    const bulletMatches = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(?:[-*]|\d+[.)])\s+/.test(line))
      .map((line) => line.replace(/^(?:[-*]|\d+[.)])\s+/, '').trim())
      .filter((line) => line.length > 0);

    if (bulletMatches.length > 0) {
      return bulletMatches.slice(0, 8);
    }

    const sentenceChunks = content
      .split(/[.!?]\s+/)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length >= 20)
      .slice(0, 5);

    if (sentenceChunks.length > 0) {
      return sentenceChunks;
    }

    return [content.slice(0, 240)];
  }

  private buildWorkingSummary(content: string, remainingSteps: string[]): string {
    const head = content.replace(/\s+/g, ' ').trim();
    const intro = head.length > 360 ? `${head.slice(0, 359)}…` : head;
    return `User requested a large-task flow. Core request: ${intro} Remaining execution focus: ${remainingSteps.join(' | ')}`;
  }

  private buildExecutionInstruction(workingSummary: string, remainingSteps: string[]): string {
    const steps = remainingSteps.map((step, index) => `${index + 1}. ${step}`).join(' ');
    return [
      'This turn is running in staged execution mode.',
      `Working summary: ${workingSummary}`,
      `Execute the remaining steps in order: ${steps}`,
      'Produce a focused partial-complete answer that clearly states progress and does not lose track of remaining work.',
    ].join(' ');
  }

  private buildResumeInstruction(checkpoint: TurnExecutionState): string {
    const steps = checkpoint.remainingSteps.map((step, index) => `${index + 1}. ${step}`).join(' ');
    return [
      'Resume the previously checkpointed staged task.',
      `Working summary: ${checkpoint.workingSummary}`,
      checkpoint.partialResponse ? `Partial progress already produced: ${checkpoint.partialResponse}` : '',
      `Continue from phase=${checkpoint.phase}. Remaining steps: ${steps}`,
      'Do not restart the task from scratch. Continue from the saved execution state and finish the remaining work.',
    ]
      .filter((part) => part.length > 0)
      .join(' ');
  }
}
