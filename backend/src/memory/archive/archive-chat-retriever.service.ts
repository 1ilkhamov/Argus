import { Inject, Injectable, Optional } from '@nestjs/common';

import { Conversation } from '../../chat/entities/conversation.entity';
import { CHAT_REPOSITORY, ChatRepository } from '../../chat/repositories/chat.repository';
import { EmbeddingService } from '../../embedding/embedding.service';
import { cosineSimilarity } from '../../embedding/vector-search.functions';
import type { ArchivedChatEvidenceItem, ArchivedChatMessageHit } from './archive-chat-retrieval.types';

type SuppressedMemoryFact = { key: string; value: string };

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'my',
  'our',
  'is',
  'are',
  'me',
  'you',
  'i',
  'we',
  'что',
  'это',
  'как',
  'мой',
  'моя',
  'мою',
  'мои',
  'мне',
  'наш',
  'наша',
  'и',
  'или',
  'не',
  'по',
  'для',
  'про',
]);

const MAX_TOKENS = 12;
const MAX_EXCERPT_LENGTH = 240;
const RECENT_CONVERSATION_WINDOW = 6;
const RECENT_RECALL_FALLBACK_CONVERSATIONS = 8;
const RECENT_RECALL_FALLBACK_MESSAGES_PER_CONVERSATION = 4;

function isEvidenceHit(hit: ArchivedChatMessageHit): hit is ArchivedChatMessageHit & { role: 'user' | 'assistant' } {
  return hit.role === 'user' || hit.role === 'assistant';
}

const SEMANTIC_RERANK_CANDIDATES = 20;
const SEMANTIC_RERANK_WEIGHT = 0.4;
const KEYWORD_SCORE_WEIGHT = 0.6;

@Injectable()
export class ArchiveChatRetrieverService {
  constructor(
    @Inject(CHAT_REPOSITORY) private readonly chatRepository: ChatRepository,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {}

  async retrieveEvidence(
    conversation: Conversation,
    options: { limit?: number; suppressedFacts?: SuppressedMemoryFact[] } = {},
  ): Promise<ArchivedChatEvidenceItem[]> {
    const limit = options.limit ?? 6;
    const suppressedFacts = options.suppressedFacts ?? [];
    const memorySummaryQuery = this.isMemorySummaryQuery(conversation);
    const tokens = this.buildQueryTokens(conversation);
    if (tokens.length === 0 && !memorySummaryQuery) {
      return [];
    }

    const hits =
      tokens.length > 0
        ? await this.chatRepository.searchArchivedChatMessages({
            scopeKey: conversation.scopeKey,
            tokens,
            excludeConversationId: conversation.id,
            limit: Math.max(limit * 3, limit),
          })
        : [];

    let ranked = this.rankAndFormatHits(
      tokens,
      hits.filter((hit) => hit.conversationId !== conversation.id),
      suppressedFacts,
      memorySummaryQuery,
    );

    if (memorySummaryQuery && ranked.length < limit) {
      const fallbackEvidence = await this.buildRecentRecallFallbackEvidence(conversation, suppressedFacts, limit);
      ranked = this.mergeEvidence(ranked, fallbackEvidence);
    }

    if (this.embeddingService?.isAvailable() && ranked.length > limit && tokens.length > 0) {
      const query = this.buildQueryText(conversation);
      return this.rerankWithEmbeddings(query, ranked, limit);
    }

    return ranked.slice(0, limit);
  }

  private async buildRecentRecallFallbackEvidence(
    conversation: Conversation,
    suppressedFacts: SuppressedMemoryFact[],
    limit: number,
  ): Promise<ArchivedChatEvidenceItem[]> {
    if (typeof this.chatRepository.getAllConversations !== 'function') {
      return [];
    }

    const conversations = await this.chatRepository.getAllConversations(conversation.scopeKey);
    const hits: ArchivedChatMessageHit[] = conversations
      .filter((candidate) => candidate.id !== conversation.id)
      .sort((left, right) => right.updatedAt.toISOString().localeCompare(left.updatedAt.toISOString()))
      .slice(0, Math.max(limit * 2, RECENT_RECALL_FALLBACK_CONVERSATIONS))
      .flatMap((candidateConversation) =>
        candidateConversation.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-RECENT_RECALL_FALLBACK_MESSAGES_PER_CONVERSATION)
          .map((message) => ({
            conversationId: candidateConversation.id,
            messageId: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt.toISOString(),
            conversationUpdatedAt: candidateConversation.updatedAt.toISOString(),
            matchCount: this.getRecallFallbackMatchCount(message.role, message.content),
          }))
          .filter((hit) => hit.matchCount > 0),
      );

    return this.rankAndFormatHits([], hits, suppressedFacts, true).slice(0, limit);
  }

  private mergeEvidence(
    primary: ArchivedChatEvidenceItem[],
    fallback: ArchivedChatEvidenceItem[],
  ): ArchivedChatEvidenceItem[] {
    return [...primary, ...fallback]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.createdAt.localeCompare(left.createdAt);
      })
      .filter((item, index, items) =>
        items.findIndex((candidate) => candidate.conversationId === item.conversationId && candidate.messageId === item.messageId) ===
        index,
      );
  }

  private buildQueryText(conversation: Conversation): string {
    const userMessages = conversation.messages.filter((m) => m.role === 'user');
    return userMessages.slice(-2).map((m) => m.content).join(' ').slice(0, 500);
  }

  private async rerankWithEmbeddings(
    query: string,
    candidates: ArchivedChatEvidenceItem[],
    limit: number,
  ): Promise<ArchivedChatEvidenceItem[]> {
    try {
      const topCandidates = candidates.slice(0, SEMANTIC_RERANK_CANDIDATES);
      const queryResult = await this.embeddingService!.embed(query);
      if (!queryResult) {
        return candidates.slice(0, limit);
      }

      const excerpts = topCandidates.map((c) => c.excerpt);
      const batchResult = await this.embeddingService!.embedBatch(excerpts);
      if (!batchResult) {
        return candidates.slice(0, limit);
      }

      const maxKeywordScore = Math.max(...topCandidates.map((c) => c.score), 1);

      const reranked = topCandidates.map((candidate, i) => {
        const semanticScore = cosineSimilarity(queryResult.embedding, batchResult.embeddings[i]!);
        const normalizedKeyword = candidate.score / maxKeywordScore;
        const hybridScore =
          KEYWORD_SCORE_WEIGHT * normalizedKeyword +
          SEMANTIC_RERANK_WEIGHT * Math.max(0, semanticScore);
        return { ...candidate, score: hybridScore };
      });

      reranked.sort((a, b) => b.score - a.score);

      return reranked.slice(0, limit);
    } catch {
      return candidates.slice(0, limit);
    }
  }

  private buildQueryTokens(conversation: Conversation): string[] {
    const userMessages = conversation.messages.filter((message) => message.role === 'user');
    const window = userMessages.slice(-RECENT_CONVERSATION_WINDOW);
    const latestMessage = window[window.length - 1]?.content ?? '';
    const priorContext = window.slice(0, -1).map((message) => message.content).join(' ');

    return this.mergeQueryTokens([
      ...this.extractPriorityTokens(latestMessage),
      ...Array.from(this.tokenize(latestMessage)),
      ...this.extractPriorityTokens(priorContext),
      ...Array.from(this.tokenize(priorContext)),
    ]);
  }

  private mergeQueryTokens(tokens: string[]): string[] {
    return Array.from(
      new Set(
        tokens
          .map((token) => token.toLocaleLowerCase().trim())
          .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
      ),
    ).slice(0, MAX_TOKENS);
  }

  private extractPriorityTokens(value: string): string[] {
    if (!value.trim()) {
      return [];
    }

    const quotedTokens = Array.from(value.matchAll(/[`"“”']([^`"“”']{2,80})[`"“”']/gu)).flatMap((match) =>
      match[1] ? Array.from(this.tokenize(match[1])) : [],
    );
    const compoundTokens = Array.from(value.matchAll(/\b[\p{L}\p{N}_]+(?:[-/][\p{L}\p{N}_]+)+\b/gu)).flatMap((match) =>
      Array.from(this.tokenize(match[0])),
    );

    return this.mergeQueryTokens([...quotedTokens, ...compoundTokens]);
  }

  private rankAndFormatHits(
    tokens: string[],
    hits: ArchivedChatMessageHit[],
    suppressedFacts: SuppressedMemoryFact[] = [],
    suppressGenericRecallHits = false,
  ): ArchivedChatEvidenceItem[] {
    const now = Date.now();
    const normalizedTokens = tokens.map((token) => token.toLocaleLowerCase());
    const normalizedSuppressedValues = suppressedFacts
      .map((suppressedFact) => this.normalizeForSuppression(suppressedFact.value))
      .filter((value) => value.length > 0);

    const evidence = hits
      .filter((hit) => isEvidenceHit(hit))
      .filter((hit) => !this.hitContainsSuppressedValue(hit, normalizedSuppressedValues))
      .filter((hit) => !(suppressGenericRecallHits && this.isGenericRecallPrompt(hit.content)))
      .map((hit) => {
        const score = this.scoreHit(hit, normalizedTokens, now);
        return {
          conversationId: hit.conversationId,
          messageId: hit.messageId,
          createdAt: hit.createdAt,
          role: hit.role,
          excerpt: this.buildExcerpt(hit.content, normalizedTokens),
          score,
        } satisfies ArchivedChatEvidenceItem;
      })
      .filter((item) => item.excerpt.length > 0);

    return evidence
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.createdAt.localeCompare(left.createdAt);
      })
      .filter((item, index, items) =>
        items.findIndex((candidate) => candidate.conversationId === item.conversationId && candidate.messageId === item.messageId) ===
        index,
      );
  }

  private scoreHit(hit: ArchivedChatMessageHit, tokens: string[], nowMs: number): number {
    const createdAtMs = new Date(hit.createdAt).getTime();
    const recencyDays = Math.max(0, (nowMs - createdAtMs) / (1000 * 60 * 60 * 24));
    const recencyBoost = 1 / (1 + recencyDays / 14);

    const normalizedContent = hit.content.toLocaleLowerCase();
    let overlap = 0;
    for (const token of tokens) {
      if (normalizedContent.includes(token)) {
        overlap += 1;
      }
    }

    return overlap * 2 + hit.matchCount + recencyBoost;
  }

  private getRecallFallbackMatchCount(role: ArchivedChatMessageHit['role'], content: string): number {
    if (role !== 'user' && role !== 'assistant') {
      return 0;
    }

    if (this.isGenericRecallPrompt(content)) {
      return 0;
    }

    const normalized = content.trim();
    if (!normalized) {
      return 0;
    }

    const rememberable =
      /(?:\bmy\s+(?:name|role|project|goal)\b|\bwe\s+(?:decided|cannot|can't)\b|\bremember\s+that\b|\bimportant\s+context\b|как\s+меня\s+зовут|моя\s+роль|мой\s+проект|моя\s+цель|мы\s+решили|нельзя|запомни|важный\s+контекст|для\s+контекста)/iu.test(
        normalized,
      );

    if (rememberable) {
      return role === 'user' ? 3 : 2;
    }

    return role === 'user' && normalized.length >= 12 ? 1 : 0;
  }

  private hitContainsSuppressedValue(hit: ArchivedChatMessageHit, suppressedValues: string[]): boolean {
    if (suppressedValues.length === 0) {
      return false;
    }

    const normalizedContent = this.normalizeForSuppression(hit.content);
    return suppressedValues.some((value) => normalizedContent.includes(value));
  }

  private buildExcerpt(content: string, tokens: string[]): string {
    const normalized = content.trim();
    if (!normalized) {
      return '';
    }

    const lower = normalized.toLocaleLowerCase();
    const matchIndex = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0];

    if (matchIndex === undefined) {
      return normalized.length > MAX_EXCERPT_LENGTH ? `${normalized.slice(0, MAX_EXCERPT_LENGTH - 1)}…` : normalized;
    }

    const start = Math.max(0, matchIndex - Math.floor(MAX_EXCERPT_LENGTH / 3));
    const hasPrefix = start > 0;
    const remaining = normalized.length - start;
    const wouldNeedSuffix = remaining > MAX_EXCERPT_LENGTH;
    const prefix = hasPrefix ? '…' : '';
    const suffix = wouldNeedSuffix ? '…' : '';
    const availableSliceLength = Math.max(1, MAX_EXCERPT_LENGTH - prefix.length - suffix.length);
    const slice = normalized.slice(start, start + availableSliceLength);
    return `${prefix}${slice}${suffix}`.trim();
  }

  private normalizeForSuppression(value: string): string {
    return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  private isMemorySummaryQuery(conversation: Conversation): boolean {
    const latestUserMessage = [...conversation.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    return /(?:what|which)(?:[^.!?\n]{0,40})(?:remember|know)(?:[^.!?\n]{0,40})(?:about\s+me|about\s+us)|(?:что|что\s+именно)(?:[^.!?\n]{0,40})(?:помнишь|знаешь)(?:[^.!?\n]{0,40})(?:обо\s+мне|о\s+мне|о\s+нас)/iu.test(
      latestUserMessage,
    );
  }

  private isGenericRecallPrompt(value: string): boolean {
    return /(?:what|which)(?:[^.!?\n]{0,40})(?:remember|know)(?:[^.!?\n]{0,40})(?:about\s+me|about\s+us)|(?:tell\s+me|show\s+me)(?:[^.!?\n]{0,40})(?:what\s+you\s+(?:remember|know))(?:[^.!?\n]{0,40})(?:about\s+me|about\s+us)|(?:что|что\s+именно)(?:[^.!?\n]{0,40})(?:помнишь|знаешь)(?:[^.!?\n]{0,40})(?:обо\s+мне|о\s+мне|о\s+нас)|(?:скажи|покажи)(?:[^.!?\n]{0,40})(?:что\s+ты\s+(?:помнишь|знаешь))(?:[^.!?\n]{0,40})(?:обо\s+мне|о\s+мне|о\s+нас)/iu.test(
      value.trim(),
    );
  }

  private tokenize(value: string): Set<string> {
    return new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
    );
  }
}
