/**
 * Pure entry-selection and scoring functions extracted from
 * ConversationalMemoryCommandService.
 *
 * Every function here is side-effect-free: entries + context in → best match out.
 */
import type { Conversation } from '../../chat/entities/conversation.entity';
import type { EpisodicMemoryKind } from './memory-command.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'my', 'our', 'is', 'are', 'me', 'you', 'i', 'we',
  'что', 'это', 'как', 'мой', 'моя', 'мою', 'мои', 'мне', 'наш', 'наша', 'и', 'или', 'не', 'по', 'для', 'про', 'это',
]);

/* ------------------------------------------------------------------ */
/*  Main entry point                                                  */
/* ------------------------------------------------------------------ */

interface SelectorEntry {
  kind: string;
  summary: string;
  updatedAt: string;
  pinned?: boolean;
}

export function pickRelevantEntryByKind(
  entries: SelectorEntry[],
  kind: EpisodicMemoryKind,
  conversation?: Conversation,
  selectorText = '',
): SelectorEntry | undefined {
  const selectorTokens = tokenize(selectorText);
  const contextTokens = tokenize(buildRecentConversationContext(conversation));
  const combinedContext = `${selectorText} ${buildRecentConversationContext(conversation)}`;
  const desiredConstraintPolarity = kind === 'constraint' ? inferConstraintPolarity(combinedContext) : 'unknown';

  return entries
    .filter((entry) => entry.kind === kind)
    .sort((left, right) => {
      const leftSelectorOverlap = calculateOverlap(left.summary, selectorTokens);
      const rightSelectorOverlap = calculateOverlap(right.summary, selectorTokens);
      if (leftSelectorOverlap !== rightSelectorOverlap) {
        return rightSelectorOverlap - leftSelectorOverlap;
      }

      const leftContextOverlap = calculateOverlap(left.summary, contextTokens);
      const rightContextOverlap = calculateOverlap(right.summary, contextTokens);
      if (leftContextOverlap !== rightContextOverlap) {
        return rightContextOverlap - leftContextOverlap;
      }

      const polarityDelta =
        getConstraintPolarityScore(right.summary, desiredConstraintPolarity) -
        getConstraintPolarityScore(left.summary, desiredConstraintPolarity);
      if (polarityDelta !== 0) {
        return polarityDelta;
      }

      const recencyDelta = right.updatedAt.localeCompare(left.updatedAt);
      if (recencyDelta !== 0) {
        return recencyDelta;
      }

      return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    })[0];
}

/* ------------------------------------------------------------------ */
/*  Conversation context                                              */
/* ------------------------------------------------------------------ */

export function buildRecentConversationContext(conversation?: Conversation): string {
  if (!conversation) {
    return '';
  }

  const userMessages = conversation.messages.filter((message) => message.role === 'user');
  const contextMessages = userMessages.length > 1 ? userMessages.slice(-5, -1) : userMessages.slice(-4);
  return contextMessages.map((message) => message.content).join(' ');
}

/* ------------------------------------------------------------------ */
/*  Overlap scoring                                                   */
/* ------------------------------------------------------------------ */

export function calculateOverlap(value: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) {
    return 0;
  }

  const valueTokens = tokenize(value);
  let overlap = 0;
  for (const token of valueTokens) {
    if (queryTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

/* ------------------------------------------------------------------ */
/*  Constraint polarity                                               */
/* ------------------------------------------------------------------ */

export function inferConstraintPolarity(value: string): 'negative' | 'positive' | 'unknown' {
  const normalized = value.toLocaleLowerCase();
  if (/(?:cannot|can't|must not|should not|don't|avoid|forbid|forbidden|нельзя|не стоит|не надо|не нужно|избегать|запрет)/iu.test(normalized)) {
    return 'negative';
  }

  if (/(?:can use|can now use|allowed|may use|можно использовать|теперь можно использовать|можем использовать|разрешено)/iu.test(normalized)) {
    return 'positive';
  }

  return 'unknown';
}

export function getConstraintPolarityScore(
  summary: string,
  desired: 'negative' | 'positive' | 'unknown',
): number {
  if (desired === 'unknown') {
    return 0;
  }

  const normalized = summary.toLocaleLowerCase();
  const hasNegative = /(?:cannot|can't|must not|should not|don't|avoid|нельзя|не стоит|не надо|не нужно|избегать|запрет)/iu.test(
    normalized,
  );
  const hasPositive = /(?:can use|can be used|можно использовать|можно для|allowed|разрешено)/iu.test(normalized);

  if (hasNegative && hasPositive) {
    return 1;
  }

  if (desired === 'negative') {
    if (hasNegative) {
      return 2;
    }

    if (hasPositive) {
      return -2;
    }
  }

  if (desired === 'positive') {
    if (hasPositive) {
      return 2;
    }

    if (hasNegative) {
      return -2;
    }
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/*  Tokenization                                                      */
/* ------------------------------------------------------------------ */

export function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  );
}
