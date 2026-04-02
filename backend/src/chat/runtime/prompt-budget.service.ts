import { Injectable } from '@nestjs/common';

import type { SystemPromptSection } from '../../agent/prompt/prompt-section.types';
import type { LlmMessage } from '../../llm/interfaces/llm.interface';
import type { BudgetPromptInput, BudgetedPrompt, PromptAssemblyHistoryMessage } from './prompt-assembly.types';

const LOW_PRIORITY_SECTION_DROP_ORDER = ['archive_evidence', 'recalled_memory'] as const;
const COMPRESSIBLE_SECTION_ORDER = [
  'episodic_memory',
  'user_facts',
  'self_model',
  'identity_traits',
  'personality',
  'user_profile',
] as const;

@Injectable()
export class PromptBudgetService {
  budget(input: BudgetPromptInput): BudgetedPrompt {
    const reservedCompletionTokens = this.resolveReservedCompletionTokens(input);
    const reservedRetryTokens = this.resolveReservedRetryTokens(input, reservedCompletionTokens);
    const reservedToolRoundTokens = this.resolveReservedToolRoundTokens(input, reservedCompletionTokens);
    const reservedStructuredFinishTokens = this.resolveReservedStructuredFinishTokens(input, reservedCompletionTokens);
    const availablePromptTokens = Math.max(
      input.runtimeProfile.contextWindowTokens - reservedCompletionTokens - reservedRetryTokens - reservedToolRoundTokens - reservedStructuredFinishTokens,
      1024,
    );

    let systemSections = input.assembly.systemSections.map((section) => ({ ...section }));
    let historyMessages = input.assembly.historyMessages.map((item) => ({ ...item, message: { ...item.message } }));
    const trimmedSectionIds: string[] = [];
    const compressedSectionIds: string[] = [];
    let trimmedHistoryCount = 0;

    let currentTotal = this.totalTokens(systemSections, historyMessages);

    for (const sectionId of LOW_PRIORITY_SECTION_DROP_ORDER) {
      if (currentTotal <= availablePromptTokens) {
        break;
      }

      const nextSections = systemSections.filter((section) => section.id !== sectionId);
      if (nextSections.length !== systemSections.length) {
        systemSections = nextSections;
        trimmedSectionIds.push(sectionId);
        currentTotal = this.totalTokens(systemSections, historyMessages);
      }
    }

    if (currentTotal > availablePromptTokens) {
      const trimmedHistory = this.trimHistory(historyMessages, availablePromptTokens - this.sumSectionTokens(systemSections));
      historyMessages = trimmedHistory.historyMessages;
      trimmedHistoryCount = trimmedHistory.trimmedCount;
      currentTotal = this.totalTokens(systemSections, historyMessages);
    }

    for (const sectionId of COMPRESSIBLE_SECTION_ORDER) {
      if (currentTotal <= availablePromptTokens) {
        break;
      }

      const nextSections = systemSections.map((section) => {
        if (section.id !== sectionId || section.trimPolicy !== 'compress') {
          return section;
        }

        const compressed = this.compressSection(section);
        if (compressed.content === section.content) {
          return section;
        }

        if (!compressedSectionIds.includes(section.id)) {
          compressedSectionIds.push(section.id);
        }

        return compressed;
      });

      systemSections = nextSections;
      currentTotal = this.totalTokens(systemSections, historyMessages);
    }

    const systemMessage: LlmMessage = {
      role: 'system',
      content: systemSections.map((section) => section.content).join(' '),
    };

    const messages: LlmMessage[] = [systemMessage, ...historyMessages.map((item) => item.message)];
    const finalInputTokens = this.totalTokens(systemSections, historyMessages) + 6;

    return {
      messages,
      systemSections,
      historyMessages,
      completionOptions: {
        maxTokens: reservedCompletionTokens,
      },
      budget: {
        provider: input.runtimeProfile.provider,
        model: input.runtimeProfile.model,
        maxContextTokens: input.runtimeProfile.contextWindowTokens,
        reservedCompletionTokens,
        reservedRetryTokens,
        reservedToolRoundTokens,
        reservedStructuredFinishTokens,
        availablePromptTokens,
        estimatedInputTokens: input.assembly.estimatedTotalTokens,
        finalInputTokens,
        trimmedSectionIds,
        trimmedHistoryCount,
        compressedSectionIds,
        budgetPressure: this.resolveBudgetPressure(finalInputTokens, availablePromptTokens),
      },
    };
  }

  private resolveReservedCompletionTokens(input: BudgetPromptInput): number {
    const baseline = Math.min(input.runtimeProfile.maxCompletionTokens, 2048);
    if (input.toolsEnabled) {
      return Math.max(896, baseline);
    }

    if (input.needsBufferedCompletion) {
      return Math.max(768, baseline);
    }

    return Math.max(640, Math.min(baseline, 1536));
  }

  private resolveReservedRetryTokens(input: BudgetPromptInput, reservedCompletionTokens: number): number {
    if (!input.needsBufferedCompletion) {
      return 0;
    }

    return Math.max(256, Math.floor(reservedCompletionTokens * 0.45));
  }

  private resolveReservedToolRoundTokens(input: BudgetPromptInput, reservedCompletionTokens: number): number {
    if (!input.toolsEnabled) {
      return 0;
    }

    return Math.max(448, Math.min(1024, Math.floor(reservedCompletionTokens * 0.55)));
  }

  private resolveReservedStructuredFinishTokens(input: BudgetPromptInput, reservedCompletionTokens: number): number {
    if (input.needsBufferedCompletion) {
      return Math.max(224, Math.min(640, Math.floor(reservedCompletionTokens * 0.28)));
    }

    if (input.toolsEnabled) {
      return 192;
    }

    return 128;
  }

  private trimHistory(historyMessages: PromptAssemblyHistoryMessage[], availableHistoryTokens: number): {
    historyMessages: PromptAssemblyHistoryMessage[];
    trimmedCount: number;
  } {
    if (availableHistoryTokens <= 0) {
      const locked = historyMessages.filter((item) => item.locked);
      return { historyMessages: locked, trimmedCount: historyMessages.length - locked.length };
    }

    const working = [...historyMessages];
    let trimmedCount = 0;
    let total = working.reduce((sum, item) => sum + item.estimatedTokens, 0);

    for (let index = 0; index < working.length && total > availableHistoryTokens; index += 1) {
      if (working[index]?.locked) {
        continue;
      }

      total -= working[index]!.estimatedTokens;
      working.splice(index, 1);
      trimmedCount += 1;
      index -= 1;
    }

    return { historyMessages: working, trimmedCount };
  }

  private compressSection(section: SystemPromptSection): SystemPromptSection {
    const maxChars = this.resolveCompressedCharCap(section.id, section.priority);
    if (section.content.length <= maxChars) {
      return section;
    }

    const compressedContent = `${section.content.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    return {
      ...section,
      content: compressedContent,
      estimatedTokens: Math.max(8, Math.ceil((section.estimatedTokens ?? 0) * 0.65)),
    };
  }

  private resolveCompressedCharCap(sectionId: string, priority: SystemPromptSection['priority']): number {
    if (sectionId === 'episodic_memory') {
      return 420;
    }
    if (sectionId === 'user_facts') {
      return 320;
    }
    if (priority === 'high') {
      return 360;
    }
    return 280;
  }

  private totalTokens(systemSections: SystemPromptSection[], historyMessages: PromptAssemblyHistoryMessage[]): number {
    return this.sumSectionTokens(systemSections) + historyMessages.reduce((sum, item) => sum + item.estimatedTokens, 0);
  }

  private sumSectionTokens(systemSections: SystemPromptSection[]): number {
    return systemSections.reduce((sum, section) => sum + (section.estimatedTokens ?? 0), 0);
  }

  private resolveBudgetPressure(finalInputTokens: number, availablePromptTokens: number): 'low' | 'medium' | 'high' {
    if (availablePromptTokens <= 0) {
      return 'high';
    }

    const ratio = finalInputTokens / availablePromptTokens;
    if (ratio >= 0.9) {
      return 'high';
    }
    if (ratio >= 0.72) {
      return 'medium';
    }
    return 'low';
  }
}
