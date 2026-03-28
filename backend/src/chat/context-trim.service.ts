import { Injectable, Logger } from '@nestjs/common';

import { MemoryExtractorV2Service } from '../memory/capture/pipeline/memory-extractor-v2.service';
import { AutoCaptureService } from '../memory/capture/pipeline/auto-capture.service';
import { MemoryStoreService } from '../memory/core/memory-store.service';
import type { MemoryEntry } from '../memory/core/memory-entry.types';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';

// ─── Configuration ─────────────────────────────────────────────────────────

/** Trigger trim when message count exceeds this */
const TRIM_THRESHOLD = 40;

/** Keep this many recent messages after trim */
const KEEP_RECENT_COUNT = 16;

/** Jaccard overlap threshold: message considered "covered" if overlap >= this */
const COVERAGE_THRESHOLD = 0.5;

/** Max messages to extract from in a single sweep (LLM budget) */
const MAX_EXTRACT_BATCH = 8;

export interface TrimResult {
  trimmed: boolean;
  messagesRemoved: number;
  memoriesExtracted: number;
  summaryInjected: boolean;
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class ContextTrimService {
  private readonly logger = new Logger(ContextTrimService.name);

  constructor(
    private readonly extractor: MemoryExtractorV2Service,
    private readonly captureService: AutoCaptureService,
    private readonly store: MemoryStoreService,
  ) {}

  /**
   * Check if a conversation needs trimming and perform
   * smart extraction sweep before removing old messages.
   *
   * Returns a new Conversation with trimmed messages + injected summary,
   * or the original conversation if no trim was needed.
   */
  async trimIfNeeded(conversation: Conversation): Promise<{ conversation: Conversation; result: TrimResult }> {
    const messages = conversation.messages;
    const result: TrimResult = {
      trimmed: false,
      messagesRemoved: 0,
      memoriesExtracted: 0,
      summaryInjected: false,
    };

    if (messages.length <= TRIM_THRESHOLD) {
      return { conversation, result };
    }

    const removeCount = messages.length - KEEP_RECENT_COUNT;
    if (removeCount <= 0) {
      return { conversation, result };
    }

    const messagesToRemove = messages.slice(0, removeCount);
    const messagesToKeep = messages.slice(removeCount);

    this.logger.debug(
      `Trim sweep: ${messages.length} messages, removing ${removeCount}, keeping ${messagesToKeep.length}`,
    );

    // Step 1: Find uncovered messages (not already represented in memory)
    const uncoveredPairs = await this.findUncoveredPairs(messagesToRemove);

    // Step 2: Extract memories from uncovered pairs
    let extractedCount = 0;
    if (uncoveredPairs.length > 0) {
      const batch = uncoveredPairs.slice(0, MAX_EXTRACT_BATCH);
      for (const pair of batch) {
        try {
          const captureResult = await this.captureService.captureFromTurn(
            pair.userMessage,
            pair.assistantResponse,
            conversation.id,
            undefined,
            conversation.scopeKey,
          );
          extractedCount += captureResult.created.length;
        } catch (err) {
          this.logger.warn(`Trim extraction failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Step 3: Build summary of trimmed content
    const summary = this.buildTrimSummary(messagesToRemove, extractedCount);

    // Step 4: Construct new conversation with summary + kept messages
    const summaryMessage = new Message({
      conversationId: conversation.id,
      role: 'assistant',
      content: summary,
    });

    const newConversation = new Conversation({
      id: conversation.id,
      scopeKey: conversation.scopeKey,
      title: conversation.title,
      messages: [summaryMessage, ...messagesToKeep],
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });

    result.trimmed = true;
    result.messagesRemoved = removeCount;
    result.memoriesExtracted = extractedCount;
    result.summaryInjected = true;

    this.logger.debug(
      `Trim complete: removed=${removeCount}, extracted=${extractedCount}, uncovered=${uncoveredPairs.length}`,
    );

    return { conversation: newConversation, result };
  }

  // ─── Coverage check ────────────────────────────────────────────────────

  /**
   * Find user→assistant message pairs that aren't already covered by
   * existing memory entries. A pair is "covered" if its content has
   * high word overlap with at least one existing memory entry.
   */
  private async findUncoveredPairs(
    messages: readonly Message[],
  ): Promise<Array<{ userMessage: string; assistantResponse: string }>> {
    // Fetch existing memory entries for coverage check
    // Note: scopeKey not available here (messages don't carry it),
    // but the conversation is already scoped so coverage check is best-effort.
    const existingEntries = await this.store.query({
      excludeSuperseded: true,
      limit: 100,
    });

    const pairs: Array<{ userMessage: string; assistantResponse: string }> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role !== 'user') continue;

      // Find the next assistant message
      const nextMsg = messages[i + 1];
      if (!nextMsg || nextMsg.role !== 'assistant') continue;

      // Check if this pair is already covered
      const pairContent = `${msg.content} ${nextMsg.content}`;
      if (!this.isCovered(pairContent, existingEntries)) {
        pairs.push({
          userMessage: msg.content,
          assistantResponse: nextMsg.content,
        });
      }
    }

    return pairs;
  }

  /**
   * Check if message content is already represented in existing memory entries.
   * Uses word overlap: if any entry has >= COVERAGE_THRESHOLD Jaccard similarity
   * with the message content, it's considered covered.
   */
  private isCovered(content: string, entries: MemoryEntry[]): boolean {
    const normalizedContent = this.normalize(content);
    const contentWords = this.tokenize(normalizedContent);
    if (contentWords.size === 0) return true; // empty content is trivially covered

    for (const entry of entries) {
      const entryWords = this.tokenize(this.normalize(entry.content));
      const similarity = this.jaccardFromSets(contentWords, entryWords);
      if (similarity >= COVERAGE_THRESHOLD) return true;
    }

    return false;
  }

  // ─── Summary builder ───────────────────────────────────────────────────

  private buildTrimSummary(removedMessages: readonly Message[], extractedCount: number): string {
    const userMessages = removedMessages.filter((m) => m.role === 'user');
    const topics = this.extractTopics(userMessages);

    const parts = [
      `[Context summary: ${removedMessages.length} earlier messages trimmed.`,
    ];

    if (topics.length > 0) {
      parts.push(`Topics discussed: ${topics.join(', ')}.`);
    }

    if (extractedCount > 0) {
      parts.push(`${extractedCount} new memories extracted and saved before trim.`);
    }

    parts.push('Key facts and decisions are preserved in long-term memory.]');

    return parts.join(' ');
  }

  /**
   * Extract short topic descriptors from user messages for the summary.
   */
  private extractTopics(userMessages: Message[]): string[] {
    const topics: string[] = [];
    const maxTopics = 5;

    for (const msg of userMessages) {
      if (topics.length >= maxTopics) break;
      const trimmed = msg.content.trim();
      if (trimmed.length <= 50) {
        topics.push(trimmed);
      } else {
        topics.push(trimmed.slice(0, 47) + '...');
      }
    }

    return topics;
  }

  // ─── Text helpers ──────────────────────────────────────────────────────

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(text: string): Set<string> {
    return new Set(text.split(' ').filter((w) => w.length >= 2));
  }

  private jaccardFromSets(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }
}

// ─── Exported constants for testing ──────────────────────────────────────

export const _testing = {
  TRIM_THRESHOLD,
  KEEP_RECENT_COUNT,
  COVERAGE_THRESHOLD,
  MAX_EXTRACT_BATCH,
};
