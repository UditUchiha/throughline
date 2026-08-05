export interface EmbeddingSearchHit {
  chunkId: number;
  distance: number;
}

export interface EmbeddingRepository {
  insertMany(entries: { chunkId: number; embedding: number[] }[]): Promise<void>;
  deleteByChunkIds(chunkIds: number[]): Promise<void>;
  search(queryEmbedding: number[], topK: number): Promise<EmbeddingSearchHit[]>;
}
