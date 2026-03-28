/**
 * Shared near-duplicate detection utilities for memory capture services.
 * Pure functions — no DI, no side effects.
 */

// ─── Stopwords ───────────────────────────────────────────────────────────────

const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'and', 'but', 'or', 'nor', 'if', 'it', 'its',
  'he', 'she', 'they', 'we', 'you', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'about', 'up',
  // Common sentence-start words (would be falsely flagged as significant due to capitalization)
  'main', 'using', 'based', 'working', 'currently', 'previously',
  'also', 'just', 'still', 'even', 'well', 'much', 'new', 'old',
  'first', 'last', 'next', 'full', 'general', 'common', 'current',
  'earlier', 'user', 'uses', 'prefers', 'wants', 'needs', 'likes',
]);

const STOPWORDS_RU = new Set([
  'и', 'в', 'на', 'с', 'по', 'для', 'от', 'из', 'к', 'за', 'о', 'об',
  'до', 'без', 'при', 'через', 'над', 'под', 'между', 'у', 'а', 'но',
  'или', 'что', 'как', 'это', 'он', 'она', 'оно', 'они', 'мы', 'вы',
  'ты', 'я', 'его', 'её', 'их', 'мой', 'твой', 'наш', 'ваш', 'свой',
  'не', 'ни', 'же', 'ли', 'бы', 'вот', 'тоже', 'также', 'ещё', 'уже',
  'тут', 'там', 'когда', 'где', 'если', 'то', 'чтобы', 'так', 'все',
  'всё', 'вся', 'весь', 'этот', 'эта', 'эти', 'тот', 'та', 'те',
  'быть', 'был', 'была', 'были', 'есть', 'будет', 'будут', 'нет',
  'да', 'очень', 'только', 'может', 'нужно', 'надо', 'можно',
  'который', 'которая', 'которые', 'которое', 'более', 'менее',
  'чем', 'чего', 'кто', 'кого', 'кому', 'ком', 'себя', 'себе',
  // Common sentence-start words
  'основной', 'главный', 'текущий', 'проект', 'пользователь',
  'полный', 'общий', 'простой', 'новый', 'старый', 'другой',
  'первый', 'последний', 'каждый', 'любой', 'сам',
  'работает', 'использует', 'предпочитает',
]);

const ALL_STOPWORDS = new Set([...STOPWORDS_EN, ...STOPWORDS_RU]);

// ─── Normalization ───────────────────────────────────────────────────────────

export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Jaccard similarity ──────────────────────────────────────────────────────

export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter((w) => w.length >= 2));
  const wordsB = new Set(b.split(' ').filter((w) => w.length >= 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Significant token extraction (cross-language dedup) ─────────────────────

/**
 * Extract "significant" tokens from text — proper nouns, tech terms, numbers.
 * These tokens are language-independent and useful for cross-language dedup.
 *
 * Examples:
 *  "Main stack: TypeScript, NestJS, React" → {"typescript", "nestjs", "react"}
 *  "Основной стек — TypeScript и NestJS"  → {"typescript", "nestjs"}
 *  "User's name is Артём"                 → {"артём"}
 *  "Name: Артём"                          → {"артём"}
 */
export function extractSignificantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  // Split on whitespace and punctuation, keep meaningful chunks
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (ALL_STOPWORDS.has(lower)) continue;

    // Keep if: starts with uppercase (proper noun/tech term), or is mixed-case (NestJS, PostgreSQL)
    const hasUpper = /[A-ZА-ЯЁ]/.test(word);
    const hasLower = /[a-zа-яё]/.test(word);
    const isMixedCase = hasUpper && hasLower && word !== word.toLowerCase();
    const isAllCaps = word === word.toUpperCase() && word.length >= 2 && /[A-ZА-ЯЁ]/.test(word);
    const isCapitalized = /^[A-ZА-ЯЁ]/.test(word) && word.length >= 3;
    const isNumber = /^\d+$/.test(word);

    if (isMixedCase || isAllCaps || isCapitalized || isNumber) {
      tokens.add(lower);
    }
  }

  return tokens;
}

/**
 * Compute overlap of significant tokens between two texts.
 * Returns ratio of intersection / min(size_a, size_b).
 * Using min instead of union so that a short entry fully contained in a long one scores high.
 */
export function significantTokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const minSize = Math.min(a.size, b.size);
  return minSize > 0 ? intersection / minSize : 0;
}
