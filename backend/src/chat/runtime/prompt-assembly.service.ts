import { Injectable } from '@nestjs/common';

import { SystemPromptBuilder } from '../../agent/prompt/prompt.builder';
import type { SystemPromptSection } from '../../agent/prompt/prompt-section.types';
import type { LlmMessage } from '../../llm/interfaces/llm.interface';
import { TokenEstimatorService } from './token-estimator.service';
import type { PromptAssembly, PromptAssemblyInput, PromptAssemblyHistoryMessage } from './prompt-assembly.types';

@Injectable()
export class PromptAssemblyService {
  constructor(
    private readonly systemPromptBuilder: SystemPromptBuilder,
    private readonly tokenEstimator: TokenEstimatorService,
  ) {}

  assemble(input: PromptAssemblyInput, provider: string): PromptAssembly {
    const structured = this.systemPromptBuilder.buildStructured(input.mode, input.userProfile, {
      userProfileSource: input.userProfileSource,
      userFacts: input.userFacts,
      episodicMemories: input.episodicMemories,
      recalledMemories: input.recalledMemories,
      identityTraits: input.identityTraits,
      selfModelRaw: input.selfModelRaw,
      archiveEvidence: input.archiveEvidence,
      memoryGrounding: input.memoryGrounding,
      responseDirectives: input.responseDirectives,
    });

    const systemSections = structured.sections.map((section) => this.withEstimatedTokens(section, provider));
    if (input.extraSystemInstruction?.trim()) {
      systemSections.push(
        this.withEstimatedTokens(
          {
            id: 'extra_system_instruction',
            title: 'Extra System Instruction',
            priority: 'critical',
            trimPolicy: 'never',
            source: 'directive',
            content: input.extraSystemInstruction.trim(),
          },
          provider,
        ),
      );
    }

    const historyMessages = this.buildHistoryMessages(input.conversation.getMessageHistory(), provider);
    const estimatedSystemTokens = systemSections.reduce((sum, section) => sum + (section.estimatedTokens ?? 0), 0);
    const estimatedHistoryTokens = historyMessages.reduce((sum, item) => sum + item.estimatedTokens, 0);

    return {
      systemSections,
      historyMessages,
      estimatedSystemTokens,
      estimatedHistoryTokens,
      estimatedTotalTokens: estimatedSystemTokens + estimatedHistoryTokens,
    };
  }

  appendSystemSection(
    assembly: PromptAssembly,
    section: Omit<SystemPromptSection, 'estimatedTokens'>,
    provider: string,
  ): PromptAssembly {
    const nextSection = this.withEstimatedTokens(section, provider);
    const systemSections = [...assembly.systemSections, nextSection];
    const estimatedSystemTokens = systemSections.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);

    return {
      systemSections,
      historyMessages: [...assembly.historyMessages],
      estimatedSystemTokens,
      estimatedHistoryTokens: assembly.estimatedHistoryTokens,
      estimatedTotalTokens: estimatedSystemTokens + assembly.estimatedHistoryTokens,
    };
  }

  private buildHistoryMessages(
    history: Array<{ role: LlmMessage['role']; content: string }>,
    provider: string,
  ): PromptAssemblyHistoryMessage[] {
    return history.map((message, index, messages) => {
      const llmMessage: LlmMessage = { role: message.role, content: message.content };
      const isLast = index === messages.length - 1;
      const isPenultimateAssistant = index === messages.length - 2 && message.role === 'assistant';

      return {
        message: llmMessage,
        estimatedTokens: this.tokenEstimator.estimateMessageTokens(llmMessage, provider),
        locked: isLast || isPenultimateAssistant,
      };
    });
  }

  private withEstimatedTokens(section: SystemPromptSection, provider: string): SystemPromptSection {
    return {
      ...section,
      estimatedTokens: this.tokenEstimator.estimateTextTokens(section.content, provider),
    };
  }
}
