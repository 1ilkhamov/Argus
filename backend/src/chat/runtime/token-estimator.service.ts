import { Injectable } from '@nestjs/common';

import { getTextContent, type LlmMessage } from '../../llm/interfaces/llm.interface';

@Injectable()
export class TokenEstimatorService {
  estimateTextTokens(content: string, provider = 'openai'): number {
    if (!content.trim()) {
      return 0;
    }

    const charsPerToken = this.resolveCharsPerToken(provider);
    const base = Math.ceil(content.length / charsPerToken);
    const newlinePenalty = (content.match(/\n/g) ?? []).length;
    const punctuationPenalty = Math.ceil((content.match(/[,:;()[\]{}]/g) ?? []).length / 6);
    const longWordPenalty = Math.ceil(
      content
        .split(/\s+/)
        .filter((token) => token.length >= 12).length / 10,
    );

    const bulletPenalty = Math.ceil((content.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length * 1.5);
    const codeFencePenalty = (content.match(/```/g) ?? []).length * 6;
    const quotedLinePenalty = Math.ceil((content.match(/^\s*>/gm) ?? []).length * 1.5);
    const jsonLikePenalty = Math.ceil((content.match(/[{}\[\]"]/g) ?? []).length / 5);
    const nonAsciiPenalty = Math.ceil((content.match(/[^\x00-\x7F]/g) ?? []).length / 12);
    const subtotal =
      base +
      newlinePenalty +
      punctuationPenalty +
      longWordPenalty +
      bulletPenalty +
      codeFencePenalty +
      quotedLinePenalty +
      jsonLikePenalty +
      nonAsciiPenalty +
      6;

    return Math.max(1, Math.ceil(subtotal * this.resolveSafetyMultiplier(provider)));
  }

  estimateMessageTokens(message: LlmMessage, provider = 'openai'): number {
    const roleOverhead = message.role === 'system' ? 18 : message.role === 'tool' ? 16 : 10;
    return this.estimateTextTokens(getTextContent(message.content), provider) + roleOverhead;
  }

  private resolveCharsPerToken(provider: string): number {
    switch (provider) {
      case 'anthropic':
        return 3.3;
      case 'google':
        return 3.5;
      case 'local':
        return 3.0;
      default:
        return 3.2;
    }
  }

  private resolveSafetyMultiplier(provider: string): number {
    switch (provider) {
      case 'anthropic':
        return 1.08;
      case 'google':
        return 1.06;
      case 'local':
        return 1.12;
      default:
        return 1.1;
    }
  }
}
