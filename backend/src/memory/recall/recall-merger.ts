import type { MemoryEntry, MemoryKind, RecalledMemory, RecallConfidence } from '../core/memory-entry.types';

// ─── RRF (Reciprocal Rank Fusion) ──────────────────────────────────────────

export interface RankedCandidate {
  entry: MemoryEntry;
  score: number;
  source: RecalledMemory['matchSource'];
}

export interface MergeOptions {
  rrrK?: number;           // RRF constant (default 60)
  limit?: number;
  minScore?: number;
}

export interface DiversityOptions {
  totalBudget?: number;
  maxPerKind?: Partial<Record<MemoryKind, number>>;
  similarityThreshold?: number;  // 0–1, Jaccard threshold for intra-slot dedup (default 0.6)
}

// ─── Kind-aware decay half-lives ────────────────────────────────────────────

const LN2 = Math.LN2; // 0.693...
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Half-life in ms per kind. Infinity = no decay. */
const KIND_HALF_LIFE_MS: Record<MemoryKind, number> = {
  fact: Infinity,             // facts don't decay until superseded
  preference: Infinity,       // preferences are stable
  skill: Infinity,            // skills don't expire
  identity: Infinity,         // identity traits are persistent
  learning: 60 * MS_PER_DAY, // learnings stay relevant ~2 months
  episode: 14 * MS_PER_DAY,  // episodes lose relevance in ~2 weeks
  action: 7 * MS_PER_DAY,    // actions are short-lived context
};

/** Window in which a recently accessed entry gets a boost */
const ACCESS_BOOST_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACCESS_BOOST_HALF_LIFE_MS = 12 * 60 * 60 * 1000; // halves at 12h
const ACCESS_BOOST_STRENGTH = 0.15; // max +15% boost

/** Importance spread: maps importance 0–1 to multiplier range */
const IMPORTANCE_SPREAD = 0.4; // importance 1.0 → +20%, importance 0.0 → −20%

/** Pinned entries get a flat multiplier */
const PINNED_BOOST = 1.5;

/** Default slot budgets per kind for diversity filter */
const DEFAULT_MAX_PER_KIND: Record<MemoryKind, number> = {
  fact: 3,
  episode: 2,
  preference: 2,
  identity: 2,
  learning: 1,
  skill: 1,
  action: 1,
};

const DEFAULT_RRF_K = 60;

/** Confidence thresholds (applied after normalization to 0–1) */
const CONFIDENCE_HIGH_THRESHOLD = 0.6;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.3;

// ─── Contradiction detection patterns ──────────────────────────────────────

/** Categories that can contradict within the same entry */
const CONTRADICTION_CATEGORIES = new Set([
  'identity', 'technical', 'project', 'workflow', 'goal',
]);

// ─── Core merge function ───────────────────────────────────────────────────

/**
 * Merge multiple ranked lists using Reciprocal Rank Fusion,
 * then apply composite scoring (kind decay, importance, access recency, pinned).
 *
 * Each `rankedList` is an array of candidates sorted by relevance (best first).
 */
export function mergeRecallResults(
  rankedLists: RankedCandidate[][],
  options: MergeOptions = {},
): RecalledMemory[] {
  const k = options.rrrK ?? DEFAULT_RRF_K;
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;

  // Step 1: RRF score per entry id
  const scoreMap = new Map<string, { entry: MemoryEntry; rrfScore: number; bestSource: RecalledMemory['matchSource'] }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const candidate = list[rank]!;
      const rrfContribution = 1 / (k + rank + 1);
      const existing = scoreMap.get(candidate.entry.id);
      if (existing) {
        existing.rrfScore += rrfContribution;
        if (existing.bestSource !== candidate.source) {
          existing.bestSource = 'merged';
        }
      } else {
        scoreMap.set(candidate.entry.id, {
          entry: candidate.entry,
          rrfScore: rrfContribution,
          bestSource: candidate.source,
        });
      }
    }
  }

  // Step 2: Apply composite scoring
  const now = Date.now();
  const results: RecalledMemory[] = [];

  for (const { entry, rrfScore, bestSource } of scoreMap.values()) {
    const compositeScore = computeCompositeScore(entry, rrfScore, now);

    if (compositeScore >= minScore) {
      results.push({
        entry,
        score: compositeScore,
        matchSource: bestSource,
        confidence: 'medium', // placeholder, assigned after normalization
      });
    }
  }

  // Step 3: Sort by score descending, then limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── Composite scoring ─────────────────────────────────────────────────────

/**
 * Compute composite score from RRF base + 4 multiplicative factors:
 * kind decay, importance, access recency, pinned.
 */
export function computeCompositeScore(entry: MemoryEntry, rrfScore: number, now: number): number {
  // Factor 1: Kind-aware recency decay
  const halfLifeMs = KIND_HALF_LIFE_MS[entry.kind];
  let kindDecayFactor: number;
  if (halfLifeMs === Infinity) {
    kindDecayFactor = 1.0;
  } else {
    const createdAge = Math.max(0, now - new Date(entry.createdAt).getTime());
    kindDecayFactor = Math.exp(-LN2 * createdAge / halfLifeMs);
  }

  // Factor 2: Access recency (working memory effect)
  let accessRecencyFactor = 1.0;
  if (entry.lastAccessedAt) {
    const accessAge = Math.max(0, now - new Date(entry.lastAccessedAt).getTime());
    if (accessAge < ACCESS_BOOST_WINDOW_MS) {
      accessRecencyFactor = 1.0 + ACCESS_BOOST_STRENGTH * Math.exp(-LN2 * accessAge / ACCESS_BOOST_HALF_LIFE_MS);
    }
  }

  // Factor 3: Importance (centered at 0.5, spread ±IMPORTANCE_SPREAD/2)
  const importanceFactor = 1.0 + (entry.importance - 0.5) * IMPORTANCE_SPREAD;

  // Factor 4: Pinned boost
  const pinnedFactor = entry.pinned ? PINNED_BOOST : 1.0;

  return rrfScore * kindDecayFactor * accessRecencyFactor * importanceFactor * pinnedFactor;
}

// ─── Normalize scores ──────────────────────────────────────────────────────

/**
 * Normalize scores to 0–1 range.
 */
export function normalizeScores(memories: RecalledMemory[]): RecalledMemory[] {
  if (memories.length === 0) return [];
  const maxScore = memories[0]!.score;
  if (maxScore === 0) return memories;
  return memories.map((m) => ({ ...m, score: m.score / maxScore }));
}

// ─── Confidence assignment ─────────────────────────────────────────────────

/**
 * Assign confidence levels based on normalized score.
 * Must be called AFTER normalizeScores.
 */
export function assignConfidence(memories: RecalledMemory[]): RecalledMemory[] {
  return memories.map((m) => ({
    ...m,
    confidence: scoreToConfidence(m.score),
  }));
}

export function scoreToConfidence(normalizedScore: number): RecallConfidence {
  if (normalizedScore >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (normalizedScore >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

// ─── Contradiction detection ───────────────────────────────────────────────

/**
 * Detect potential contradictions among recalled entries.
 * Two entries may contradict if:
 *  - Same kind AND same category
 *  - Low content overlap (different statements about the same topic)
 *  - Both are facts or episodes about the same category
 *
 * Returns the same array with `contradicts` populated where detected.
 */
export function detectContradictions(memories: RecalledMemory[]): RecalledMemory[] {
  if (memories.length < 2) return memories;

  // Group by (kind, category) — only check within same group
  const groups = new Map<string, number[]>();
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]!;
    if (!m.entry.category || !CONTRADICTION_CATEGORIES.has(m.entry.category)) continue;
    const key = `${m.entry.kind}:${m.entry.category}`;
    const group = groups.get(key);
    if (group) {
      group.push(i);
    } else {
      groups.set(key, [i]);
    }
  }

  // For each group with 2+ entries, check pairwise content similarity
  const contradictionMap = new Map<number, string[]>();

  for (const indices of groups.values()) {
    if (indices.length < 2) continue;

    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const entryA = memories[indices[a]!]!.entry;
        const entryB = memories[indices[b]!]!.entry;

        const similarity = jaccardSimilarity(
          normalizeForComparison(entryA.content),
          normalizeForComparison(entryB.content),
        );

        // Moderate-to-low similarity within same category = potential contradiction
        // (e.g. "works at NovaTech" vs "works at CloudBase" → Jaccard ~0.6)
        if (similarity < 0.7 && similarity > 0.05) {
          const aContradicts = contradictionMap.get(indices[a]!) ?? [];
          aContradicts.push(entryB.id);
          contradictionMap.set(indices[a]!, aContradicts);

          const bContradicts = contradictionMap.get(indices[b]!) ?? [];
          bContradicts.push(entryA.id);
          contradictionMap.set(indices[b]!, bContradicts);
        }
      }
    }
  }

  if (contradictionMap.size === 0) return memories;

  return memories.map((m, i) => {
    const contradicts = contradictionMap.get(i);
    return contradicts ? { ...m, contradicts } : m;
  });
}

// ─── Slot-based diversity filter ───────────────────────────────────────────

/**
 * Filter recalled memories for diversity using slot-based allocation:
 * 1. Each kind gets a budget (slot)
 * 2. Within a slot, entries with >threshold Jaccard similarity are deduped
 * 3. Overflow pass fills remaining budget ignoring kind limits
 */
export function applyDiversityFilter(
  memories: RecalledMemory[],
  options: DiversityOptions = {},
): RecalledMemory[] {
  const totalBudget = options.totalBudget ?? 10;
  const maxPerKind = { ...DEFAULT_MAX_PER_KIND, ...options.maxPerKind };
  const threshold = options.similarityThreshold ?? 0.6;

  if (memories.length <= totalBudget) return memories;

  const selected: RecalledMemory[] = [];
  const kindCounts = new Map<MemoryKind, number>();
  const selectedIds = new Set<string>();

  // Pass 1: Fill slots respecting kind budgets
  for (const candidate of memories) {
    if (selected.length >= totalBudget) break;

    const kind = candidate.entry.kind;
    const currentCount = kindCounts.get(kind) ?? 0;
    const maxForKind = maxPerKind[kind] ?? 1;

    if (currentCount >= maxForKind) continue;

    // Intra-slot similarity check
    const sameKindSelected = selected.filter((s) => s.entry.kind === kind);
    const isDuplicate = sameKindSelected.some((s) =>
      jaccardSimilarity(
        normalizeForComparison(s.entry.content),
        normalizeForComparison(candidate.entry.content),
      ) >= threshold,
    );
    if (isDuplicate) continue;

    selected.push(candidate);
    selectedIds.add(candidate.entry.id);
    kindCounts.set(kind, currentCount + 1);
  }

  // Pass 2: Fill remaining budget ignoring kind limits, still dedup
  if (selected.length < totalBudget) {
    for (const candidate of memories) {
      if (selected.length >= totalBudget) break;
      if (selectedIds.has(candidate.entry.id)) continue;

      const isDuplicate = selected.some((s) =>
        jaccardSimilarity(
          normalizeForComparison(s.entry.content),
          normalizeForComparison(candidate.entry.content),
        ) >= threshold,
      );
      if (isDuplicate) continue;

      selected.push(candidate);
      selectedIds.add(candidate.entry.id);
    }
  }

  return selected;
}

// ─── Text comparison helpers ───────────────────────────────────────────────

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a: string, b: string): number {
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

// ─── Exported constants for testing ────────────────────────────────────────

export const _testing = {
  KIND_HALF_LIFE_MS,
  ACCESS_BOOST_WINDOW_MS,
  ACCESS_BOOST_STRENGTH,
  IMPORTANCE_SPREAD,
  PINNED_BOOST,
  DEFAULT_MAX_PER_KIND,
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_MEDIUM_THRESHOLD,
  jaccardSimilarity,
  normalizeForComparison,
};
