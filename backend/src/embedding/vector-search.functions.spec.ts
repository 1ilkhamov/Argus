import {
  cosineSimilarity,
  contentHash,
  deserializeEmbedding,
  findTopKSimilar,
  serializeEmbedding,
} from './vector-search.functions';

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('computes correct similarity for arbitrary vectors', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const dot = 1 * 4 + 2 * 5 + 3 * 6;
    const normA = Math.sqrt(1 + 4 + 9);
    const normB = Math.sqrt(16 + 25 + 36);
    expect(cosineSimilarity(a, b)).toBeCloseTo(dot / (normA * normB));
  });
});

describe('serializeEmbedding / deserializeEmbedding', () => {
  it('round-trips an embedding', () => {
    const original = [0.1, 0.2, -0.3, 1.5, 0.0];
    const buffer = serializeEmbedding(original);
    expect(buffer.length).toBe(original.length * 4);
    const restored = deserializeEmbedding(buffer);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it('handles empty embedding', () => {
    const buffer = serializeEmbedding([]);
    expect(buffer.length).toBe(0);
    expect(deserializeEmbedding(buffer)).toEqual([]);
  });
});

describe('contentHash', () => {
  it('returns same hash for same content', () => {
    expect(contentHash('hello world')).toBe(contentHash('hello world'));
  });

  it('returns different hash for different content', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });

  it('returns a string', () => {
    expect(typeof contentHash('test')).toBe('string');
  });
});

describe('findTopKSimilar', () => {
  it('returns top-k most similar items', () => {
    const query = [1, 0, 0];
    const items = [
      { item: 'a', embedding: [1, 0, 0] },
      { item: 'b', embedding: [0, 1, 0] },
      { item: 'c', embedding: [0.9, 0.1, 0] },
    ];

    const results = findTopKSimilar(query, items, 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.item).toBe('a');
    expect(results[0]!.similarity).toBeCloseTo(1.0);
    expect(results[1]!.item).toBe('c');
  });

  it('filters by minSimilarity', () => {
    const query = [1, 0, 0];
    const items = [
      { item: 'a', embedding: [1, 0, 0] },
      { item: 'b', embedding: [0, 1, 0] },
    ];

    const results = findTopKSimilar(query, items, 10, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0]!.item).toBe('a');
  });

  it('returns empty for no items', () => {
    expect(findTopKSimilar([1, 0], [], 5)).toEqual([]);
  });
});
