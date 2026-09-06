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
}
