export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dot / denominator;
}

export function serializeEmbedding(embedding: number[]): Buffer {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i]!, i * 4);
  }
  return buffer;
}

export function deserializeEmbedding(buffer: Buffer): number[] {
  const length = buffer.length / 4;
  const embedding = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    embedding[i] = buffer.readFloatLE(i * 4);
  }
  return embedding;
}

export function contentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return (hash >>> 0).toString(36);
}

export interface VectorSearchResult<T> {
  item: T;
  similarity: number;
}

export function findTopKSimilar<T>(
  query: number[],
  items: Array<{ item: T; embedding: number[] }>,
  k: number,
  minSimilarity = 0.0,
): VectorSearchResult<T>[] {
  const scored = items
    .map(({ item, embedding }) => ({
      item,
      similarity: cosineSimilarity(query, embedding),
    }))
    .filter((result) => result.similarity >= minSimilarity);

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, k);
}
