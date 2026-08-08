export interface EmbeddingSearchHit {
  chunkId: number;
  distance: number;
}

export interface EmbeddingRepository {
  insertMany(entries: { chunkId: number; embedding: number[] }[]): Promise<void>;
  deleteByChunkIds(chunkIds: number[]): Promise<void>;
  /**
   * Search for nearest neighbours. When `sourceFilter` is provided, results are
   * restricted to chunks whose `source` column matches one of the given values.
   */
  search(
    queryEmbedding: number[],
    topK: number,
    sourceFilter?: string[],
  ): Promise<EmbeddingSearchHit[]>;
}
