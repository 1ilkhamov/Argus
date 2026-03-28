export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokenCount: number;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  model: string;
  totalTokens: number;
}


