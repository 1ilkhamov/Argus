import { Injectable, Logger } from '@nestjs/common';

import { LlmService } from '../llm/llm.service';
import { TelegramClientMessagesRepository } from './telegram-client-messages.repository';
import type { TgStoredMessage, TgChatType, TgChatProfile } from './telegram-client.types';

export type { TgChatProfile };

/** How many new messages must accumulate before we rebuild the profile */
const REBUILD_THRESHOLD = 50;

/** Maximum messages to feed into the LLM for profiling */
const PROFILE_MESSAGES_LIMIT = 150;

/** Maximum owner examples to keep */
const MAX_OWNER_EXAMPLES = 15;

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class TelegramClientChatProfilerService {
  private readonly logger = new Logger(TelegramClientChatProfilerService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly messagesRepository: TelegramClientMessagesRepository,
  ) {}

  /**
   * Build or return cached profile for a chat.
   * Rebuilds if the profile is stale (many new messages since last profiling).
   */
  async getOrBuildProfile(
    chatId: string,
    chatType: TgChatType,
    ownerName: string,
  ): Promise<TgChatProfile | null> {
    const existing = await this.messagesRepository.getChatProfile(chatId);

    if (existing) {
      const currentCount = await this.messagesRepository.getMessageCount(chatId);
      const delta = currentCount - existing.totalMessages;

      if (delta < REBUILD_THRESHOLD) {
        return existing;
      }

      this.logger.debug(`Profile stale for ${chatId}: ${delta} new messages, rebuilding`);
    }

    return this.buildProfile(chatId, chatType, ownerName);
  }

  /**
   * Build a fresh profile by analyzing stored messages via LLM.
   */
  async buildProfile(
    chatId: string,
    chatType: TgChatType,
    ownerName: string,
  ): Promise<TgChatProfile | null> {
    const messages = await this.messagesRepository.getRecent(chatId, PROFILE_MESSAGES_LIMIT);
    if (messages.length < 5) {
      this.logger.debug(`Not enough messages (${messages.length}) for profiling chat ${chatId}`);
      return null;
    }

    const ownerMessages = messages.filter((m) => m.isOutgoing);
    if (ownerMessages.length < 3) {
      this.logger.debug(`Not enough owner messages (${ownerMessages.length}) for profiling chat ${chatId}`);
      return null;
    }

    try {
      const transcript = this.formatTranscript(messages, ownerName);
      const analysisPrompt = this.buildAnalysisPrompt(transcript, ownerName, chatType);

      const result = await this.llmService.complete(
        [
          { role: 'system', content: 'You are an analytical assistant. Respond ONLY with valid JSON, no markdown fences.' },
          { role: 'user', content: analysisPrompt },
        ],
        { temperature: 0.3, maxTokens: 2000 },
      );

      const parsed = this.parseProfileResponse(result.content, ownerMessages);

      const totalMessages = await this.messagesRepository.getMessageCount(chatId);
      const profile: TgChatProfile = {
        chatId,
        chatType,
        language: parsed.language || 'auto',
        ownerStyleSummary: parsed.styleSummary || '',
        ownerStyleExamples: parsed.examples || this.pickExamples(ownerMessages),
        chatTopicSummary: parsed.topicSummary || '',
        participantSummary: parsed.participantSummary || '',
        lastProfiledAt: new Date().toISOString(),
        totalMessages,
      };

      await this.messagesRepository.saveChatProfile(profile);
      this.logger.log(`Profile built for chat ${chatId}: ${ownerMessages.length} owner msgs analyzed`);

      return profile;
    } catch (err) {
      this.logger.error(`Profile build failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}`);

      // Fallback: heuristic profile without LLM
      return this.buildHeuristicProfile(chatId, chatType, ownerMessages, messages);
    }
  }

  // ─── Prompt ─────────────────────────────────────────────────────────────

  private buildAnalysisPrompt(transcript: string, ownerName: string, chatType: TgChatType): string {
    return `Analyze this Telegram ${chatType} chat transcript. Messages from "${ownerName}" are marked [OWNER].

TRANSCRIPT:
${transcript}

Analyze and return JSON:
{
  "language": "primary language used by the owner (e.g. 'ru', 'en')",
  "styleSummary": "Description of how ${ownerName} writes in this chat: message length (short/medium/long), tone (formal/casual/friendly/professional), punctuation style, emoji usage (none/rare/frequent), greeting patterns, any slang or characteristic phrases. 2-4 sentences max.",
  "examples": ["array of 10-15 most characteristic owner messages that best represent their writing style, verbatim quotes"],
  "topicSummary": "What this chat is typically about, 1-2 sentences",
  "participantSummary": "Who are the other participants, their apparent relationship with the owner, 1-2 sentences"
}`;
  }

  private formatTranscript(messages: TgStoredMessage[], ownerName: string): string {
    return messages
      .map((m) => {
        const label = m.isOutgoing ? `[OWNER] ${ownerName}` : m.senderName || 'Unknown';
        const time = m.timestamp.slice(0, 16).replace('T', ' ');
        return `[${time}] ${label}: ${m.text}`;
      })
      .join('\n');
  }

  // ─── Response parsing ──────────────────────────────────────────────────

  private parseProfileResponse(
    raw: string,
    ownerMessages: TgStoredMessage[],
  ): {
    language: string;
    styleSummary: string;
    examples: string[];
    topicSummary: string;
    participantSummary: string;
  } {
    try {
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```json?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        language: String(parsed.language || 'auto'),
        styleSummary: String(parsed.styleSummary || ''),
        examples: Array.isArray(parsed.examples)
          ? parsed.examples.slice(0, MAX_OWNER_EXAMPLES).map(String)
          : this.pickExamples(ownerMessages),
        topicSummary: String(parsed.topicSummary || ''),
        participantSummary: String(parsed.participantSummary || ''),
      };
    } catch {
      this.logger.warn('Failed to parse LLM profile response, using heuristic fallback');
      return {
        language: 'auto',
        styleSummary: '',
        examples: this.pickExamples(ownerMessages),
        topicSummary: '',
        participantSummary: '',
      };
    }
  }

  // ─── Heuristic fallback ────────────────────────────────────────────────

  private async buildHeuristicProfile(
    chatId: string,
    chatType: TgChatType,
    ownerMessages: TgStoredMessage[],
    allMessages: TgStoredMessage[],
  ): Promise<TgChatProfile> {
    const avgLength = ownerMessages.reduce((sum, m) => sum + m.text.length, 0) / ownerMessages.length;
    const hasEmoji = ownerMessages.some((m) => /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{2600}-\u{26FF}]/u.test(m.text));
    const lengthDesc = avgLength < 30 ? 'short' : avgLength < 100 ? 'medium' : 'long';

    const participants = new Set(allMessages.filter((m) => !m.isOutgoing).map((m) => m.senderName).filter(Boolean));

    const totalMessages = await this.messagesRepository.getMessageCount(chatId);

    const profile: TgChatProfile = {
      chatId,
      chatType,
      language: 'auto',
      ownerStyleSummary: `Writes ${lengthDesc} messages. ${hasEmoji ? 'Uses emoji.' : 'Rarely uses emoji.'}`,
      ownerStyleExamples: this.pickExamples(ownerMessages),
      chatTopicSummary: '',
      participantSummary: participants.size > 0 ? `Participants: ${[...participants].join(', ')}` : '',
      lastProfiledAt: new Date().toISOString(),
      totalMessages,
    };

    await this.messagesRepository.saveChatProfile(profile);
    return profile;
  }

  private pickExamples(ownerMessages: TgStoredMessage[]): string[] {
    // Pick diverse examples: varied lengths, from different parts of the history
    const sorted = [...ownerMessages].sort((a, b) => b.text.length - a.text.length);
    const result: string[] = [];
    const step = Math.max(1, Math.floor(sorted.length / MAX_OWNER_EXAMPLES));

    for (let i = 0; i < sorted.length && result.length < MAX_OWNER_EXAMPLES; i += step) {
      const text = sorted[i]!.text.trim();
      if (text.length > 0 && text.length < 500) {
        result.push(text);
      }
    }

    return result;
  }
}
