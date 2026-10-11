import type { CorpusSource } from '../../common/types/knowledge.types';

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
   *
   * `CorpusSource[]` rather than `string[]`: the callers are the four search
   * tools, which each hold a literal list, and a filter naming a source that
   * cannot exist is not a narrower search — it returns nothing at all, silently,
   * because no row matches. A typo should not typecheck.
   */
  search(
    queryEmbedding: number[],
    topK: number,
    sourceFilter?: CorpusSource[],
  ): Promise<EmbeddingSearchHit[]>;

  /**
   * The `topK` chunks nearest an *already indexed* chunk, excluding itself.
   *
   * Distinct from `search` because the query vector already exists in the table.
   * Re-embedding the chunk's text to search with it would cost one embedding
   * call per chunk scanned — on the current corpus, 172 calls against a free
   * tier that allows roughly 20 per window — to reproduce a vector sitting in
   * the row being read. Worse, it would reproduce it only *approximately*: a
   * provider switch or a model revision between indexing and scanning yields a
   * vector from a different space than its neighbours, so the ranking would
   * quietly stop meaning anything.
   *
   * Returns `[]` when the chunk has no vector, which is a real state — indexing
   * writes the chunk row before the embedding.
   */
  neighbours(chunkId: number, topK: number): Promise<EmbeddingSearchHit[]>;
}
