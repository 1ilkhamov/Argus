// ─── Qdrant Point ───────────────────────────────────────────────────────────

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

// ─── Qdrant Filter ──────────────────────────────────────────────────────────

export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}

export type QdrantCondition =
  | { key: string; match: { value: string | number | boolean } }
  | { key: string; match: { any: string[] } };

// ─── Qdrant Config ──────────────────────────────────────────────────────────

export interface QdrantConfig {
  url: string;              // e.g. http://localhost:6333
  apiKey?: string;
  collectionName: string;   // e.g. 'argus_memory'
  vectorSize: number;       // e.g. 768 for E5-base, 1536 for OpenAI
}
