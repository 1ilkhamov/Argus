import { Injectable } from '@nestjs/common';

import { Conversation } from '../../chat/entities/conversation.entity';
import { ModeClassifier } from './mode-classifier';
import { DEFAULT_AGENT_MODE } from './mode-registry';
import type { AgentModeId } from './mode.types';

const RECENT_MODE_WINDOW = 6;
const MIN_CONFIDENT_MODE_SCORE = 2;
const CONTINUATION_MESSAGE_MAX_LENGTH = 40;
const CONTINUATION_MESSAGE_MAX_WORDS = 4;

const CONTINUATION_PATTERNS = [
  /^(ok|okay|yes|yep|continue|go on|next|carry on|keep going|sounds good|got it)[.!?]*$/i,
  /^(ок|окей|да|ага|угу|дальше|продолжай|продолжим|давай дальше|идем дальше|хорошо|понял)[.!?]*$/i,
];

@Injectable()
export class ModeSelector {
  constructor(private readonly modeClassifier: ModeClassifier) {}

  selectMode(conversation: Conversation): AgentModeId {
    const recentUserMessages = this.getRecentUserMessages(conversation);

    if (recentUserMessages.length === 0) {
      return DEFAULT_AGENT_MODE;
    }

    const [latestMessage, ...previousMessages] = recentUserMessages;
    if (!latestMessage) {
      return DEFAULT_AGENT_MODE;
    }

    const latestTopMatch = this.modeClassifier.classify(latestMessage);
    if (latestTopMatch.score >= MIN_CONFIDENT_MODE_SCORE) {
      return latestTopMatch.mode;
    }

    if (this.isLikelyContinuationMessage(latestMessage)) {
      for (const content of previousMessages) {
        const previousTopMatch = this.modeClassifier.classify(content);
        if (previousTopMatch.score >= MIN_CONFIDENT_MODE_SCORE) {
          return previousTopMatch.mode;
        }
      }
    }

    return DEFAULT_AGENT_MODE;
  }

  private getRecentUserMessages(conversation: Conversation): string[] {
    return [...conversation.messages]
      .reverse()
      .filter((message) => message.role === 'user')
      .map((message) => message.content.trim())
      .filter((content) => content.length > 0)
      .slice(0, RECENT_MODE_WINDOW);
  }

  private isLikelyContinuationMessage(content: string): boolean {
    if (CONTINUATION_PATTERNS.some((pattern) => pattern.test(content))) {
      return true;
    }

    const words = content.split(/\s+/).filter(Boolean);
    return content.length <= CONTINUATION_MESSAGE_MAX_LENGTH && words.length <= CONTINUATION_MESSAGE_MAX_WORDS;
  }
}
